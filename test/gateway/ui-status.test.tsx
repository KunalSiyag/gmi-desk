// Usage's GMI gateway card (harness.md §24 H1-D): TPM use, queue, breakers, online state and cache-hit %, rendered
// from a GatewayStatus with react-dom/server, plus the source rules the Usage page keeps (D16–D18: brand ink, one
// accent green, words + icons for alert states, no lime fill).
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GatewayStatus } from '@shared/contracts/gateway';
import { BAR_FILL } from '@renderer/pages/usage/parts';
import { formatTokens, GatewayOnlineBadge, GatewaySection, GatewayStatusView, modelsToShow, tpmShare } from '@renderer/pages/usage/GatewayCard';

const NOW = new Date('2026-11-02T10:00:00.000Z');

const status = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  online: true,
  tpmLimit: 1_000_000,
  tpmEffective: 1_000_000,
  tpmUsedLastMinute: 120_000,
  queued: 0,
  inFlight: 0,
  models: [],
  cacheHitRatio24h: 0.64,
  last429At: null,
  updatedAt: NOW.toISOString(),
  ...over,
});

const view = (s: GatewayStatus) => renderToStaticMarkup(<GatewayStatusView status={s} now={NOW} />);
const section = (s: GatewayStatus) => renderToStaticMarkup(<GatewaySection status={s} now={NOW} />);

describe('helpers', () => {
  it('formats token counts like the rate-limit tiers', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(50_000_000)).toBe('50M');
    expect(formatTokens(120_000)).toBe('120k');
    expect(formatTokens(2_500)).toBe('2.5k');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
  });

  it('clamps the TPM share and survives a zero limit', () => {
    expect(tpmShare({ tpmUsedLastMinute: 250_000, tpmEffective: 1_000_000 })).toBe(0.25);
    expect(tpmShare({ tpmUsedLastMinute: 2_000_000, tpmEffective: 1_000_000 })).toBe(1);
    expect(tpmShare({ tpmUsedLastMinute: 5, tpmEffective: 0 })).toBe(0);
  });

  it('lists open breakers first, then probing, then the busiest healthy models; idle healthy ones are left out', () => {
    const rows = modelsToShow([
      { model: 'a/idle', breaker: 'closed', reopenAt: null, inFlight: 0 },
      { model: 'b/busy', breaker: 'closed', reopenAt: null, inFlight: 3 },
      { model: 'c/half', breaker: 'half_open', reopenAt: null, inFlight: 1 },
      { model: 'd/open', breaker: 'open', reopenAt: '2026-11-02T10:00:30.000Z', inFlight: 0 },
      { model: 'e/one', breaker: 'closed', reopenAt: null, inFlight: 1 },
    ]);
    expect(rows.map((r) => r.model)).toEqual(['d/open', 'c/half', 'b/busy', 'e/one']);
  });
});

describe('status view', () => {
  it('shows TPM used of the effective limit with an accessible meter in the brand bar fill', () => {
    const html = view(status());
    expect(html).toContain('Rate limit · last minute');
    expect(html).toContain('120k');
    expect(html).toContain('/ 1M');
    expect(html).toContain('Tokens per minute · tier 1M');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuetext="120,000 of 1,000,000 tokens per minute"');
    expect(html).toContain(BAR_FILL);
    expect(html).toContain('width:12%');
  });

  it('says when AIMD slowed down after a 429, and when the last rate limit was', () => {
    const html = view(status({ tpmEffective: 700_000, last429At: '2026-11-02T09:58:00.000Z', tpmUsedLastMinute: 690_000 }));
    expect(html).toContain('/ 700k');
    expect(html).toContain('Slowed after a 429 · tier 1M');
    expect(html).toContain('2m ago');
    expect(html).toContain('GMI said 429; requests waited');
    // Above 80 % of the effective limit: amber, not the brand fill.
    expect(html).toContain('bg-warning');
  });

  it('shows the queue and in-flight counts', () => {
    const html = view(status({ queued: 4, inFlight: 2 }));
    expect(html).toMatch(/Queue<\/span>.*>4</s);
    expect(html).toContain('2 in flight');
  });

  it('shows the cache-hit ratio, or a dash before anything was measured', () => {
    expect(view(status())).toContain('64%');
    const none = view(status({ cacheHitRatio24h: null }));
    expect(none).toContain('—');
    expect(none).toContain('No measured requests yet');
  });

  it('a quiet gateway says nothing is failing (brand ink check, no table)', () => {
    const html = view(status());
    expect(html).toContain('No model is failing and nothing is in flight.');
    expect(html).toContain('text-primary-ink');
    expect(html).not.toContain('<table');
    expect(html).toContain('No 429 since GMI Desk started');
  });

  it('lists failing and busy models with words and icons, and explains Retry ("Try anyway")', () => {
    const html = view(
      status({
        models: [
          { model: 'zai-org/GLM-5.3', breaker: 'open', reopenAt: '2026-11-02T10:00:30.000Z', inFlight: 0 },
          { model: 'deepseek-ai/DeepSeek-V4-Pro', breaker: 'half_open', reopenAt: null, inFlight: 1 },
          { model: 'router:balanced', breaker: 'closed', reopenAt: null, inFlight: 2 },
        ],
      }),
    );
    expect(html).toContain('<table');
    expect(html).toContain('zai-org/GLM-5.3');
    expect(html).toMatch(/Failing · retry \d\d:\d\d:\d\d/);
    expect(html).toContain('Testing');
    expect(html).toContain('GMI Router · balanced');
    expect(html).toContain('Healthy');
    expect(html).toContain('Retry</span> on that reply tries it anyway');
    // Alert states carry an icon (svg) next to the words; red / amber tints, never a lime fill.
    expect(html).toContain('bg-destructive/12');
    expect(html).toContain('bg-warning/15');
    // (BAR_FILL's `dark:bg-primary` on the TPM bar is the sanctioned bar fill, not a lime action fill.)
    expect(html).not.toMatch(/(?<![:\w-])bg-primary(?![\w/-])/);
    expect(html.indexOf('zai-org/GLM-5.3')).toBeLessThan(html.indexOf('deepseek-ai/DeepSeek-V4-Pro'));
  });
});

