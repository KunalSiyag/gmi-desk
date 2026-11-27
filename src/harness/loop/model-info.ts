import { z } from 'zod';
import type { MainRpc } from '../types';
import type { ModelInfo } from './runner';

const count = z.number().int().positive().max(100_000_000).nullable();
const price = z.number().finite().nonnegative().max(1_000_000);
export const modelInfoSchema = z.object({
  contextTokens: count,
  tierBoundaryTokens: count,
  pricing: z.object({ inputPerMTok: price, outputPerMTok: price, cacheReadPerMTok: price.nullable() }).nullable(),
});

export const UNKNOWN_MODEL_INFO: ModelInfo = { contextTokens: null, tierBoundaryTokens: null, pricing: null };

/** Refresh once per turn. A failed catalog lookup discards stale prices, never invents them. */
export function createModelInfoCache(rpc: MainRpc) {
  const cache = new Map<string, ModelInfo>();
  return {
    get: (model: string): ModelInfo => cache.get(model) ?? UNKNOWN_MODEL_INFO,
    async refresh(models: Array<string | null | undefined>): Promise<void> {
      const ids = [...new Set(models.filter((m): m is string => !!m && m !== 'router'))].slice(0, 8);
      for (const id of ids) cache.delete(id);
      if (!ids.length) return;
      try {
        const raw = await rpc.call('models.info', { models: ids }, { timeoutMs: 5_000 });
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        for (const id of ids) {
          const parsed = modelInfoSchema.safeParse(Object.hasOwn(raw, id) ? (raw as Record<string, unknown>)[id] : null);
          if (parsed.success) cache.set(id, parsed.data);
        }
      } catch {
        // The loop has conservative context defaults; main still enforces monetary reservations.
      }
    },
  };
}
