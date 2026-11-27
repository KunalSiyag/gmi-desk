// Owned by the Media slice: mock handlers for estimate_generation, submit_generation, get_generation, upload_media.
// list_generations belongs to the Usage slice's mock; get_generation stays consistent with it by looking up ids there.
//
// Mock outputs live at https://media.mock.gmicloud.invalid/... (a reserved, never-resolving domain). The media service
// never fetches them: in mock mode it "downloads" them by rendering placeholders locally (renderMockMedia), so the
// gallery shows real files through gmi-media:// while offline.
import { randomUUID } from 'node:crypto';
import { GmiError } from '@shared/contracts/errors';
import { modalityFromKind, type MediaJob, type MediaJobStatus, type MediaModality } from '@shared/contracts/media';
import { catalogMockTools } from './catalog';
import demoVideo from './fixtures/media/demo-video.json';
import estimatesFixture from './fixtures/media/estimates.json';
import modelsFixture from './fixtures/media/models.json';
import type { MockToolTable } from './types';
import { usageMockTools } from './usage';

export const MOCK_MEDIA_HOST = 'media.mock.gmicloud.invalid';
export const MOCK_UPLOAD_HOST = 'upload.mock.gmicloud.invalid';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** How long a mock job takes from submission to result. */
const RUN_MS: Record<MediaModality, number> = { image: 3500, audio: 4500, video: 6000, workflow: 6000, other: 4000 };
const DEDUPE_MS = 10 * 60_000;
const STILL_RUNNING =
  'Still running. This generation was accepted and is being charged; it did not fail. Call get_generation with this request_id to get the result.';
const FAILED_NOTE =
  "This generation ended as failed, which is terminal: nothing further will arrive by polling. The generation service's own description of the failure is in the failure_reason field.";

interface MockGeneration {
  requestId: string;
  modelId: string;
  modality: MediaModality;
  prompt: string;
  parameters: Obj;
  submittedAt: number;
  readyAt: number;
  outcome: 'success' | 'failed';
  failureReason: string | null;
  outputCount: number;
  key: string | null;
}

const generations = new Map<string, MockGeneration>();

/** Test helper: forgets every mock generation. */
export function resetMediaMock(): void {
  generations.clear();
}

// ------------------------------------------------------------------------------------------------ models & pricing

const FIXTURE_MODELS = modelsFixture.models as unknown as Record<string, Obj>;

async function lookupModel(modelId: string): Promise<Obj | null> {
  const fixture = FIXTURE_MODELS[modelId];
  if (fixture) return fixture;
  const fromCatalog = catalogMockTools.get_model;
  if (fromCatalog) {
    try {
      const result = await fromCatalog({ model_id: modelId });
      if (isObj(result)) return isObj(result.model) ? result.model : result;
    } catch {
      // unknown to the catalog mock as well
    }
  }
  return null;
}

function modelModality(model: Obj | null): MediaModality {
  const mm = model && isObj(model.multimodal) ? model.multimodal : null;
  const modality = modalityFromKind(typeof mm?.model_type === 'string' ? mm.model_type : null);
  return modality === 'other' ? 'image' : modality;
}

function modelPricing(model: Obj | null): { price: number; unit: string } {
  const mm = model && isObj(model.multimodal) ? model.multimodal : null;
  const pricing = mm && isObj(mm.pricing) ? mm.pricing : null;
  const price = Number(pricing?.price);
  return {
    price: Number.isFinite(price) && price >= 0 ? price : 50_000,
    unit: typeof pricing?.unit === 'string' && pricing.unit ? pricing.unit : 'request',
  };
}

function schemaDefault(model: Obj | null, name: string): unknown {
  const params = model && Array.isArray(model.parameters) ? model.parameters : [];
  const p = params.find((x): x is Obj => isObj(x) && x.name === name);
  return p?.default;
}

function hasParameter(model: Obj | null, name: string): boolean {
  const params = model && Array.isArray(model.parameters) ? model.parameters : [];
  return params.some((x) => isObj(x) && x.name === name);
}

