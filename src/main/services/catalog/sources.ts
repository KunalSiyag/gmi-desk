/**
 * Network access for the catalog. The four public feeds are undocumented console endpoints
 * without CORS (only the main process can read them); the models API needs the inference key.
 * Always through ctx.http: Cloudflare in front of GMI blocks some default User-Agents.
 */
import { GMI_URLS } from '@shared/app';
import type { Http } from '../../core/http';
import { catalogPublicFixtures, mockModelsApiResponse } from '../../mock/catalog';

export interface CatalogFetchers {
  publicPrices(signal?: AbortSignal): Promise<unknown>;
  publicMedia(signal?: AbortSignal): Promise<unknown>;
  featured(signal?: AbortSignal): Promise<unknown>;
  leaderboard(signal?: AbortSignal): Promise<unknown>;
  /** GET /v1/models with the inference key. Throws GmiError('invalid_api_key') on 401. */
  modelsApi(key: string, signal?: AbortSignal): Promise<unknown>;
}

export const PUBLIC_FEED_URLS = {
  prices: `${GMI_URLS.consoleApi}/billing/model_prices`,
  media: `${GMI_URLS.consoleApi}/ie/requestqueue/models`,
  featured: `${GMI_URLS.consoleApi}/ie/app/featured-models/active`,
  leaderboard: `${GMI_URLS.consoleApi}/ie/recommendation/leaderboard`,
  modelsApi: `${GMI_URLS.inference}/models`,
} as const;

export function createHttpFetchers(http: Http): CatalogFetchers {
  return {
    publicPrices: (signal) => http.json(PUBLIC_FEED_URLS.prices, { retries: 1, signal }),
    // ~2 MB of JSON: give it more time than the default 30 s.
    publicMedia: (signal) => http.json(PUBLIC_FEED_URLS.media, { retries: 1, timeoutMs: 90_000, signal }),
    featured: (signal) => http.json(PUBLIC_FEED_URLS.featured, { retries: 1, signal }),
    leaderboard: (signal) => http.json(PUBLIC_FEED_URLS.leaderboard, { retries: 1, signal }),
    modelsApi: (key, signal) =>
      http.json(PUBLIC_FEED_URLS.modelsApi, { bearer: key, unauthorizedCode: 'invalid_api_key', retries: 1, signal }),
  };
}

const later = <T>(value: () => T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value())), ms));

/** GMI_DESK_MOCK: recorded, sanitised fixtures; no network. */
export function createMockFetchers(latencyMs = 120): CatalogFetchers {
  return {
    publicPrices: () => later(() => catalogPublicFixtures.prices, latencyMs),
    publicMedia: () => later(() => catalogPublicFixtures.media, latencyMs * 2),
    featured: () => later(() => catalogPublicFixtures.featured, latencyMs),
    leaderboard: () => later(() => catalogPublicFixtures.leaderboard, latencyMs),
    modelsApi: () => later(() => mockModelsApiResponse(), latencyMs),
  };
}
