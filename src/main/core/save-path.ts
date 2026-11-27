import { basename } from 'node:path';

/** Used when a suggested name has no usable file name in it. */
export const FALLBACK_SAVE_NAME = 'download';

/**
 * The file name a native save dialog may suggest for `defaultName`, which can come from a remote machine: only the
 * last path segment (either slash), never `.`/`..` (they would point the dialog at a folder outside Downloads),
 * never empty and never with a NUL or other control character.
 */
export function safeSaveName(defaultName: string): string {
  const name = basename(defaultName.replace(/\\/g, '/')).trim();
  if (!name || name === '.' || name === '..' || /[\u0000-\u001f\u007f]/.test(name)) return FALLBACK_SAVE_NAME;
  return name;
}