const COUNT_PARAMS = ['n', 'num_images', 'num_outputs', 'num_outputs_per_prompt'];

/**
 * How many outputs a request asks for, the way live GMI prices it: `n` and similar count fields (top-level `n` only
 * when the model has an `n` parameter), and `max_images` only with `sequential_image_generation: "auto"` (with it
 * disabled, seedream makes one image whatever max_images says). Recorded live: gpt-image-2-generate n=1 → $0.05468,
 * n=4 → $0.21272; seedream-5.0-pro max_images=4 → $0.085 (disabled), $0.34 (auto).
 */
export function requestedOutputCount(model: Obj | null, args: Obj): number {
  const params = isObj(args.parameters) ? args.parameters : {};
  const whole = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : 1;
  };
  let count = 1;
  for (const name of COUNT_PARAMS) {
    const value = params[name] ?? (name === 'n' && hasParameter(model, 'n') ? args.n : undefined);
    if (value !== undefined && value !== null && value !== '') count = Math.max(count, whole(value));
  }
  const sequential = params.sequential_image_generation ?? schemaDefault(model, 'sequential_image_generation');
  if (sequential === 'auto') count = Math.max(count, whole(params.max_images ?? schemaDefault(model, 'max_images')));
  return count;
}

function seconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function recordedEstimate(args: Obj): Obj | null {
  for (const call of estimatesFixture.calls as unknown as Array<{ args: Obj; result: Obj }>) {
    if (call.args.model_id !== args.model_id) continue;
    if (stableJson(call.args.parameters ?? {}) === stableJson(args.parameters ?? {})) return call.result;
  }
  return null;
}

async function estimate(args: Obj): Promise<Obj> {
  const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : '';
  if (!modelId) throw new GmiError('invalid_input', 'model_id is required');
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new GmiError('invalid_input', 'prompt is required');
  const recorded = recordedEstimate(args);
  if (recorded) return { ...recorded };

  const model = await lookupModel(modelId);
  const { price, unit } = modelPricing(model);
  const params = isObj(args.parameters) ? args.parameters : {};
  let micro = price;
  let note: string | undefined;
  if (/second/i.test(unit)) {
    micro = price * seconds(params.duration ?? params.video_length ?? schemaDefault(model, 'duration'));
    note = 'This model is priced per second, and this price covers the duration these parameters ask for.';
  } else if (/char/i.test(unit)) {
    const text = String(params.text ?? params.lyrics ?? args.prompt);
    // GMI lists some per-character prices per 1K characters (e.g. Inworld TTS: 15000 micro-USD = $0.015 / 1K chars).
    const perThousand = /1k|thousand/i.test(unit) || price >= 1000;
    micro = perThousand ? (price * text.length) / 1000 : price * text.length;
  }
  // Like GMI: the quote covers every output the request asks for.
  micro = Math.round(micro * requestedOutputCount(model, args));
  return {
    currency: 'micro_usd',
    model_id: modelId,
    price_micro_usd: micro,
    price_usd: String(Number((micro / 1e6).toFixed(6))),
    unit,
    ...(note ? { note } : {}),
  };
}

// ------------------------------------------------------------------------------------------------ generations

/** Outputs a mock image job produces: what the request is priced for, capped at 4 placeholders. */
function outputCountFor(modality: MediaModality, model: Obj | null, args: Obj): number {
  if (modality !== 'image') return 1;
  return Math.min(4, requestedOutputCount(model, args));
}

function outputKind(modality: MediaModality): { type: 'image' | 'video' | 'audio'; ext: string; mime: string } {
  if (modality === 'video' || modality === 'workflow') return { type: 'video', ext: 'webm', mime: 'video/webm' };
  if (modality === 'audio') return { type: 'audio', ext: 'wav', mime: 'audio/wav' };
  return { type: 'image', ext: 'svg', mime: 'image/svg+xml' };
}

