/**
 * Model capabilities and resolution (harness.md §4.2). GMI's catalog carries no capability flags, so the gateway
 * keeps a local table keyed by model-id pattern, overridden by probe results (`data/gateway-capabilities.json`,
 * written by the dev-only probes) and by what it learns at run time (a model that answers 400 "use
 * max_completion_tokens"). The resolver is synchronous over a catalog snapshot (admission and estimate() are
 * synchronous); `refresh()` reloads it.
 */
import { readFile } from 'node:fs/promises';
import type { CatalogModel, LlmPricing } from '@shared/contracts/catalog';
import type { GatewayPurpose, GatewayRequest } from '@shared/contracts/gateway';
import type { CatalogService } from '../../core/services';
import type { Logger } from '../../core/logger';
import { GATEWAY_LIMITS, routerModelKey, type ModelCapabilities, type ModelResolver, type ResolvedModel } from './types';

/** Same rule as the chat slice's model ids (services/chat/settings.ts). */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;

export function isGatewayModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

/**
 * When the catalog does not know a model: Responses-only models (harness.md §4.2 table `[V]`), the union of the
 * catalog's rule (services/catalog/text.ts) and chat's fallback guessApi (services/chat/service.ts).
 */
export function guessApi(modelId: string): 'chat' | 'responses' {
  if (/-codex|gpt-5\.4-pro|seed-2\.0-mini/i.test(modelId)) return 'responses';
  return /^openai\/.*(codex|-pro)(?![\w.])/i.test(modelId) ? 'responses' : 'chat';
}

/**
 * The family a model's replayed reasoning belongs to (harness.md §4.2): the provider prefix of its id
 * (`zai-org`, `deepseek-ai`, …). Reasoning is replayed only to the same family; on a switch it is dropped.
 */
export function reasoningFamily(modelId: string): string {
  const slash = modelId.indexOf('/');
  return (slash > 0 ? modelId.slice(0, slash) : modelId).toLowerCase();
}

/** Defaults before any probe (harness.md §4.2 table); `[U]` capabilities stay off until probed. */
export const BASE_CAPABILITIES: Readonly<ModelCapabilities> = {
  api: 'chat',
  maxTokensField: 'max_tokens',
  maxOutputTokens: GATEWAY_LIMITS.unknownMaxOutputTokens,
  tools: true,
  // [U] until H-P5: an unsupported parameter answers 400, so these are not sent before a probe says so.
  parallelToolCalls: false,
  toolChoiceRequired: false,
  strictTools: false,
  reasoningReplay: 'never',
  ctxExceededParam: true,
  includeUsage: true,
  cacheKeyParam: null,
  developerRole: false,
  // Passed only when the request sets them (chat's settings do today); a family that rejects them is listed below.
  temperature: true,
  reasoningEffort: true,
};

