// The computer's file browser (compute.md §8.3, T8; C2-B): listing, preview, save, mkdir, rename, delete.
//
// - Paths are normalised here first (absolute, POSIX, no NUL, no `..`, at most 4,096 bytes) and then reach the
//   sandbox only through exec `envs` (`"$GMID_P"`), never interpolated into a command (T8). `/files` takes them as
//   a query parameter (URL-encoded by the data plane).
// - Listing: one exec of `find -printf` with NUL-separated records, capped at 5,000 entries (`truncated`). When
//   `-printf` is missing (busybox) a second exec runs a POSIX `stat -c` loop with the same record format.
// - Read: `GET /files`, at most 2 MiB; binary = a NUL in the first 8 KiB or invalid UTF-8.
// - Write: at most 1 MiB of text; a 200 with `[]` is an error (the data plane checks).
// - Every operation takes one exec slot. Listing is not activity (a renderer refresh must not keep a sandbox
//   alive, §9.5); read, write, mkdir, rename and delete are user file operations.
import { FILE_PREVIEW_MAX_BYTES, FILE_WRITE_MAX_BYTES, type DirEntry, type DirListing, type FileContent } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import { assertRemotePath, type DataPlaneApi } from '../sandbox/dataplane';
import { execFailure, stderrLine, type ComputerTarget, type ExecRunner } from './exec';

/** Entries returned by one listing at most (§8.3). */
export const LIST_MAX_ENTRIES = 5_000;
/** `execution_timeout_seconds` of file-browser execs. */
export const FILE_EXEC_TIMEOUT_SEC = 30;
/** Remote paths longer than this (UTF-8 bytes) are refused (AB §15.10). */
export const REMOTE_PATH_MAX_BYTES = 4096;
/** Binary detection looks for a NUL in this many leading bytes. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/** The environment variable every file command reads its path from. */
export const PATH_ENV = 'GMID_P';

/**
 * Primary listing: one NUL-terminated record per entry, `type \t size \t mtime \t mode \t name`. The name is last,
 * so tabs and newlines inside it survive.
 */
export const LIST_COMMAND = `find "$${PATH_ENV}" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\0'`;

/**
 * busybox fallback (no `-printf`): the same record format from a `stat -c` loop. Type from `test` (symlink first,
 * like `%y`), size / mtime / mode from `stat -c '%s %Y %a'`, name from the parameter expansion. Hidden entries come from the two
 * extra globs; unmatched globs are skipped by the existence test.
 */
export const LIST_FALLBACK_COMMAND = [
  `[ -d "$${PATH_ENV}" ] || { echo "$${PATH_ENV}: No such file or directory" >&2; exit 2; };`,
  `for f in "$${PATH_ENV}"/* "$${PATH_ENV}"/.[!.]* "$${PATH_ENV}"/..?*; do`,
  `if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; elif [ -e "$f" ]; then t=o; else continue; fi;`,
  `set -- $(stat -c '%s %Y %a' "$f" 2>/dev/null);`,
  `printf '%s\\t%s\\t%s\\t%s\\t%s\\0' "$t" "$1" "$2" "$3" "\${f##*/}";`,
  'done',
].join(' ');

/** stderr of a `find` that does not know `-printf` (busybox, toybox) or a missing `find`. */
const NO_PRINTF = /printf|unrecognized|unknown (?:predicate|option)|invalid (?:predicate|argument)|not found|applet/i;

// ─── Paths ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Client-side path rules (§8.3): absolute, POSIX-normalised (empty and `.` parts dropped, a trailing `/` removed),
 * no NUL, no `..` part (rejected, never resolved), at most 4,096 bytes. Throws GmiError('invalid_input').
 */
export function normalizeRemotePath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) throw new GmiError('invalid_input', 'A remote path is required.');
  if (input.includes('\0')) throw new GmiError('invalid_input', 'Remote paths cannot contain a NUL byte.');
  if (!input.startsWith('/')) throw new GmiError('invalid_input', 'Remote paths must be absolute (start with /).');
  const parts: string[] = [];
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new GmiError('invalid_input', 'Remote paths cannot contain "..".');
    parts.push(part);
  }
  const path = `/${parts.join('/')}`;
  if (Buffer.byteLength(path, 'utf8') > REMOTE_PATH_MAX_BYTES) throw new GmiError('invalid_input', 'The remote path is too long.');
  assertRemotePath(path);
  return path;
}

