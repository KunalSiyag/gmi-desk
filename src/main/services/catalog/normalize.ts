/**
 * One normaliser per catalog source: raw JSON (untrusted) → ModelPatch[] + hidden ids.
 * Units: MCP LLM prices are USD/token strings, console feeds micro-USD; discounts are fractions
 * (MCP) or hundredths of a percent (console). See src/shared/lib/money.ts.
 */
import type {
  Leaderboard,
  LeaderboardEntry,
  LeaderboardScores,
  LlmPriceTier,
  LlmPricing,
  MediaPricing,
} from '@shared/contracts/catalog';
import { toIsoDate } from '@shared/lib/format';
import { hundredthsPercentToFraction, microUsdToUsd, roundPrice, usdPerTokenToPerMTok } from '@shared/lib/money';
import { prettyProvider } from './providers';
import {
  cleanModelName,
  isHttpsUrl,
  isInternalText,
  isJunkId,
  isJunkName,
  mapKind,
  normalizeModalities,
  normalizeTags,
  normalizeUnit,
  num,
  positiveFraction,
  shortText,
  str,
} from './text';
import type {
  LeaderboardResult,
  ModelPatch,
  PublicDetail,
  PublicMediaResult,
  RawApiModel,
  RawFeatured,
  RawLeaderboard,
  RawLeaderboardModel,
  RawMcpModel,
  RawPriceRow,
  RawPriceTier,
  RawQueueModel,
  SourceResult,
} from './types';

