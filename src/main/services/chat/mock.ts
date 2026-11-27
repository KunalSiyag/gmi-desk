/**
 * Mock mode (GMI_DESK_MOCK=1, screenshots): demo threads seeded on first run, priced from the mock table.
 * The simulated streaming of canned replies moved to the gateway's mock transport (services/gateway/mock.ts,
 * harness.md §4.8), which reads the same fixtures. No network and no API key involved.
 */
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSettings, RoutingInfo, TokenUsage } from '@shared/contracts/chat';
import { estimateTokenCostUsd } from '@shared/lib/money';
import demoThreadsJson from '../../mock/fixtures/chat/demo-threads.json';
import pricingJson from '../../mock/fixtures/chat/pricing.json';
import { normalizeChatSettings } from './settings';
import { defaultChatSettings, threadCost, type ThreadRecord } from './store';

interface SeedMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  model?: string | null;
  routing?: RoutingInfo | null;
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number | null; cachedTokens: number | null };
  minutesBefore: number;
  durationSec?: number;
}

interface SeedThread {
  id: string;
  title: string;
  at: { minutesAgo?: number; daysAgo?: number; hour?: number; minute?: number };
  settings: Partial<ChatSettings>;
  messages: SeedMessage[];
}

interface MockPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  discount: number;
  reasoning: boolean;
}

const SEEDS = (demoThreadsJson as unknown as { threads: SeedThread[] }).threads;
const PRICES = (pricingJson as unknown as { models: Record<string, MockPrice> }).models;

/** Ids of the seeded demo threads (deterministic, so screenshots can link to them). */
export const MOCK_THREAD_IDS: readonly string[] = SEEDS.map((t) => t.id);

/** List-price cost with the mock discount, for models the (mock) catalog does not know. */
export function mockCostUsd(modelId: string, usage: TokenUsage): number | null {
  const price = PRICES[modelId];
  if (!price) return null;
  return estimateTokenCostUsd(usage, price, price.discount);
}

function seedTime(at: SeedThread['at'], now: Date): Date {
  if (at.minutesAgo !== undefined) return new Date(now.getTime() - at.minutesAgo * 60_000);
  const d = new Date(now);
  d.setDate(d.getDate() - (at.daysAgo ?? 0));
  d.setHours(at.hour ?? 12, at.minute ?? 0, 0, 0);
  return d.getTime() > now.getTime() ? new Date(now.getTime() - 60_000) : d;
}

/** The demo threads, with timestamps relative to `now` so they land in Today / Yesterday / Previous 7 days. */
export function buildSeedThreads(now: Date): ThreadRecord[] {
  return SEEDS.map((seed) => {
    const end = seedTime(seed.at, now);
    const settings = normalizeChatSettings(seed.settings, defaultChatSettings());
    const messages: ChatMessage[] = seed.messages.map((m, i) => {
      const createdAt = new Date(end.getTime() - m.minutesBefore * 60_000 + i * 2_000);
      if (m.role === 'user') {
        return {
          id: randomUUID(),
          role: 'user',
          content: m.content,
          reasoning: null,
          model: null,
          routing: null,
          usage: null,
          costUsd: null,
          createdAt: createdAt.toISOString(),
          status: 'complete',
          error: null,
        };
      }
      const usage: TokenUsage | null = m.usage
        ? { ...m.usage, totalTokens: m.usage.promptTokens + m.usage.completionTokens }
        : null;
      const model = m.routing?.selectedModel ?? m.model ?? null;
      return {
        id: randomUUID(),
        role: 'assistant',
        content: m.content,
        reasoning: m.reasoning ?? null,
        model,
        routing: m.routing ?? null,
        usage,
        costUsd: usage && model ? mockCostUsd(model, usage) : null,
        createdAt: createdAt.toISOString(),
        status: 'complete',
        error: null,
        finishReason: 'stop',
        completedAt: new Date(createdAt.getTime() + (m.durationSec ?? 5) * 1000).toISOString(),
      };
    });
    const first = messages[0]?.createdAt ?? end.toISOString();
    const last = messages[messages.length - 1];
    const record: ThreadRecord = {
      id: seed.id,
      title: seed.title,
      mode: settings.mode,
      model: settings.mode === 'model' ? settings.model : null,
      createdAt: first,
      updatedAt: last?.createdAt ?? first,
      messageCount: messages.length,
      costUsd: 0,
      settings,
      messages,
      titleCustom: false,
      discardedCostUsd: 0,
    };
    record.costUsd = threadCost(record);
    return record;
  });
}
