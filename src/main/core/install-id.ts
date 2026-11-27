import { randomBytes } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger';
import { durableWriteFile } from './store';

/** 16 random bytes as 32 lowercase hex characters. */
export const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

interface InstallFile {
  installId: string;
  createdAt: string;
}

export interface InstallIdOptions {
  log?: Logger;
  now?: () => Date;
}

/** The id in `text`, or null when the file is not JSON or holds no valid id. */
function parseInstallFile(text: string): string | null {
  try {
    const raw = JSON.parse(text) as Partial<InstallFile> | null;
    return raw && typeof raw.installId === 'string' && INSTALL_ID_PATTERN.test(raw.installId) ? raw.installId : null;
  } catch {
    return null;
  }
}

/**
 * The installation id from `<data>/install.json`, created on first use. compute.md §7 tags this install's billing
 * resources with it, so it is replaced only when the file is missing or malformed:
 * - a malformed file is moved aside (`install.json.corrupt-<ms>`) so its id can still be recovered for adopt;
 * - any other read error (EIO, EACCES, EMFILE…) throws: overwriting would orphan the tagged resources;
 * - a failed first write (disk full, read-only data dir) is logged and the app runs with the new id in memory (the
 *   next start creates another one; resources created meanwhile show up as "another install" and need adopt).
 */
export async function loadInstallId(dataDir: string, opts: InstallIdOptions = {}): Promise<string> {
  const path = join(dataDir, 'install.json');
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      throw new Error(`Could not read the install id (${path}: ${code}). Check the app data folder's permissions and free space.`, { cause: error });
    }
  }
  if (text !== null) {
    const existing = parseInstallFile(text);
    if (existing) return existing;
    const aside = `${path}.corrupt-${Date.now()}`;
    opts.log?.warn(`install.json held no valid id; moved to ${aside} and creating a new one`);
    await rename(path, aside).catch((error: unknown) => opts.log?.warn('could not move the malformed install.json aside', error));
  }
  const installId = randomBytes(16).toString('hex');
  const file: InstallFile = { installId, createdAt: (opts.now?.() ?? new Date()).toISOString() };
  try {
    await durableWriteFile(path, `${JSON.stringify(file, null, 2)}\n`);
  } catch (error) {
    opts.log?.error('could not save the new install id; using it for this session only', error);
  }
  return installId;
}
