import { join } from 'node:path';
import type { AppPaths } from '../../core/context';

/** The host's data dir (`init.dataDir`): `<userData>/data/harness` (harness.md §5.2; layout in src/harness/types.ts harnessPaths). */
export function harnessDataDir(paths: Pick<AppPaths, 'data'>): string {
  return join(paths.data, 'harness');
}
