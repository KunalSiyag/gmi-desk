/**
 * Doom-loop detection (harness.md §6.4). Fed once per step, after the step's tool results are appended.
 *
 * | Signal                                         | Threshold            | Action                                  |
 * | identical (tool, canonical args)               | 3 calls in a row     | ask                                     |
 * | same normalised error text                     | 3 times              | 3rd: hint message; 4th: ask             |
 * | no new file change / path read / command       | 8 steps              | ask                                     |
 * | a file's content hash returns to an old state  | twice                | ask                                     |
 * | identical step signature (non-empty text)      | 2 steps in a row     | ask                                     |
 * | every result of the step is an execution error | 5 consecutive steps  | ask                                     |
 *
 * Empty assistant text never matches the step signature by itself: DeepSeek, GLM and Kimi send `content: ""` with
 * every tool call (RL-10). A command that ran and exited non-zero is EXECUTED (a failing test run is progress).
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../protocol';
import type { ToolErrorKind } from '../types';

export const DOOM_LIMITS = {
  identicalCalls: 3,
  sameErrorHint: 3,
  sameErrorAsk: 4,
  noProgressSteps: 8,
  oscillations: 2,
  identicalSteps: 2,
  failingSteps: 5,
} as const;

export type DoomSignal = 'identical_calls' | 'same_error' | 'no_progress' | 'oscillation' | 'identical_steps' | 'failing_steps';

export type DoomAction = { kind: 'hint'; signal: 'same_error' } | { kind: 'ask'; signal: DoomSignal; text: string };

export interface DoomCall {
  name: string;
  /** Raw argument JSON; canonicalised here (key order and whitespace do not matter). */
  args: string;
}

export interface DoomResult {
  ok: boolean;
  errorKind: ToolErrorKind | null;
  /** True when the error is a user decision (deny, cancel), which is not an execution error. */
  byUser?: boolean;
  /** Model-facing text (used for the same-error signal when !ok). */
  content: string;
  effects?: { readPaths?: string[]; changedPaths?: string[]; command?: string | null; contentHashes?: Record<string, string> };
}

export interface DoomStep {
  text: string;
  calls: DoomCall[];
  results: DoomResult[];
}

const EXECUTION_ERRORS: ReadonlySet<ToolErrorKind> = new Set(['invalid_args', 'execution', 'denied', 'timeout']);

export function canonicalArgs(raw: string): string {
  try {
    return canonicalJson(JSON.parse(raw === '' ? '{}' : raw));
  } catch {
    return raw.trim();
  }
}