export function mockOutputUrl(requestId: string, index: number, ext: string): string {
  return `https://${MOCK_MEDIA_HOST}/g/${encodeURIComponent(requestId)}/${index}.${ext}`;
}

function payload(g: MockGeneration, now: number): Obj {
  const total = Math.max(1, g.readyAt - g.submittedAt);
  const elapsed = now - g.submittedAt;
  if (elapsed < total) {
    return { request_id: g.requestId, model_id: g.modelId, status: elapsed < total * 0.25 ? 'queued' : 'processing', note: STILL_RUNNING };
  }
  if (g.outcome === 'failed') {
    return { request_id: g.requestId, model_id: g.modelId, status: 'failed', failure_reason: g.failureReason ?? 'Generation failed.', note: FAILED_NOTE };
  }
  const kind = outputKind(g.modality);
  return {
    request_id: g.requestId,
    model_id: g.modelId,
    status: 'success',
    media: Array.from({ length: g.outputCount }, (_, i) => ({ type: kind.type, mime_type: kind.mime, url: mockOutputUrl(g.requestId, i, kind.ext) })),
  };
}

async function submit(args: Obj): Promise<Obj> {
  const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : '';
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!modelId) throw new GmiError('invalid_input', 'model_id is required');
  if (!prompt) throw new GmiError('invalid_input', 'prompt is required');
  const { wait_seconds: _wait, ...rest } = args;
  const key = stableJson(rest);
  const now = Date.now();
  // Like GMI: an identical request inside the window returns the earlier job instead of a new (charged) one.
  for (const g of generations.values()) {
    if (g.key === key && now - g.submittedAt < DEDUPE_MS) return payload(g, now);
  }
  const model = await lookupModel(modelId);
  const modality = modelModality(model);
  const outputCount = outputCountFor(modality, model, args);
  const requestId = `mock-${modality}-${outputCount}-${randomUUID().slice(0, 8)}`;
  const failed = /#fail\b/i.test(prompt);
  const g: MockGeneration = {
    requestId,
    modelId,
    modality,
    prompt,
    parameters: isObj(args.parameters) ? args.parameters : {},
    submittedAt: now,
    readyAt: now + RUN_MS[modality],
    outcome: failed ? 'failed' : 'success',
    failureReason: failed ? 'The model rejected this prompt (demo failure: the prompt contains #fail).' : null,
    outputCount,
    key,
  };
  generations.set(requestId, g);
  return payload(g, now);
}

const MOCK_ID = /^mock-(image|video|audio|workflow|other)-(\d{1,2})-/;

/** Mock ids encode their modality and output count, so they resolve even after an app restart. */
function fromMockId(requestId: string): MockGeneration | null {
  const m = MOCK_ID.exec(requestId);
  if (!m) return null;
  const modality = m[1] as MediaModality;
  const g: MockGeneration = {
    requestId,
    modelId: 'unknown',
    modality,
    prompt: '',
    parameters: {},
    submittedAt: 0,
    readyAt: 0,
    outcome: 'success',
    failureReason: null,
    outputCount: Math.min(4, Math.max(1, Number(m[2]))),
    key: null,
  };
  generations.set(requestId, g);
  return g;
}

/** Ids listed by the Usage slice's list_generations mock resolve consistently with their listed status. */
async function fromHistory(requestId: string): Promise<MockGeneration | null> {
  const list = usageMockTools.list_generations;
  if (!list) return null;
  for (let offset = 0; offset < 300; offset += 100) {
    let result: unknown;
    try {
      result = await list({ limit: 100, offset });
    } catch {
      return null;
    }
    const items = isObj(result) && Array.isArray(result.generations) ? result.generations : [];
    const hit = items.find((x): x is Obj => isObj(x) && x.request_id === requestId);
    if (hit) {
      const status = String(hit.status ?? '');
      const modality = modalityFromKind(typeof hit.modality === 'string' ? hit.modality : null);
      const now = Date.now();
      const running = !['success', 'failed', 'cancelled'].includes(status);
      const g: MockGeneration = {
        requestId,
        modelId: typeof hit.model_id === 'string' ? hit.model_id : 'unknown',
        modality: modality === 'other' ? 'image' : modality,
        prompt: '',
        parameters: {},
        submittedAt: now - (running ? 1000 : 60_000),
        readyAt: running ? now + 30_000 : now - 1000,
        outcome: status === 'failed' || status === 'cancelled' ? 'failed' : 'success',
        failureReason: status === 'cancelled' ? 'The request was cancelled.' : 'Backend error (403). Please try again.',
        outputCount: 1,
        key: null,
      };
      generations.set(requestId, g);
      return g;
    }
    if (items.length < 100) break;
  }
  return null;
}

