import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@shared/contracts/catalog';
import type { MediaEstimate, MediaJob, MediaJobList } from '@shared/contracts/media';
import { normalizeParameters } from '@shared/lib/parameters';
import {
  buildRequest,
  catalogUnpricedReason,
  estimateSummary,
  formatCents,
  formIssues,
  initialValues,
  isGeneratable,
  layoutFields,
  modelsForTab,
  outputSrc,
  promptPlaceholder,
  requestFromJob,
  requestKey,
  sameValues,
  shortAge,
  shortModelId,
  statusView,
  unitPrice,
  upsertJob,
} from '../../src/renderer/pages/create/form';
import { catalogModel, FIXTURE_MODELS } from './fakes';
import { liveParameters } from './live-models';

const layoutOf = (id: string) => layoutFields(normalizeParameters(FIXTURE_MODELS[id]?.parameters));
const names = (list: Array<{ name: string }>) => list.map((p) => p.name);

const job = (id: string, createdAt: string, extra: Partial<MediaJob> = {}): MediaJob => ({
  id,
  modelId: 'seedream-5.0-pro',
  modality: 'image',
  status: 'success',
  prompt: 'a lighthouse',
  parameters: { size: '2K' },
  estimateUsd: 0.068,
  createdAt,
  updatedAt: createdAt,
  outputs: [],
  error: null,
  fromThisDevice: true,
  ...extra,
});

describe('form layout from recorded GMI schemas', () => {
  it('puts the negative prompt under the prompt, two uploads and four settings up front, the rest under Advanced (wan3.0-video)', () => {
    const l = layoutOf('wan3.0-video');
    expect(l.schema.promptName).toBe('prompt');
    expect(l.negative?.name).toBe('negative_prompt');
    expect(names(l.primary)).toEqual(['first_frame', 'last_frame', 'resolution', 'ratio', 'duration', 'prompt_extend']);
    // Wide fields (uploads) first; seed and watermark always advanced.
    expect(names(l.advanced)).toEqual(['reference_image', 'reference_video', 'audio_url', 'watermark', 'seed']);
  });

  it('keeps required inputs up front whatever their position (happyhorse-1.1-i2v)', () => {
    const l = layoutOf('happyhorse-1.1-i2v');
    expect(l.primary[0]).toMatchObject({ name: 'first_frame', required: true });
    expect(names(l.advanced)).toEqual(expect.arrayContaining(['seed', 'watermark']));
    expect(names(l.primary)).not.toContain('negative_prompt');
  });

  it('uses the text field as the main input for text-to-speech, and keeps lyrics as a required field for music', () => {
    const tts = layoutOf('minimax-tts-speech-2.8-hd');
    expect(tts.schema.promptName).toBe('text');
    expect(names([...tts.primary, ...tts.advanced])).not.toContain('text');
    expect(names(tts.primary)).toEqual(['voice_id', 'speed', 'vol', 'pitch']);
    const music = layoutOf('minimax-music-3.0');
    expect(music.schema.promptName).toBe('prompt');
    expect(music.primary[0]).toMatchObject({ name: 'lyrics', required: true });
  });

  it('copes with workflows that publish no schema', () => {
    const l = layoutFields(null);
    expect(l.primary).toEqual([]);
    expect(l.advanced).toEqual([]);
    expect(l.negative).toBeNull();
    expect(l.schema.promptName).toBe('prompt');
  });
});

