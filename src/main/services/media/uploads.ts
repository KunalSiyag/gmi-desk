/**
 * Input media uploads: native file picker → GMI upload_media slot → PUT the bytes to the slot's signed URL.
 * The resulting public URL is what a model parameter takes. Slots expire after ~15 minutes, so the PUT happens
 * immediately after the slot is issued. Image uploads also keep a local copy for thumbnails.
 */
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import { MAX_UPLOAD_BYTES, MEDIA_UPLOAD_TYPES, type UploadResult } from '@shared/contracts/media';
import { formatBytes } from '@shared/lib/format';
import type { AppContext } from '../../core/context';
import { safeFileName, toMediaUrl } from '../../core/media-paths';
import type { McpGateway } from '../../core/services';
import { atomicWriteFile } from '../../core/store';
import { mimeForExtension } from './outputs';
import { parseUploadSlot } from './parse';

export type UploadKind = keyof typeof MEDIA_UPLOAD_TYPES;

const FILTER_NAMES: Record<UploadKind, string> = { image: 'Images', video: 'Videos', audio: 'Audio' };
const PICK_TITLES: Record<UploadKind, string> = {
  image: 'Choose an image to upload',
  video: 'Choose a video to upload',
  audio: 'Choose an audio file to upload',
};

/** Upload PUTs get two minutes (files are capped at 200 MB). */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * GMI signs its upload slots for its Google Cloud Storage bucket (docs: upload_url is
 * "https://storage.googleapis.com/.../<id>.png?X-Goog-Algorithm=..."). The user's file is only ever PUT there.
 */
export function isGmiUploadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && (host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com'));
  } catch {
    return false;
  }
}

export interface UploadDeps {
  ctx: AppContext;
  mcp: McpGateway;
  /** Throws (not_signed_in / reauth_required) when there is no GMI session. */
  requireSignedIn(): void;
  /** True for slot URLs that must not be contacted (mock mode). */
  skipPut?(uploadUrl: string): boolean;
  /** Aborts the PUT (the app is closing). */
  signal?: AbortSignal;
}

export function isUploadKind(value: unknown): value is UploadKind {
  return value === 'image' || value === 'video' || value === 'audio';
}

export function uploadFilters(kind: UploadKind): Array<{ name: string; extensions: string[] }> {
  return [{ name: FILTER_NAMES[kind], extensions: [...MEDIA_UPLOAD_TYPES[kind]] }];
}

/** Opens the native picker, then uploads. Null when the picker is cancelled. */
export async function pickAndUpload(deps: UploadDeps, kind: unknown): Promise<UploadResult | null> {
  if (!isUploadKind(kind)) throw new GmiError('invalid_input', 'Unknown upload kind.');
  deps.requireSignedIn();
  const path = await deps.ctx.platform.pickFile({ title: PICK_TITLES[kind], filters: uploadFilters(kind) });
  if (!path) return null;
  return uploadFile(deps, kind, path);
}

/** Uploads one local file to a fresh GMI upload slot. */
export async function uploadFile(deps: UploadDeps, kind: UploadKind, path: string): Promise<UploadResult> {
  const allowed: readonly string[] = MEDIA_UPLOAD_TYPES[kind];
  const ext = extname(path).slice(1).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new GmiError('invalid_input', `GMI accepts ${allowed.join(', ')} files for this input.`);
  }
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new GmiError('not_found', 'That file could not be read.');
  if (info.size === 0) throw new GmiError('invalid_input', 'That file is empty.');
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new GmiError('invalid_input', `That file is ${formatBytes(info.size)}; uploads are limited to ${formatBytes(MAX_UPLOAD_BYTES)}.`);
  }
  deps.requireSignedIn();

  const slot = parseUploadSlot(await deps.mcp.callTool('upload_media', { file_type: ext }, { timeoutMs: 30_000 }));
  if (!slot) throw new GmiError('upstream', 'GMI did not return a usable upload slot.');
  const put = !deps.skipPut?.(slot.uploadUrl);
  if (put && !isGmiUploadUrl(slot.uploadUrl)) {
    throw new GmiError('upstream', "GMI returned an upload address outside its storage, so your file was not sent.", {
      detail: new URL(slot.uploadUrl).hostname,
    });
  }
  const contentType = slot.contentType ?? mimeForExtension(ext) ?? 'application/octet-stream';
  const body = await readFile(path);

  if (put) {
    // Signed URL: no bearer token, and Content-Type must match what the slot was signed for. A redirect is an error
    // (a signed PUT never redirects), so the file cannot be forwarded to another host.
    await deps.ctx.http.request(slot.uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      headers: { 'Content-Type': contentType, Accept: '*/*' },
      timeoutMs: UPLOAD_TIMEOUT_MS,
      signal: deps.signal,
      redirect: 'error',
    });
  }

  let previewUrl: string | null = null;
  if (kind === 'image') {
    try {
      const name = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}-${safeFileName(basename(path), `upload.${ext}`)}`;
      const dest = join(deps.ctx.paths.media, 'uploads', name);
      await atomicWriteFile(dest, body);
      previewUrl = toMediaUrl(deps.ctx.paths.media, dest);
    } catch (error) {
      deps.ctx.log.warn('could not keep a local copy of an upload', error);
    }
  }

  return { publicUrl: slot.publicUrl, fileName: basename(path), contentType, bytes: info.size, previewUrl };
}
