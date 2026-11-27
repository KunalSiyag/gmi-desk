/**
 * Prefix stability, golden (harness.md §7.1, §16): for a fixed thread across 10 steps (and a second turn), the
 * serialised `[system]+[tools]+[user#0]` is byte-identical and history only appends. The snapshot files in
 * prefix-v1/ pin the bytes: a prompt change must bump PROMPT_VERSION (new snapshot directory) on purpose.
 *
 * Regenerate deliberately with: GMI_DESK_UPDATE_GOLDEN=1 npx vitest run test/harness/golden
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '@shared/contracts/gateway';
import { canonicalJson } from '@harness/protocol';
import { serialisePrefix } from '@harness/loop/context';
import { PROMPT_VERSION } from '@harness/loop/prompts';
import { bench, callsReply, runTurn, text, THREAD_A } from '../loop/helpers';

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), `prefix-${PROMPT_VERSION}`);
const UPDATE = process.env.GMI_DESK_UPDATE_GOLDEN === '1';

function prefixOf(req: GatewayRequest) {
  return serialisePrefix({ system: req.messages[0]!, tools: req.tools ?? [], user0: req.messages[1]! });
}

async function tenSteps() {
  const b = bench({ thread: { title: 'Golden', envBlock: null } });
  b.store.trustedFiles.replace('p_demo', [{ projectId: 'p_demo', path: 'AGENTS.md', sha: 's1', content: '# Demo\nRun `npm test` before you finish.\n' }]);
  for (let i = 0; i < 9; i += 1) {
    const name = i % 3 === 0 ? 'read' : i % 3 === 1 ? 'grep' : 'edit';
    b.link.gateway.script.push(callsReply([{ id: 'call_0', name, args: name === 'edit' ? { path: `f${i}.ts`, content: `v${i}` } : { path: `f${i}.ts` } }], { prompt: 1_000 + i * 200, cached: 900 + i * 200 }));
  }
  b.link.gateway.script.push(text('Done.'));
  await runTurn(b, 'Fix the failing test.');
  b.clock.advance(3_600_000);
  b.link.gateway.script.push(callsReply([{ id: 'call_0', name: 'read', args: { path: 'g.ts' } }]), text('Also done.'));
  await runTurn(b, 'Now the other one.');
  return b;
}

describe(`golden prefix (${PROMPT_VERSION})`, () => {
  it('[system]+[tools]+[user#0] is byte-identical across 10 steps and 2 turns, and history only appends', async () => {
    const b = await tenSteps();
    const reqs = b.link.gateway.requests;
    expect(reqs).toHaveLength(12);
    const first = prefixOf(reqs[0]!);
    for (const req of reqs) expect(prefixOf(req)).toEqual(first);
    expect(new Set(reqs.map((r) => r.prefixHash)).size).toBe(1);
    for (let i = 1; i < reqs.length; i += 1) {
      const prev = reqs[i - 1]!.messages.map((m) => canonicalJson(m));
      const cur = reqs[i]!.messages.map((m) => canonicalJson(m));
      expect(cur.slice(0, prev.length)).toEqual(prev);
      expect(cur.length).toBeGreaterThan(prev.length);
    }
    // Volatile data only in the turn's own message.
    expect(String(reqs[0]!.messages[2]!.content)).toContain('<context>\ndate: 2026-11-02');
    expect(String(reqs[10]!.messages.at(-1)!.content)).toContain('<context>\ndate: 2026-11-02');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('matches the committed snapshot bytes', async () => {
    const b = await tenSteps();
    const p = prefixOf(b.link.gateway.requests[0]!);
    const files: Record<string, string> = { 'system.txt': `${p.system}\n`, 'tools.txt': `${p.tools}\n`, 'user0.txt': `${p.user0}\n` };
    if (UPDATE || !existsSync(DIR)) {
      // Writing a missing snapshot is allowed only when asked to; otherwise fail loudly.
      if (!UPDATE) throw new Error(`Missing golden snapshot ${DIR}. Run with GMI_DESK_UPDATE_GOLDEN=1 to create it on purpose.`);
      mkdirSync(DIR, { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(DIR, name), body);
    }
    for (const [name, body] of Object.entries(files)) expect(readFileSync(join(DIR, name), 'utf8'), name).toBe(body);
  });
});
