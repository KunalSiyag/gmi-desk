/**
 * Store migrations, run in the worker thread (harness.md §5.1: no synchronous block over 1 s on the host's event
 * loop; §5.2: `PRAGMA user_version`, a `harness.sqlite.bak-<v>` copy before migrating).
 *
 * The job `store.migrate` is registered at module load, so the worker thread (which runs the same bundle) has it as
 * soon as this module is part of the host bundle. Tests run it with the inline worker.
 */
import { chmodSync, statSync } from 'node:fs';
import { GmiError } from '@shared/contracts/errors';
import { registerWorkerJob } from '../worker';
import { dbError, openSqlite, prepareDbFile, sqlite, type SqliteDb } from './db';
import { MIGRATIONS, STORE_SCHEMA_VERSION, type Migration } from './schema';

export interface MigrateResult {
  from: number;
  to: number;
  /** The copy made before migrating (null for a new, empty database). */
  backup: string | null;
}

declare module '../types' {
  interface WorkerJobs {
    'store.migrate': { input: { file: string }; output: MigrateResult };
  }
}

/**
 * Reads `user_version` without applying any pragma (a newer file must stay byte-identical when refused). Throws
 * GmiError (detail `db_corrupt` …) when the file is not a database.
 */
export function peekUserVersion(file: string): number {
  prepareDbFile(file);
  let raw: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']> | null = null;
  try {
    raw = new (sqlite().DatabaseSync)(file);
    const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined;
    return Number(row?.user_version ?? 0);
  } catch (error) {
    throw dbError(error, 'Open');
  } finally {
    try {
      raw?.close();
    } catch {
      // already closed
    }
  }
}

export function readUserVersion(db: SqliteDb): number {
  const row = db.prepare('PRAGMA user_version').get<{ user_version?: number | bigint }>();
  return Number(row?.user_version ?? 0);
}

/** The path of the copy made before migrating from version `v`. */
export function backupPathOf(file: string, version: number): string {
  return `${file}.bak-${version}`;
}

export function newerSchemaError(found: number, supported: number): GmiError {
  return new GmiError('conflict', 'The agent database was written by a newer version of GMI Desk.', {
    detail: `db_newer:${found}>${supported}`,
  });
}

/**
 * Migrates `file` to the last of `migrations`. Each migration and its `user_version` bump commit together, so a
 * failure leaves the file at the last completed version (and the backup in place). Refuses a newer file without
 * touching it.
 */
export async function migrateFile(file: string, migrations: readonly Migration[] = MIGRATIONS): Promise<MigrateResult> {
  const target = migrations[migrations.length - 1]?.version ?? 0;
  const from = peekUserVersion(file);
  if (from > target) throw newerSchemaError(from, target);
  if (from === target) return { from, to: from, backup: null };
  const db = openSqlite(file);
  try {
    const hasContent = from > 0 || Number(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get<{ n: number }>()?.n ?? 0) > 0;
    let backup: string | null = null;
    if (hasContent) {
      backup = backupPathOf(file, from);
      await sqlite().backup(db.raw, backup);
      chmodSync(backup, 0o600);
      if (statSync(backup).size === 0) throw new GmiError('internal', 'The database backup before migrating is empty.', { detail: 'db_backup' });
    }

    let version = from;
    for (const m of migrations) {
      if (m.version <= version) continue;
      db.transaction(() => {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${Math.floor(m.version)}`);
      });
      version = m.version;
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { from, to: version, backup };
  } finally {
    db.close();
  }
}

registerWorkerJob('store.migrate', ({ file }) => migrateFile(file));

export { STORE_SCHEMA_VERSION };
