/**
 * Opens the harness store (harness.md §5.2): `<userData>/data/harness/harness.sqlite`, 0600 in a 0700 directory,
 * WAL + synchronous=FULL. A database older than this build is migrated in the worker thread (phase `migrating`,
 * after a `harness.sqlite.bak-<v>` copy); a newer one is refused untouched (GmiError conflict, detail
 * `db_newer:<found>><supported>`). Open errors carry detail `db_corrupt`, `db_locked` or `db_error` (§17: main then
 * offers the view-only fallback and "Restore backup").
 */
import { GmiError } from '@shared/contracts/errors';
import type { OpenStore, OpenStoreOptions } from '../types';
import { openSqlite } from './db';
import { newerSchemaError, peekUserVersion, readUserVersion } from './migrate';
import { STORE_SCHEMA_VERSION } from './schema';
import { createSqliteStore, type SqliteStore } from './store';

export { createReceiptGuard, type ReceiptGuard } from './receipts';
export { backupPathOf, migrateFile, type MigrateResult } from './migrate';
export { MIGRATIONS, STORE_SCHEMA_VERSION } from './schema';
export { foldTimeline, TimelineFold, TIMELINE_PAGE, type TimelinePage } from './projections';
export type { SqliteStore } from './store';

/** How long receipts are kept: replays only follow a host restart. */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function openSqliteStore(opts: OpenStoreOptions): Promise<SqliteStore> {
  const log = opts.log.child('store');
  // Checked before any pragma is applied: a newer file is refused byte-identical.
  let version = peekUserVersion(opts.file);
  if (version > STORE_SCHEMA_VERSION) throw newerSchemaError(version, STORE_SCHEMA_VERSION);
  if (version < STORE_SCHEMA_VERSION) {
    opts.phase('migrating');
    const result = await opts.worker.run('store.migrate', { file: opts.file });
    log.info('store migrated', { from: result.from, to: result.to, backup: result.backup !== null });
  }
  const db = openSqlite(opts.file);
  version = readUserVersion(db);
  if (version !== STORE_SCHEMA_VERSION) {
    db.close();
    throw new GmiError('internal', 'The agent database migration did not complete.', { detail: `db_migrate:${version}` });
  }
  const store = createSqliteStore(db, { clock: opts.clock, log });
  try {
    const pruned = store.receipts.prune(RECEIPT_RETENTION_MS);
    if (pruned > 0) log.debug('receipts pruned', { count: pruned });
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}

/** The frozen `OpenStore` (src/harness/types.ts). */
export const openStore: OpenStore = openSqliteStore;
