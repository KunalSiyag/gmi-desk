import { vi } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import type { CatalogModel } from '@shared/contracts/catalog';
import { GmiError } from '@shared/contracts/errors';
import type { BudgetCheck } from '@shared/contracts/usage';
import type { AuthService, BudgetGuard, CatalogService, GmiToolName, McpGateway } from '@main/core/services';
import modelsFixture from '../../src/main/mock/fixtures/media/models.json';

export const FIXTURE_MODELS = modelsFixture.models as unknown as Record<string, Record<string, unknown>>;

export type ToolHandler = (args: Record<string, unknown>) => unknown;

export interface FakeMcp extends McpGateway {
  calls: Array<{ name: GmiToolName; args: Record<string, unknown> }>;
  handlers: Partial<Record<GmiToolName, ToolHandler>>;
  callsTo(name: GmiToolName): Array<Record<string, unknown>>;
}

/** MCP gateway double: per-tool handlers (may throw), every call recorded. get_model serves recorded fixtures. */
export function createFakeMcp(handlers: Partial<Record<GmiToolName, ToolHandler>> = {}): FakeMcp {
  const calls: FakeMcp['calls'] = [];
  const all: Partial<Record<GmiToolName, ToolHandler>> = {
    get_model: (args) => {
      const model = FIXTURE_MODELS[String(args.model_id)];
      if (!model) throw new GmiError('not_found', `unknown model ${String(args.model_id)}`);
      return model;
    },
    ...handlers,
  };
  return {
    calls,
    handlers: all,
    callsTo: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    async callTool<T>(name: GmiToolName, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const handler = all[name];
      if (!handler) throw new GmiError('not_implemented', `no fake for ${name}`);
      return (await handler(args)) as T;
    },
  };
}

export function createFakeAuth(signedIn = true) {
  const listeners = new Set<(state: AuthState) => void>();
  const state = (): AuthState => ({
    status: fake.signedIn ? 'signed_in' : 'signed_out',
    scopes: [],
    orgId: null,
    signedInAt: null,
    accessTokenExpiresAt: null,
    inferenceKey: {
      status: 'missing',
      source: null,
      last4: null,
      keyId: null,
      scope: null,
      orgId: null,
      orgMatchesAccount: null,
      validatedAt: null,
      error: null,
    },
    secureStorage: 'os',
    lastError: null,
    mock: false,
  });
  const fake: AuthService & { signedIn: boolean; setSignedIn(value: boolean): void } = {
    signedIn,
    getState: state,
    isSignedIn: () => fake.signedIn,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSignedIn(value) {
      fake.signedIn = value;
      for (const l of listeners) l(state());
    },
  };
  return fake;
}

export function catalogModel(partial: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    name: partial.id,
    kind: 'image',
    provider: null,
    description: null,
    iconUrl: null,
    tags: [],
    api: 'queue',
    contextLength: null,
    quantization: null,
    llmPricing: null,
    mediaPricing: null,
    discount: null,
    inputs: [],
    outputs: [],
    available: true,
    featured: false,
    createdAt: null,
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    isNew: false,
    leaderboard: null,
    sources: ['mcp'],
    ...partial,
  };
}

export function createFakeCatalog(models: CatalogModel[] = []): CatalogService {
  return {
    getSnapshot: async () => ({ models, updatedAt: null, sources: {}, refreshing: false }),
    findModel: async (id) => models.find((m) => m.id === id) ?? null,
  };
}

export interface FakeBudget extends BudgetGuard {
  next: BudgetCheck;
  recorded: Array<{ kind: string; modelId: string; usd: number; ref?: string | null }>;
  checks: Array<number | null>;
}

/** Budget double: returns `next` from check(), records spends. Defaults: allowed, always confirm. */
export function createFakeBudget(next: Partial<BudgetCheck> = {}): FakeBudget {
  const fake: FakeBudget = {
    next: { allowed: true, needsConfirmation: true, reason: null, remainingTodayUsd: 5, remainingMonthUsd: 40, ...next },
    recorded: [],
    checks: [],
    check: vi.fn(async (usd: number | null) => {
      fake.checks.push(usd);
      return { ...fake.next };
    }),
    record: vi.fn(async (entry) => {
      fake.recorded.push(entry);
    }),
    statusSnapshot: () => ({
      budget: { dailyUsd: null, monthlyUsd: null, confirmAboveUsd: 0, enforce: true },
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      remainingTodayUsd: null,
      remainingMonthUsd: null,
      updatedAt: new Date(0).toISOString(),
    }),
  };
  return fake;
}

/** estimate_generation handler returning `micro` micro-USD per call. */
export const estimateReturning = (micro: number, unit = 'image', note?: string): ToolHandler => () => ({
  currency: 'micro_usd',
  price_micro_usd: micro,
  price_usd: String(micro / 1e6),
  unit,
  ...(note ? { note } : {}),
});

/** Resolves pending promise callbacks (store writes, emits) without advancing timers. */
export async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
