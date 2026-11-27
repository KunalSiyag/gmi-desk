/**
 * Media outputs: finding every output URL in a GMI result (whatever its shape), deciding each one's kind, and
 * downloading copies into the app's media folder safely (public https hosts only, redirects re-checked hop by hop,
 * size-capped, streamed through a temp file that never outlives a failure, path-checked).
 */
import { createHash } from 'node:crypto';
import { createWriteStream, type Dirent, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import { isPublicHttpsUrl, type MediaModality, type MediaOutput } from '@shared/contracts/media';
import { formatBytes } from '@shared/lib/format';
import type { Http } from '../../core/http';
import { isInsideDir, safeFileName } from '../../core/media-paths';

export type OutputKind = MediaOutput['kind'];

export interface ExtractedOutput {
  url: string;
  kind: OutputKind;
  mimeType: string | null;
}

/** 1 GB: the largest output the app downloads. */
export const MAX_OUTPUT_BYTES = 1024 ** 3;

const EXT_KIND: Record<string, OutputKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  avif: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  aac: 'audio',
  opus: 'audio',
};

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  json: 'application/json',
  txt: 'text/plain',
};

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/json': 'json',
  'text/plain': 'txt',
};

/** Lower-case extension of a URL's last path segment ("png"), or null. */
export function urlExtension(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    const m = /\.([a-z0-9]{1,5})$/i.exec(last);
    return m ? (m[1] as string).toLowerCase() : null;
  } catch {
    return null;
  }
}

export function mimeForExtension(ext: string | null | undefined): string | null {
  return ext ? (EXT_MIME[ext.toLowerCase()] ?? null) : null;
}

function baseMime(mime: string | null | undefined): string | null {
  const m = mime?.split(';')[0]?.trim().toLowerCase();
  return m || null;
}

export function kindFromMime(mime: string | null | undefined): OutputKind | null {
  const m = baseMime(mime);
  if (!m) return null;
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

/** "image" | "video" | "audio" | "image/png" | "mp3" → kind. */
export function kindFromTypeWord(type: string | null | undefined): OutputKind | null {
  const t = type?.trim().toLowerCase();
  if (!t) return null;
  if (t.includes('/')) return kindFromMime(t);
  if (/image|img|picture|photo|poster/.test(t)) return 'image';
  if (/video|movie|clip/.test(t)) return 'video';
  if (/audio|sound|music|speech|voice|song/.test(t)) return 'audio';
  return EXT_KIND[t] ?? null;
}

function kindFromModality(modality: MediaModality | null | undefined): OutputKind | null {
  return modality === 'image' || modality === 'video' || modality === 'audio' ? modality : null;
}

// Keys whose values are request inputs, previews or upload slots — never outputs.
const SKIP_KEYS = new Set([
  'payload',
  'parameters',
  'params',
  'input',
  'inputs',
  'request',
  'arguments',
  'args',
  'poster',
  'poster_url',
  'thumbnail',
  'thumbnail_url',
  'thumbnail_image_url',
  'cover',
  'cover_url',
  'preview',
  'preview_url',
  'upload_url',
  'note',
  'description',
  'failure_reason',
  'error',
]);

// Keys that hold outputs (searched first, in this order).
const OUTPUT_CONTAINERS = ['media', 'outputs', 'output', 'outcome', 'result', 'results', 'medias', 'media_urls', 'urls', 'images', 'videos', 'audios', 'files', 'data'];

const URL_FIELDS = ['url', 'uri', 'href', 'src', 'download_url', 'file_url', 'signed_url'];
const URLISH_KEY = /(^|_)(url|urls|uri|link|href|src)$|_url$/i;
const URL_IN_TEXT = /https:\/\/[^\s"'<>()[\]{}`]+/g;

/**
 * Every distinct https output URL in a generation result, in order. Tolerates GMI's MCP shape (`media: [...]`),
 * the request-queue shape (`outcome.media_urls`, `outcome.video_url`, `outcome.medias`), plain URL arrays and text.
 * Request inputs echoed back (`payload`, `parameters`) and posters/thumbnails are ignored, and so are URLs on
 * IP literals, localhost or private-network names (never where GMI or its providers publish media).
 */
export function extractOutputs(raw: unknown, fallbackModality: MediaModality | null = null): ExtractedOutput[] {
  const found = new Map<string, ExtractedOutput>();

  const add = (url: string, hints: { type?: string | null; mime?: string | null }) => {
    if (!isPublicHttpsUrl(url)) return;
    const ext = urlExtension(url);
    const mime = baseMime(hints.mime) ?? mimeForExtension(ext);
    const fromExt: OutputKind | null = ext ? (EXT_KIND[ext] ?? null) : null;
    const kind: OutputKind = kindFromTypeWord(hints.type) ?? kindFromMime(hints.mime) ?? fromExt ?? kindFromModality(fallbackModality) ?? 'file';
    const existing = found.get(url);
    if (existing) {
      if (!existing.mimeType && mime) existing.mimeType = mime;
      if (existing.kind === 'file' && kind !== 'file') existing.kind = kind;
      return;
    }
    found.set(url, { url, kind, mimeType: mime });
  };

  const visit = (node: unknown, depth: number, hint: string | null, acceptStrings: boolean) => {
    if (depth > 7 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (acceptStrings) add(node.trim(), { type: hint });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 200)) visit(item, depth + 1, hint, true);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const ownType = [o.type, o.kind, o.media_type, o.mediaType].find((v): v is string => typeof v === 'string') ?? null;
    const ownMime = [o.mime_type, o.mimeType, o.content_type, o.contentType].find((v): v is string => typeof v === 'string') ?? null;
    const format = typeof o.format === 'string' ? o.format : null;
    for (const field of URL_FIELDS) {
      const v = o[field];
      if (typeof v === 'string') add(v.trim(), { type: ownType ?? (format && !ownMime ? format : null) ?? hint, mime: ownMime ?? mimeForExtension(format) });
    }
    for (const [key, value] of Object.entries(o)) {
      const k = key.toLowerCase();
      if (SKIP_KEYS.has(k) || URL_FIELDS.includes(k)) continue;
      const keyHint = kindFromTypeWord(k.replace(/_?urls?$/, '')) ? k : null;
      visit(value, depth + 1, keyHint ?? hint, URLISH_KEY.test(k) || OUTPUT_CONTAINERS.includes(k));
    }
  };

  if (typeof raw === 'string') {
    for (const m of raw.matchAll(URL_IN_TEXT)) add(m[0].replace(/[.,;:]+$/, ''), {});
    return [...found.values()];
  }
  if (Array.isArray(raw)) {
    visit(raw, 0, null, true);
    return [...found.values()];
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of OUTPUT_CONTAINERS) {
      if (key in o) visit(o[key], 1, kindFromTypeWord(key.replace(/s$/, '')) ? key : null, true);
    }
    if (found.size === 0) visit(o, 0, null, false);
  }
  return [...found.values()];
}

