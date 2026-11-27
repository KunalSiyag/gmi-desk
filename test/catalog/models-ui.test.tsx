// Models page on the shared kit: selected rows (list and leaderboard) are the app's row selection (accent + the
// brand-ink ActiveBar, instant) rather than a lime wash; deals, micro-labels and selects come from the kit, and
// brand-positive states use lime ink, never the mint `success` token.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CatalogModel, Leaderboard } from '@shared/contracts/catalog';
import { activeBarBefore } from '@renderer/components/ui/active-bar';
import { microLabel } from '@renderer/components/ui/misc';
import { qk } from '@renderer/lib/query';
import { LeaderboardView } from '@renderer/pages/models/LeaderboardView';
import { ModelList } from '@renderer/pages/models/ModelList';
import { Fact, NewBadge, PanelSection } from '@renderer/pages/models/parts';

const model = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id.split('/').pop() ?? id,
  kind: 'llm',
  provider: 'Z.ai',
  description: null,
  iconUrl: null,
  tags: [],
  api: 'chat',
  contextLength: 128_000,
  quantization: null,
  llmPricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: null, cacheWritePerMTok: null },
  mediaPricing: null,
  discount: null,
  inputs: [{ type: 'text', required: true }],
  outputs: [{ type: 'text', required: false }],
  available: true,
  featured: false,
  createdAt: null,
  firstSeenAt: '2026-10-01T00:00:00Z',
  isNew: false,
  leaderboard: null,
  sources: ['mcp'],
  ...over,
});

const ROWS = [model('zai-org/GLM-5.3', { discount: 0.5 }), model('acme/Other-1', { isNew: true })];

const words = (classes: string) => classes.split(/\s+/).filter(Boolean);

/** class attribute of the element whose opening tag contains `marker`. */
function classOf(html: string, marker: string): string {
  const tag = html.split('<').find((t) => t.includes(marker));
  return /class="([^"]*)"/.exec(tag ?? '')?.[1] ?? '';
}

function list(selectedId: string | null): string {
  return renderToStaticMarkup(
    <ModelList rows={ROWS} selectedId={selectedId} onSelect={() => undefined} sort="recommended" onSort={() => undefined} showKind showContext />,
  );
}

