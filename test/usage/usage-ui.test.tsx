// Usage and Create in GMI's palette: the budget meter's brand → amber → red states, the chart series, the balance
// hero, Top models' bars and focus, the empty states (one Dino, kit icon empty states, titles on one line), Media
// activity's done counts, the job status chip (one working signal), and a source scan that keeps raw colours, the old
// palette and local copies of kit pieces out of both pages.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountSummary, LocalSpend as LocalSpendData, MediaActivity as MediaActivityData } from '@shared/contracts/usage';
import { JobStatusBadge } from '@renderer/pages/create/JobMedia';
import { AccountOverview } from '@renderer/pages/usage/AccountOverview';
import { LocalSpend } from '@renderer/pages/usage/LocalSpend';
import { MediaActivity } from '@renderer/pages/usage/MediaActivity';
import { ACCOUNT_EMPTY, BAR_FILL, Meter, SERIES } from '@renderer/pages/usage/parts';
import { TopModels } from '@renderer/pages/usage/TopModels';

const meter = (spent: number, limit: number | null) =>
  renderToStaticMarkup(<Meter label="Today" spent={spent} limit={limit} noLimitLabel="no daily limit" />);

describe('budget meter', () => {
  it('fills like the Top models bars (olive on light, lime on dark) while well under the limit', () => {
    const html = meter(1, 5);
    expect(html).toContain(BAR_FILL);
    expect(BAR_FILL).toBe('bg-brand-olive dark:bg-primary');
    // Not the chat series lime: on a light surface it was a lime sliver behind an edge.
    expect(html).not.toContain('bg-brand-lime');
    expect(html).not.toContain('primary-edge');
    expect(html).toContain('$4.00 left');
    expect(html).not.toContain('Near the limit');
  });

  it('turns amber with words and an icon above 80 %', () => {
    const html = meter(4.21, 5);
    expect(html).toContain('bg-warning');
    expect(html).toContain('Near the limit');
    expect(html).toContain('84%');
  });

  it('turns red at or over the limit and says by how much', () => {
    const html = meter(6, 5);
    expect(html).toContain('bg-destructive');
    expect(html).toContain('Over by $1.00');
  });

  it('has no fill without a limit and keeps the meter accessible', () => {
    const html = meter(2, null);
    expect(html).not.toMatch(/bg-(brand-lime|brand-olive|warning|destructive)/);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuetext="$2.00, no daily limit"');
  });
});

describe('chart series', () => {
  it('uses GMI chart tokens: lime for LLM, olive (dark) / moss (light) for media', () => {
    expect(SERIES.chat).toContain('bg-brand-lime');
    // Lime on white needs an edge.
    expect(SERIES.chat).toContain('shadow-[var(--primary-edge)]');
    expect(SERIES.media).toContain('bg-brand-moss');
    expect(SERIES.media).toContain('dark:bg-brand-olive');
  });
});

const summary = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  days: 7,
  orgId: '00000000-0000-0000-0000-000000000000',
  balanceUsd: 128.4,
  balanceUnlimited: false,
  promotionCreditUsd: 250,
  llmTokenCostUsd: 35.87,
  llmTokens: 34_982_110,
  llmRequests: 1764,
  usageNote: null,
  topModels: [],
  periodStart: null,
  periodEnd: null,
  fetchedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('account overview', () => {
  it('shows the balance as the hero number in brand ink', () => {
    const html = renderToStaticMarkup(<AccountOverview summary={summary()} periodLabel="Last 7 days" loading={false} />);
    expect(html).toMatch(/text-primary-ink[^>]*>\$128\.40</);
    expect(html).toContain('tabular-nums');
  });

  it('turns a negative balance red and says why', () => {
    const html = renderToStaticMarkup(<AccountOverview summary={summary({ balanceUsd: -3.2 })} periodLabel="Last 7 days" loading={false} />);
    expect(html).toMatch(/text-destructive[^>]*>-\$3\.20</);
    expect(html).toContain('Below zero: GMI keeps charging');
  });
});

describe('top models', () => {
  const ranked = summary({
    topModels: [
      { model: 'openai/gpt-6-astra', requests: 14, tokens: 198_000, costUsd: 9.28 },
      { model: 'zai-org/GLM-5.3', requests: 11, tokens: 488_000, costUsd: 0.9 },
    ],
  });

  it('draws magnitude bars in olive on light and lime on dark (the LLM series lime stays for swatches)', () => {
    const html = renderToStaticMarkup(<TopModels summary={ranked} loading={false} periodLabel="Last 7 days" />);
    expect(html).toContain(BAR_FILL);
    expect(html).not.toContain('bg-brand-lime');
  });

  it('keeps a visible keyboard focus on its rows', () => {
    const html = renderToStaticMarkup(<TopModels summary={ranked} loading={false} periodLabel="Last 7 days" />);
    expect(html).toContain('Open in Models');
    expect(html).not.toContain('outline-none');
  });
});