/** The local table: later rows override earlier ones. */
const TABLE: ReadonlyArray<{ match: RegExp; caps: Partial<ModelCapabilities> }> = [
  // GPT-5.x and the o-series reject max_tokens (`unsupported_parameter`, research/harness.md §1.1 [V]); the
  // open-weight gpt-oss models are served like any other open model. A miss is caught by the 400 → re-send rule.
  { match: /^openai\/(gpt-(?!oss)|o\d)/i, caps: { maxTokensField: 'max_completion_tokens' } },
  // DeepSeek, Kimi and GLM need reasoning_content replayed inside a tool loop [V: RESEARCH].
  { match: /^deepseek-ai\//i, caps: { reasoningReplay: 'tool_loop' } },
  { match: /^moonshotai\/|kimi/i, caps: { reasoningReplay: 'tool_loop' } },
  { match: /^zai-org\/glm|^zai-org\//i, caps: { reasoningReplay: 'tool_loop' } },
];

/** Probe results / learned facts, per model id (lower-case keys). */
export type CapabilityOverrides = Map<string, Partial<ModelCapabilities>>;

/** The capabilities of `modelId`: table defaults, the catalog's API, then overrides. */
export function capabilitiesFor(modelId: string, catalogApi: 'chat' | 'responses' | null, overrides?: CapabilityOverrides | null): ModelCapabilities {
  const caps: ModelCapabilities = { ...BASE_CAPABILITIES };
  for (const row of TABLE) if (row.match.test(modelId)) Object.assign(caps, row.caps);
  caps.api = catalogApi ?? guessApi(modelId);
  // The Responses-only models are reasoning models that reject temperature (chat's buildResponsesBody never sent it).
  if (caps.api === 'responses') caps.temperature = false;
  const over = overrides?.get(modelId.toLowerCase());
  if (over) Object.assign(caps, over);
  return caps;
}

/**
 * Whether `modelId`'s output cap is known (a table row or an override / probe sets it), rather than the
 * unknown-model default. Chat clamps only to a known cap: it sent the user's Max tokens as-is before the gateway.
 */
export function hasKnownOutputCap(modelId: string, overrides?: CapabilityOverrides | null): boolean {
  if (TABLE.some((row) => row.match.test(modelId) && row.caps.maxOutputTokens !== undefined)) return true;
  return overrides?.get(modelId.toLowerCase())?.maxOutputTokens !== undefined;
}

const CAP_VALIDATORS: { [K in keyof ModelCapabilities]: (v: unknown) => boolean } = {
  api: (v) => v === 'chat' || v === 'responses',
  maxTokensField: (v) => v === 'max_tokens' || v === 'max_completion_tokens',
  maxOutputTokens: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000,
  tools: (v) => typeof v === 'boolean',
  parallelToolCalls: (v) => typeof v === 'boolean',
  toolChoiceRequired: (v) => typeof v === 'boolean',
  strictTools: (v) => typeof v === 'boolean',
  reasoningReplay: (v) => v === 'tool_loop' || v === 'always' || v === 'never' || v === 'empty',
  ctxExceededParam: (v) => typeof v === 'boolean',
  includeUsage: (v) => typeof v === 'boolean',
  cacheKeyParam: (v) => v === null || v === 'prompt_cache_key' || v === 'user',
  developerRole: (v) => typeof v === 'boolean',
  temperature: (v) => typeof v === 'boolean',
  reasoningEffort: (v) => typeof v === 'boolean',
};

/** Keeps only valid capability fields (the file is written by probes, but read defensively). */
export function sanitizeCapabilities(raw: unknown): Partial<ModelCapabilities> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const valid = (CAP_VALIDATORS as Record<string, (v: unknown) => boolean>)[key];
    if (valid?.(value)) out[key] = value;
  }
  return out as Partial<ModelCapabilities>;
}

/** `{ "models": { "<model id>": { …capabilities } } }`; a missing or broken file is no overrides. */
export function parseCapabilityOverrides(raw: unknown): CapabilityOverrides {
  const map: CapabilityOverrides = new Map();
  const models = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).models : null;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return map;
  for (const [id, caps] of Object.entries(models as Record<string, unknown>)) {
    if (!isGatewayModelId(id)) continue;
    const clean = sanitizeCapabilities(caps);
    if (Object.keys(clean).length > 0) map.set(id.toLowerCase(), clean);
  }
  return map;
}

export async function loadCapabilityOverrides(path: string, log?: Logger): Promise<CapabilityOverrides> {
  try {
    return parseCapabilityOverrides(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') log?.warn('gateway capability overrides unreadable; using the defaults', { error: String(error) });
    return new Map();
  }
}

export interface ModelResolverOptions {
  catalog: CatalogService;
  overrides?: CapabilityOverrides;
  /** Prices for models the catalog does not know (mock mode: the chat fixtures' pricing.json). */
  fallbackPricing?: (modelId: string) => { pricing: LlmPricing; discount: number | null } | null;
  /** Minimum time between two refresh() calls that actually reload (default 30 s; refresh(true) forces). */
  minRefreshMs?: number;
  now?: () => number;
  log?: Logger;
}

export interface GatewayModelResolver extends ModelResolver {
  /** Remembers a capability learnt at run time (in memory; e.g. max_completion_tokens after a 400). */
  learn(modelId: string, caps: Partial<ModelCapabilities>): void;
  /** Reload now, or only when the last reload is older than minRefreshMs. */
  refresh(force?: boolean): Promise<void>;
}

const NOT_CHAT_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'workflow']);