/** `dir` + one name (the name must be a single, non-special path part). */
export function joinRemote(dir: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new GmiError('invalid_input', 'Not a valid file name.');
  }
  return normalizeRemotePath(dir === '/' ? `/${name}` : `${dir}/${name}`);
}

export function remoteBasename(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

export function remoteParent(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

// ─── Listing parser ───────────────────────────────────────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, DirEntry['type']> = { d: 'dir', f: 'file', l: 'symlink' };

function toIso(seconds: string): string | null {
  const n = Number(seconds);
  if (!seconds || !Number.isFinite(n) || n < 0) return null;
  const d = new Date(Math.round(n * 1000));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parses NUL-terminated `type \t size \t mtime \t mode \t name` records (both listing commands). A record without
 * its terminating NUL is dropped when the output was cut (`outputTruncated`); `.`/`..`, empty names and names with
 * `/` are skipped. Directories first, then by name; at most `max` entries.
 */
export function parseListing(dir: string, stdout: string, opts: { outputTruncated?: boolean; max?: number } = {}): DirListing {
  const max = opts.max ?? LIST_MAX_ENTRIES;
  const records = stdout.split('\0');
  // The text after the last NUL is empty for complete output; when GMI cut stdout it is a partial record.
  const tail = records.pop() ?? '';
  if (tail.length > 0 && !opts.outputTruncated) records.push(tail);
  let truncated = Boolean(opts.outputTruncated);
  const entries: DirEntry[] = [];
  for (const record of records) {
    const fields = record.split('\t');
    if (fields.length < 5) continue;
    const [t = '', size = '', mtime = '', mode = ''] = fields;
    const name = fields.slice(4).join('\t');
    if (!name || name === '.' || name === '..' || name.includes('/')) continue;
    if (entries.length >= max) {
      truncated = true;
      break;
    }
    const type: DirEntry['type'] = TYPE_MAP[t.trim()] ?? 'other';
    const bytes = Number(size);
    let path: string;
    try {
      path = joinRemote(dir, name);
    } catch {
      continue;
    }
    entries.push({
      name,
      path,
      type,
      size: type === 'file' && size !== '' && Number.isFinite(bytes) && bytes >= 0 ? bytes : null,
      mtime: toIso(mtime.trim()),
      mode: /^[0-7]{3,4}$/.test(mode.trim()) ? mode.trim() : null,
    });
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'dir' ? -1 : 1);
  return { path: dir, entries, truncated };
}

// ─── Content ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Binary when a NUL appears in the first 8 KiB or the bytes are not valid UTF-8 (a cut final character is fine). */
export function decodeText(bytes: Uint8Array, truncated: boolean): { text: string | null; binary: boolean } {
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) return { text: null, binary: true };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
    return { text, binary: false };
  } catch {
    return { text: null, binary: true };
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FileService {
  listDir(target: ComputerTarget, path: string, opts?: { signal?: AbortSignal }): Promise<DirListing>;
  readFile(target: ComputerTarget, path: string, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<FileContent>;
  writeFile(target: ComputerTarget, path: string, text: string): Promise<void>;
  makeDir(target: ComputerTarget, path: string): Promise<void>;
  movePath(target: ComputerTarget, from: string, to: string): Promise<void>;
  /** Removes a file or a folder recursively (the renderer asked the user). Never `/` or `home`. */
  removePath(target: ComputerTarget, path: string, opts?: { home?: string | null }): Promise<void>;
  /** `mkdir -p` as part of an upload (a transfer: activity `transfer`). */
  ensureDir(target: ComputerTarget, path: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

export interface FileServiceDeps {
  runner: ExecRunner;
  dataPlane: DataPlaneApi;
  log: Logger;
}

export function createFileService(deps: FileServiceDeps): FileService {
  const { runner } = deps;
  const log = deps.log.child('computer.files');

  async function shell(target: ComputerTarget, what: string, command: string, envs: Record<string, string>, activity: 'file_op' | 'transfer', signal?: AbortSignal): Promise<void> {
    const result = await runner.run(target, { command, envs, timeoutSec: FILE_EXEC_TIMEOUT_SEC, origin: 'user', activity, signal });
    if (result.status !== 'succeeded' || result.exit_code !== 0) throw execFailure(result, what);
  }

  return {
    async listDir(target, rawPath, opts = {}) {
      const path = normalizeRemotePath(rawPath);
      const envs = { [PATH_ENV]: path };
      const run = (command: string) => runner.run(target, { command, envs, timeoutSec: FILE_EXEC_TIMEOUT_SEC, origin: 'app', signal: opts.signal });
      const first = await run(LIST_COMMAND);
      if (first.stdout) return parseListing(path, first.stdout, { outputTruncated: Boolean(first.stdout_truncated) });
      if (first.status === 'succeeded' && first.exit_code === 0) return { path, entries: [], truncated: false };
      const line = stderrLine(first);
      if (first.status === 'succeeded' || first.status === 'failed') {
        if (/no such file or directory/i.test(line)) throw new GmiError('not_found', 'That folder does not exist in the sandbox.', { detail: line });
        if (/not a directory/i.test(line)) throw new GmiError('invalid_input', 'That is not a folder.', { detail: line });
        if (/permission denied/i.test(line)) throw execFailure(first, 'Listing the folder');
        if (first.exit_code === 127 || NO_PRINTF.test(line)) {
          log.debug('find -printf unavailable; using the stat fallback');
          const second = await run(LIST_FALLBACK_COMMAND);
          if (second.stdout) return parseListing(path, second.stdout, { outputTruncated: Boolean(second.stdout_truncated) });
          if (second.status === 'succeeded' && second.exit_code === 0) return { path, entries: [], truncated: false };
          throw execFailure(second, 'Listing the folder');
        }
      }
      throw execFailure(first, 'Listing the folder');
    },

    async readFile(target, rawPath, opts = {}) {
      const path = normalizeRemotePath(rawPath);
      const requested = opts.maxBytes ?? FILE_PREVIEW_MAX_BYTES;
      const maxBytes = Number.isFinite(requested) ? Math.max(0, Math.min(Math.floor(requested), FILE_PREVIEW_MAX_BYTES)) : FILE_PREVIEW_MAX_BYTES;
      const res = await runner.withSlot(target, { origin: 'user', activity: 'file_op', signal: opts.signal }, () =>
        deps.dataPlane.readFile(target.sandboxId, path, { maxBytes, signal: opts.signal }),
      );
      const { text, binary } = decodeText(res.bytes, res.truncated);
      return { path, size: res.size ?? res.bytes.byteLength, text, binary, truncated: res.truncated };
    },

    async writeFile(target, rawPath, text) {
      const path = normalizeRemotePath(rawPath);
      if (typeof text !== 'string') throw new GmiError('invalid_input', 'Only text can be saved here.');
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > FILE_WRITE_MAX_BYTES) throw new GmiError('invalid_input', 'Files over 1 MB cannot be edited here. Use Upload instead.');
      await runner.withSlot(target, { origin: 'user', activity: 'file_op' }, () => deps.dataPlane.writeFile(target.sandboxId, path, bytes));
    },

    async makeDir(target, rawPath) {
      const path = normalizeRemotePath(rawPath);
      if (path === '/') throw new GmiError('invalid_input', 'That folder already exists.');
      await shell(target, 'Creating the folder', `mkdir -p "$${PATH_ENV}"`, { [PATH_ENV]: path }, 'file_op');
    },

    async movePath(target, rawFrom, rawTo) {
      const from = normalizeRemotePath(rawFrom);
      const to = normalizeRemotePath(rawTo);
      if (from === '/') throw new GmiError('invalid_input', 'The root folder cannot be moved.');
      if (from === to) return;
      if (to.startsWith(`${from}/`)) throw new GmiError('invalid_input', 'A folder cannot be moved into itself.');
      await shell(target, 'Moving', 'mv "$GMID_FROM" "$GMID_TO"', { GMID_FROM: from, GMID_TO: to }, 'file_op');
    },

    async removePath(target, rawPath, opts = {}) {
      const path = normalizeRemotePath(rawPath);
      if (path === '/') throw new GmiError('invalid_input', 'The root folder cannot be deleted.');
      if (opts.home && path === normalizeRemotePath(opts.home)) throw new GmiError('invalid_input', 'The home folder cannot be deleted.');
      await shell(target, 'Deleting', `rm -rf "$${PATH_ENV}"`, { [PATH_ENV]: path }, 'file_op');
    },

    async ensureDir(target, rawPath, opts = {}) {
      const path = normalizeRemotePath(rawPath);
      if (path === '/') return;
      await shell(target, 'Creating the folder', `mkdir -p "$${PATH_ENV}"`, { [PATH_ENV]: path }, 'transfer', opts.signal);
    },
  };
}