describe('form values', () => {
  it('starts from schema defaults and overlays a preset, dropping names the model does not have', () => {
    const { schema } = layoutOf('seedream-5.0-pro');
    expect(initialValues(schema)).toEqual({
      size: '2048x2048',
      sequential_image_generation: 'disabled',
      max_images: 1,
      output_format: 'jpeg',
      watermark: false,
    });
    const preset = initialValues(schema, { size: '2K', bogus: 1, prompt: 'x', max_images: 3 });
    expect(preset).toMatchObject({ size: '2K', max_images: 3 });
    expect(preset).not.toHaveProperty('bogus');
    expect(preset).not.toHaveProperty('prompt');
    // No schema at all: keep whatever the job used.
    expect(initialValues(layoutFields(null).schema, { strength: 0.4 })).toEqual({ strength: 0.4 });
  });

  it('flags a missing prompt, missing required inputs, ranges and enums, and reports missing values separately', () => {
    const { schema } = layoutOf('happyhorse-1.1-i2v');
    const empty = formIssues(schema, '  ', initialValues(schema));
    expect(empty.promptMissing).toBe(true);
    expect(empty.prompt).toBe('Prompt is required.');
    expect(empty.missing.has('first_frame')).toBe(true);
    expect(empty.count).toBe(2);

    const bad = formIssues(schema, 'a cat', { ...initialValues(schema), first_frame: 'http://insecure.example/a.png', duration: '99', resolution: '4K' });
    expect(bad.prompt).toBeNull();
    expect(bad.fields.first_frame).toMatch(/https/);
    expect(bad.fields.duration).toMatch(/between 3 and 15/);
    expect(bad.fields.resolution).toMatch(/one of/);
    expect(bad.missing.size).toBe(0);

    const ok = formIssues(schema, 'a cat', { ...initialValues(schema), first_frame: 'https://cdn.example/cat.png' });
    expect(ok.count).toBe(0);
  });

  it('checks the main text of prompt-less models only once, and enforces its length', () => {
    const { schema } = layoutOf('minimax-tts-speech-2.8-hd');
    const issues = formIssues(schema, '', initialValues(schema));
    expect(issues.prompt).toBe('Text is required.');
    expect(issues.fields).not.toHaveProperty('text');
    const wan = layoutOf('wan3.0-video').schema;
    expect(formIssues(wan, 'x'.repeat(5001), {}).prompt).toMatch(/too long \(5001 of 5000/);
  });

  it('builds the request GMI expects: typed values, no empties, prompt kept out of parameters', () => {
    const { schema } = layoutOf('wan3.0-video');
    const req = buildRequest('wan3.0-video', schema, '  a drone shot  ', {
      ...initialValues(schema),
      duration: '8',
      negative_prompt: '',
      first_frame: ' https://cdn.example/f.png ',
      reference_image: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      prompt: 'ignored',
    });
    expect(req.prompt).toBe('a drone shot');
    expect(req.parameters).toMatchObject({ duration: 8, first_frame: 'https://cdn.example/f.png', reference_image: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] });
    expect(req.parameters).not.toHaveProperty('negative_prompt');
    expect(req.parameters).not.toHaveProperty('prompt');

    const tts = layoutOf('minimax-tts-speech-2.8-hd').schema;
    const speech = buildRequest('minimax-tts-speech-2.8-hd', tts, 'Hello there', { ...initialValues(tts), speed: '1.5', text: 'stale' });
    expect(speech.prompt).toBe('Hello there');
    expect(speech.parameters).not.toHaveProperty('text');
    expect(speech.parameters?.speed).toBe(1.5);
  });

  it('parses JSON lists and objects typed into the form', () => {
    const params = normalizeParameters([
      { name: 'prompt', type: 'string', required: true },
      { name: 'tags', type: 'array' },
      { name: 'extra', type: 'json' },
    ]);
    const { schema } = layoutFields(params);
    expect(formIssues(schema, 'x', { tags: 'not json' }).fields.tags).toMatch(/list/);
    expect(formIssues(schema, 'x', { extra: '{oops' }).fields.extra).toMatch(/JSON/);
    expect(buildRequest('m', schema, 'x', { tags: '["a","b"]', extra: '{"k":1}' }).parameters).toEqual({ tags: ['a', 'b'], extra: { k: 1 } });
  });

  it("opens seedream-5.0-lite with GMI's default size valid, priceable and kept in the request", () => {
    // Live schema: size defaults to "2048x2048", which its enum (2K, 3K, fixed sizes) leaves out.
    const { schema } = layoutFields(liveParameters('seedream-5.0-lite'));
    const values = initialValues(schema);
    expect(values.size).toBe('2048x2048');
    const issues = formIssues(schema, 'A lighthouse at dusk', values);
    expect(issues.fields).toEqual({});
    expect(issues.count).toBe(0);
    expect(buildRequest('seedream-5.0-lite', schema, 'A lighthouse at dusk', values).parameters).toMatchObject({ size: '2048x2048' });
    // The select offers it (first), and the other published sizes stay valid.
    expect(schema.fields.find((p) => p.name === 'size')?.enum?.slice(0, 3)).toEqual(['2048x2048', '2K', '3K']);
    expect(formIssues(schema, 'x', { ...values, size: '3K' }).count).toBe(0);
    expect(formIssues(schema, 'x', { ...values, size: '640x480' }).fields.size).toMatch(/must be one of/);
  });

  it('gives equal requests equal keys regardless of key order', () => {
    const a = requestKey({ modelId: 'm', prompt: 'p', parameters: { b: 1, a: { y: 2, x: 1 } } });
    const b = requestKey({ parameters: { a: { x: 1, y: 2 }, b: 1 }, prompt: 'p', modelId: 'm' });
    expect(a).toBe(b);
    expect(sameValues({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameValues({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('models and prices', () => {
  const models: CatalogModel[] = [
    catalogModel({ id: 'z-old', name: 'Zeta', kind: 'image', provider: 'Acme' }),
    catalogModel({ id: 'a-new', name: 'Alpha', kind: 'image', isNew: true }),
    catalogModel({ id: 'f', name: 'Featured', kind: 'image', featured: true }),
    catalogModel({ id: 'gone', name: 'Gone', kind: 'image', available: false }),
    catalogModel({ id: 'v', name: 'Video', kind: 'video' }),
    catalogModel({ id: 'llm', name: 'Chat', kind: 'llm' }),
  ];

  it('lists available models per tab: New first, then featured, then by name; search matches name, id and provider', () => {
    expect(modelsForTab(models, 'image').map((m) => m.id)).toEqual(['a-new', 'f', 'z-old']);
    expect(modelsForTab(models, 'image', 'acme').map((m) => m.id)).toEqual(['z-old']);
    expect(modelsForTab(models, 'video').map((m) => m.id)).toEqual(['v']);
  });

  it('shows the charged unit price with the list price when discounted', () => {
    const pricing = { usdPerUnit: 0.085, unit: 'image', pricingType: null, details: null };
    expect(unitPrice({ mediaPricing: pricing, discount: 0.2 })).toEqual({ charged: '$0.068', list: '$0.085', unit: 'image' });
    expect(unitPrice({ mediaPricing: pricing, discount: null })).toEqual({ charged: '$0.085', list: null, unit: 'image' });
    expect(unitPrice({ mediaPricing: null, discount: 0.5 })).toBeNull();
  });

  // Live: Gemini-batch-inference is model_type "image" with a text output, price 0 per request, billed by tokens.
  const batch = catalogModel({
    id: 'Gemini-batch-inference',
    name: 'Gemini-batch-inference',
    kind: 'image',
    outputs: [{ type: 'text', required: true }],
    mediaPricing: { usdPerUnit: 0, unit: 'request', pricingType: 'per-request', details: 'Actual cost depends on input/output tokens.' },
  });

  it('keeps text-only models (Gemini batch inference) off the media tabs and out of deep links', () => {
    const image = catalogModel({ id: 'img', name: 'Img', kind: 'image', outputs: [{ type: 'image', required: true }] });
    const unknownOutputs = catalogModel({ id: 'unk', name: 'Unk', kind: 'image', outputs: [] });
    const faceId = catalogModel({ id: 'kling-identify-face', name: 'Face', kind: 'video', outputs: [{ type: 'text', required: true }] });
    expect(modelsForTab([batch, image, unknownOutputs], 'image').map((m) => m.id)).toEqual(['img', 'unk']);
    expect(modelsForTab([faceId], 'video')).toEqual([]);
    expect(isGeneratable(batch)).toBe(false);
    expect(isGeneratable(image)).toBe(true);
    expect(isGeneratable(catalogModel({ id: 'chat', kind: 'llm' }))).toBe(false);
  });

  it('shows no unit price for models GMI cannot price in advance, and keeps it for ones whose notes mention tokens', () => {
    expect(unitPrice(batch)).toBeNull(); // not "$0.00 / request"
    expect(catalogUnpricedReason(batch)).toMatch(/can't price/);
    const internal = catalogModel({ id: 'ea', kind: 'video', outputs: [{ type: 'video', required: true }], mediaPricing: { usdPerUnit: 0, unit: 'video', pricingType: null, details: null } });
    expect(unitPrice(internal)).toBeNull();
    // gemini-nano-banana-2.1 (live notes): priced per image, the token rates are just the breakdown.
    const nano = catalogModel({
      id: 'gemini-nano-banana-2.1',
      kind: 'image',
      outputs: [{ type: 'image', required: true }],
      mediaPricing: {
        usdPerUnit: 0.041,
        unit: 'image',
        pricingType: 'per-image output ($30/1M tokens, resolution-based)',
        details: 'Input (text,image): $1.50 / 1M tokens\nText output (incl. thinking): $7.50 / 1M tokens\nImage output: $30 / 1M tokens\nPer image output: 1K=$0.0336, 2K=$0.0504, 4K=$0.113',
      },
    });
    expect(catalogUnpricedReason(nano)).toBeNull();
    expect(unitPrice(nano)).toEqual({ charged: '$0.041', list: null, unit: 'image' });
  });

  it('summarises an estimate as charged price plus list price and discount', () => {
    const base: MediaEstimate = {
      listUsd: 0.07,
      discount: 0.5,
      chargedUsd: 0.035,
      note: null,
      unit: 'image',
      budget: { allowed: true, needsConfirmation: true, reason: null, remainingTodayUsd: null, remainingMonthUsd: null },
    };
    expect(estimateSummary(base)).toEqual({ charged: '$0.035', detail: 'list $0.07 · 50% off' });
    expect(estimateSummary({ ...base, discount: null, chargedUsd: 0.07 })).toEqual({ charged: '$0.07', detail: null });
    expect(formatCents(0.789)).toBe('$0.79');
    expect(formatCents(0.001)).toBe('<$0.01');
  });
});

describe('gallery helpers', () => {
  it('rebuilds the exact request of a job (for a retake) and refuses history entries without one', () => {
    const mine = job('j1', '2026-10-31T10:00:00Z', { options: { aspectRatio: '16:9', seed: 7 } });
    expect(requestFromJob(mine)).toEqual({ modelId: 'seedream-5.0-pro', prompt: 'a lighthouse', parameters: { size: '2K' }, aspectRatio: '16:9', seed: 7 });
    expect(requestFromJob(job('h1', '2026-10-31T10:00:00Z', { prompt: null, fromThisDevice: false }))).toBeNull();
    expect(requestFromJob(job('u1', '2026-10-31T10:00:00Z', { modelId: 'unknown' }))).toBeNull();
  });

  it('applies job events to a gallery page: replace in place, or insert by date and count it', () => {
    const list: MediaJobList = { jobs: [job('b', '2026-10-31T12:00:00Z'), job('a', '2026-10-31T10:00:00Z')], total: 2 };
    const replaced = upsertJob(list, job('a', '2026-10-31T10:00:00Z', { status: 'failed' }));
    expect(replaced.jobs.map((j) => [j.id, j.status])).toEqual([
      ['b', 'success'],
      ['a', 'failed'],
    ]);
    expect(replaced.total).toBe(2);
    const inserted = upsertJob(list, job('c', '2026-10-31T11:00:00Z'));
    expect(inserted.jobs.map((j) => j.id)).toEqual(['b', 'c', 'a']);
    expect(inserted.total).toBe(3);
    expect(list.jobs).toHaveLength(2); // not mutated
  });

  it('labels statuses, including jobs the app stopped tracking', () => {
    expect(statusView({ status: 'queued' })).toEqual({ label: 'Queued', tone: 'progress', busy: true });
    expect(statusView({ status: 'dispatched' }).label).toBe('Queued');
    expect(statusView({ status: 'processing' })).toMatchObject({ label: 'Processing', busy: true });
    expect(statusView({ status: 'processing', pollingStopped: true })).toMatchObject({ label: 'Not tracked', busy: false });
    expect(statusView({ status: 'success' })).toMatchObject({ label: 'Done', tone: 'success' });
    expect(statusView({ status: 'failed' })).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(statusView({ status: 'cancelled' }).label).toBe('Cancelled');
    expect(statusView({ status: 'unknown' }).tone).toBe('muted');
  });

  it('prefers the local copy of an output and never displays non-https remote URLs', () => {
    const remote = { url: 'https://cdn.example/a.png', kind: 'image' as const, localPath: null, localUrl: null, mimeType: null };
    expect(outputSrc(remote)).toBe('https://cdn.example/a.png');
    expect(outputSrc({ ...remote, localPath: '/m/a.png', localUrl: 'gmi-media://local/j/0.png' })).toBe('gmi-media://local/j/0.png');
    expect(outputSrc({ ...remote, url: 'http://cdn.example/a.png' })).toBeNull();
    expect(outputSrc({ ...remote, url: 'file:///etc/passwd' })).toBeNull();
    // Nor intranet addresses (the main process refuses to download them too).
    expect(outputSrc({ ...remote, url: 'https://10.0.0.5/a.png' })).toBeNull();
    expect(outputSrc({ ...remote, url: 'https://intranet/a.png' })).toBeNull();
  });

  it('formats compact ages and model labels', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    expect(shortAge('2026-11-01T11:59:40Z', now)).toBe('now');
    expect(shortAge('2026-11-01T11:51:00Z', now)).toBe('9m');
    expect(shortAge('2026-11-01T09:00:00Z', now)).toBe('3h');
    expect(shortAge('2026-10-30T12:00:00Z', now)).toBe('2d');
    expect(shortAge('2026-10-01T12:00:00Z', now)).toBe('Oct 1');
    expect(shortModelId('zai-org/GLM-5.3')).toBe('GLM-5.3');
    expect(shortModelId('80ce8515-e387-4050-883c-7a34e127fba8')).toBe('Workflow 80ce8515');
  });
});

describe('main text placeholder', () => {
  const schemaOf = (params: Parameters<typeof layoutFields>[0]) => layoutFields(params).schema;

  it('asks an avatar model for the words to speak, not a shot description (heygen-avatar-4 input_text)', () => {
    const schema = schemaOf(liveParameters('heygen-avatar-4'));
    expect(schema.promptName).toBe('input_text');
    const placeholder = promptPlaceholder('video', schema, 'heygen-avatar-4');
    expect(placeholder).toMatch(/speak/);
    expect(placeholder).not.toMatch(/Describe the shot/);
  });

  it("shows GMI's description for main fields that are not prompts (kling-lip-sync session_id)", () => {
    const schema = schemaOf(liveParameters('kling-lip-sync'));
    expect(schema.promptName).toBe('session_id');
    const placeholder = promptPlaceholder('video', schema, 'kling-lip-sync');
    expect(placeholder).toMatch(/^Session ID returned by a prior kling-identify-face request/);
    expect(placeholder.length).toBeLessThanOrEqual(90);
    expect(placeholder).not.toMatch(/Describe the shot/);
  });

  it('keeps the image hint for image prompts, whatever the field is called (wan2.7-image text, gpt-image-2-generate prompt)', () => {
    const wan = schemaOf(liveParameters('wan2.7-image'));
    expect(wan.promptName).toBe('text');
    expect(promptPlaceholder('image', wan, 'wan2.7-image')).toBe('Describe the image: subject, setting, light, style…');
    const gpt = schemaOf(liveParameters('gpt-image-2-generate'));
    expect(promptPlaceholder('image', gpt, 'gpt-image-2-generate')).toBe('Describe the image: subject, setting, light, style…');
    // A prompt's description that merely contains "description" is not a script to read out.
    const described = schemaOf(normalizeParameters([{ name: 'caption_text', type: 'string', required: true, description: 'Text description of the scene to render.' }]));
    expect(promptPlaceholder('video', described, 'm')).toBe('Text description of the scene to render.');
  });

  it('keeps the audio hints: speech for text-to-speech, music for music models', () => {
    const tts = schemaOf(normalizeParameters(FIXTURE_MODELS['minimax-tts-speech-2.8-hd']?.parameters));
    expect(promptPlaceholder('audio', tts, 'minimax-tts-speech-2.8-hd')).toBe('Type the text to speak…');
    const music = schemaOf(normalizeParameters(FIXTURE_MODELS['minimax-music-3.0']?.parameters));
    expect(promptPlaceholder('audio', music, 'minimax-music-3.0')).toBe('Describe the music: genre, mood, instruments…');
    expect(promptPlaceholder('video', schemaOf(null), 'kling-3.0-turbo-t2v')).toBe('Describe the shot: subject, action, camera movement, style…');
    expect(promptPlaceholder('workflow', schemaOf(null), 'wf')).toBe('What should this workflow make?');
  });
});