export function createModelResolver(opts: ModelResolverOptions): GatewayModelResolver {
  const overrides: CapabilityOverrides = new Map(opts.overrides ?? []);
  const minRefreshMs = opts.minRefreshMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  let byId = new Map<string, CatalogModel>();
  let lastRefresh = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const find = (id: string): CatalogModel | null => byId.get(id) ?? byId.get(id.toLowerCase()) ?? null;

  function pricingOf(id: string, model: CatalogModel | null): { pricing: LlmPricing | null; discount: number | null } {
    if (model?.llmPricing) return { pricing: model.llmPricing, discount: model.discount };
    const fallback = opts.fallbackPricing?.(id) ?? null;
    if (fallback) return fallback;
    return { pricing: null, discount: model?.discount ?? null };
  }

  async function reload(): Promise<void> {
    try {
      const snapshot = await opts.catalog.getSnapshot();
      const next = new Map<string, CatalogModel>();
      for (const m of snapshot.models) {
        next.set(m.id, m);
        if (!next.has(m.id.toLowerCase())) next.set(m.id.toLowerCase(), m);
      }
      byId = next;
    } catch (error) {
      opts.log?.warn('gateway: catalog unavailable; models resolve without prices', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    resolve(target: GatewayRequest['target'], maxOutputTokens: number, resolveOpts?: { purpose?: GatewayPurpose }): ResolvedModel | null {
      if ('router' in target) {
        return {
          model: null,
          router: target.router,
          api: 'router',
          modelKey: routerModelKey(target.router),
          pricing: null,
          discount: null,
          contextLength: null,
          capabilities: null,
          // The router ignores max_tokens [V]; the request's value bounds the estimate only.
          maxOutputTokens,
          truncationRisk: false,
        };
      }
      const id = target.model;
      if (!isGatewayModelId(id)) return null;
      const model = find(id);
      if (model && (model.api === 'queue' || NOT_CHAT_KINDS.has(model.kind))) return null;
      const catalogApi = model ? (model.api === 'responses' ? 'responses' : 'chat') : null;
      const capabilities = capabilitiesFor(id, catalogApi, overrides);
      const { pricing, discount } = pricingOf(id, model);
      return {
        model: id,
        router: null,
        api: capabilities.api,
        modelKey: id,
        pricing,
        discount,
        contextLength: model?.contextLength ?? null,
        capabilities,
        // Chat keeps the user's Max tokens unless the model's cap is actually known (parity with the old bodies).
        maxOutputTokens:
          resolveOpts?.purpose === 'chat' && !hasKnownOutputCap(id, overrides) ? Math.max(1, maxOutputTokens) : Math.max(1, Math.min(maxOutputTokens, capabilities.maxOutputTokens)),
        truncationRisk: capabilities.api === 'chat' && !capabilities.ctxExceededParam,
      };
    },
    resolveRouted(modelId) {
      if (!isGatewayModelId(modelId)) return null;
      const model = find(modelId);
      const priced = pricingOf(modelId, model);
      return priced.pricing ? priced : null;
    },
    refresh(force = false) {
      if (inFlight) return inFlight;
      if (!force && now() - lastRefresh < minRefreshMs) return Promise.resolve();
      lastRefresh = now();
      inFlight = reload().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    learn(modelId, caps) {
      const key = modelId.toLowerCase();
      overrides.set(key, { ...overrides.get(key), ...sanitizeCapabilities(caps) });
    },
  };
}