/** The same output after GMI re-signed its URL (Luma mints a new presigned URL on every poll). */
export function sameOutputUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

/** Extension for a downloaded file: from the URL when known, else from the MIME type, else the kind. */
export function outputExtension(output: { url: string; mimeType: string | null; kind: OutputKind }): string {
  const fromUrl = urlExtension(output.url);
  if (fromUrl && (EXT_KIND[fromUrl] || EXT_MIME[fromUrl])) return fromUrl;
  const fromMime = MIME_EXT[baseMime(output.mimeType) ?? ''];
  if (fromMime) return fromMime;
  return output.kind === 'image' ? 'png' : output.kind === 'video' ? 'mp4' : output.kind === 'audio' ? 'mp3' : 'bin';
}

/** `<mediaDir>/<safe job id>/<index>.<ext>`; throws when the result would escape the media dir. */
export function outputFilePath(mediaDir: string, jobId: string, index: number, output: { url: string; mimeType: string | null; kind: OutputKind }): string {
  if (!Number.isInteger(index) || index < 0 || index > 999) throw new GmiError('invalid_input', 'Invalid output index.');
  const ext = safeFileName(outputExtension(output), 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
  const file = join(mediaDir, jobFolderName(jobId), `${index}.${ext}`);
  if (!isInsideDir(mediaDir, file) || file === mediaDir) throw new GmiError('invalid_input', 'Refusing to write outside the media folder.');
  return file;
}

let partCounter = 0;

/** Folder name for a job's outputs. Ids that need sanitising get a hash suffix so two ids never share a folder. */
export function jobFolderName(jobId: string): string {
  const safe = safeFileName(jobId, 'job');
  if (safe === jobId) return safe;
  return `${safe.slice(0, 100)}-${createHash('sha256').update(jobId).digest('hex').slice(0, 10)}`;
}

export interface DownloadResult {
  bytes: number;
  contentType: string | null;
}

/** Redirects followed per download; every hop is checked before it is requested. */
export const MAX_DOWNLOAD_REDIRECTS = 5;

const NOT_PUBLIC = 'GMI Desk only downloads outputs from public https hosts.';

async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * GETs `url` and follows up to MAX_DOWNLOAD_REDIRECTS redirects by hand (the http layer returns 3xx untouched with
 * `redirect: 'manual'`), so a hop to http, localhost, an IP literal or a private name is refused before it is sent.
 */
async function getFollowingRedirects(http: Http, url: string, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const res = await http.request(current, { headers: { Accept: '*/*' }, timeoutMs: opts.timeoutMs, signal: opts.signal, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    await discardBody(res);
    const location = res.headers.get('location');
    if (!location) throw new GmiError('upstream', `The download answered HTTP ${res.status} without a new address.`);
    if (hop >= MAX_DOWNLOAD_REDIRECTS) throw new GmiError('upstream', 'The download was redirected too many times.');
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new GmiError('invalid_input', 'The download was redirected to an invalid address.');
    }
    if (!isPublicHttpsUrl(next)) throw new GmiError('invalid_input', `The download was redirected elsewhere. ${NOT_PUBLIC}`);
    current = next;
  }
}

/**
 * Deletes a partial download once its file handle is closed: Windows cannot delete an open file, and a handle
 * still closing would otherwise leave the `.part-` file behind.
 */
async function removePartial(out: WriteStream, tmp: string): Promise<void> {
  if (!out.closed) {
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 2000);
      (fallback as { unref?: () => void }).unref?.();
      out.once('close', () => {
        clearTimeout(fallback);
        resolve();
      });
      out.destroy();
    });
  }
  await rm(tmp, { force: true }).catch(() => undefined);
}

