// H2-A Store: opening, pragmas (WAL + synchronous=FULL), file modes, migrations (from an empty database and from a
// v1 fixture, in the worker), the .bak copy, refusal of newer files, failed migrations, online backup.
// Every file lives in a throwaway directory under os.tmpdir().
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { backupPathOf, migrateFile, MIGRATIONS, openSqliteStore, STORE_SCHEMA_VERSION } from '@harness/store';
import { openSqlite } from '@harness/store/db';
import { contextIdOf, harnessPaths, type Worker } from '@harness/types';
import { fakeClock, inlineWorker, memoryLog } from '../fakes';
import { messageRow, openTestStore, projectRow, tempDir, threadRow, type TempDir } from './helpers';

const FIXTURE_V1 = readFileSync(fileURLToPath(new URL('./fixtures/v1.sql', import.meta.url)), 'utf8');

function sqliteDb(file: string, readOnly = false): DatabaseSync {
  const { DatabaseSync: Db } = process.getBuiltinModule('node:sqlite');
  return new Db(file, { readOnly });
}

function writeFixture(file: string): void {
  const db = sqliteDb(file);
  db.exec(FIXTURE_V1);
  db.close();
}

let tmp: TempDir;
beforeEach(async () => {
  tmp = await tempDir('open');
});
afterEach(async () => {
  await tmp.cleanup();
});

describe('open: pragmas and file modes', () => {
  it('creates the database 0600 in a 0700 directory with WAL, synchronous=FULL, foreign keys and busy_timeout', async () => {
    const dataDir = join(tmp.dir, 'data', 'harness');
    const { store, file } = await openTestStore(dataDir);
    expect(file).toBe(harnessPaths(dataDir).db);
    const pragma = (name: string) => Object.values(store.db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('synchronous')).toBe(2);
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('busy_timeout')).toBe(5000);
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);

    store.projects.upsert(projectRow());
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    store.close();
    store.close(); // idempotent
  });

  it('tightens an existing directory and file to 0700 / 0600', async () => {
    const dataDir = join(tmp.dir, 'loose');
    const { store, file } = await openTestStore(dataDir);
    store.close();
    const { chmodSync } = await import('node:fs');
    chmodSync(dataDir, 0o755);
    chmodSync(file, 0o644);
    const again = await openTestStore(dataDir);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    again.store.close();
  });

  it('writes are durable across a reopen; close checkpoints the WAL', async () => {
    const { store, file } = await openTestStore(tmp.dir);
    store.projects.upsert(projectRow());
    store.threads.insert(threadRow('thr_1'));
    store.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: null, turn: null, step: null, type: 'notice', payload: { n: 1 } });
    store.close();
    expect(statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
    const again = await openTestStore(tmp.dir);
    expect(again.phases).toEqual([]);
    expect(again.store.events.lastSeq('thr_1')).toBe(1);
    expect(again.store.threads.get('thr_1')?.title).toBe('Thread thr_1');
    again.store.close();
  });

  it('a damaged file fails with db_corrupt (main then offers the view-only fallback, §17) and is not deleted', async () => {
    const file = harnessPaths(tmp.dir).db;
    writeFileSync(file, Buffer.alloc(8192, 0x5a));
    const err = await openTestStore(tmp.dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GmiError);
    expect((err as GmiError).detail).toBe('db_corrupt');
    expect(statSync(file).size).toBe(8192);
  });
});

