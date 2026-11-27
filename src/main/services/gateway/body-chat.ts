/**
 * Chat Completions request body (harness.md §4.2 "Request body"). Key order is fixed (deterministic bytes); the
 * first keys are exactly the chat slice's buildChatCompletionsBody, so chat's bodies stay byte-equal except for the
 * parameters added at the end (`context_length_exceeded_behavior`, tools, cache key).
 */
import type { GatewayRequest } from '@shared/contracts/gateway';
import { GMI_URLS } from '@shared/app';
import { toChatMessages, toChatTools } from './messages';
import type { ModelCapabilities, ResolvedModel } from './types';

export const CHAT_COMPLETIONS_URL = `${GMI_URLS.inference}/chat/completions`;

export type ChatBodyRequest = Pick<GatewayRequest, 'messages' | 'tools' | 'toolChoice' | 'parallelToolCalls' | 'temperature' | 'reasoningEffort' | 'cacheKey'>;

export function buildChatBody(req: ChatBodyRequest, resolved: Pick<ResolvedModel, 'model' | 'maxOutputTokens'> & { capabilities: ModelCapabilities }): Record<string, unknown> {
  const caps = resolved.capabilities;
  const model = resolved.model ?? '';
  const body: Record<string, unknown> = {
    model,
    messages: toChatMessages(req.messages, caps, model),
    stream: true,
  };
  if (caps.includeUsage) body.stream_options = { include_usage: true };
  body[caps.maxTokensField] = resolved.maxOutputTokens;
  if (typeof req.temperature === 'number' && caps.temperature) body.temperature = req.temperature;
  if (req.reasoningEffort && caps.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
  const tools = req.tools ?? [];
  if (tools.length > 0) {
    body.tools = toChatTools(tools, caps.strictTools);
    if (req.toolChoice) body.tool_choice = req.toolChoice === 'required' && !caps.toolChoiceRequired ? 'auto' : req.toolChoice;
    if (typeof req.parallelToolCalls === 'boolean' && caps.parallelToolCalls) body.parallel_tool_calls = req.parallelToolCalls;
  }
  // GMI truncates silently by default [V]; "error" makes an overflow visible (DH6).
  if (caps.ctxExceededParam) body.context_length_exceeded_behavior = 'error';
  if (caps.cacheKeyParam && req.cacheKey) body[caps.cacheKeyParam] = req.cacheKey;
  return body;
}

/** The same body with `max_tokens` renamed (GMI answered 400 asking for max_completion_tokens); key order kept. */
export function withMaxCompletionTokens(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!('max_tokens' in body)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k === 'max_tokens' ? 'max_completion_tokens' : k] = v;
  return out;
}
