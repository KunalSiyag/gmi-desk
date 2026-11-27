/**
 * Prompt texts of the loop (harness.md §7.1, §14 "Prompts"). The texts live in `prompts/*-v<N>.ts` as string
 * modules (the build has no Markdown loader); the version is part of the prefix hash, because the system text is.
 *
 * Volatile texts (mode rules, date, budget) are built here too, but they go ONLY into the turn's user message
 * (`[user#N]`), never into the prefix.
 */
import type { RuntimeMode } from '@shared/contracts/code';
import { SYSTEM_PROMPT_V1 } from './prompts/system-v1';
import {
  CONTINUATION_CUT_V1,
  CONTINUATION_LENGTH_V1,
  DOOM_HINT_V1,
  lengthInArgsNoteV1,
  MAX_STEPS_V1,
  RESUME_V1,
  SUMMARY_PREFIX_V1,
} from './prompts/notes-v1';

export const PROMPT_VERSION = 'v1';

export const PROMPTS = {
  system: SYSTEM_PROMPT_V1,
  continuationLength: CONTINUATION_LENGTH_V1,
  continuationCut: CONTINUATION_CUT_V1,
  maxSteps: MAX_STEPS_V1,
  lengthInArgs: lengthInArgsNoteV1,
  doomHint: DOOM_HINT_V1,
  resume: RESUME_V1,
  summaryPrefix: SUMMARY_PREFIX_V1,
} as const;

/** Output limit of the step-cap summary request (§6.3). */
export const MAX_STEPS_OUTPUT_TOKENS = 1_500;

/** Project instruction files, in this order, from the trusted snapshot (§7.1). */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.gmi-desk/instructions.md'] as const;
/** Cap of the `<project-instructions>` block (§7.1). */
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
/** Cap of the git status in the volatile block (§7.1). */
export const GIT_STATUS_MAX_BYTES = 2 * 1024;

/** One line per mode for the volatile `<context>` block (§7.1, §9.2). */
export const MODE_RULES: Record<RuntimeMode, string> = {
  'approval-required': 'approval-required: every file edit, shell command (except read-only ones) and network access waits for the user\'s approval.',
  'auto-accept-edits': 'auto-accept-edits: file edits inside the worktree are applied without asking; shell commands (except read-only and approved ones) and network access wait for approval.',
  auto: 'auto: file edits and sandboxed shell commands (no network) run without asking; network access waits for approval.',
  'full-access': 'full-access: edits, shell commands and network access run without asking; destructive commands and paid tools still wait for approval.',
};

/** Synthetic tool results (§6.1 invariant 1, §5.1, §6.5). The model sees these as the call's result. */
export const SYNTHETIC = {
  cancelled: 'Cancelled by the user.',
  restarted: 'Interrupted: the runtime restarted. State unknown; re-check before retrying.',
  restartedNotRun: 'Not executed: the runtime restarted before this call ran.',
  shutdown: 'Interrupted: the app was closing. State unknown; re-check before retrying.',
  timeCap: 'Not executed: the turn reached its time limit.',
  timeCapRunning: 'Interrupted: the turn reached its time limit. State unknown; re-check before retrying.',
  stepCap: 'Not executed: step cap reached.',
  invalidBudget: 'Not executed: too many invalid tool calls in this step.',
  runStopped: 'Not executed: the run stopped.',
} as const;

/** Truncates `text` to `maxBytes` UTF-8 bytes (on a character boundary) with a marker. */
export function capBytes(text: string, maxBytes: number, marker = '\n[truncated]'): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  // Never split a surrogate pair.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + marker;
}