describe('migrations (in the worker)', { timeout: 60_000 }, () => { // fsync-bound (synchronous=FULL): slow when the disk is busy
  it('migrates an empty database to the current version, reporting phase `migrating`, without a backup', async () => {
    const jobs: string[] = [];
    const inner = inlineWorker();
    const worker: Worker = {
      run: (job, input, opts) => {
        jobs.push(job);
        return inner.run(job, input, opts);
      },
      close: () => inner.close(),
    };
    const phases: string[] = [];
    const file = harnessPaths(tmp.dir).db;
    const store = await openSqliteStore({ file, worker, clock: fakeClock(), log: memoryLog(), phase: (p) => phases.push(p) });
    expect(jobs).toEqual(['store.migrate']);
    expect(phases).toEqual(['migrating']);
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(existsSync(backupPathOf(file, 0))).toBe(false);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>()
      .map((r) => r.name);
    expect(tables).toEqual([
      'approvals',
      'checkpoints',
      'command_receipts',
      'compactions',
      'events',
      'git_procs',
      'mcp_servers',
      'messages',
      'permission_rules',
      'projects',
      'reads',
      'ref_snapshots',
      'sensitive_hashes',
      'threads',
      'todos',
      'tool_calls',
      'trusted_files',
      'usage_steps',
    ]);
    store.close();

    // A second open needs no migration.
    phases.length = 0;
    jobs.length = 0;
    const again = await openSqliteStore({ file, worker, clock: fakeClock(), log: memoryLog(), phase: (p) => phases.push(p) });
    expect(jobs).toEqual([]);
    expect(phases).toEqual([]);
    again.close();
  });

  it('migrates a v1 fixture: .bak-1 is an intact v1 copy, every row reads back through the Store', async () => {
    const file = harnessPaths(tmp.dir).db;
    writeFixture(file);
    const { store, phases, log } = await openTestStore(tmp.dir);
    expect(phases).toEqual(['migrating']);
    expect(log.lines.some((l) => l.message === 'store migrated' && l.meta?.from === 1 && l.meta?.to === STORE_SCHEMA_VERSION)).toBe(true);

    const bak = backupPathOf(file, 1);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    const bakDb = sqliteDb(bak, true);
    expect(bakDb.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(bakDb.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 8 });
    bakDb.close();

    expect(store.projects.get('prj_fixture')?.rootPath).toBe('/tmp/gmi-desk-fixture/repo');
    expect(store.trustedFiles.get('prj_fixture', 'AGENTS.md')?.content).toBe('# Rules\nRun npm test.\n');
    expect(store.threads.list().map((t) => t.id)).toEqual(['thr_a', 'thr_b']);
    expect(store.threads.get('thr_a')).toMatchObject({ status: 'completed', costUsd: 0.0123, tokens: { input: 1200, cached: 800, output: 300, reasoning: 40 }, archived: false });
    expect(store.threads.get('thr_b')?.archived).toBe(true);
    expect(store.events.list('thr_a').map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(store.events.lastSeq('thr_b')).toBe(1);
    const msgs = store.messages.list('ctx_thr_a');
    expect(msgs.map((m) => [m.ord, m.role, m.steering ?? false])).toEqual([
      [1, 'user', false],
      [2, 'assistant', false],
      [3, 'tool', false],
    ]);
    expect(msgs[1]?.toolCalls).toEqual([{ id: 'call_0', name: 'bash', arguments: '{"command":"npm test"}' }]);
    expect(store.toolCalls.byWireId('ctx_thr_a', 'call_0')?.status).toBe('succeeded');
    expect(store.approvals.pending('thr_a').map((a) => a.request.title)).toEqual(['rm -rf build']);
    expect(store.rules.list({ projectId: 'prj_fixture' }).map((r) => r.pattern)).toEqual(['npm test']);
    expect(store.checkpoints.list('thr_a').map((c) => c.filesChanged)).toEqual([2]);
    expect(store.compactions.list('ctx_thr_a').map((c) => c.afterTokens)).toEqual([1200]);
    expect(store.reads.get('ctx_thr_a', 'src/a.ts')?.ranges).toEqual([[0, 120]]);
    expect(store.usage.list('thr_a')[0]).toMatchObject({ prompt: 1200, cached: 800, estimated: false });
    expect(store.mcpServers.list({ projectId: null }).map((m) => m.toolHashes)).toEqual([{ search: 'abc' }]);
    expect(store.todos.get('ctx_thr_a')).toEqual([{ id: 't1', text: 'Run the tests', status: 'done' }]);
    expect(store.refSnapshots.get('run_fx1')?.refs).toEqual({ 'refs/heads/main': 'b'.repeat(40) });
    expect(store.sensitiveHashes.get('thr_a')).toEqual({ 'package.json': '7'.repeat(64), '.envrc': null });
    expect(store.gitProcs.list()).toEqual([{ pid: 424242, threadId: 'thr_a', startedAt: '2026-10-30T10:00:00.000Z' }]);
    expect(store.receipts.get('cmd_fx1')).toEqual({ threadId: 'thr_a', at: '2026-10-30T10:00:00.000Z', result: { runId: 'run_fx1', turn: 1 } });
    expect(store.projections.summary('thr_a')).toMatchObject({ diff: { files: 2, additions: 10, deletions: 3 }, pendingApprovals: 1 });

    // The new column works on migrated rows, and appends continue the fixture's sequences.
    const m = store.messages.append(messageRow('msg_new', 'thr_a', { steering: true, turn: 2 }));
    expect(m).toMatchObject({ ord: 4, steering: true });
    const e = store.events.append({ threadId: 'thr_a', contextId: 'ctx_thr_a', runId: 'run_2', turn: 2, step: null, type: 'turn.started', payload: {} });
    expect(e.seq).toBe(8);
    store.close();
  });

  it('refuses a database from a newer version without touching it', async () => {
    const file = harnessPaths(tmp.dir).db;
    const db = sqliteDb(file);
    db.exec(`CREATE TABLE future (x); PRAGMA user_version = ${STORE_SCHEMA_VERSION + 5}`);
    db.close();
    const before = readFileSync(file);
    const err = await openTestStore(tmp.dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GmiError);
    expect((err as GmiError).code).toBe('conflict');
    expect((err as GmiError).detail).toBe(`db_newer:${STORE_SCHEMA_VERSION + 5}>${STORE_SCHEMA_VERSION}`);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(backupPathOf(file, STORE_SCHEMA_VERSION + 5))).toBe(false);
  });

  it('a failing migration rolls back to the last completed version and keeps the backup', async () => {
    const file = harnessPaths(tmp.dir).db;
    writeFixture(file);
    const broken = [...MIGRATIONS, { version: STORE_SCHEMA_VERSION + 1, sql: 'CREATE TABLE ok_part (x); ALTER TABLE no_such_table ADD COLUMN y;' }];
    await expect(migrateFile(file, broken)).rejects.toBeInstanceOf(GmiError);
    const db = sqliteDb(file, true);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: STORE_SCHEMA_VERSION });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok_part'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 8 });
    db.close();
    expect(existsSync(backupPathOf(file, 1))).toBe(true);
    // The real migrations then open it normally.
    const { store } = await openTestStore(tmp.dir);
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    store.close();
  });

  it('the migrate job is registered on the worker (the worker thread runs the same bundle)', async () => {
    const file = harnessPaths(tmp.dir).db;
    const result = await inlineWorker().run('store.migrate', { file });
    expect(result).toEqual({ from: 0, to: STORE_SCHEMA_VERSION, backup: null });
    const db = openSqlite(file);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: STORE_SCHEMA_VERSION });
    db.close();
  });
});

describe('backup', () => {
  it('makes an online 0600 copy while the store stays writable; refuses to overwrite the database itself', async () => {
    const { store, file } = await openTestStore(tmp.dir);
    store.projects.upsert(projectRow());
    store.threads.insert(threadRow('thr_1'));
    for (let i = 0; i < 50; i += 1) {
      store.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: null, turn: null, step: null, type: 'notice', payload: { i, pad: 'x'.repeat(500) } });
    }
    const dest = join(tmp.dir, 'copy.sqlite');
    const pending = store.backup(dest);
    store.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: null, turn: null, step: null, type: 'notice', payload: { i: 50 } });
    await pending;
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const copy = sqliteDb(dest, true);
    const n = (copy.prepare("SELECT COUNT(*) AS n FROM events WHERE thread_id = 'thr_1'").get() as { n: number }).n;
    expect(n === 50 || n === 51).toBe(true);
    expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: STORE_SCHEMA_VERSION });
    copy.close();
    expect(store.events.lastSeq('thr_1')).toBe(51);
    await expect(store.backup(file)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(store.quickCheck()).toBe('ok');
    store.close();
  });
});