function rowsOf(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function asObject<T>(value: unknown): T | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

/**
 * A public (console feed) discount, or null for none. A 100%-off public row is not trusted: GMI leaves
 * such rows for models it still bills (inclusionAI/Ling-3.0-flash-fin is listed at price 0 while the org
 * catalog charges $0.06/$0.18 per 1M), and a zero price would hide the spend from the budget guard.
 */
function publicDiscount(d: number | null): number | null {
  return d !== null && d > 0 && d < 1 ? d : null;
}

/** Hundredths of a percent → fraction; null for 0 and for 100% off (see publicDiscount). */
function consoleDiscount(value: unknown): number | null {
  return publicDiscount(hundredthsPercentToFraction(value));
}

/** micro-USD → USD; null when missing. */
const micro = (value: unknown) => microUsdToUsd(num(value));

/** MCP USD/token string → USD per 1M tokens. */
const perToken = (value: unknown) => usdPerTokenToPerMTok(num(value));

/**
 * A cache price of exactly 0 means "not offered / unknown" (GMI fills the field with "0"), not free
 * cached tokens. Input/output prices of 0 do mean free.
 */
function cachePrice(value: number | null): number | null {
  return value === null || value <= 0 ? null : value;
}

function workflowName(primary: unknown, fallback: unknown): string | null {
  return cleanModelName(primary, { workflow: true }) ?? cleanModelName(fallback, { workflow: true });
}

// ---------------------------------------------------------------------------------------------
// Public price list (billing/model_prices). Prices only: these rows never create a model by
// themselves (the list keeps retired and dedicated-endpoint entries), they enrich other sources.
// ---------------------------------------------------------------------------------------------

function priceTiers(raw: unknown): RawPriceTier[] {
  return Array.isArray(raw) ? raw.filter((t): t is RawPriceTier => Boolean(asObject(t))) : [];
}

export function normalizePublicPrices(raw: unknown): SourceResult {
  const rows = rowsOf(raw, 'modelPrices');
  const patches: ModelPatch[] = [];
  const hidden: string[] = [];
  for (const item of rows) {
    const row = asObject<RawPriceRow>(item);
    if (!row) continue;
    const id = str(row.modelName);
    if (!id) continue;
    if (isJunkId(id)) {
      hidden.push(id);
      continue;
    }
    const billing = str(row.billingType)?.toLowerCase() ?? '';
    if (billing === 'llm') {
      const listIn = micro(row.originPricePer1mPromptToken) ?? micro(row.pricePer1mPromptToken);
      const listOut = micro(row.originPricePer1mCompletionToken) ?? micro(row.pricePer1mCompletionToken);
      const tiers = priceTiers(row.tiers).sort((a, b) => (num(a.threshold) ?? 0) - (num(b.threshold) ?? 0));
      const base = tiers.find((t) => (num(t.threshold) ?? 0) === 0) ?? null;
      const extra: LlmPriceTier[] = tiers
        .filter((t) => (num(t.threshold) ?? 0) > 0)
        .map((t) => ({
          minPromptTokens: num(t.threshold) ?? 0,
          inputPerMTok: micro(t.originInputPrice) ?? micro(t.inputPrice),
          outputPerMTok: micro(t.originOutputPrice) ?? micro(t.outputPrice),
          cacheReadPerMTok: cachePrice(micro(t.originCacheReadPrice) ?? micro(t.cacheReadPrice)),
          cacheWritePerMTok: cachePrice(micro(t.originCacheWritePrice) ?? micro(t.cacheWritePrice)),
        }));
      const llmPricing: LlmPricing = {
        inputPerMTok: listIn,
        outputPerMTok: listOut,
        cacheReadPerMTok: base ? cachePrice(micro(base.originCacheReadPrice) ?? micro(base.cacheReadPrice)) : null,
        cacheWritePerMTok: base ? cachePrice(micro(base.originCacheWritePrice) ?? micro(base.cacheWritePrice)) : null,
        ...(extra.length ? { tiers: extra } : {}),
      };
      // Discount: explicit percentage, else per-token-type discount, else implied by charged vs list.
      let discount = consoleDiscount(row.percentageDiscount);
      const ttd = asObject<Record<string, unknown>>(row.tokenTypeDiscounts);
      if (!discount && ttd) discount = consoleDiscount(ttd.prompt_token);
      if (!discount) {
        const charged = micro(row.pricePer1mPromptToken);
        if (listIn && charged !== null && charged < listIn) discount = publicDiscount(Math.round((1 - charged / listIn) * 10_000) / 10_000);
      }
      patches.push({ id, source: 'public_prices', kind: 'llm', name: cleanModelName(id), llmPricing, discount });
    } else {
      const unit = /^videolength/i.test(str(row.chargeUnit) ?? '') ? 'second' : null;
      const price = micro(row.originPrice) ?? micro(row.price);
      patches.push({
        id,
        source: 'public_prices',
        mediaPricing: price === null ? null : { usdPerUnit: price, unit, pricingType: null, details: null },
        discount: consoleDiscount(row.percentageDiscount),
      });
    }
  }
  return { patches, hidden, count: rows.length };
}

// ---------------------------------------------------------------------------------------------
// Public request-queue catalog (ie/requestqueue/models): media models + GMI Studio workflows.
// ---------------------------------------------------------------------------------------------

export function normalizePublicMedia(raw: unknown): PublicMediaResult {
  const rows = rowsOf(raw, 'models');
  const patches: ModelPatch[] = [];
  const hidden: string[] = [];
  const details: Record<string, PublicDetail> = {};
  for (const item of rows) {
    const row = asObject<RawQueueModel>(item);
    if (!row) continue;
    const id = str(row.model);
    if (!id) continue;
    const kind = mapKind(row.model_type);
    // The queue catalog still carries stale LLM rows (inactive/invisible); LLMs come from MCP and the models API.
    if (kind === 'llm') continue;
    const priceInfo = asObject<NonNullable<RawQueueModel['price_info']>>(row.price_info);
    if (isJunkId(id) || isJunkName(row.display_name) || isInternalText(row.brief_description, priceInfo?.pricing_type)) {
      hidden.push(id);
      continue;
    }
    const meta = asObject<NonNullable<RawQueueModel['model_metadata']>>(row.model_metadata);
    const visibility = str(meta?.visibility)?.toLowerCase();
    if (str(row.status)?.toLowerCase() !== 'active' || (visibility !== undefined && visibility !== 'visible')) {
      hidden.push(id);
      continue;
    }
    const isWorkflow = kind === 'workflow';
    const name = isWorkflow ? workflowName(row.brief_description, row.display_name) : (cleanModelName(row.display_name) ?? cleanModelName(id));
    if (!name || isJunkName(name)) continue;
    const longDescription = str(row.detailed_description);
    const brief = shortText(row.brief_description);
    const description = isWorkflow
      ? longDescription && longDescription.length <= 400 && longDescription !== brief
        ? shortText(longDescription)
        : null
      : brief;
    const price = micro(priceInfo?.price);
    const mediaPricing: MediaPricing | null =
      priceInfo === null
        ? null
        : {
            usdPerUnit: price,
            unit: normalizeUnit(priceInfo.unit, priceInfo.pricing_type, priceInfo.price),
            pricingType: str(priceInfo.pricing_type),
            details: shortText(row.pricing_details, 400),
          };
    const modalities = asObject<NonNullable<RawQueueModel['modalities']>>(row.modalities);
    patches.push({
      id,
      source: 'public_media',
      kind: kind ?? 'other',
      name,
      providerHint: str(row.external_provider),
      description,
      iconUrl: isHttpsUrl(row.icon_link) ? row.icon_link : null,
      tags: normalizeTags(row.tags),
      mediaPricing,
      discount: consoleDiscount(row.percentage_discount),
      inputs: normalizeModalities(modalities?.input),
      outputs: normalizeModalities(modalities?.output),
      available: true,
      featured: row.is_feature === true,
      createdAt: toIsoDate(num(row.created_at)),
    });
    details[id] = { parameters: Array.isArray(row.parameters) ? row.parameters : null, longDescription };
  }
  return { patches, hidden, details, count: rows.length };
}

// ---------------------------------------------------------------------------------------------
// Featured models (ie/app/featured-models/active).
// ---------------------------------------------------------------------------------------------

export function normalizeFeatured(raw: unknown): SourceResult {
  const rows = rowsOf(raw, 'models');
  const patches: ModelPatch[] = [];
  const hidden: string[] = [];
  for (const item of rows) {
    const row = asObject<RawFeatured>(item);
    if (!row) continue;
    const id = str(row.model_name);
    if (!id) continue;
    if (isJunkId(id)) {
      hidden.push(id);
      continue;
    }
    if (str(row.status)?.toLowerCase() !== 'active' || row.featured === false) continue;
    const kind = mapKind(row.model_type);
    const name = cleanModelName(id);
    // The feed's description is often just the name again ("ZAI: GLM-5.3").
    const description = str(row.description);
    const squash = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const informative = description && description !== id && squash(cleanModelName(description)) !== squash(name);
    const discount = consoleDiscount(row.percentage_discount);
    const patch: ModelPatch = {
      id,
      source: 'featured',
      kind,
      name,
      providerHint: str(row.provider),
      description: informative ? shortText(description) : null,
      iconUrl: isHttpsUrl(row.icon_url) ? row.icon_url : null,
      tags: normalizeTags(row.tags).filter((t) => t.toLowerCase() !== 'llm'),
      discount,
      featured: true,
      featuredOrder: num(row.display_order),
      openSource: typeof row.is_open_source === 'boolean' ? row.is_open_source : null,
    };
    // The featured feed lists the charged price and (as origin_*) the list price.
    const listIn = micro(row.origin_input_price) ?? micro(row.input_price);
    const listOut = micro(row.origin_output_price) ?? micro(row.output_price);
    if (kind === 'llm') {
      patch.llmPricing = { inputPerMTok: listIn, outputPerMTok: listOut, cacheReadPerMTok: null, cacheWritePerMTok: null };
    } else if (listOut !== null) {
      patch.mediaPricing = { usdPerUnit: listOut, unit: null, pricingType: null, details: null };
    }
    patches.push(patch);
  }
  return { patches, hidden, count: rows.length };
}

// ---------------------------------------------------------------------------------------------
// Leaderboard (ie/recommendation/leaderboard).
// ---------------------------------------------------------------------------------------------

function numberRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const obj = asObject<Record<string, unknown>>(raw);
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    const n = num(v);
    if (n !== null && k.length <= 40) out[k] = n;
  }
  return out;
}

