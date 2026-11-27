import { describe, expect, it } from 'vitest';
import featured from '@main/mock/fixtures/catalog/public-featured.json';
import leaderboard from '@main/mock/fixtures/catalog/public-leaderboard.json';
import llm from '@main/mock/fixtures/catalog/mcp-search-llm.json';
import mm from '@main/mock/fixtures/catalog/mcp-search-multimodal.json';
import prices from '@main/mock/fixtures/catalog/public-model-prices.json';
import media from '@main/mock/fixtures/catalog/public-requestqueue-models.json';
import { mergeSources } from '@main/services/catalog/merge';
import {
  normalizeFeatured,
  normalizeLeaderboard,
  normalizeMcpSearch,
  normalizePublicMedia,
  normalizePublicPrices,
} from '@main/services/catalog/normalize';
import { pricingTable } from '../../src/renderer/pages/models/pricing';

const catalog = mergeSources({
  public_prices: normalizePublicPrices(prices),
  public_media: normalizePublicMedia(media),
  featured: normalizeFeatured(featured),
  leaderboard: normalizeLeaderboard(leaderboard, '2026-10-31T00:00:00.000Z'),
  mcp: normalizeMcpSearch({ llm, multimodal: [mm] }),
}).models;
const model = (id: string) => {
  const m = catalog.find((x) => x.id === id);
  if (!m) throw new Error(`${id} is not in the merged fixture`);
  return m;
};

describe('model detail pricing table', () => {
  it('puts every long-context tier price on its own row, so the "You pay" column fits the details panel', () => {
    // MiniMax-M3: 20% off with a "prompt > 512K" tier (the table that was cut off below 1280 px).
    const table = pricingTable(model('MiniMaxAI/MiniMax-M3'));
    expect(table).toMatchObject({ discounted: true, unitNote: 'USD per 1M tokens' });
    expect(table?.rows).toEqual([
      { type: 'price', label: 'Input', list: 0.3, charged: 0.24, nested: false, group: null },
      { type: 'price', label: 'Output', list: 1.2, charged: 0.96, nested: false, group: null },
      { type: 'price', label: 'Cached input', list: 0.06, charged: 0.048, nested: false, group: null },
      { type: 'heading', label: 'Prompt > 512K tokens' },
      { type: 'price', label: 'Input', list: 0.6, charged: 0.48, nested: true, group: 'Prompt > 512K tokens' },
      { type: 'price', label: 'Output', list: 2.4, charged: 1.92, nested: true, group: 'Prompt > 512K tokens' },
    ]);
  });

  it('lists several tiers in ascending order', () => {
    const rows = pricingTable(model('Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8'))?.rows ?? [];
    expect(rows.filter((r) => r.type === 'heading').map((r) => r.label)).toEqual(['Prompt > 32K tokens', 'Prompt > 128K tokens']);
    expect(rows.every((r) => r.type === 'heading' || typeof r.list === 'number')).toBe(true);
  });

  it('prices media per unit, and says when GMI publishes no price', () => {
    const video = pricingTable(model('heygen-avatar-4'));
    expect(video?.rows).toEqual([{ type: 'price', label: 'Per second', list: 0.0667, charged: 0.0667, nested: false, group: null }]);
    expect(video?.unitNote).toBe('USD · video length based pricing');
    expect(pricingTable({ kind: 'image', llmPricing: null, mediaPricing: null, discount: null })).toBeNull();
    expect(pricingTable({ kind: 'llm', llmPricing: null, mediaPricing: null, discount: 0.5 })).toBeNull();
  });
});