describe('model list selection', () => {
  it('marks the selected row with accent + the inset brand-ink bar, no lime wash, no transition', () => {
    const selected = classOf(list('zai-org/GLM-5.3'), 'id="model-option-0"');
    expect(words(selected)).toContain('bg-accent');
    for (const c of words(activeBarBefore)) expect(words(selected)).toContain(c);
    expect(selected).not.toMatch(/bg-primary\//);
    expect(selected).not.toMatch(/transition|duration-/);
  });

  it('gives unselected rows the quiet accent hover only', () => {
    const other = classOf(list('zai-org/GLM-5.3'), 'id="model-option-1"');
    expect(words(other)).toContain('hover:bg-accent/60');
    expect(other).not.toContain('before:bg-primary-ink');
    expect(words(other)).not.toContain('bg-accent');
  });

  it('uses the kit discount badge (lime tint + ink, mono) and the kit "new" chip (a heavier tint, not a lime fill)', () => {
    const html = list(null);
    // The badge's opening tag is the last tag before its text.
    const deal = html.split('>-50%<')[0]!.split('<').pop()!;
    expect(deal).toContain('text-primary-ink');
    expect(deal).toContain('font-mono');
    const fresh = words(classOf(renderToStaticMarkup(<NewBadge />), 'class='));
    expect(fresh).toEqual(expect.arrayContaining(['bg-primary/20', 'text-primary-ink', 'ring-primary-ink/30']));
    expect(fresh).not.toContain('bg-primary');
    expect(fresh).not.toContain('text-primary-foreground');
  });

  it('labels its columns with the kit micro-label', () => {
    expect(list(null)).toContain(microLabel.split(' ')[0]!);
    expect(list(null)).toContain('tracking-[0.16em]');
  });
});

describe('detail panel parts', () => {
  it('renders facts and section titles with the kit micro-label', () => {
    const fact = renderToStaticMarkup(
      <dl>
        <Fact label="Context">1M tokens</Fact>
      </dl>,
    );
    expect(fact).toMatch(/<dt class="[^"]*tracking-\[0\.16em\][^"]*text-muted-foreground/);
    const section = renderToStaticMarkup(<PanelSection title="Pricing">x</PanelSection>);
    expect(section).toContain(`<h3 class="${microLabel}">`);
  });
});

describe('leaderboard selection', () => {
  const board: Leaderboard = {
    categories: [{ key: 'overall', label: 'Overall' }],
    entries: [
      { modelId: 'acme/Other-1', name: 'Other 1', provider: 'Acme', openSource: false, publishedAt: null, quality: { overall: 80 }, cost: {} },
      { modelId: 'zai-org/GLM-5.3', name: 'GLM-5.3', provider: 'Z.ai', openSource: true, publishedAt: null, quality: { overall: 70 }, cost: {} },
    ],
    fetchedAt: '2026-11-01T00:00:00Z',
  };

  function render(node: ReactNode): string {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.leaderboard, board);
    return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  }

  it('marks the selected row with accent and the inset bar on its first cell', () => {
    const catalog = new Map(ROWS.map((m) => [m.id.toLowerCase(), m]));
    const html = render(<LeaderboardView query="" catalog={catalog} selectedId="zai-org/GLM-5.3" onSelect={() => undefined} />);
    const rows = html.split('<tr').slice(2); // skip the header row
    const selected = rows.find((r) => r.includes('aria-selected="true"'))!;
    const other = rows.find((r) => r.includes('aria-selected="false"'))!;
    expect(words(/class="([^"]*)"/.exec(selected)![1]!)).toContain('bg-accent');
    expect(selected).toContain('before:bg-primary-ink');
    expect(selected).not.toMatch(/bg-primary\//);
    expect(other).toContain('hover:bg-accent/60');
    expect(other).not.toContain('before:bg-primary-ink');
  });

  it('sits the bar 12px inside the table (like the model list), not on the app sidebar border', () => {
    const catalog = new Map(ROWS.map((m) => [m.id.toLowerCase(), m]));
    const html = render(<LeaderboardView query="" catalog={catalog} selectedId="zai-org/GLM-5.3" onSelect={() => undefined} />);
    const selected = html.split('<tr').slice(2).find((r) => r.includes('aria-selected="true"'))!;
    const firstCell = words(/<td class="([^"]*)"/.exec(selected)![1]!);
    expect(firstCell).toContain('before:left-3');
    expect(firstCell).not.toContain('before:left-0');
  });

  it('labels its columns with the kit micro-label (no tracking override; narrow columns use short labels)', () => {
    const board2: Leaderboard = {
      ...board,
      categories: [
        { key: 'overall', label: 'Overall' },
        { key: 'agentic', label: 'Agentic' },
        { key: 'instruction', label: 'Instruction' },
      ],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.leaderboard, board2);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LeaderboardView query="" catalog={new Map()} selectedId={null} onSelect={() => undefined} />
      </QueryClientProvider>,
    );
    const heads = html.split('<th ').slice(1).map((t) => /class="([^"]*)"/.exec(t)![1]!);
    for (const h of heads) {
      // The kit micro-label (the sorted column swaps its colour for text-foreground).
      for (const c of words(microLabel).filter((c) => !c.startsWith('text-muted'))) expect(words(h)).toContain(c);
      expect(h).not.toMatch(/tracking-\[0\.0/);
    }
    expect(html).toContain('>Agent</span>');
    expect(html).toContain('>Instr</span>');
    expect(html).toContain('aria-label="Sort by Agentic"');
  });
});

describe('models page sources', () => {
  const dir = fileURLToPath(new URL('../../src/renderer/pages/models/', import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));

  it('has no local copies of kit pieces (micro-label, discount badge, select chevron)', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/MICRO_LABEL|FilterSelect|function DiscountBadge|function discountLabel|appearance-none/);
    }
  });

  it('keeps brand-positive states lime (no mint success token)', () => {
    for (const { f, text } of sources) expect(text, f).not.toMatch(/\b(?:text|bg|border|ring)-success/);
  });
});