async function getGeneration(args: Obj): Promise<Obj> {
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new GmiError('invalid_input', 'request_id is required');
  const g = generations.get(requestId) ?? fromMockId(requestId) ?? (await fromHistory(requestId));
  if (!g) throw new GmiError('not_found', `no generation with request id "${requestId}"`);
  return payload(g, Date.now());
}

function uploadSlot(args: Obj): Obj {
  const fileType = typeof args.file_type === 'string' ? args.file_type.trim().toLowerCase() : '';
  const contentType = UPLOAD_CONTENT_TYPES[fileType];
  if (!contentType) throw new GmiError('invalid_input', 'file_type must be one of: jpeg, jpg, png, mp4, mp3, wav');
  const id = randomUUID();
  return {
    upload_url: `https://${MOCK_UPLOAD_HOST}/slot/${id}.${fileType}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=900&X-Goog-Signature=mock`,
    public_url: `https://${MOCK_MEDIA_HOST}/uploads/${id}.${fileType}`,
    content_type: contentType,
    expires_in_seconds: 900,
  };
}

export const mediaMockTools: MockToolTable = {
  estimate_generation: (args) => estimate(args),
  submit_generation: (args) => submit(args),
  get_generation: (args) => getGeneration(args),
  upload_media: (args) => uploadSlot(args),
};

// ------------------------------------------------------------------------------------------------ placeholders