export function normalizeLeaderboard(raw: unknown, fetchedAt: string): LeaderboardResult {
  const obj = asObject<RawLeaderboard>(raw) ?? {};
  const categories = (Array.isArray(obj.categories) ? obj.categories : [])
    .map((c) => asObject<{ key?: unknown; label?: unknown }>(c))
    .filter((c): c is { key?: unknown; label?: unknown } => c !== null)
    .map((c) => ({ key: str(c.key) ?? '', label: str(c.label) ?? str(c.key) ?? '' }))
    .filter((c) => c.key);
  const rows = Array.isArray(obj.models) ? obj.models : [];
  const entries: LeaderboardEntry[] = [];
  const patches: ModelPatch[] = [];
  for (const item of rows) {
    const row = asObject<RawLeaderboardModel>(item);
    if (!row) continue;
    const id = str(row.id);
    if (!id || isJunkId(id) || row.visible === false) continue;
    const quality = numberRecord(row.quality);
    const cost = numberRecord(row.cost);
    const name = cleanModelName(row.displayName) ?? cleanModelName(id) ?? id;
    const openSource = typeof row.openSource === 'boolean' ? row.openSource : null;
    entries.push({
      modelId: id,
      name,
      provider: prettyProvider(id, [str(row.provider)], 'llm'),
      openSource: openSource ?? false,
      publishedAt: toIsoDate(num(row.publish_date)),
      quality,
      cost,
    });
    const scores: LeaderboardScores = {
      overall: quality.overall ?? null,
      coding: quality.coding ?? null,
      agentic: quality.agentic ?? null,
      reasoning: quality.reasoning ?? null,
    };
    patches.push({ id, source: 'leaderboard', kind: 'llm', name, providerHint: str(row.provider), leaderboard: scores, openSource });
  }
  entries.sort((a, b) => (b.quality.overall ?? -1) - (a.quality.overall ?? -1));
  const leaderboard: Leaderboard = { categories, entries, fetchedAt };
  return { patches, hidden: [], leaderboard, count: rows.length };
}