describe('media activity', () => {
  const activity = (over: Partial<MediaActivityData> = {}): MediaActivityData => ({
    days: 7,
    total: 3,
    byModel: [{ modelId: 'wan3.0-video', count: 3, succeeded: 2, failed: 1 }],
    byModality: { image: 0, video: 3, audio: 0 },
    truncated: false,
    ...over,
  });

  it('has an icon empty state with an action (Top models beside it keeps the one Dino)', () => {
    const html = renderToStaticMarkup(
      <MediaActivity activity={activity({ total: 0, byModel: [], byModality: {} })} loading={false} periodLabel="Last 7 days" />,
    );
    expect(html).toContain('No media jobs yet');
    expect(html).toMatch(/<button[^>]*>.*<svg.*Create something<\/button>/);
    expect(html).not.toContain('data-mood');
  });

  it('marks done counts in brand ink and failures in red', () => {
    const html = renderToStaticMarkup(<MediaActivity activity={activity()} loading={false} periodLabel="Last 7 days" />);
    expect(html).toMatch(/<svg[^>]*text-primary-ink/);
    expect(html).toMatch(/<svg[^>]*text-destructive/);
    expect(html).not.toContain('success-foreground');
  });
});

describe('empty usage (one Dino, kit empty states, titles on one line)', () => {
  /** class attribute of the first element whose opening tag starts with `tag`. */
  const classOf = (html: string, tag: string) => /class="([^"]*)"/.exec(html.split('<').find((t) => t.startsWith(tag)) ?? '')?.[1] ?? '';
  const top = renderToStaticMarkup(
    <TopModels summary={summary({ llmTokenCostUsd: 0, llmTokens: 0, llmRequests: 0 })} loading={false} periodLabel="Last 7 days" />,
  );
  const media = renderToStaticMarkup(
    <MediaActivity activity={{ days: 7, total: 0, byModel: [], byModality: {}, truncated: false }} loading={false} periodLabel="Last 7 days" />,
  );

  it('keeps the one Dino in Top models; Media activity has the icon tile', () => {
    expect(top).toContain('data-mood');
    expect(media).not.toContain('data-mood');
  });

  it('gives both account cards one min-height and top-anchored empty states, the icon one lower by the art difference', () => {
    expect(classOf(top, 'section ')).toContain(ACCOUNT_EMPTY.card);
    expect(classOf(media, 'section ')).toContain(ACCOUNT_EMPTY.card);
    expect(top).toContain(ACCOUNT_EMPTY.dino);
    expect(media).toContain(ACCOUNT_EMPTY.icon);
    for (const c of [ACCOUNT_EMPTY.dino, ACCOUNT_EMPTY.icon]) expect(c).toContain('justify-start');
  });

  it("shows this device's empty spend as the kit icon empty state, not a dashed box", () => {
    const spend: LocalSpendData = { days: 7, chatUsd: 0, mediaUsd: 0, byModel: [], entries: [], entryCount: 0 };
    const html = renderToStaticMarkup(<LocalSpend spend={spend} loading={false} periodLabel="Last 7 days" />);
    expect(html).toContain('Nothing spent from this device');
    expect(html).toContain('No chats or generations in the last 7 days.');
    expect(html).toMatch(/<svg[^>]*lucide-receipt/);
    expect(html).not.toContain('border-dashed');
    expect(html).not.toContain('data-mood');
  });
});

describe('job status chip', () => {
  it('shows the plates (no spinner) while GMI works, in the lime tint', () => {
    const html = renderToStaticMarkup(<JobStatusBadge job={{ status: 'processing' }} />);
    expect(html).toContain('data-plates');
    expect(html).not.toContain('animate-spin');
    expect(html).toContain('text-primary-ink');
    expect(html).toContain('Processing');
  });

  it('shares the lime tint for done (with a check), red for failed, amber when no longer tracked', () => {
    const done = renderToStaticMarkup(<JobStatusBadge job={{ status: 'success' }} />);
    expect(done).toContain('text-primary-ink');
    expect(done).toContain('<svg');
    expect(done).not.toContain('data-plates');
    expect(done).not.toContain('success-foreground');
    expect(renderToStaticMarkup(<JobStatusBadge job={{ status: 'failed' }} />)).toContain('text-destructive');
    const stale = renderToStaticMarkup(<JobStatusBadge job={{ status: 'processing', pollingStopped: true }} />);
    expect(stale).toContain('text-warning-foreground');
    expect(stale).not.toContain('data-plates');
  });
});

describe('palette hygiene (pages/usage, pages/create)', () => {
  const root = fileURLToPath(new URL('../../src/renderer/pages/', import.meta.url));
  const files = ['usage', 'create'].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => join(dir, f)),
  );

  it.each(files)('%s uses tokens, not raw colours or the old palette', (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    expect(source).not.toMatch(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?![\w-])/i);
    expect(source).not.toMatch(/oklch\(/);
    expect(source).not.toMatch(/\b(?:indigo|violet|blue|sky|orange|emerald)-\d/);
    // Lime text is unreadable on light surfaces: brand text uses text-primary-ink.
    expect(source).not.toMatch(/\btext-primary(?![-\w])/);
    // No glassmorphism.
    expect(source).not.toMatch(/backdrop-blur/);
    // One accent green: brand-positive states (deals, done, OK) are lime, not the mint success token.
    expect(source).not.toMatch(/success-foreground|variant="success"/);
    // Focus stays visible.
    expect(source).not.toMatch(/\boutline-none\b/);
    // Kit pieces, not local copies: the micro-label and the grid floor.
    expect(source).not.toMatch(/uppercase tracking-\[/);
    expect(source).not.toMatch(/GridFloor|linear-gradient\(to right/);
  });
});
