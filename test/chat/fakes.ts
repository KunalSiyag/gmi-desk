import type { CatalogModel } from '@shared/contracts/catalog';
import type { ChatSettings, ChatStreamEvent, ChatThreadSummary } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';
import type { BudgetCheck, SpendKind } from '@shared/contracts/usage';
import type { BudgetGuard, CatalogService, KeyProvider } from '@main/core/services';
import { chatGatewayRequest } from '@main/services/chat/service';
import type { ChatPlan, HistoryMessage } from '@main/services/chat/types';
import { buildChatBody } from '@main/services/gateway/body-chat';
import { buildResponsesBody } from '@main/services/gateway/body-responses';
import { buildRouterBody } from '@main/services/gateway/body-router';
import { capabilitiesFor } from '@main/services/gateway/capabilities';
import { readStreamParts, type StreamParser, type StreamPart } from '@main/services/gateway/parsers/common';
import type { GatewayClock } from '@main/services/gateway/types';
import type { TestContext } from '../helpers/context';

export function fakeKeys(key: string | null = 'sk-test-1234') {
  const reported: string[] = [];
  const keys: KeyProvider = {
    getInferenceKey: async () => key,
    requireInferenceKey: async () => {
      if (!key) throw new GmiError('no_api_key', 'Add a GMI inference API key in Settings.');
      return key;
    },
    reportInvalidKey: async (reason) => {
      reported.push(reason);
    },
  };
  return { keys, reported };
}

export function llm(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id.split('/').pop() ?? id,
    kind: 'llm',
    provider: 'GMI Cloud',
    description: null,
    iconUrl: null,
    tags: [],
    api: 'chat',
    contextLength: 1_048_576,
    quantization: 'fp8',
    llmPricing: { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: null },
    mediaPricing: null,
    discount: 0.5,
    inputs: [],
    outputs: [],
    available: true,
    featured: false,
    createdAt: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    isNew: false,
    leaderboard: null,
    sources: ['mcp'],
    ...over,
  };
}

export function fakeCatalog(models: CatalogModel[] = []): CatalogService {
  return {
    getSnapshot: async () => ({ models, updatedAt: null, sources: {}, refreshing: false }),
    findModel: async (id) => models.find((m) => m.id === id) ?? null,
  };
}

export function fakeBudget(check: Partial<BudgetCheck> = {}) {
  const recorded: Array<{ kind: SpendKind; modelId: string; usd: number; ref?: string | null }> = [];
  const checks: Array<{ estimatedUsd: number | null; kind: SpendKind }> = [];
  const budget: BudgetGuard = {
    check: async (estimatedUsd, kind) => {
      checks.push({ estimatedUsd, kind });
      return { allowed: true, needsConfirmation: false, reason: null, remainingTodayUsd: null, remainingMonthUsd: null, ...check };
    },
    record: async (entry) => {
      recorded.push(entry);
    },
    statusSnapshot: () => ({
      budget: { dailyUsd: null, monthlyUsd: null, confirmAboveUsd: 0, enforce: true },
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      remainingTodayUsd: null,
      remainingMonthUsd: null,
      updatedAt: new Date(0).toISOString(),
    }),
  };
  return { budget, recorded, checks };
}

/** A streaming SSE response the test feeds block by block (stays open until close()). */
export function controllableSse(headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const state = { cancelled: false, closed: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }),
    push(block: string) {
      if (!state.closed && !state.cancelled) controller?.enqueue(encoder.encode(block));
    },
    close() {
      if (state.closed || state.cancelled) return;
      state.closed = true;
      controller?.close();
    },
    state,
  };
}

/** Polls until `fn` returns a truthy value. */
export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function streamEvents(t: TestContext): ChatStreamEvent[] {
  return t.emitted.filter((e) => e.name === 'chat:stream').map((e) => e.payload as ChatStreamEvent);
}

export function threadEvents(t: TestContext): ChatThreadSummary[][] {
  return t.emitted.filter((e) => e.name === 'chat:threads').map((e) => e.payload as ChatThreadSummary[]);
}

/** Resolves with the final event (done | error) for a message. */
export function waitForEnd(t: TestContext, messageId: string) {
  return waitFor(() => streamEvents(t).find((e) => e.messageId === messageId && (e.type === 'done' || e.type === 'error')));
}

/** OpenAI-style chunk. */
export function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'zai-org/GLM-5.3', choices: [{ index: 0, delta, finish_reason: null }], ...extra };
}

/** Runs a response through a (gateway) parser and collects the parts. */
export async function collectParts(res: Response, parser: StreamParser): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of readStreamParts(res, parser, { signal: new AbortController().signal, onChunk: () => undefined })) parts.push(part);
  return parts;
}

/**
 * The body chat's request becomes on the wire: chat's GatewayRequest (chatGatewayRequest) through the gateway's
 * builders, with the capability table's defaults for `model` (catalog API `api`).
 */
export function wireBody(plan: { route: ChatPlan['route']; model: string | null; settings: ChatSettings; history: HistoryMessage[] }): Record<string, unknown> {
  const req = chatGatewayRequest('req-1', 'thread-1', plan);
  if (plan.route === 'router') return buildRouterBody(req, plan.settings.routerMode);
  const model = plan.model ?? '';
  const capabilities = capabilitiesFor(model, plan.route === 'responses' ? 'responses' : 'chat');
  const resolved = { model, maxOutputTokens: Math.min(req.maxOutputTokens, capabilities.maxOutputTokens), capabilities };
  return plan.route === 'responses' ? buildResponsesBody(req, resolved) : buildChatBody(req, resolved);
}

/**
 * A gateway clock running `factor` times faster than real time (timers fire after ms / factor), so minute-long
 * waits (the 60 s rate-limit give-up for chat) take milliseconds in tests.
 */
export function fastClock(factor = 1000): GatewayClock {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * factor,
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms / factor)),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
  };
}

/** Concatenated text of one channel. */
export function textOf(parts: StreamPart[], type: 'content' | 'reasoning'): string {
  return parts
    .filter((p): p is Extract<StreamPart, { type: 'content' | 'reasoning' }> => p.type === type)
    .map((p) => p.text)
    .join('');
}
