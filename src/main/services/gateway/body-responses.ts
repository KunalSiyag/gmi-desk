/**
 * Responses API request body (harness.md §4.2, DH5): stateless full replay (`store: false`, never
 * `previous_response_id`). The first keys are exactly the chat slice's buildResponsesBody (byte parity); the
 * parameters the gateway adds come last.
 */
import type { GatewayRequest } from '@shared/contracts/gateway';
import { GMI_URLS } from '@shared/app';
import { toResponsesInput, toResponsesTools } from './messages';
import type { ModelCapabilities, ResolvedModel } from './types';

export const RESPONSES_URL = `${GMI_URLS.inference}/responses`;

export type ResponsesBodyRequest = Pick<GatewayRequest, 'messages' | 'tools' | 'toolChoice' | 'parallelToolCalls' | 'temperature' | 'reasoningEffort' | 'cacheKey'>;

export function buildResponsesBody(req: ResponsesBodyRequest, resolved: Pick<ResolvedModel, 'model' | 'maxOutputTokens'> & { capabilities: ModelCapabilities }): Record<string, unknown> {
  const caps = resolved.capabilities;
  const { instructions, input } = toResponsesInput(req.messages);
  const body: Record<string, unknown> = {
    model: resolved.model ?? '',
    input,
    stream: true,
    max_output_tokens: resolved.maxOutputTokens,
  };
  if (instructions) body.instructions = instructions;
  if (req.reasoningEffort && caps.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
  if (typeof req.temperature === 'number' && caps.temperature) body.temperature = req.temperature;
  const tools = req.tools ?? [];
  if (tools.length > 0) {
    body.tools = toResponsesTools(tools, caps.strictTools);
    if (req.toolChoice) body.tool_choice = req.toolChoice === 'required' && !caps.toolChoiceRequired ? 'auto' : req.toolChoice;
    if (typeof req.parallelToolCalls === 'boolean' && caps.parallelToolCalls) body.parallel_tool_calls = req.parallelToolCalls;
  }
  // Whether GMI keeps Responses server state is [U] (privacy): never store.
  body.store = false;
  if (caps.cacheKeyParam && req.cacheKey) body[caps.cacheKeyParam] = req.cacheKey;
  return body;
}