/**
 * Streams a public https URL to `dest` (via a temp file) with a size cap. Never sends credentials. A failure or an
 * abort (`signal`) removes the temp file; `sweepStaleTempFiles` removes the ones a crash or a kill left behind.
 * Throws GmiError (invalid_input for refused addresses / too large, cancelled, plus the http layer's codes).
 */
export async function downloadToFile(
  http: Http,
  url: string,
  dest: string,
  opts: { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  if (!isPublicHttpsUrl(url)) throw new GmiError('invalid_input', NOT_PUBLIC);
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  const res = await getFollowingRedirects(http, url, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 15 * 60_000 });
  if (res.url && !isPublicHttpsUrl(res.url)) {
    await discardBody(res);
    throw new GmiError('invalid_input', `The download was redirected elsewhere. ${NOT_PUBLIC}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(res);
    throw new GmiError('invalid_input', `The file is larger than ${formatBytes(maxBytes)}.`);
  }
  if (!res.body) throw new GmiError('upstream', 'GMI returned an empty file.');
  if (opts.signal?.aborted) {
    await discardBody(res);
    throw new GmiError('cancelled', 'The download was cancelled.');
  }

  await mkdir(dirname(dest), { recursive: true });
  partCounter += 1;
  const tmp = `${dest}.part-${process.pid}-${partCounter}`;
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new GmiError('invalid_input', `The file is larger than ${formatBytes(maxBytes)}.`));
      else callback(null, chunk);
    },
  });
  const out = createWriteStream(tmp);
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), limiter, out, { signal: opts.signal });
    await rename(tmp, dest);
  } catch (error) {
    await removePartial(out, tmp);
    if (opts.signal?.aborted) throw new GmiError('cancelled', 'The download was cancelled.', { cause: error });
    if (error instanceof Error && error.name === 'TimeoutError') throw new GmiError('timeout', 'The download took too long.', { cause: error });
    throw toGmiError(error);
  }
  return { bytes, contentType: baseMime(res.headers.get('content-type')) };
}

/** Temp files older than this are leftovers of a crash, a kill or a forced quit (live ones are being written to). */
export const STALE_TEMP_MS = 10 * 60_000;

/** `<file>.part-<pid>-<n>` (downloads) and `<file>.tmp-<pid>-<n>` (atomic writes of mock renders and upload copies). */
const TEMP_FILE = /\.(?:part|tmp)-\d+-\d+$/;

/**
 * Deletes temp files left in the media folder and its job folders by a crash, a kill or a quit that did not wait.
 * Only files older than `olderThanMs` go: a younger one may be a download in progress (in this app or another
 * instance). Never follows symlinks, never throws; returns how many files were removed.
 */
export async function sweepStaleTempFiles(mediaDir: string, opts: { olderThanMs?: number; now?: number } = {}): Promise<number> {
  const cutoff = (opts.now ?? Date.now()) - (opts.olderThanMs ?? STALE_TEMP_MS);
  let removed = 0;
  const sweep = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) await sweep(path, 1);
        continue;
      }
      if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
      try {
        if ((await stat(path)).mtimeMs > cutoff) continue;
        await rm(path, { force: true });
        removed += 1;
      } catch {
        // Gone already, or locked: the next start tries again.
      }
    }
  };
  await sweep(mediaDir, 0);
  return removed;
}
