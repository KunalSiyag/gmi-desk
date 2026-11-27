/**
 * Canonical GwMessage[] → each API's wire messages (harness.md §4.2 "Messages"). Serialisation is deterministic:
 * every object is built with a fixed key order, `undefined` never appears, nothing time-dependent is added — the
 * byte-stable prompt prefix (§7.1) depends on it.
 */
import type { GwMessage, GwPart, GwToolDef } from '@shared/contracts/gateway';
import { reasoningFamily } from './capabilities';
import type { ModelCapabilities } from './types';

export type WireContent = string | Array<{ type: 'text'; text: string }>;

function wireContent(content: string | GwPart[]): WireContent {
  if (typeof content === 'string') return content;
  return content.map((p) => ({ type: 'text' as const, text: p.text }));
}

/** Plain text of a message's content (parts joined). */
export function contentText(content: string | GwPart[]): string {
  return typeof content === 'string' ? content : content.map((p) => p.text).join('');
}

/** Index of the last user message (the current turn starts there); -1 when none. */
function lastUserIndex(messages: readonly GwMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === 'user') return i;
  return -1;
}

/**
 * The `reasoning_content` to replay on the assistant message at `index`, or undefined (omitted):
 * - `tool_loop`: only assistant messages of the current user turn (after the last user message), same family;
 * - `always`: every assistant message with reasoning of the same family;
 * - `empty`: `""` on every assistant message;
 * - `never`: omitted.
 */
function replayedReasoning(m: GwMessage, index: number, currentTurnStart: number, mode: ModelCapabilities['reasoningReplay'], family: string): string | undefined {
  if (m.role !== 'assistant') return undefined;
  if (mode === 'empty') return '';
  if (mode === 'never' || !m.reasoning || typeof m.reasoning.text !== 'string') return undefined;
  if (m.reasoning.family.toLowerCase() !== family) return undefined;
  if (mode === 'tool_loop' && index < currentTurnStart) return undefined;
  return m.reasoning.text;
}

/** Chat Completions messages (also the base of the router's). */
export function toChatMessages(messages: readonly GwMessage[], caps: Pick<ModelCapabilities, 'reasoningReplay' | 'developerRole'>, modelId: string): Array<Record<string, unknown>> {
  const turnStart = lastUserIndex(messages);
  const family = reasoningFamily(modelId);
  return messages.map((m, i) => {
    if (m.role === 'tool') {
      const out: Record<string, unknown> = { role: 'tool', tool_call_id: m.toolCallId ?? '', content: wireContent(m.content) };
      if (m.name) out.name = m.name;
      return out;
    }
    const role = m.role === 'system' && caps.developerRole ? 'developer' : m.role;
    const out: Record<string, unknown> = { role, content: wireContent(m.content) };
    if (m.role === 'user' && m.name) out.name = m.name;
    const reasoning = replayedReasoning(m, i, turnStart, caps.reasoningReplay, family);
    if (reasoning !== undefined) out.reasoning_content = reasoning;
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
    }
    return out;
  });
}

/** Chat Completions `tools`. */
export function toChatTools(tools: readonly GwToolDef[], strict: boolean): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn: Record<string, unknown> = { name: t.name, description: t.description, parameters: t.parameters };
    if (strict) fn.strict = true;
    return { type: 'function', function: fn };
  });
}

/** Router messages: role and text only (the router takes plain chat, harness.md §4.2). */
export function toRouterMessages(messages: readonly GwMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: contentText(m.content) }));
}

/**
 * Responses API input. Leading system messages become `instructions` (as chat's buildResponsesBody did);
 * a later system message stays an input item. Assistant tool calls become `function_call` items after the
 * assistant's text, tool results `function_call_output` items. Reasoning is not replayed: encrypted reasoning
 * items have no field in GwMessage yet (H-P7).
 */
export function toResponsesInput(messages: readonly GwMessage[]): { instructions: string | null; input: Array<Record<string, unknown>> } {
  const leading: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i]!.role === 'system') {
    leading.push(contentText(messages[i]!.content));
    i += 1;
  }
  const input: Array<Record<string, unknown>> = [];
  for (const m of messages.slice(i)) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: contentText(m.content) });
      continue;
    }
    const text = contentText(m.content);
    const hasCalls = m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0;
    if (!hasCalls || text) input.push({ role: m.role, content: typeof m.content === 'string' ? m.content : text });
    if (hasCalls) {
      for (const c of m.toolCalls!) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
    }
  }
  return { instructions: leading.length > 0 ? leading.join('\n\n') : null, input };
}

/** Responses `tools` (flat function tools). */
export function toResponsesTools(tools: readonly GwToolDef[], strict: boolean): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const out: Record<string, unknown> = { type: 'function', name: t.name, description: t.description, parameters: t.parameters };
    if (strict) out.strict = true;
    return out;
  });
}
