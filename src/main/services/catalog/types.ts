import type {
  CatalogSource,
  LeaderboardScores,
  Leaderboard,
  LlmPricing,
  MediaPricing,
  ModalitySpec,
  ModelKind,
} from '@shared/contracts/catalog';

// ---------------------------------------------------------------------------------------------
// Raw shapes as GMI publishes them. Every field is optional: these feeds are undocumented and
// change without notice, so normalisers check types instead of trusting them.
// ---------------------------------------------------------------------------------------------

export interface RawModality {
  type?: unknown;
  required?: unknown;
}

/** GET console.gmicloud.ai/api/v1/billing/model_prices → { modelPrices: RawPriceRow[] } (micro-USD). */
export interface RawPriceRow {
  billingType?: unknown;
  chargeUnit?: unknown;
  effectiveAt?: unknown;
  modelName?: unknown;
  originPrice?: unknown;
  price?: unknown;
  percentageDiscount?: unknown;
  originPricePer1mPromptToken?: unknown;
  originPricePer1mCompletionToken?: unknown;
  pricePer1mPromptToken?: unknown;
  pricePer1mCompletionToken?: unknown;
  tiers?: unknown;
  tokenTypeDiscounts?: unknown;
}

export interface RawPriceTier {
  threshold?: unknown;
  originInputPrice?: unknown;
  originOutputPrice?: unknown;
  originCacheReadPrice?: unknown;
  originCacheWritePrice?: unknown;
  inputPrice?: unknown;
  outputPrice?: unknown;
  cacheReadPrice?: unknown;
  cacheWritePrice?: unknown;
}

/** GET console.gmicloud.ai/api/v1/ie/requestqueue/models → { models: RawQueueModel[] }. */
export interface RawQueueModel {
  model?: unknown;
  display_name?: unknown;
  brief_description?: unknown;
  detailed_description?: unknown;
  icon_link?: unknown;
  model_type?: unknown;
  external_provider?: unknown;
  tags?: unknown;
  price_info?: { pricing_type?: unknown; price?: unknown; unit?: unknown } | null;
  pricing_details?: unknown;
  percentage_discount?: unknown;
  modalities?: { input?: unknown; output?: unknown } | null;
  parameters?: unknown;
  model_metadata?: { visibility?: unknown; delivery_mode?: unknown } | null;
  status?: unknown;
  is_feature?: unknown;
  created_at?: unknown;
}

/** GET console.gmicloud.ai/api/v1/ie/app/featured-models/active → RawFeatured[] (micro-USD per 1M / per unit). */
export interface RawFeatured {
  model_name?: unknown;
  provider?: unknown;
  icon_url?: unknown;
  input_price?: unknown;
  output_price?: unknown;
  origin_input_price?: unknown;
  origin_output_price?: unknown;
  percentage_discount?: unknown;
  model_type?: unknown;
  description?: unknown;
  status?: unknown;
  display_order?: unknown;
  featured?: unknown;
  is_open_source?: unknown;
  tags?: unknown;
}

/** GET console.gmicloud.ai/api/v1/ie/recommendation/leaderboard. */
export interface RawLeaderboard {
  categories?: unknown;
  models?: unknown;
}

export interface RawLeaderboardModel {
  id?: unknown;
  publish_date?: unknown;
  displayName?: unknown;
  provider?: unknown;
  openSource?: unknown;
  visible?: unknown;
  quality?: unknown;
  cost?: unknown;
}

/** MCP search_models / get_model entries. LLM prices are USD-per-token strings, media prices micro-USD. */
export interface RawMcpModel {
  model_id?: unknown;
  display_name?: unknown;
  kind?: unknown;
  provider?: unknown;
  description?: unknown;
  available?: unknown;
  llm?: {
    context_length?: unknown;
    quantization?: unknown;
    pricing?: {
      prompt?: unknown;
      completion?: unknown;
      input_cache_read?: unknown;
      input_cache_write?: unknown;
      discount_to_user?: unknown;
      overrides?: unknown;
    } | null;
  } | null;
  multimodal?: {
    model_type?: unknown;
    input?: unknown;
    output?: unknown;
    pricing?: { price?: unknown; pricing_type?: unknown; unit?: unknown } | null;
  } | null;
  parameters?: unknown;
  discount?: unknown;
  discount_to_user?: unknown;
}

/** GET api.gmi-serving.com/v1/models (inference key) → { data: RawApiModel[] }. */
export interface RawApiModel {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  owned_by?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
  discount_to_user?: unknown;
  context_length?: unknown;
}

// ---------------------------------------------------------------------------------------------
// Internal shapes.
// ---------------------------------------------------------------------------------------------

/** What one source knows about one model. Merged by id (case-insensitive) in merge.ts. */
export interface ModelPatch {
  id: string;
  source: CatalogSource;
  name?: string | null;
  kind?: ModelKind | null;
  /** Raw provider value (prettified after merging). */
  providerHint?: string | null;
  description?: string | null;
  iconUrl?: string | null;
  tags?: string[];
  contextLength?: number | null;
  quantization?: string | null;
  llmPricing?: LlmPricing | null;
  mediaPricing?: MediaPricing | null;
  discount?: number | null;
  inputs?: ModalitySpec[];
  outputs?: ModalitySpec[];
  available?: boolean;
  featured?: boolean;
  featuredOrder?: number | null;
  createdAt?: string | null;
  leaderboard?: LeaderboardScores | null;
  openSource?: boolean | null;
}

/** Public per-model details kept out of the snapshot (parameters + long markdown description). */
export interface PublicDetail {
  parameters: unknown;
  longDescription: string | null;
}

export interface SourceResult {
  patches: ModelPatch[];
  /** Ids GMI marks inactive/invisible (or internal tests): removed from the merged catalog. */
  hidden: string[];
  /** Set by the LLM-list sources (MCP llm query, models API): the ids they vouch for. */
  llmIds?: string[];
  /** Rows the source returned (before filtering), for SourceStatus.count. */
  count: number;
}

export interface PublicMediaResult extends SourceResult {
  details: Record<string, PublicDetail>;
}

export interface LeaderboardResult extends SourceResult {
  leaderboard: Leaderboard;
}
