/**
 * Object import (§8.3): commits the agent made inside the sandbox live in the thread's object dir. After each run and
 * before any commit, diff or merge that needs them, the host copies what the thread branch reaches beyond the base
 * into the common store, under the per-repo mutex:
 *   rev-list --objects <tip> --not <base>   (thread object dir + common store)
 *   pack-objects --revs --stdout            (same)
 *   unpack-objects --strict                 (common store: git re-hashes and checks every object)
 * and then checks that the common store alone reaches every object (`rev-list --objects`, no thread objects).
 */
import { GmiError } from '@shared/contracts/errors';
import { isHexSha } from '@shared/lib/git-safe';
import type { ThreadGitRecord } from '../types';
import { commonOpts, type GitCtx } from './context';
import { verifyRecord } from './record';

export async function readRef(ctx: GitCtx, r: ThreadGitRecord, ref: string): Promise<string | null> {
  const res = await ctx.exec.raw(commonOpts(r, ['rev-parse', '--verify', '-q', ref]));
  const sha = res.stdout.toString('utf8').trim();
  return res.code === 0 && isHexSha(sha) ? sha : null;
}

export async function importObjects(ctx: GitCtx, r: ThreadGitRecord): Promise<{ imported: number }> {
  await verifyRecord(r);
  if (!r.objectDir || !r.branch) return { imported: 0 };
  const objectDir = r.objectDir;
  const branchRef = `refs/heads/${r.branch}`;
  return ctx.repoMutex.run(r.commonDir, async () => {
    const tip = await readRef(ctx, r, branchRef);
    if (!tip) return { imported: 0 };
    const last = ctx.lastImported.get(r.threadId);
    if (last === tip) return { imported: 0 };
    const exclude = [r.baseSha, last].filter((s): s is string => isHexSha(s));
    const threadStore = { objectDir, alternates: [`${r.commonDir}/objects`] };
    const listed = await ctx.exec.raw(commonOpts(r, ['rev-list', '--objects', tip, ...(exclude.length ? ['--not', ...exclude] : [])], 'strict', { ...threadStore, maxBytes: 256 * 1024 * 1024 }));
    if (listed.code !== 0) throw new GmiError('internal', 'The thread branch has missing objects.', { detail: `git_import_list:${listed.stderr.split('\n')[0]?.slice(0, 200) ?? ''}` });
    const count = listed.stdout.toString('utf8').split('\n').filter(Boolean).length;
    if (count > 0) {
      const input = `${tip}\n${exclude.map((s) => `^${s}`).join('\n')}\n`;
      const pack = await ctx.exec.run(commonOpts(r, ['pack-objects', '--revs', '--stdout', '-q'], 'strict', { ...threadStore, stdin: input, maxBytes: 1024 * 1024 * 1024, timeoutMs: 10 * 60_000 }));
      await ctx.exec.run(commonOpts(r, ['unpack-objects', '--strict', '-q'], 'strict', { stdin: pack.stdout, timeoutMs: 10 * 60_000 }));
    }
    const shas = listed.stdout
      .toString('utf8')
      .split('\n')
      .map((l) => l.slice(0, l.indexOf(' ') === -1 ? l.length : l.indexOf(' ')))
      .filter(isHexSha);
    if (shas.length) {
      const check = await ctx.exec.raw(commonOpts(r, ['cat-file', '--batch-check=%(objectname)'], 'strict', { stdin: `${shas.join('\n')}\n`, maxBytes: 256 * 1024 * 1024, timeoutMs: 10 * 60_000 }));
      if (check.code !== 0 || / missing$/m.test(check.stdout.toString('utf8'))) throw new GmiError('internal', 'Imported objects could not be verified.', { detail: 'git_import_verify' });
    }
    ctx.lastImported.set(r.threadId, tip);
    return { imported: count };
  });
}