// ---------------------------------------------------------------------------------------------
// MCP search_models / get_model.
// ---------------------------------------------------------------------------------------------

function mcpLlmPricing(raw: RawMcpModel['llm']): LlmPricing | null {
  const pricing = asObject<NonNullable<NonNullable<RawMcpModel['llm']>['pricing']>>(raw?.pricing);
  if (!pricing) return null;
  const tiers: LlmPriceTier[] = (Array.isArray(pricing.overrides) ? pricing.overrides : [])
    .map((o) => asObject<Record<string, unknown>>(o))
    .filter((o): o is Record<string, unknown> => o !== null && (num(o.min_prompt_tokens) ?? 0) > 0)
    .map((o) => ({
      minPromptTokens: num(o.min_prompt_tokens) ?? 0,
      inputPerMTok: perToken(o.prompt),
      outputPerMTok: perToken(o.completion),
      cacheReadPerMTok: cachePrice(perToken(o.input_cache_read)),
      cacheWritePerMTok: cachePrice(perToken(o.input_cache_write)),
    }))
    .sort((a, b) => a.minPromptTokens - b.minPromptTokens);
  return {
    inputPerMTok: perToken(pricing.prompt),
    outputPerMTok: perToken(pricing.completion),
    cacheReadPerMTok: cachePrice(perToken(pricing.input_cache_read)),
    cacheWritePerMTok: cachePrice(perToken(pricing.input_cache_write)),
    ...(tiers.length ? { tiers } : {}),
  };
}

/** One MCP model entry (LLM or multimodal) → patch. Null for junk/stale rows (recorded in `hidden` when known). */
export function normalizeMcpModel(entry: unknown, hidden: string[] = []): ModelPatch | null {
  const row = asObject<RawMcpModel>(entry);
  if (!row) return null;
  const id = str(row.model_id);
  if (!id) return null;
  if (isJunkId(id) || isJunkName(row.display_name)) {
    hidden.push(id);
    return null;
  }
  const isLlm = str(row.kind)?.toLowerCase() === 'llm' || Boolean(asObject(row.llm));
  if (isLlm) {
    const llm = asObject<NonNullable<RawMcpModel['llm']>>(row.llm);
    const llmPricing = mcpLlmPricing(llm);
    const context = num(llm?.context_length);
    return {
      id,
      source: 'mcp',
      kind: 'llm',
      name: cleanModelName(row.display_name) ?? cleanModelName(id),
      providerHint: str(row.provider),
      contextLength: context && context > 0 ? Math.round(context) : null,
      quantization: str(llm?.quantization),
      llmPricing,
      // MCP prices are the org's: a price without discount_to_user means no discount for this org (0), so a
      // public promotion (or a stale 100%-off price row) cannot make the model look cheaper than it is.
      discount: llmPricingDiscount(llm) ?? positiveFraction(row.discount_to_user) ?? positiveFraction(row.discount) ?? (llmPricing ? 0 : null),
    };
  }
  const mm = asObject<NonNullable<RawMcpModel['multimodal']>>(row.multimodal);
  const kind = mapKind(mm?.model_type);
  // Stale request-queue LLM rows show up in the multimodal list too; skip them.
  if (kind === 'llm') return null;
  const pricing = asObject<NonNullable<NonNullable<RawMcpModel['multimodal']>['pricing']>>(mm?.pricing);
  if (isInternalText(row.description, pricing?.pricing_type)) {
    hidden.push(id);
    return null;
  }
  const isWorkflow = kind === 'workflow';
  const name = isWorkflow ? workflowName(row.description, row.display_name) : (cleanModelName(row.display_name) ?? cleanModelName(id));
  if (!name || isJunkName(name)) return null;
  return {
    id,
    source: 'mcp',
    kind: kind ?? 'other',
    name,
    providerHint: str(row.provider),
    description: isWorkflow ? null : shortText(row.description),
    mediaPricing: pricing
      ? {
          usdPerUnit: micro(pricing.price),
          unit: normalizeUnit(pricing.unit, pricing.pricing_type, pricing.price),
          pricingType: str(pricing.pricing_type),
          details: null,
        }
      : null,
    discount: positiveFraction(row.discount_to_user) ?? positiveFraction(row.discount),
    inputs: normalizeModalities(mm?.input),
    outputs: normalizeModalities(mm?.output),
    available: row.available !== false,
  };
}