describe('section and online state', () => {
  it('online is the brand tint with a word; offline is amber with an icon and says requests wait', () => {
    const on = renderToStaticMarkup(<GatewayOnlineBadge online />);
    expect(on).toContain('Online');
    expect(on).toContain('text-primary-ink');
    const off = renderToStaticMarkup(<GatewayOnlineBadge online={false} />);
    expect(off).toContain('Offline · requests wait');
    expect(off).toContain('bg-warning/15');
    expect(off).toContain('<svg');
  });

  it('the section has a labelled heading and the online chip', () => {
    const html = section(status({ online: false }));
    expect(html).toContain('aria-labelledby="usage-gateway"');
    expect(html).toContain('id="usage-gateway"');
    expect(html).toContain('GMI gateway');
    expect(html).toContain('Offline');
  });
});

describe('source rules (D16–D18)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/renderer/pages/usage/GatewayCard.tsx', import.meta.url)), 'utf8');

  it('uses the kit (Figure, Badge, MicroLabel, Plates) and theme tokens, no raw colours or lime text', () => {
    expect(src).toMatch(/from '\.\/parts'/);
    expect(src).toContain('<Figure');
    expect(src).toContain('<Badge');
    expect(src).toContain('<Plates');
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(src).not.toMatch(/\b(text|bg|border)-(green|lime|red|yellow|amber|emerald)-\d/);
    expect(src).not.toContain('text-primary ');
    expect(src).not.toMatch(/\bbg-primary\b(?!\/|-)/);
    expect(src).not.toContain('<Dino');
  });

  it('keeps the status live from code:gateway and does not retry the not-yet-served query', () => {
    expect(src).toContain("useGmiEvent('code:gateway'");
    expect(src).toContain('qk.gatewayStatus');
    expect(src).toContain('retry: false');
    // Nothing while no status is known (test/core/f0-renderer keeps the "renders nothing" contract).
    expect(src).toContain('query.data ? <GatewaySection status={query.data} /> : null');
  });
});

describe('chat: "Try anyway" on a breaker fast fail (harness.md §4.6)', () => {
  it('ErrorNotice names the retry action when given a label, in the compact layout too', async () => {
    const { ErrorNotice } = await import('@renderer/components/ErrorNotice');
    const { GmiError } = await import('@shared/contracts/errors');
    const error = new GmiError('upstream', 'GMI is failing for this model right now.', { detail: 'breaker_open' });
    const compact = renderToStaticMarkup(<ErrorNotice compact error={error} onRetry={() => undefined} retryLabel="Try anyway" />);
    expect(compact).toContain('Try anyway');
    const plain = renderToStaticMarkup(<ErrorNotice compact error={error} onRetry={() => undefined} />);
    expect(plain).toContain('aria-label="Retry"');
    expect(plain).not.toContain('Try anyway');
  });

  it('the chat reply passes "Try anyway" for detail breaker_open', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/renderer/pages/chat/MessageView.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/retryLabel=\{message\.error\?\.detail === 'breaker_open' \? 'Try anyway' : undefined\}/);
  });
});
