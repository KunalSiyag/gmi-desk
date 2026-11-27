/**
 * The gateway's mock "model" (GMI_DESK_MOCK=1, screenshots, tests; harness.md §15). It replaces only the transport:
 * validation, scheduling, metering and reservations run exactly as in real mode.
 *  - Chat: replays the chat fixtures (`fixtures/chat/replies.json`), moved here from the chat slice's mock stream
 *    (same pacing, reasoning, routing and usage numbers, so the mock chat looks as before).
 *  - Agent purposes with tools: a deterministic tool-call script chosen by keywords in the last user message
 *    ("fix the failing test" → read, grep, edit, bash; otherwise list, read), then a final answer; the cached share
 *    of the prompt rises after the first step, so meters look real.
 *  - "simulate error" fails mid-stream (rate limit, partial output kept); "simulate overflow" is refused before
 *    any byte, as GMI does with `context_length_exceeded_behavior: "error"`.
 * No network and no API key involved.
 */
import { randomUUID } from 'node:crypto';
import type { RouterMode } from '@shared/contracts/app';
import type { LlmPricing } from '@shared/contracts/catalog';
import type { RoutingInfo } from '@shared/contracts/chat';
import type { GatewayRequest, GwMessage, GwToolDef } from '@shared/contracts/gateway';
import { GmiError } from '@shared/contracts/errors';
import pricingJson from '../../mock/fixtures/chat/pricing.json';
import repliesJson from '../../mock/fixtures/chat/replies.json';
import { contentText } from './messages';
import type { Transport } from './gateway';
import type { StreamPart } from './parsers/common';
import type { ResolvedModel } from './types';

interface CannedReply {
  id: string;
  match: string[];
  reasoning: string | null;
  content: string;
}

interface MockRoute {
  task: string;
  match: string[];
  models: Record<RouterMode, string>;
  fallbacks: string[];
}

interface MockPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  discount: number;
  reasoning: boolean;
}

const REPLIES = (repliesJson as unknown as { replies: CannedReply[]; routes: MockRoute[] }).replies;
const ROUTES = (repliesJson as unknown as { replies: CannedReply[]; routes: MockRoute[] }).routes;
const PRICES = (pricingJson as unknown as { models: Record<string, MockPrice> }).models;

/** Mock list prices and discount for models the (mock) catalog does not know (resolver fallback in mock mode). */
export function mockPricing(modelId: string): { pricing: LlmPricing; discount: number | null } | null {
  const price = PRICES[modelId];
  if (!price) return null;
  return {
    pricing: { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok, cacheReadPerMTok: price.cacheReadPerMTok, cacheWritePerMTok: null },
    discount: price.discount,
  };
}

function matches(prompt: string, words: string[]): boolean {
  return words.some((w) => prompt.includes(w));
}

export function pickMockReply(prompt: string): CannedReply {
  const lower = prompt.toLowerCase();
  const reply = REPLIES.find((r) => r.match.length > 0 && matches(lower, r.match)) ?? REPLIES.find((r) => r.match.length === 0) ?? REPLIES[0];
  if (!reply) throw new GmiError('internal', 'Mock replies are missing.');
  return reply;
}

export function pickMockRoute(prompt: string, mode: RouterMode): Omit<RoutingInfo, 'recommendationId'> {
  const lower = prompt.toLowerCase();
  const route = ROUTES.find((r) => r.match.length > 0 && matches(lower, r.match)) ?? ROUTES.find((r) => r.match.length === 0) ?? ROUTES[0];
  if (!route) throw new GmiError('internal', 'Mock routes are missing.');
  return { selectedModel: route.models[mode] ?? route.models.balanced, taskType: route.task, mode, fallbackModels: route.fallbacks };
}

function isReasoningModel(model: string | null): boolean {
  if (!model) return false;
  return PRICES[model]?.reasoning ?? /thinking|-r1|reason/i.test(model);
}