/** Error text with digits and paths stripped (§6.4), so "line 12" and "line 13" are the same error. */
export function normaliseError(text: string): string {
  return text
    .slice(0, 2_000)
    .replace(/(?:[A-Za-z]:)?(?:[\w.@~-]*[\\/])+[\w.@-]*/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stepSignature(step: DoomStep): string | null {
  const text = step.text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  const calls = step.calls.map((c) => `${c.name}\0${canonicalArgs(c.args)}`).sort();
  return createHash('sha256').update(text).update('\u0001').update(calls.join('\u0002')).digest('hex');
}

export class DoomDetector {
  private lastCall: string | null = null;
  private callRun = 0;
  private readonly errorCounts = new Map<string, number>();
  private readonly seenReads = new Set<string>();
  private readonly seenCommands = new Set<string>();
  private readonly seenChanges = new Set<string>();
  private stepsWithoutProgress = 0;
  private readonly hashHistory = new Map<string, string[]>();
  private oscillations = 0;
  private lastSignature: string | null = null;
  private signatureRun = 0;
  private failingRun = 0;
  private seenCalls = new Set<string>();

  /** Feeds one step; returns the first action, or null. */
  observe(step: DoomStep): DoomAction | null {
    const actions: DoomAction[] = [];

    // 1. Identical (tool, canonical args), consecutive across steps.
    for (const c of step.calls) {
      const key = `${c.name}\0${canonicalArgs(c.args)}`;
      if (key === this.lastCall) this.callRun += 1;
      else {
        this.lastCall = key;
        this.callRun = 1;
      }
      if (this.callRun >= DOOM_LIMITS.identicalCalls) {
        actions.push({ kind: 'ask', signal: 'identical_calls', text: `The agent repeated the same call ${this.callRun} times.` });
      }
    }

    // 2. The same normalised error text.
    for (const r of step.results) {
      if (r.ok || r.byUser) continue;
      const key = normaliseError(r.content);
      if (!key) continue;
      const n = (this.errorCounts.get(key) ?? 0) + 1;
      this.errorCounts.set(key, n);
      if (n === DOOM_LIMITS.sameErrorHint) actions.push({ kind: 'hint', signal: 'same_error' });
      else if (n >= DOOM_LIMITS.sameErrorAsk) actions.push({ kind: 'ask', signal: 'same_error', text: `The same error came back ${n} times.` });
    }

    // 3. No progress: no new file change, no new path read, no new command.
    let progress = false;
    for (const r of step.results) {
      const e = r.effects;
      if (!e) continue;
      for (const p of e.readPaths ?? []) if (!this.seenReads.has(p)) {
        this.seenReads.add(p);
        progress = true;
      }
      if (e.command && !this.seenCommands.has(e.command)) {
        this.seenCommands.add(e.command);
        progress = true;
      }
      for (const p of e.changedPaths ?? []) {
        const key = `${p}\0${e.contentHashes?.[p] ?? ''}`;
        if (!this.seenChanges.has(key)) {
          this.seenChanges.add(key);
          progress = true;
        }
      }
    }
    // Review H2: a successful call never made before (tool + canonical args: a new glob, list, search, page of a
    // file, URL) is progress too; the real tools report no command for most of these.
    step.calls.forEach((c, i) => {
      if (!step.results[i]?.ok) return;
      const key = `${c.name}\0${canonicalArgs(c.args)}`;
      if (this.seenCalls.has(key)) return;
      this.seenCalls.add(key);
      if (this.seenCalls.size > 4_096) this.seenCalls.delete(this.seenCalls.values().next().value as string);
      progress = true;
    });
    this.stepsWithoutProgress = progress ? 0 : this.stepsWithoutProgress + 1;
    if (this.stepsWithoutProgress >= DOOM_LIMITS.noProgressSteps) {
      actions.push({ kind: 'ask', signal: 'no_progress', text: `No new file, read or command in ${this.stepsWithoutProgress} steps.` });
    }

    // 4. Edit oscillation: a file's content returns to an earlier (not the current) state.
    for (const r of step.results) {
      for (const [path, hash] of Object.entries(r.effects?.contentHashes ?? {})) {
        const history = this.hashHistory.get(path) ?? [];
        const current = history[history.length - 1];
        if (hash === current) continue;
        if (history.includes(hash)) this.oscillations += 1;
        history.push(hash);
        this.hashHistory.set(path, history.slice(-32));
      }
    }
    if (this.oscillations >= DOOM_LIMITS.oscillations) {
      actions.push({ kind: 'ask', signal: 'oscillation', text: 'A file went back to an earlier version twice.' });
    }

    // 5. Identical step signature (non-empty text only).
    const sig = stepSignature(step);
    if (sig !== null && sig === this.lastSignature) this.signatureRun += 1;
    else this.signatureRun = sig === null ? 0 : 1;
    this.lastSignature = sig;
    if (this.signatureRun >= DOOM_LIMITS.identicalSteps) {
      actions.push({ kind: 'ask', signal: 'identical_steps', text: `The agent sent the same step ${this.signatureRun} times in a row.` });
    }

    // 6. Failing steps: every result is an execution error (the tool could not run).
    const failing = step.results.length > 0 && step.results.every((r) => !r.ok && !r.byUser && r.errorKind !== null && EXECUTION_ERRORS.has(r.errorKind));
    this.failingRun = failing ? this.failingRun + 1 : 0;
    if (this.failingRun >= DOOM_LIMITS.failingSteps) {
      actions.push({ kind: 'ask', signal: 'failing_steps', text: `Every tool call failed in ${this.failingRun} steps in a row.` });
    }

    return actions.find((a) => a.kind === 'ask') ?? actions[0] ?? null;
  }

  /** After the user chose "Continue": the signal that fired starts counting again. */
  reset(signal: DoomSignal): void {
    switch (signal) {
      case 'identical_calls':
        this.lastCall = null;
        this.callRun = 0;
        break;
      case 'same_error':
        this.errorCounts.clear();
        break;
      case 'no_progress':
        this.stepsWithoutProgress = 0;
        break;
      case 'oscillation':
        this.oscillations = 0;
        break;
      case 'identical_steps':
        this.lastSignature = null;
        this.signatureRun = 0;
        break;
      case 'failing_steps':
        this.failingRun = 0;
        break;
    }
  }
}
