/**
 * node:sqlite behind the small `Db` interface (harness.md §5.2), so the driver could be swapped if the API changes.
 *
 * - Pragmas: journal_mode=WAL, synchronous=FULL (a committed `tool.started` survives an OS crash, invariant 2),
 *   foreign_keys=ON, busy_timeout=5000.
 * - The file is created 0600 in a 0700 directory before SQLite opens it; SQLite gives its -wal/-shm files the
 *   main file's mode.
 * - `transaction` is synchronous: the outer call is `BEGIN IMMEDIATE`, nested calls are savepoints, a throw rolls
 *   back (only the savepoint for nested calls). A callback that returns a promise is refused: the transaction would
 *   otherwise commit before the awaited work ran.
 */
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { GmiError } from '@shared/contracts/errors';
import type { Db, DbStatement, SqlValue } from '../types';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/** node:sqlite, loaded on first use: after host.ts installed its ExperimentalWarning filter (§5.2). */
export function sqlite(): SqliteModule {
  if (!sqliteModule) sqliteModule = process.getBuiltinModule('node:sqlite') as SqliteModule;
  return sqliteModule;
}

export const DB_PRAGMAS = {
  journalMode: 'wal',
  /** 2 = FULL. */
  synchronous: 2,
  foreignKeys: 1,
  busyTimeoutMs: 5_000,
} as const;

export interface SqliteDb extends Db {
  /** The driver handle (online backup, pragmas in tests). */
  readonly raw: DatabaseSync;
  readonly file: string;
  /** True while a transaction (outer or nested) is open on this connection. */
  inTransaction(): boolean;
}

/** Makes `<dir>` 0700 and `<file>` 0600 (creating an empty file if needed). */
export function prepareDbFile(file: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const fd = openSync(file, 'a', 0o600);
  closeSync(fd);
  chmodSync(file, 0o600);
}

/** Maps a driver error to a GmiError: constraint → conflict, busy/locked → conflict(db_locked), corrupt → internal(db_corrupt). */
export function dbError(error: unknown, what: string): GmiError {
  if (error instanceof GmiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  const code = typeof errcode === 'number' ? errcode & 0xff : -1;
  if (code === 19 || /constraint failed/i.test(message)) return new GmiError('conflict', `${what}: constraint violated.`, { detail: 'db_constraint', cause: error });
  if (code === 5 || code === 6 || /database is (locked|busy)/i.test(message)) return new GmiError('conflict', `${what}: the agent database is locked.`, { detail: 'db_locked', cause: error });
  if (code === 11 || code === 26 || /malformed|not a database/i.test(message)) return new GmiError('internal', `${what}: the agent database is damaged.`, { detail: 'db_corrupt', cause: error });
  return new GmiError('internal', `${what}: the agent database failed.`, { detail: 'db_error', cause: error });
}

/**
 * Opens (creating if needed) the database file with the store pragmas. Throws GmiError (detail `db_corrupt`,
 * `db_locked` or `db_error`) when it cannot be opened or the pragmas cannot be applied.
 */
export function openSqlite(file: string): SqliteDb {
  prepareDbFile(file);
  let raw: DatabaseSync;
  try {
    raw = new (sqlite().DatabaseSync)(file);
  } catch (error) {
    throw dbError(error, 'Open');
  }
  try {
    raw.exec(`PRAGMA busy_timeout = ${DB_PRAGMAS.busyTimeoutMs}`);
    const mode = raw.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== DB_PRAGMAS.journalMode) throw new GmiError('internal', 'The agent database cannot use WAL.', { detail: 'db_error' });
    raw.exec('PRAGMA synchronous = FULL');
    raw.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    try {
      raw.close();
    } catch {
      // already closed
    }
    throw dbError(error, 'Open');
  }
  return wrap(raw, file);
}

function wrap(raw: DatabaseSync, file: string): SqliteDb {
  const cache = new Map<string, DbStatement>();
  let depth = 0;
  let savepoint = 0;
  let closed = false;

  const prepare = (sql: string): DbStatement => {
    const hit = cache.get(sql);
    if (hit) return hit;
    let stmt: ReturnType<DatabaseSync['prepare']>;
    try {
      stmt = raw.prepare(sql);
    } catch (error) {
      throw dbError(error, 'Prepare');
    }
    const wrapped: DbStatement = {
      run(...params) {
        try {
          const r = stmt.run(...(params as Exclude<SqlValue, null>[]));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        } catch (error) {
          throw dbError(error, 'Write');
        }
      },
      get<T>(...params: SqlValue[]) {
        try {
          return stmt.get(...(params as Exclude<SqlValue, null>[])) as T | undefined;
        } catch (error) {
          throw dbError(error, 'Read');
        }
      },
      all<T>(...params: SqlValue[]) {
        try {
          return stmt.all(...(params as Exclude<SqlValue, null>[])) as T[];
        } catch (error) {
          throw dbError(error, 'Read');
        }
      },
    };
    cache.set(sql, wrapped);
    return wrapped;
  };

  const exec = (sql: string) => {
    try {
      raw.exec(sql);
    } catch (error) {
      throw dbError(error, 'Write');
    }
  };

  return {
    raw,
    file,
    prepare,
    exec,
    inTransaction: () => depth > 0,
    transaction<T>(fn: () => T): T {
      if (closed) throw new GmiError('internal', 'The agent database is closed.', { detail: 'db_closed' });
      const outer = depth === 0;
      const name = outer ? '' : `sp_${(savepoint += 1)}`;
      exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      depth += 1;
      let result: T;
      try {
        result = fn();
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
          throw new GmiError('internal', 'Store transactions must be synchronous.', { detail: 'async_transaction' });
        }
      } catch (error) {
        depth -= 1;
        try {
          if (outer) exec('ROLLBACK');
          else exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        } catch {
          // A failed rollback leaves SQLite's own state (it rolls back on error where it must).
        }
        throw error;
      }
      depth -= 1;
      try {
        exec(outer ? 'COMMIT' : `RELEASE ${name}`);
      } catch (error) {
        // A failed COMMIT (disk full, I/O error) can leave the transaction open: roll it back so the connection
        // stays usable and nothing half-written is committed later.
        try {
          if (outer) exec('ROLLBACK');
          else exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        } catch {
          // already rolled back by SQLite
        }
        throw error;
      }
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      try {
        raw.close();
      } catch {
        // already closed
      }
    },
  };
}
