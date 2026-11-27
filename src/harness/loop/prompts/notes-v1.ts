/**
 * Fixed texts the loop adds to history (harness.md §6.2–§6.5, §7.1). History is append-only and replayed
 * byte-for-byte, so these strings are part of what the prompt cache sees: change them only with a version bump.
 */

/** §6.2 step 4: `length` with no tool calls → one continuation request. */
export const CONTINUATION_LENGTH_V1 = 'Your previous response was cut off by the output limit. Continue exactly where you stopped; do not repeat.';

/** §6.2 step 8: a stream cut after output (no incomplete tool-call deltas) → one continuation request. */
export const CONTINUATION_CUT_V1 = 'Your previous response was cut off by a connection error. Continue exactly where you stopped; do not repeat.';

/** §6.3 step cap: the final request (tool_choice "none", max_tokens 1,500). */
export const MAX_STEPS_V1 = 'You have reached the step limit for this turn. Do not call any tools. Summarise what is done, what is left, and the next step.';

/** §6.2 step 4: `length` while a tool call's arguments were being written. */
export function lengthInArgsNoteV1(tool: string): string {
  return `Output limit hit while writing ${tool} arguments; split the change into smaller edits.`;
}

/** §6.4: the same error three times. */
export const DOOM_HINT_V1 = 'Same error 3×: reconsider the approach; read the error carefully.';

/** §6.5 resume of a stopped turn whose last message is the assistant's: the model needs a user message. */
export const RESUME_V1 = 'Continue.';

/** §7.4 summary rows (role `system` in storage, sent as a user message right after `[user#0]`). */
export const SUMMARY_PREFIX_V1 = 'Summary of earlier work in this thread:';