/** Splits text into chunks of `min`–`max` characters, like a token stream (deterministic with a fixed `random`). */
function chunks(text: string, random: () => number, min = 2, max = 7): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = min + Math.floor(random() * (max - min + 1));
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function pause(ms: number, speed: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const wait = Math.max(0, ms * speed);
  if (wait === 0) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, wait);
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface MockOpenInput {
  req: Pick<GatewayRequest, 'purpose' | 'messages' | 'tools' | 'reasoningEffort' | 'target'>;
  resolved: Pick<ResolvedModel, 'model' | 'router' | 'api'>;
  signal: AbortSignal;
  /** 1 = realistic pacing; 0 = as fast as possible (tests). */
  speed: number;
  random?: () => number;
}

const lastUserText = (messages: readonly GwMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === 'user') return contentText(messages[i]!.content);
  return '';
};

/** The chat mock's usage rule: prompt ≈ chars/4 + 6 per message, 60 % cached once the history has 3+ messages. */
function chatUsage(messages: readonly GwMessage[], content: string, reasoning: string | null) {
  const system = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content).length);
  const history = messages.filter((m) => m.role !== 'system');
  const promptChars = history.reduce((sum, m) => sum + contentText(m.content).length, 0) + (system[0] ?? 0);
  const promptTokens = Math.max(8, Math.ceil(promptChars / 4) + 6 * history.length);
  const reasoningTokens = reasoning ? Math.ceil(reasoning.length / 4) : null;
  const completionTokens = Math.ceil(content.length / 4) + (reasoningTokens ?? 0);
  const cached = history.length > 2 ? Math.floor((promptTokens * 0.6) / 64) * 64 : 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens, cachedTokens: cached > 0 ? cached : null };
}

/**
 * Opens a mock reply: resolves like a 2xx response (or throws a GmiError with an HTTP status, like ctx.http),
 * then yields the reply's parts.
 */
export async function mockOpen(input: MockOpenInput): Promise<AsyncIterable<StreamPart>> {
  const prompt = lastUserText(input.req.messages);
  if (/simulate (an )?overflow/i.test(prompt)) {
    throw new GmiError('invalid_input', "This model's maximum context length is 1048576 tokens; your request has more (simulated in demo mode).", { status: 400 });
  }
  await pause(0, 0, input.signal);
  if (input.signal.aborted) throw new GmiError('cancelled', 'The request was cancelled.');
  const tools = input.req.tools ?? [];
  if (input.req.purpose !== 'chat' && tools.length > 0 && input.resolved.api !== 'router') return agentStream(input, tools);
  return chatStream(input, prompt);
}

async function* chatStream(input: MockOpenInput, prompt: string): AsyncGenerator<StreamPart> {
  const { signal, speed } = input;
  const random = input.random ?? Math.random;
  const reply = pickMockReply(prompt);
  let model = input.resolved.model;

  if (input.resolved.router) {
    await pause(380, speed, signal);
    if (signal.aborted) return;
    const routing: RoutingInfo = { ...pickMockRoute(prompt, input.resolved.router), recommendationId: randomUUID() };
    model = routing.selectedModel;
    yield { type: 'routing', routing };
  }
  await pause(260, speed, signal);

  const reasoning = reply.reasoning && (isReasoningModel(model) || (input.req.reasoningEffort ?? null) !== null) ? reply.reasoning : null;
  if (reasoning) {
    for (const piece of chunks(reasoning, random, 4, 10)) {
      await pause(14, speed, signal);
      if (signal.aborted) return;
      yield { type: 'reasoning', text: piece };
    }
    await pause(200, speed, signal);
  }

  // "simulate error" in a prompt demonstrates the mid-stream failure path (partial output is kept).
  const failHalfway = /simulate (an )?error/i.test(prompt);
  const content = reply.content;
  const pieces = chunks(content, random);
  for (const [i, piece] of pieces.entries()) {
    await pause(15, speed, signal);
    if (signal.aborted) return;
    if (failHalfway && i === Math.floor(pieces.length / 2)) {
      yield { type: 'error', error: new GmiError('rate_limited', 'GMI is rate-limiting this organization (simulated in demo mode).', { status: 429 }) };
      return;
    }
    yield { type: 'content', text: piece };
  }

  yield { type: 'usage', usage: chatUsage(input.req.messages, content, reasoning), cacheWriteTokens: null };
  yield { type: 'finish', reason: 'stop' };
}