export function isMockMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === MOCK_MEDIA_HOST || host === MOCK_UPLOAD_HOST;
  } catch {
    return false;
  }
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function random(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const used = lines.join(' ').length;
  if (used < words.join(' ').length && lines.length) {
    const last = lines[lines.length - 1] as string;
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return lines;
}

/** Output aspect ratio implied by common parameters ("1920x1080", "16:9", "9:16"); square by default. */
function aspectFrom(parameters: Obj): number {
  for (const key of ['size', 'aspect_ratio', 'ratio', 'resolution']) {
    const v = parameters[key];
    if (typeof v !== 'string') continue;
    const m = /^(\d+(?:\.\d+)?)\s*[x:×]\s*(\d+(?:\.\d+)?)$/i.exec(v.trim());
    if (m) {
      const ratio = Number(m[1]) / Number(m[2]);
      if (ratio > 0.2 && ratio < 5) return ratio;
    }
  }
  return 1;
}

/** Curated sky palettes: [top, middle, horizon, sun, glow, hill]. */
const PALETTES: Array<[string, string, string, string, string, string]> = [
  ['#120f3a', '#6d28d9', '#fb923c', '#fff7ed', '#f472b6', '#1e1238'],
  ['#071a33', '#0e7490', '#99f6e4', '#f0fdfa', '#38bdf8', '#082032'],
  ['#1a0a05', '#b45309', '#fde68a', '#fffbeb', '#f97316', '#2a1206'],
  ['#020617', '#0f766e', '#c4b5fd', '#f5f3ff', '#a78bfa', '#04131a'],
  ['#2a0614', '#be185d', '#fecdd3', '#fff1f2', '#fb7185', '#2b0a16'],
  ['#0b1324', '#334155', '#cbd5e1', '#f8fafc', '#94a3b8', '#0f172a'],
  ['#0f172a', '#4338ca', '#fdba74', '#fff7ed', '#818cf8', '#111827'],
];

/** An abstract "generated image" (gradient sky, soft sun, layered hills) with the prompt in the corner. */
export function placeholderSvg(opts: { prompt: string; modelId: string; seed: number; aspect?: number }): string {
  const rand = random(opts.seed);
  const aspect = opts.aspect ?? 1;
  const width = aspect >= 1 ? 1024 : Math.round(1024 * aspect);
  const height = aspect >= 1 ? Math.round(1024 / aspect) : 1024;
  const [top, middle, horizon, sunColor, glow, hillColor] = PALETTES[Math.floor(rand() * PALETTES.length)] as (typeof PALETTES)[number];
  const sunX = Math.round(width * (0.28 + rand() * 0.44));
  const sunY = Math.round(height * (0.42 + rand() * 0.16));
  const r = Math.round(Math.min(width, height) * (0.05 + rand() * 0.035));
  const hill = (base: number, amp: number) => {
    const y0 = Math.round(height * base);
    const pts: string[] = [`M0 ${y0}`];
    const steps = 4;
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round((width * i) / steps);
      const cx = Math.round(x - width / steps / 2);
      const cy = Math.round(y0 - amp * height * (0.4 + rand() * 0.8) * (i % 2 ? 1 : -0.5));
      pts.push(`Q${cx} ${cy} ${x} ${Math.round(y0 + (rand() - 0.5) * amp * height)}`);
    }
    return `${pts.join(' ')} V${height} H0 Z`;
  };
  const fontSize = Math.round(width / 26);
  const lines = opts.prompt ? wrap(opts.prompt, Math.floor((width - fontSize * 3) / (fontSize * 0.52)), 3) : [];
  const textTop = height - fontSize * (lines.length * 1.3 + 1.4);
  const text = lines
    .map((line, i) => `<text x="${fontSize * 1.4}" y="${Math.round(textTop + fontSize * 1.3 * (i + 1))}">${escapeXml(line)}</text>`)
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<defs>',
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="0.58" stop-color="${middle}"/><stop offset="0.82" stop-color="${horizon}"/></linearGradient>`,
    `<radialGradient id="sun"><stop offset="0" stop-color="${sunColor}"/><stop offset="0.3" stop-color="${sunColor}" stop-opacity="0.85"/><stop offset="1" stop-color="${horizon}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="glow" cx="${(0.2 + rand() * 0.6).toFixed(2)}" cy="0.15" r="0.55"><stop offset="0" stop-color="${glow}" stop-opacity="0.35"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>`,
    '<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></linearGradient>',
    '</defs>',
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>`,
    `<rect width="${width}" height="${height}" fill="url(#glow)"/>`,
    `<circle cx="${sunX}" cy="${sunY}" r="${r * 2.6}" fill="url(#sun)"/>`,
    `<path d="${hill(0.68, 0.07)}" fill="${hillColor}" opacity="0.55"/>`,
    `<path d="${hill(0.77, 0.05)}" fill="${hillColor}" opacity="0.8"/>`,
    `<path d="${hill(0.87, 0.035)}" fill="${hillColor}"/>`,
    `<rect width="${width}" height="${height}" fill="url(#shade)"/>`,
    `<g font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="${fontSize}" font-weight="500" fill="#fff" fill-opacity="0.92">${text}</g>`,
    `<text x="${fontSize * 1.4}" y="${Math.round(fontSize * 2)}" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="${Math.round(fontSize * 0.55)}" font-weight="600" letter-spacing="2" fill="#fff" fill-opacity="0.6">DEMO · ${escapeXml(opts.modelId.toUpperCase().slice(0, 40))}</text>`,
    '</svg>',
  ].join('');
}

/** A short, soft chime (16-bit mono PCM WAV) so demo audio actually plays. */
export function chimeWav(seed: number, durationSec = 2.6, sampleRate = 16_000): Uint8Array {
  const rand = random(seed);
  const samples = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples * 2, 40);
  const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
  const notes = Array.from({ length: 5 }, (_, i) => ({ start: i * 0.38, freq: scale[Math.floor(rand() * scale.length)] as number }));
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    let v = 0;
    for (const note of notes) {
      const dt = t - note.start;
      if (dt < 0) continue;
      const env = Math.min(1, dt * 200) * Math.exp(-dt * 3.2);
      v += env * (Math.sin(2 * Math.PI * note.freq * dt) + 0.3 * Math.sin(4 * Math.PI * note.freq * dt));
    }
    const fade = Math.min(1, (durationSec - t) * 8);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 0.22 * fade * 32767))), 44 + i * 2);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

let demoVideoBytes: Uint8Array | null = null;

/**
 * Bytes for a mock output URL (rendered locally; nothing is fetched). Null for URLs that are not mock outputs.
 */
export function renderMockMedia(url: string): { data: Uint8Array; mimeType: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== MOCK_MEDIA_HOST) return null;
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (segments[0] !== 'g' || segments.length !== 3) return null;
  const requestId = segments[1] as string;
  const m = /^(\d{1,3})\.(svg|webm|wav)$/.exec(segments[2] as string);
  if (!m) return null;
  const index = Number(m[1]);
  const g = generations.get(requestId);
  if (m[2] === 'webm') {
    demoVideoBytes ??= new Uint8Array(Buffer.from(demoVideo.base64, 'base64'));
    return { data: demoVideoBytes, mimeType: 'video/webm' };
  }
  if (m[2] === 'wav') return { data: chimeWav(hash(`${requestId}:${index}`)), mimeType: 'audio/wav' };
  const svg = placeholderSvg({
    prompt: g?.prompt ?? '',
    modelId: g?.modelId && g.modelId !== 'unknown' ? g.modelId : 'gmi',
    seed: hash(`${requestId}:${index}`),
    aspect: aspectFrom(g?.parameters ?? {}),
  });
  return { data: new TextEncoder().encode(svg), mimeType: 'image/svg+xml' };
}

// ------------------------------------------------------------------------------------------------ demo gallery

interface SeedSpec {
  key: string;
  modelId: string;
  modality: MediaModality;
  prompt: string;
  parameters: Obj;
  status: MediaJobStatus;
  ageMs: number;
  /** For running jobs: how long until they finish. */
  remainingMs?: number;
  outputs?: number;
  listUsd: number;
  discount?: number | null;
  error?: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

const SEEDS: SeedSpec[] = [
  {
    key: 'demo0001',
    modelId: 'wan3.0-video',
    modality: 'video',
    prompt: 'Drone shot gliding over a misty pine forest at sunrise, volumetric light through the canopy',
    parameters: { resolution: '720P', duration: 8 },
    status: 'processing',
    ageMs: 40_000,
    remainingMs: 80_000,
    listUsd: 0.8,
  },
  {
    key: 'demo0002',
    modelId: 'seedream-5.0-pro',
    modality: 'image',
    prompt: 'A lighthouse on a basalt cliff at dusk, crashing waves, cinematic, 35mm film',
    parameters: { size: '2K', sequential_image_generation: 'auto', max_images: 2 },
    status: 'success',
    ageMs: 9 * MIN,
    outputs: 2,
    listUsd: 0.085,
    discount: 0.2,
  },
  {
    key: 'demo0003',
    modelId: 'minimax-tts-speech-2.8-hd',
    modality: 'audio',
    prompt: 'Welcome to GMI Desk. Your images, videos and voices, all in one place.',
    parameters: { text: 'Welcome to GMI Desk. Your images, videos and voices, all in one place.', voice_id: 'English_CalmWoman' },
    status: 'success',
    ageMs: 42 * MIN,
    listUsd: 0.0069,
  },
  {
    key: 'demo0004',
    modelId: 'kling-3.0-turbo-t2v',
    modality: 'video',
    prompt: 'A red fox trotting through fresh snow at golden hour, slow motion, shallow depth of field',
    parameters: { duration: '5' },
    status: 'success',
    ageMs: 2 * HOUR,
    listUsd: 0.56,
  },
  {
    key: 'demo0005',
    modelId: 'gpt-image-2.5-flare-generate',
    modality: 'image',
    prompt: 'Isometric cozy reading nook with plants and warm morning light, soft shadows',
    parameters: { quality: 'high' },
    status: 'success',
    ageMs: 5 * HOUR,
    listUsd: 0.01325,
  },
  {
    key: 'demo0006',
    modelId: 'hy-image-v3.5-preview',
    modality: 'image',
    prompt: 'Retro travel poster of Kyoto in autumn, bold flat colours',
    parameters: { size: '1080x1920' },
    status: 'failed',
    ageMs: 26 * HOUR,
    listUsd: 0.024,
    error: 'Backend error (403). Please try again.',
  },
  {
    key: 'demo0007',
    modelId: 'minimax-music-3.0',
    modality: 'audio',
    prompt: 'Indie folk, melancholic, perfect for a rainy night',
    parameters: { lyrics: '[Verse]\nStreetlights flicker on the wet road\nI keep your letters in my coat' },
    status: 'success',
    ageMs: 2 * 24 * HOUR,
    listUsd: 0.15,
  },
  {
    key: 'demo0008',
    modelId: 'hy-image-v3.5-preview',
    modality: 'image',
    prompt: 'Macro photo of dew on a spider web at dawn, soft bokeh',
    parameters: { size: '1536x1152' },
    status: 'success',
    ageMs: 3 * 24 * HOUR + 3 * HOUR,
    listUsd: 0.024,
  },
];

/**
 * Registers a small demo gallery with the mock server and returns it as local jobs (newest first): images, a
 * finished and a still-running video, speech, music and one failure. Outputs are mock URLs the media service
 * materialises locally.
 */
export function seedMockGenerations(nowMs: number): MediaJob[] {
  return SEEDS.map((spec) => {
    const outputs = spec.outputs ?? 1;
    const requestId = `mock-${spec.modality}-${outputs}-${spec.key}`;
    const submittedAt = nowMs - spec.ageMs;
    const running = spec.status !== 'success' && spec.status !== 'failed' && spec.status !== 'cancelled';
    const g: MockGeneration = {
      requestId,
      modelId: spec.modelId,
      modality: spec.modality,
      prompt: spec.prompt,
      parameters: spec.parameters,
      submittedAt,
      readyAt: running ? nowMs + (spec.remainingMs ?? 60_000) : submittedAt + RUN_MS[spec.modality],
      outcome: spec.status === 'failed' ? 'failed' : 'success',
      failureReason: spec.error ?? null,
      outputCount: outputs,
      key: null,
    };
    generations.set(requestId, g);
    const kind = outputKind(spec.modality);
    const discount = spec.discount ?? null;
    const charged = Math.round(spec.listUsd * (1 - (discount ?? 0)) * 1e9) / 1e9;
    const createdAt = new Date(submittedAt).toISOString();
    return {
      id: requestId,
      modelId: spec.modelId,
      modality: spec.modality,
      status: spec.status,
      prompt: spec.prompt,
      parameters: spec.parameters,
      estimateUsd: charged,
      listUsd: spec.listUsd,
      discount,
      createdAt,
      updatedAt: running ? new Date(nowMs).toISOString() : new Date(g.readyAt).toISOString(),
      outputs:
        spec.status === 'success'
          ? Array.from({ length: outputs }, (_, i) => ({
              url: mockOutputUrl(requestId, i, kind.ext),
              kind: kind.type,
              mimeType: kind.mime,
              localPath: null,
              localUrl: null,
            }))
          : [],
      error: spec.error ?? null,
      fromThisDevice: true,
      finishedAt: running ? null : new Date(g.readyAt).toISOString(),
    } satisfies MediaJob;
  });
}
