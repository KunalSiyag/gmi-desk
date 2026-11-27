/**
 * Tool batches that keep model order (harness.md §6.2 step 6, RL-21):
 * - the calls are split into maximal contiguous runs; a run of read-only calls executes in parallel, up to 4;
 * - every other call (edit, write, apply_patch, bash, task, question, sandbox_*, other MCP tools) is a BARRIER: it
 *   runs alone, after everything before it and before everything after it;
 * - results are returned in the original call order.
 * Example: `[read X, edit X, read X]` returns the old content, applies the edit, then returns the new content.
 *
 * Also the per-step output cap (§6.3): all results of a step together ≤ 40k tokens, the largest truncated first.
 */
import type { ToolClass } from '../types';
import { estimateTokens } from './tokens';

export const BATCH_LIMITS = {
  maxParallel: 4,
} as const;

/** Classes that are always barriers, whatever `readOnly(args)` says (task and question, §16). */
const BARRIER_CLASSES: ReadonlySet<ToolClass> = new Set(['mutate', 'shell', 'user', 'subagent', 'remote']);

export interface PlannedCall {
  index: number;
  /** Eligible for a parallel read run: a known tool, parsed args, readOnly(args) and not a barrier class. */
  parallel: boolean;
}

export function isParallelEligible(input: { known: boolean; parsed: boolean; readOnly: boolean; toolClass: ToolClass | null }): boolean {
  if (!input.known || !input.parsed) return true; // an invalid call never runs: it only produces an error result
  if (input.toolClass && BARRIER_CLASSES.has(input.toolClass)) return false;
  return input.readOnly;
}

/** Splits calls into ordered groups: maximal runs of parallel calls (chunked by maxParallel) and single barriers. */
export function planBatches(calls: readonly PlannedCall[], maxParallel: number = BATCH_LIMITS.maxParallel): number[][] {
  const groups: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    for (let i = 0; i < run.length; i += maxParallel) groups.push(run.slice(i, i + maxParallel));
    run = [];
  };
  for (const c of calls) {
    if (c.parallel) run.push(c.index);
    else {
      flush();
      groups.push([c.index]);
    }
  }
  flush();
  return groups;
}

/**
 * Runs the groups in order; calls of one group in parallel. `run(index)` never throws (it returns an error result
 * itself). Stops starting new groups when `shouldStop()` is true; the indexes that did not start are returned.
 */
export async function runBatches<R>(groups: readonly number[][], run: (index: number) => Promise<R>, shouldStop: () => boolean): Promise<{ results: Map<number, R>; notStarted: number[] }> {
  const results = new Map<number, R>();
  const notStarted: number[] = [];
  for (const group of groups) {
    if (shouldStop()) {
      notStarted.push(...group);
      continue;
    }
    const settled = await Promise.all(group.map(async (i) => [i, await run(i)] as const));
    for (const [i, r] of settled) results.set(i, r);
  }
  return { results, notStarted };
}

const STEP_MARKER = (shown: number, total: number) => `\n[step output limit: showing ${shown} of ${total} characters of this result; narrow the call (offset/limit, a smaller pattern) for the rest]`;

/** Smallest per-result level the cap cuts to (a result is never cut below this). */
const MIN_LEVEL_TOKENS = 256;

/**
 * Applies the per-step output cap by "water level": the largest results are cut first, all down to one level L
 * chosen so that Σ min(tokens_i, L) ≤ maxTokens (never below 256 tokens each). Head kept, with a marker.
 * Deterministic; results at or under L are untouched.
 */
export function capStepResults(contents: readonly string[], maxTokens: number): string[] {
  const tokens = contents.map((c) => estimateTokens(c));
  const total = tokens.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return [...contents];
  const fits = (level: number) => tokens.reduce((s, t) => s + Math.min(t, level), 0) <= maxTokens;
  let lo = MIN_LEVEL_TOKENS;
  let hi = Math.max(...tokens);
  if (!fits(lo)) hi = lo;
  else {
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
  }
  const level = lo;
  return contents.map((c, i) => {
    if (tokens[i]! <= level) return c;
    // Tokens → characters, conservatively (the estimator counts ≤ 4 ASCII chars per token; the marker costs ~40).
    let keepChars = Math.max(0, (level - 48) * 4);
    while (keepChars > 0 && estimateTokens(c.slice(0, keepChars)) > level - 48) keepChars = Math.floor(keepChars * 0.9);
    return c.slice(0, keepChars) + STEP_MARKER(keepChars, c.length);
  });
}
