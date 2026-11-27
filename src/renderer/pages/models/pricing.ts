/**
 * Rows of the model detail pricing table (pure: unit-tested in test/catalog/page-pricing.test.ts).
 * Every price row holds one list price and one charged price, so the table fits the 18rem details panel:
 * long-context tiers get a heading and their own Input / Output rows instead of "in / out" pairs.
 */
import type { CatalogModel } from '@shared/contracts/catalog';
import { formatTokens } from '@shared/lib/format';
import { applyDiscount } from '@shared/lib/money';

export type PricingRow =
  /** `group`: the tier heading a nested row belongs to (for screen readers). */
  | { type: 'price'; label: string; list: number | null; charged: number | null; nested: boolean; group: string | null }
  | { type: 'heading'; label: string };

export interface PricingTableModel {
  rows: PricingRow[];
  /** "USD per 1M tokens", "USD · per second"... */
  unitNote: string;
  /** A positive discount applies: show the list price struck through next to the charged one. */
  discounted: boolean;
}

/** Null when GMI publishes no price for the model. */
export function pricingTable(model: Pick<CatalogModel, 'kind' | 'llmPricing' | 'mediaPricing' | 'discount'>): PricingTableModel | null {
  const discount = model.discount ?? null;
  const discounted = (discount ?? 0) > 0;
  const price = (label: string, list: number | null | undefined, group: string | null = null): PricingRow => ({
    type: 'price',
    label,
    list: list ?? null,
    charged: applyDiscount(list ?? null, discount),
    nested: group !== null,
    group,
  });

  if (model.kind === 'llm' && model.llmPricing) {
    const p = model.llmPricing;
    const rows: PricingRow[] = [price('Input', p.inputPerMTok), price('Output', p.outputPerMTok)];
    if (p.cacheReadPerMTok !== null) rows.push(price('Cached input', p.cacheReadPerMTok));
    if (p.cacheWritePerMTok !== null) rows.push(price('Cache write', p.cacheWritePerMTok));
    for (const tier of p.tiers ?? []) {
      const heading = `Prompt > ${formatTokens(tier.minPromptTokens)} tokens`;
      rows.push({ type: 'heading', label: heading }, price('Input', tier.inputPerMTok, heading), price('Output', tier.outputPerMTok, heading));
    }
    return { rows, unitNote: 'USD per 1M tokens', discounted };
  }
  const m = model.mediaPricing;
  if (m && m.usdPerUnit !== null) {
    return { rows: [price(`Per ${m.unit ?? 'unit'}`, m.usdPerUnit)], unitNote: m.pricingType ? `USD · ${m.pricingType}` : 'USD', discounted };
  }
  return null;
}
