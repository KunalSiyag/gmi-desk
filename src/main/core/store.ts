import type { Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from './logger';

let tmpCounter = 0;

/** Names atomicWriteFile gives its temp files: `<file>.tmp-<pid>-<n>`. */
const TEMP_FILE_PATTERN = /\.tmp-\d+-\d+$/;

/**
 * Deletes temp files that atomicWriteFile left behind when the app crashed or was killed mid-write (each run
 * uses a new pid in the name, so nothing else ever cleans them up). Only files older than `olderThanMs` go: an
 * instance sharing the folder may be writing right now. Walks `maxDepth` levels of sub-folders; never follows
 * symlinks. Returns the removed paths.
 */
export async function sweepStaleTempFiles(
  dirs: string[],
  opts: { olderThanMs?: number; now?: number; maxDepth?: number; log?: Logger } = {},
): Promise<string[]> {
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now();
  const maxDepth = opts.maxDepth ?? 2;
  const removed: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) continue;
      try {
        if (now - (await stat(full)).mtimeMs < olderThanMs) continue;
        await rm(full, { force: true });
        removed.push(full);
      } catch (error) {
        opts.log?.warn(`could not remove stale temp file ${full}`, error);
      }
    }
  };
  for (const dir of dirs) await walk(dir, 0);
  if (removed.length > 0) opts.log?.info(`removed ${removed.length} stale temp file(s) left by an interrupted write`);
  return removed;
}

/** Writes via a temp file + rename so a crash never leaves a half-written file. */
export async function atomicWriteFile(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  tmpCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter}`;
  try {
    await writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The file operations durableWriteFile needs (injectable so tests can check the order on a fake fs). */
export interface DurableFs {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  open(path: string, flags: 'w' | 'r', mode?: number): Promise<DurableFileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts: { force: true }): Promise<void>;
}

export interface DurableFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const nodeDurableFs: DurableFs = {
  mkdir: (path, opts) => mkdir(path, opts),
  open: (path, flags, mode) => open(path, flags, mode),
  rename: (from, to) => rename(from, to),
  rm: (path, opts) => rm(path, opts),
};

/**
 * Like atomicWriteFile, but the new content survives a power loss once this resolves: write the temp file,
 * `filehandle.sync()`, rename it over `path`, then fsync the directory so the rename itself is on disk. For
 * write-ahead journals and spend ledgers (compute journal/registry, gateway thread ledger). Slower: use it only
 * where losing the last write would lose money or a resource.
 * Platforms that cannot open a directory for fsync (Windows) skip that last step.
 */
export async function durableWriteFile(path: string, data: string | Uint8Array, mode?: number, fs: DurableFs = nodeDurableFs): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter}`;
  try {
    const handle = await fs.open(tmp, 'w', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  let dirHandle: DurableFileHandle | null = null;
  try {
    dirHandle = await fs.open(dir, 'r');
    await dirHandle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows cannot open or fsync a directory; the rename is already done.
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL' && code !== 'EACCES') throw error;
  } finally {
    await dirHandle?.close().catch(() => undefined);
  }
}

/** Reads and parses a JSON file; null when it does not exist. Throws on malformed JSON. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as T;
}

export interface JsonStore<T> {
  readonly path: string;
  get(): T;
  set(next: T): Promise<void>;
  update(fn: (current: T) => T): Promise<T>;
  /** Resolves when all pending writes have hit the disk. */
  flush(): Promise<void>;
}

/**
 * A small JSON document persisted to disk. Reads are synchronous from memory; writes are
 * serialised and atomic. A corrupt file is moved aside and replaced by defaults.
 */
export async function openJsonStore<T>(
  path: string,
  defaults: T,
  opts: { log?: Logger; normalize?: (raw: unknown, defaults: T) => T } = {},
): Promise<JsonStore<T>> {
  let value: T = structuredClone(defaults);
  try {
    const raw = await readJsonFile<unknown>(path);
    if (raw !== null) value = opts.normalize ? opts.normalize(raw, structuredClone(defaults)) : (raw as T);
  } catch (error) {
    const aside = `${path}.corrupt-${Date.now()}`;
    opts.log?.warn(`store ${path} was unreadable; moved to ${aside}`, error);
    await rename(path, aside).catch(() => undefined);
    value = structuredClone(defaults);
  }

  let queue: Promise<void> = Promise.resolve();
  const persist = (snapshot: T) => {
    const text = JSON.stringify(snapshot, null, 2);
    queue = queue.then(() => atomicWriteFile(path, text)).catch((error) => {
      opts.log?.error(`failed to write ${path}`, error);
    });
    return queue;
  };

  return {
    path,
    get: () => value,
    set(next: T) {
      value = next;
      return persist(next);
    },
    async update(fn) {
      value = fn(value);
      await persist(value);
      return value;
    },
    flush: () => queue,
  };
}
