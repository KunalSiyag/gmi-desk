/** Kinds the app groups models into. `workflow` = GMI Studio gallery workflows exposed as queue models. */
export type ModelKind = 'llm' | 'image' | 'video' | 'audio' | 'workflow' | 'other';

/** Which API a model is called through. */
export type ModelApi = 'chat' | 'responses' | 'messages' | 'queue';

export type CatalogSource = 'mcp' | 'models_api' | 'public_prices' | 'public_media' | 'featured' | 'leaderboard';

/** LLM prices in USD per 1M tokens, as GMI lists them (before the org discount). */
export interface LlmPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
  /** Long-context price tiers (GMI's `overrides`), ascending by `minPromptTokens`. List prices. */
  tiers?: LlmPriceTier[];
}

/** Prices that apply once a request's prompt reaches `minPromptTokens` (USD per 1M tokens, list). */
export interface LlmPriceTier {
  minPromptTokens: number;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

/** Media prices: USD per `unit` (second, image, request, character, ...), list price. */
export interface MediaPricing {
  usdPerUnit: number | null;
  unit: string | null;
  pricingType: string | null;
  /** Free-text breakdown GMI publishes for some models. */
  details: string | null;
}

export interface ModalitySpec {
  type: string;
  required: boolean;
}

export interface LeaderboardScores {
  overall: number | null;
  coding: number | null;
  agentic: number | null;
  reasoning: number | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  kind: ModelKind;
  provider: string | null;
  description: string | null;
  iconUrl: string | null;
  tags: string[];
  api: ModelApi;
  contextLength: number | null;
  quantization: string | null;
  llmPricing: LlmPricing | null;
  mediaPricing: MediaPricing | null;
  /** Fraction 0..1 off the list price for the signed-in org (charged = list × (1 − discount)). */
  discount: number | null;
  inputs: ModalitySpec[];
  outputs: ModalitySpec[];
  available: boolean;
  featured: boolean;
  /** When GMI says the model was created, if known (ISO). */
  createdAt: string | null;
  /** When this app first saw the model (ISO). Drives "New" badges. */
  firstSeenAt: string;
  isNew: boolean;
  leaderboard: LeaderboardScores | null;
  sources: CatalogSource[];
  /** Open weights (from GMI's featured feed or leaderboard), when known. */
  openSource?: boolean | null;
  /** Position on GMI's featured list (lower first), when featured there. */
  featuredOrder?: number | null;
}

export type ParameterType =
  | 'string'
  | 'text'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'array'
  | 'object'
  | 'unknown';

/**
 * A generation parameter, normalised from GMI's per-model schema (MCP get_model or the public queue catalog)
 * by `normalizeParameters` in src/shared/lib/parameters.ts.
 * For media inputs (image/video/audio) `max` is the maximum number of items.
 */
export interface ModelParameter {
  name: string;
  label: string;
  description: string | null;
  type: ParameterType;
  /** GMI's own type string (e.g. "first_frame_image", "float"). */
  rawType: string | null;
  required: boolean;
  default: unknown;
  enum: Array<string | number> | null;
  /** Display labels for enum values, keyed by String(value). */
  enumLabels: Record<string, string> | null;
  min: number | null;
  max: number | null;
  step: number | null;
  order: number | null;
}

export interface ModelDetail extends CatalogModel {
  parameters: ModelParameter[] | null;
  longDescription: string | null;
}

/**
 * ok: fetched on the last refresh. stale: the last refresh failed, the previous result is still used.
 * error: failed and nothing to fall back to. skipped: needs a credential the app does not have
 * (MCP needs a GMI sign-in, the models API an inference key).
 */
export type SourceState = 'ok' | 'stale' | 'error' | 'skipped';

export interface SourceStatus {
  ok: boolean;
  fetchedAt: string | null;
  count: number;
  error: string | null;
  state?: SourceState;
}

/** Which source decided the LLM list: the key's models API, the org's MCP catalog, or public feeds (best effort). */
export type LlmListSource = 'models_api' | 'mcp' | 'public';

export interface CatalogSnapshot {
  models: CatalogModel[];
  updatedAt: string | null;
  sources: Partial<Record<CatalogSource, SourceStatus>>;
  /** True while a refresh is running in the background. */
  refreshing: boolean;
  llmListSource?: LlmListSource | null;
}

/** Pushed on `catalog:updated` after every refresh. */
export interface CatalogUpdate {
  updatedAt: string;
  total: number;
  newModelIds: string[];
}

export interface LeaderboardCategory {
  key: string;
  label: string;
}

export interface LeaderboardEntry {
  modelId: string;
  name: string;
  provider: string | null;
  openSource: boolean;
  publishedAt: string | null;
  quality: Record<string, number>;
  cost: Record<string, number>;
}

export interface Leaderboard {
  categories: LeaderboardCategory[];
  entries: LeaderboardEntry[];
  fetchedAt: string;
}

/** Result of exporting the live catalog as an OpenCode provider config (works inside T3 Code too). */
export interface OpenCodeExport {
  configPath: string;
  modelCount: number;
  /** Env var the config reads the key from. */
  envVar: string;
  instructions: string;
}

export interface CatalogApi {
  getSnapshot(): Promise<CatalogSnapshot>;
  /** Re-fetches every source now. */
  refresh(): Promise<CatalogSnapshot>;
  getModel(id: string): Promise<ModelDetail>;
  getLeaderboard(): Promise<Leaderboard>;
  /** Clears "New" badges for these ids (all when omitted). */
  acknowledgeNew(ids?: string[]): Promise<void>;
  exportOpenCode(): Promise<OpenCodeExport>;
}
