/**
 * Cheap side tasks through the gateway (harness.md §4.7, §12): thread titles and commit messages, on the thread's
 * `sideTaskModel` (a cheap model id, or GMI Router with 'router'), at `background` priority, with small output
 * limits. No tools, no prefix: these requests are tiny and never share the agent's cache.
 *
 * Token thrift: when no side-task model is set, the title is derived from the message for free.
 */
import { GmiError } from '@shared/contracts/errors';
import type { GatewayRequest, GatewayScope } from '@shared/contracts/gateway';
import { newId, type GatewayClient } from '../types';

export const SIDE_TASK_LIMITS = {
  titleOutputTokens: 32,
  titleInputChars: 2_000,
  titleMaxChars: 80,
  commitOutputTokens: 200,
  commitInputChars: 24_000,
  commitMaxChars: 2_000,
} as const;

const TITLE_INSTRUCTION = 'Write a short title (at most 8 words) for this coding task. Reply with the title only, no quotes or punctuation at the end.';
const COMMIT_INSTRUCTION =
  'Write a git commit message for this diff: a subject line of at most 72 characters in the imperative mood, then a blank line and at most 5 short bullet lines if needed. Reply with the message only.';

/** A free title: the message's first non-empty line, whitespace collapsed, ≤ 80 characters. */
export function fallbackTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const t = line.replace(/\s+/g, ' ');
  return t.length > SIDE_TASK_LIMITS.titleMaxChars ? `${t.slice(0, SIDE_TASK_LIMITS.titleMaxChars - 1).trimEnd()}…` : t || 'New thread';
}

export function cleanTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const t = line.replace(/^["'`*#\s]+|["'`*\s.]+$/g, '').replace(/\s+/g, ' ');
  return t.length > SIDE_TASK_LIMITS.titleMaxChars ? `${t.slice(0, SIDE_TASK_LIMITS.titleMaxChars - 1).trimEnd()}…` : t;
}

export function cleanCommitMessage(raw: string): string {
  const text = raw.replace(/^```[a-z]*\n?|```$/gm, '').trim();
  return text.length > SIDE_TASK_LIMITS.commitMaxChars ? text.slice(0, SIDE_TASK_LIMITS.commitMaxChars) : text;
}

function target(model: string): GatewayRequest['target'] {
  // GMI Router in its cheapest mode: side tasks are trivial.
  return model === 'router' ? { router: 'cost' } : { model };
}

async function complete(gateway: GatewayClient, req: GatewayRequest, signal: AbortSignal): Promise<{ text: string; costUsd: number | null }> {
  let text = '';
  let costUsd: number | null = null;
  for await (const ev of gateway.stream(req, signal)) {
    if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'usage') costUsd = ev.costUsd;
    else if (ev.type === 'error') throw new GmiError(ev.error.code, ev.error.message);
  }
  return { text, costUsd };
}

export interface SideTaskInput {
  scope: GatewayScope;
  /** A model id, or 'router' for GMI Router. */
  model: string;
  signal: AbortSignal;
}

export async function generateTitle(gateway: GatewayClient, input: SideTaskInput & { text: string }): Promise<{ title: string; costUsd: number | null }> {
  const req: GatewayRequest = {
    requestId: newId('req'),
    purpose: 'title',
    priority: 'background',
    scope: input.scope,
    target: target(input.model),
    messages: [
      { role: 'system', content: TITLE_INSTRUCTION },
      { role: 'user', content: input.text.slice(0, SIDE_TASK_LIMITS.titleInputChars) },
    ],
    maxOutputTokens: SIDE_TASK_LIMITS.titleOutputTokens,
    prefixHash: null,
  };
  const { text, costUsd } = await complete(gateway, req, input.signal);
  const title = cleanTitle(text);
  return { title: title || fallbackTitle(input.text), costUsd };
}

export async function suggestCommitMessage(gateway: GatewayClient, input: SideTaskInput & { diff: string }): Promise<{ message: string; costUsd: number | null }> {
  const diff = input.diff.length > SIDE_TASK_LIMITS.commitInputChars ? `${input.diff.slice(0, SIDE_TASK_LIMITS.commitInputChars)}\n[diff truncated]` : input.diff;
  const req: GatewayRequest = {
    requestId: newId('req'),
    purpose: 'commit_message',
    priority: 'background',
    scope: input.scope,
    target: target(input.model),
    messages: [
      { role: 'system', content: COMMIT_INSTRUCTION },
      { role: 'user', content: diff },
    ],
    maxOutputTokens: SIDE_TASK_LIMITS.commitOutputTokens,
    prefixHash: null,
  };
  const { text, costUsd } = await complete(gateway, req, input.signal);
  const message = cleanCommitMessage(text);
  if (!message) throw new GmiError('upstream', 'The model returned no commit message.');
  return { message, costUsd };
}