/** Canned arguments per built-in tool name (harness.md §8.1). */
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  list: { path: '.' },
  read: { path: 'src/sum.ts' },
  glob: { pattern: 'src/**/*.ts' },
  grep: { pattern: 'sum\\(', path: 'src' },
  edit: { path: 'src/sum.ts', old: 'return a - b;', new: 'return a + b;' },
  bash: { command: 'npm test' },
};

function scriptFor(prompt: string): string[] {
  return /fix|fail|test|bug/i.test(prompt) ? ['read', 'grep', 'edit', 'bash'] : ['list', 'read'];
}

async function* agentStream(input: MockOpenInput, tools: readonly GwToolDef[]): AsyncGenerator<StreamPart> {
  const { signal, speed } = input;
  const messages = input.req.messages;
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') {
      turnStart = i;
      break;
    }
  }
  const step = messages.slice(turnStart).filter((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0).length;
  const available = new Set(tools.map((t) => t.name));
  const script = scriptFor(lastUserText(messages)).filter((name) => available.has(name));
  const promptChars = messages.reduce((sum, m) => sum + contentText(m.content).length + (m.toolCalls ?? []).reduce((s, c) => s + c.arguments.length, 0), 0) + JSON.stringify(tools).length;
  const promptTokens = Math.max(16, Math.ceil(promptChars / 4) + 4 * messages.length);
  const cachedTokens = step === 0 ? null : Math.floor((promptTokens * Math.min(0.95, 0.7 + 0.05 * step)) / 64) * 64 || null;
  await pause(220, speed, signal);
  if (signal.aborted) return;

  const next = script[step];
  if (next) {
    const args = JSON.stringify(TOOL_ARGS[next] ?? {});
    const id = `call_mock_${step}`;
    yield { type: 'content', text: `Step ${step + 1}: using ${next}.` };
    const half = Math.ceil(args.length / 2);
    yield { type: 'tool_call_delta', index: 0, id, name: next, argumentsDelta: args.slice(0, half) };
    await pause(20, speed, signal);
    if (signal.aborted) return;
    yield { type: 'tool_call_delta', index: 0, id: null, name: null, argumentsDelta: args.slice(half) };
    yield { type: 'tool_call', call: { id, name: next, arguments: args } };
    const completionTokens = 12 + Math.ceil(args.length / 4);
    yield { type: 'usage', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: null, cachedTokens }, cacheWriteTokens: null };
    yield { type: 'finish', reason: 'tool_calls' };
    return;
  }
  const answer = script.length > 0 ? 'Done: the change is made and the tests pass (simulated in demo mode).' : 'Done (simulated in demo mode).';
  for (const piece of chunks(answer, input.random ?? Math.random)) {
    await pause(15, speed, signal);
    if (signal.aborted) return;
    yield { type: 'content', text: piece };
  }
  const completionTokens = Math.ceil(answer.length / 4);
  yield { type: 'usage', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: null, cachedTokens }, cacheWriteTokens: null };
  yield { type: 'finish', reason: 'stop' };
}

/** The gateway transport in mock mode (no network): everything else in the gateway runs as in real mode. */
export function mockTransport(opts: { speed?: number; random?: () => number } = {}): Transport {
  return {
    open: (t) => mockOpen({ req: t.req, resolved: t.resolved, signal: t.signal, speed: opts.speed ?? 1, random: opts.random }),
  };
}
