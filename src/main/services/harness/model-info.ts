import type { CatalogService } from '../../core/services';
import { modelInfoSchema, UNKNOWN_MODEL_INFO } from '@harness/loop/model-info';
import type { RpcHandlers } from './bridge';

/** Catalog metadata only: no credentials, model traffic or network requests from the host. */
export function createModelInfoHandlers(catalog: CatalogService): RpcHandlers {
  return {
    'models.info': async ({ models }) => Object.fromEntries(await Promise.all(models.map(async (id) => {
      const model = await catalog.findModel(id);
      const prices = model?.llmPricing;
      const factor = 1 - Math.min(1, Math.max(0, model?.discount ?? 0));
      const tiers = prices?.tiers?.map((t) => t.minPromptTokens).filter((n) => Number.isFinite(n) && n > 0) ?? [];
      const candidate = {
        contextTokens: model?.contextLength ?? null,
        tierBoundaryTokens: tiers.length ? Math.min(...tiers) : null,
        pricing: prices?.inputPerMTok != null && prices.outputPerMTok != null ? {
          inputPerMTok: prices.inputPerMTok * factor,
          outputPerMTok: prices.outputPerMTok * factor,
          cacheReadPerMTok: prices.cacheReadPerMTok == null ? null : prices.cacheReadPerMTok * factor,
        } : null,
      };
      const parsed = modelInfoSchema.safeParse(candidate);
      return [id, parsed.success ? parsed.data : UNKNOWN_MODEL_INFO];
    }))),
  };
}