function llmPricingDiscount(llm: RawMcpModel['llm'] | null): number | null {
  const pricing = asObject<Record<string, unknown>>(llm?.pricing);
  return pricing ? positiveFraction(pricing.discount_to_user) : null;
}

/** search_models results (one or more calls) → one SourceResult. `llmIds` is set when an LLM query ran. */
export function normalizeMcpSearch(results: { llm?: unknown; multimodal?: unknown[] }): SourceResult {
  const patches = new Map<string, ModelPatch>();
  const hidden: string[] = [];
  let count = 0;
  let llmIds: string[] | undefined;
  if (results.llm !== undefined) {
    llmIds = [];
    for (const entry of rowsOf(results.llm, 'models')) {
      count += 1;
      const patch = normalizeMcpModel(entry, hidden);
      if (patch && patch.kind === 'llm') {
        patches.set(patch.id, patch);
        llmIds.push(patch.id);
      }
    }
  }
  for (const result of results.multimodal ?? []) {
    for (const entry of rowsOf(result, 'models')) {
      count += 1;
      const patch = normalizeMcpModel(entry, hidden);
      if (patch && patch.kind !== 'llm' && !patches.has(patch.id)) patches.set(patch.id, patch);
    }
  }
  return { patches: [...patches.values()], hidden: [...new Set(hidden)], count, ...(llmIds ? { llmIds } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Inference models API (GET /v1/models with the inference key): the authoritative LLM list.
// ---------------------------------------------------------------------------------------------

/** Accepts USD/token (OpenRouter style, < $0.001) or USD per 1M tokens. */
function apiPrice(value: unknown): number | null {
  const n = num(value);
  if (n === null || n < 0) return null;
  return n > 0 && n < 0.001 ? usdPerTokenToPerMTok(n) : roundPrice(n);
}

/**
 * The model id of a /v1/models row. GMI's documented example puts the id under `object` and leaves `id`
 * empty (`{"id": "", "object": "deepseek-ai/DeepSeek-R1"}`), so `object` is used when it is not "model".
 */
function apiModelId(row: RawApiModel): string | null {
  const id = str(row.id);
  if (id) return id;
  const object = str(row.object);
  return object && object.toLowerCase() !== 'model' && object.length <= 200 && !/\s/.test(object) ? object : null;
}

export function normalizeModelsApi(raw: unknown): SourceResult {
  const rows = rowsOf(raw, 'data');
  const patches: ModelPatch[] = [];
  const hidden: string[] = [];
  const llmIds: string[] = [];
  for (const item of rows) {
    const row = asObject<RawApiModel>(item);
    if (!row) continue;
    const id = apiModelId(row);
    if (!id) continue;
    if (isJunkId(id)) {
      hidden.push(id);
      continue;
    }
    const pricing = asObject<NonNullable<RawApiModel['pricing']>>(row.pricing);
    const context = num(row.context_length);
    const input = apiPrice(pricing?.prompt);
    const output = apiPrice(pricing?.completion);
    patches.push({
      id,
      source: 'models_api',
      kind: 'llm',
      name: cleanModelName(id),
      contextLength: context && context > 0 ? Math.round(context) : null,
      llmPricing: input !== null || output !== null ? { inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: null, cacheWritePerMTok: null } : null,
      // Same rule as MCP: the key's own price list without a discount means none for this org.
      discount: positiveFraction(row.discount_to_user) ?? (input !== null || output !== null ? 0 : null),
      createdAt: toIsoDate(num(row.created)),
      available: true,
    });
    llmIds.push(id);
  }
  return { patches, hidden, llmIds, count: rows.length };
}
