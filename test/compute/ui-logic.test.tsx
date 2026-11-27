// C1-E Compute page: the pure helpers (pages/compute/format.ts, launch/state.ts). Main re-validates everything; these
// tests pin the feedback the renderer gives and the spec it sends.
import { describe, expect, it } from 'vitest';
import type { ComputeCatalog, ComputeOffer, ComputeResource, LeasePolicy } from '@shared/contracts/compute';
import {
  actionPendingText,
  checkCidr,
  cheapestByModel,
  cidrWarning,
  defaultLease,
  formatCountdown,
  formatMinutes,
  formatPerHour,
  isBilledPhase,
  isWorkingPhase,
  leaseActionsFor,
  leaseChangeNotice,
  leaseMaxUsd,
  leaseSummary,
  looksLikeJwt,
  nextEvent,
  offerSpecs,
  sizeFact,
  offerTitle,
  onBudgetSentence,
  orgBillingText,
  sizeName,
  sortAlarms,
  validateDisplayName,
  validateEnvName,
} from '@renderer/pages/compute/format';
import { computeKeyView } from '@renderer/pages/compute/hooks';
import {
  autofill,
  buildSpec,
  defaultName,
  firstInvalidStep,
  initialDraft,
  isLaunchStep,
  needsDailyBudget,
  offersFor,
  parsePorts,
  stepError,
  withKind,
  type LaunchDraft,
} from '@renderer/pages/compute/launch/state';
import { parseDailyBudget } from '@renderer/pages/compute/launch/BudgetInline';
import { sortResources } from '@renderer/pages/compute/ResourceList';
import { tabFromParams } from '@renderer/pages/compute';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

const SOURCES = { state: 'ok' as const, fetchedAt: at(-5), error: null };
function offer(patch: Partial<ComputeOffer>): ComputeOffer {
  return {
    id: 'o',
    kind: 'container',
    sku: 'gmi.container.nv.H200x1.tw3',
    idc: 'asia-east-taiwan3',
    gpuModel: 'H200',
    gpuCount: 1,
    vcpu: 16,
    memoryGiB: 128,
    diskGiB: 500,
    arch: 'x86_64',
    sizeLabel: null,
    listUsdPerHour: 3.35,
    entitled: true,
    ...patch,
  };
}
const CATALOG: ComputeCatalog = {
  idcs: [
    { id: 'asia-east-taiwan3', name: 'Taiwan 3', country: 'TW', status: 'available', kinds: ['container'], eipAvailable: true },
    { id: 'us-denver-1', name: 'Denver 1', country: 'US', status: 'maintenance', kinds: ['container'], eipAvailable: false },
    { id: 'us-central-iowa2', name: 'Iowa 2', country: 'US', status: 'available', kinds: ['sandbox', 'container'], eipAvailable: false },
  ],
  offers: [
    offer({ id: 'h200', sku: 'gmi.container.nv.H200x1.tw3' }),
    offer({ id: 'h200x8', sku: 'gmi.container.nv.H200x8.tw3', gpuCount: 8, listUsdPerHour: 26.8 }),
    offer({ id: 'iowa-cpu', sku: 'gmi.container.intel.x4660.large', idc: 'us-central-iowa2', gpuModel: null, gpuCount: 0, listUsdPerHour: null }),
    offer({ id: 'sb-small', kind: 'sandbox', sku: 'gmi.sandbox.small', idc: 'us-central-iowa2', gpuModel: null, gpuCount: 0, vcpu: 2, memoryGiB: 4, sizeLabel: 'SMALL', listUsdPerHour: 0.0911 }),
  ],
  templates: [
    { id: 'tpl-jupyter', kind: 'container', name: 'JupyterLab (PyTorch, CUDA 12)', official: true, image: 'docker.io/gmicloudai/jupyterlab-pytorch:v2', description: null, defaultPorts: [], sshReady: true, idc: null },
    { id: 'tpl-py', kind: 'sandbox', name: 'Python', official: true, image: null, description: null, defaultPorts: [], sshReady: null, idc: 'us-central-iowa2' },
  ],
  scope: 'account',
  sources: {
    idcs: SOURCES,
    publicProducts: SOURCES,
    publicTemplates: SOURCES,
    accountProducts: SOURCES,
    accountTemplates: SOURCES,
    sandboxProducts: SOURCES,
    sandboxTemplates: SOURCES,
  },
  fetchedAt: at(-5),
};

describe('format', () => {
  it('phases: working ones get Plates, billing follows §6.5/§7.4', () => {
    expect(isWorkingPhase('creating')).toBe(true);
    expect(isWorkingPhase('running')).toBe(false);
    expect(isBilledPhase({ phase: 'paused', kind: 'sandbox' })).toBe(false);
    expect(isBilledPhase({ phase: 'failed', kind: 'container' })).toBe(true);
    expect(isBilledPhase({ phase: 'failed', kind: 'sandbox' })).toBe(false);
  });

  it('money and time', () => {
    expect(formatPerHour(3.35)).toBe('$3.35/h');
    expect(formatPerHour(null)).toBe('price unknown');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(240)).toBe('4 h');
    expect(formatMinutes(1500)).toBe('1 day 1 h');
    expect(formatMinutes(4320)).toBe('3 days');
    expect(formatCountdown(at(200), NOW)).toBe('in 3 h 20 min');
    expect(formatCountdown(at(-1), NOW)).toBe('overdue');
    expect(formatCountdown(null, NOW)).toBeNull();
    expect(offerSpecs(CATALOG.offers[0]!)).toBe('1× H200 · 16 vCPU · 128 GiB');
    expect(offerSpecs(CATALOG.offers[3]!)).toBe('Small · 2 vCPU · 4 GiB');
    // Rows that already show the title (the Size step) don't repeat it.
    expect(offerSpecs(CATALOG.offers[0]!, { withTitle: false })).toBe('16 vCPU · 128 GiB');
    expect(offerSpecs(CATALOG.offers[3]!, { withTitle: false })).toBe('2 vCPU · 4 GiB');
    // Resource detail: the size in words, GMI's SKU as the hint; an unknown SKU stays as is.
    const sku = CATALOG.offers[0]!.sku;
    if (sku) expect(sizeFact(CATALOG, sku)).toEqual({ label: 'Size', value: '1× H200 · 16 vCPU · 128 GiB', hint: sku });
    expect(sizeFact(CATALOG, 'unknown-sku')).toEqual({ label: 'Size', value: 'unknown-sku' });
    expect(sizeFact(undefined, null)).toEqual({ label: 'Size', value: '—' });
  });

  it('sandbox size presets read as words next to "1× H100" and "CPU" (GMI sends enum names)', () => {
    expect(sizeName('SMALL')).toBe('Small');
    expect(sizeName('X_SMALL')).toBe('X-Small');
    expect(sizeName('X_LARGE')).toBe('X-Large');
    // Acronyms, model names and anything not in enum form pass through untouched.
    for (const keep of ['CPU', 'XL', 'H100', 'Small', 'gmi.sandbox.small']) expect(sizeName(keep)).toBe(keep);
    expect(offerTitle(CATALOG.offers[3]!)).toBe('Small');
    expect(offerTitle({ gpuModel: null, gpuCount: 0, sizeLabel: null })).toBe('CPU');
  });

  it('signed-out summary: the lowest known price per model, unknown prices last', () => {
    const rows = cheapestByModel(
      [offer({ idc: 'a', listUsdPerHour: 4 }), offer({ idc: 'b', listUsdPerHour: 3 }), offer({ gpuModel: 'B200', listUsdPerHour: null })],
      'container',
    );
    expect(rows.map((r) => [r.title, r.fromUsdPerHour, r.idcs])).toEqual([
      ['1× H200', 3, ['a', 'b']],
      ['1× B200', null, ['asia-east-taiwan3']],
    ]);
  });

  it('leases: chosen defaults (container 4 h then delete; budget → notify), container actions have no pause', () => {
    expect(defaultLease('container')).toEqual({ maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' });
    expect(defaultLease('sandbox')).toMatchObject({ maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 20, onBudget: 'pause' });
    expect(leaseActionsFor('container')).toEqual(['delete', 'notify']);
    expect(leaseSummary(defaultLease('container'))).toBe('Deletes after 4 h');
    expect(leaseSummary({ ...defaultLease('container'), maxLifetimeMin: null })).toBe('No automatic limit');
    expect(leaseMaxUsd(3.35, defaultLease('container'))).toBeCloseTo(13.4);
    expect(leaseMaxUsd(3.35, { ...defaultLease('container'), maxLifetimeMin: null })).toBeNull();
    expect(onBudgetSentence('container', 'notify')).toContain('Your budget will not stop this container');
  });

  it('lease changes that main confirms natively are announced (loosen, or delete sooner)', () => {
    const base: LeasePolicy = defaultLease('container');
    expect(leaseChangeNotice(base, base, 10)).toBeNull();
    expect(leaseChangeNotice(base, { ...base, maxLifetimeMin: 480 }, 10)).toContain('a longer limit');
    expect(leaseChangeNotice(base, { ...base, maxLifetimeMin: null }, 10)).toContain('a longer limit');
    expect(leaseChangeNotice(base, { ...base, onExpiry: 'notify' }, 10)).toContain('no delete at the end');
    expect(leaseChangeNotice(base, { ...base, maxLifetimeMin: 60 }, 50)).toContain('sooner');
    const sb = defaultLease('sandbox');
    expect(leaseChangeNotice(sb, { ...sb, onBudget: 'delete' }, 10)).toContain('sooner');
    expect(leaseChangeNotice(sb, { ...sb, idlePauseMin: null }, 10)).toContain('no idle pause');
  });

  it('names, env names and JWT-shaped values', () => {
    expect(validateDisplayName('h200 notebook')).toBeNull();
    expect(validateDisplayName('')).toMatch(/name/);
    expect(validateDisplayName('-bad')).not.toBeNull();
    expect(validateDisplayName('x'.repeat(41))).toMatch(/40/);
    expect(validateEnvName('HF_TOKEN')).toBeNull();
    expect(validateEnvName('1BAD')).not.toBeNull();
    expect(looksLikeJwt(`Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX19f`)).toBe(true);
    expect(looksLikeJwt('hello')).toBe(false);
  });

  it('CIDRs (§6.3): /32 is fine, broader is open, 0.0.0.0/0 is All Open, reserved ranges and IPv6 refused', () => {
    expect(checkCidr('203.0.113.7')).toEqual({ cidr: '203.0.113.7/32', error: null, open: false, allOpen: false });
    expect(cidrWarning(checkCidr('203.0.113.7'))).toBeNull();
    const wide = checkCidr('203.0.113.9/24');
    expect(wide).toMatchObject({ cidr: '203.0.113.0/24', open: true, allOpen: false });
    expect(cidrWarning(wide)).toMatch(/256 addresses.*system dialog/);
    const all = checkCidr('0.0.0.0/0');
    expect(all).toMatchObject({ cidr: '0.0.0.0/0', open: true, allOpen: true });
    expect(cidrWarning(all)).toMatch(/All Open: anyone on the internet/);
    for (const bad of ['127.0.0.1', '169.254.1.1/32', '224.0.0.1', '240.0.0.1', '0.1.2.3', '10.0.0.256', '2001:db8::1', '1.2.3.4/33', '01.2.3.4'])
      expect(checkCidr(bad).error, bad).not.toBeNull();
  });

  it('org billing banner: counts and $/h only', () => {
    expect(orgBillingText(null)).toBeNull();
    expect(orgBillingText({ containers: 0, eips: 0, usdPerHour: 0 })).toBeNull();
    expect(orgBillingText({ containers: 2, eips: 1, usdPerHour: 30.25 })).toBe('2 containers · 1 EIP are billing in your organization ($30.25/h list)');
    expect(orgBillingText({ containers: 1, eips: 0, usdPerHour: null })).toBe('1 container is billing in your organization');
  });

  it('alarms sort critical first, then newest', () => {
    const a = (id: string, severity: 'info' | 'warning' | 'critical', createdAt: string) => ({ id, severity, createdAt });
    expect(sortAlarms([a('1', 'info', at(0)), a('2', 'critical', at(-10)), a('3', 'warning', at(-1)), a('4', 'critical', at(-1))]).map((x) => x.id)).toEqual(['4', '2', '3', '1']);
  });

  it('next event: the soonest of lease end, GMI timeout and idle pause; none while paused', () => {
    const r = { phase: 'running' as const, kind: 'sandbox' as const, lease: defaultLease('sandbox'), leaseEndsAt: at(300), serverEndsAt: at(40), idlePauseAt: at(12) };
    expect(nextEvent(r, NOW)).toEqual({ label: 'Idle pause in 12 min', at: at(12), soon: true });
    expect(nextEvent({ ...r, idlePauseAt: null }, NOW)?.label).toBe('GMI timeout in 40 min');
    expect(nextEvent({ ...r, kind: 'container', lease: defaultLease('container') }, NOW)?.label).toBe('Deletes in 5 h');
    expect(nextEvent({ ...r, phase: 'paused' }, NOW)).toBeNull();
    expect(actionPendingText({ action: 'delete', dueAt: at(0), attempts: 2, lastError: null })).toBe('Delete pending · 2 attempts');
  });

  it('key view: the compute slice wins once it answers; a locked keychain is its own state', () => {
    const key = { status: 'valid' as const, last4: 'c0mp', keyId: 'k', orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
    expect(computeKeyView(undefined, undefined)).toBe('loading');
    expect(computeKeyView({ computeKey: { ...key, status: 'missing' } } as never, undefined)).toBe('none');
    expect(computeKeyView({ computeKey: key } as never, undefined)).toBe('ready');
    expect(computeKeyView({ computeKey: key } as never, { access: { key: { ...key, status: 'invalid' } } } as never)).toBe('invalid');
    expect(computeKeyView({ computeKey: key, lockedSecrets: ['compute_key'] } as never, undefined)).toBe('locked');
  });

  it('page params: tab, or launch when a wizard step/snapshot is linked', () => {
    expect(tabFromParams({})).toBe('resources');
    expect(tabFromParams({ tab: 'network' })).toBe('network');
    expect(tabFromParams({ tab: 'bogus' })).toBe('resources');
    expect(tabFromParams({ step: 'review' })).toBe('launch');
    expect(isLaunchStep('review')).toBe(true);
    expect(isLaunchStep('nope')).toBe(false);
  });

  it('resources: managed first, then live before paused/failed/deleted', () => {
    const r = (id: string, managed: boolean, phase: ComputeResource['phase']) => ({ id, managed, phase, createdAt: at(0), updatedAt: at(0) }) as ComputeResource;
    expect(sortResources([r('a', false, 'running'), r('b', true, 'deleted'), r('c', true, 'running'), r('d', true, 'paused')]).map((x) => x.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('daily budget input: required, positive, capped', () => {
    expect(parseDailyBudget('')).toMatchObject({ value: null });
    expect(parseDailyBudget('0').error).not.toBeNull();
    expect(parseDailyBudget('$25')).toEqual({ value: 25, error: null });
    expect(parseDailyBudget('2,000,000').error).not.toBeNull();
  });
});

describe('launch draft', () => {
  const ready = (kind: 'container' | 'sandbox', patch: Partial<LaunchDraft> = {}): LaunchDraft => autofill({ ...initialDraft(kind), ...patch }, CATALOG, 'review');

  it('a deep link to review fills the earlier steps (first template, first available IDC, cheapest priced size, a name)', () => {
    const d = ready('container');
    expect(d).toMatchObject({ templateId: 'tpl-jupyter', idc: 'asia-east-taiwan3', offerId: 'h200', displayName: 'jupyterlab-pytorch-cuda' });
    expect(firstInvalidStep(d, CATALOG)).toBe('review');
    // The user's choices are kept.
    expect(autofill({ ...initialDraft('container'), offerId: 'h200x8', idc: 'asia-east-taiwan3' }, CATALOG, 'review').offerId).toBe('h200x8');
  });

  it('a sandbox defaults to the cheapest size with at least 8 GiB (small is too tight), else the cheapest priced one', () => {
    const sb = (patch: Partial<ComputeOffer>) => offer({ kind: 'sandbox', idc: 'us-central-iowa2', gpuModel: null, gpuCount: 0, ...patch });
    const withSizes: ComputeCatalog = {
      ...CATALOG,
      offers: [
        ...CATALOG.offers,
        sb({ id: 'sb-large', sku: 'gmi.sandbox.large', vcpu: 4, memoryGiB: 8, sizeLabel: 'LARGE', listUsdPerHour: 0.36 }),
        sb({ id: 'sb-medium', sku: 'gmi.sandbox.medium', vcpu: 2, memoryGiB: 8, sizeLabel: 'MEDIUM', listUsdPerHour: 0.18 }),
      ],
    };
    expect(autofill(initialDraft('sandbox'), withSizes, 'review').offerId).toBe('sb-medium');
    // A sandbox is preselected on the Size step itself; a GPU container is not (picked deliberately).
    expect(autofill(initialDraft('sandbox'), withSizes, 'size').offerId).toBe('sb-medium');
    expect(autofill(initialDraft('container'), withSizes, 'size').offerId).toBeNull();
    // Only the small size listed: it is still picked rather than leaving the step empty.
    expect(ready('sandbox').offerId).toBe('sb-small');
    // The user's choice wins.
    expect(autofill({ ...initialDraft('sandbox'), offerId: 'sb-small', idc: 'us-central-iowa2' }, withSizes, 'review').offerId).toBe('sb-small');
  });

  it('the wizard settles when the data centre’s own list (real SKUs) replaces the public aggregated sizes', () => {
    // Mirrors LaunchWizard: the public catalog fills template + IDC, the effective (per-IDC) catalog fills the rest.
    const pub: ComputeCatalog = { ...CATALOG, scope: 'public', offers: CATALOG.offers.map((o) => ({ ...o, id: `agg:${o.id}`, sku: null })) };
    let d = initialDraft('container');
    let rounds = 0;
    for (; rounds < 6; rounds++) {
      const base = autofill(d, pub, 'size');
      const filled = autofill(base, CATALOG, 'review');
      if (filled === d) break;
      d = filled;
    }
    expect(rounds).toBeLessThanOrEqual(2);
    expect(d.offerId).toBe('h200');
    expect(buildSpec(d, CATALOG)).not.toBeNull();
  });

  it('the wizard settles on the sandbox Size step too (only the per-IDC pass preselects; regression: React #185 loop)', () => {
    const pub: ComputeCatalog = { ...CATALOG, scope: 'public', offers: CATALOG.offers.map((o) => ({ ...o, id: `agg:${o.id}`, sku: null })) };
    let d = initialDraft('sandbox');
    let rounds = 0;
    for (; rounds < 6; rounds++) {
      const base = autofill(d, pub, 'size', { preselectSandboxSize: false });
      const filled = autofill(base, CATALOG, 'size');
      if (filled === d) break;
      d = filled;
    }
    expect(rounds).toBeLessThanOrEqual(2);
    expect(d.offerId).toBe('sb-small');
  });

  it('sandbox templates pin their IDC; sizes follow', () => {
    const d = ready('sandbox');
    expect(d).toMatchObject({ templateId: 'tpl-py', idc: 'us-central-iowa2', offerId: 'sb-small' });
    expect(offersFor(CATALOG, 'sandbox', 'us-central-iowa2').map((o) => o.id)).toEqual(['sb-small']);
  });

  it('step errors: maintenance IDC, missing size, bad access CIDR, public access where no EIP exists', () => {
    const d = ready('container');
    expect(stepError({ ...d, idc: 'us-denver-1' }, 'idc', CATALOG)).toMatch(/maintenance/);
    expect(stepError({ ...d, offerId: null }, 'size', CATALOG)).toMatch(/size/);
    expect(stepError({ ...d, access: { mode: 'ssh', cidr: '127.0.0.1', httpPorts: '' } }, 'options', CATALOG)).toMatch(/loopback/);
    expect(stepError({ ...d, idc: 'us-central-iowa2', offerId: 'iowa-cpu', access: { mode: 'ssh', cidr: '203.0.113.7', httpPorts: '' } }, 'options', CATALOG)).toMatch(/not offered/);
    expect(stepError({ ...d, access: { mode: 'http', cidr: '203.0.113.7', httpPorts: '' } }, 'options', CATALOG)).toMatch(/HTTP ports/);
    expect(stepError({ ...d, env: [{ key: '1', name: 'A', value: 'x', secret: true }, { key: '2', name: 'A', value: 'y', secret: false }] }, 'options', CATALOG)).toMatch(/twice/);
  });

  it('container spec: SSH = TCP 22 from one /32 with an app key; a wider CIDR is sent as is (main asks natively)', () => {
    const d = ready('container', { access: { mode: 'ssh', cidr: '203.0.113.7', httpPorts: '' }, env: [{ key: '1', name: 'HF_TOKEN', value: 'secret', secret: true }] });
    expect(buildSpec(d, CATALOG)).toEqual({
      kind: 'container',
      displayName: 'jupyterlab-pytorch-cuda',
      idc: 'asia-east-taiwan3',
      sku: 'gmi.container.nv.H200x1.tw3',
      templateId: 'tpl-jupyter',
      env: [{ name: 'HF_TOKEN', value: 'secret', secret: true }],
      ports: undefined,
      ssh: { mode: 'app_key' },
      access: { mode: 'public', allowCidrs: ['203.0.113.7/32'], tcpPorts: [22] },
      lease: defaultLease('container'),
    });
    const all = buildSpec({ ...d, access: { mode: 'http', cidr: '0.0.0.0/0', httpPorts: '8000, 8888' } }, CATALOG);
    expect(all).toMatchObject({ access: { mode: 'public', allowCidrs: ['0.0.0.0/0'], tcpPorts: [8000, 8888], allOpen: true }, ssh: { mode: 'none' } });
  });

  it('sandbox spec: explicit timeout, secure previews, purpose computer; snapshots replace the template', () => {
    const d = ready('sandbox');
    expect(buildSpec(d, CATALOG)).toMatchObject({
      kind: 'sandbox',
      product: 'gmi.sandbox.small',
      source: { templateId: 'tpl-py' },
      timeoutSec: 3600,
      onTimeout: 'pause',
      secure: true,
      egress: { mode: 'open' },
      purpose: 'computer',
    });
    expect(buildSpec({ ...d, snapshotId: 'snap-1' }, CATALOG)).toMatchObject({ source: { snapshotId: 'snap-1' } });
    expect(buildSpec({ ...d, egress: { mode: 'allowlist', hostnames: 'PyPI.org, registry.npmjs.org' } }, CATALOG)).toMatchObject({
      egress: { mode: 'allowlist', hostnames: ['pypi.org', 'registry.npmjs.org'], cidrs: [] },
    });
  });

  it('no spec while a step is invalid or the size is an aggregated signed-out offer (no SKU)', () => {
    expect(buildSpec(initialDraft('container'), CATALOG)).toBeNull();
    const signedOut: ComputeCatalog = { ...CATALOG, scope: 'public', offers: CATALOG.offers.map((o) => ({ ...o, sku: null })) };
    expect(buildSpec(autofill(initialDraft('container'), signedOut, 'review'), signedOut)).toBeNull();
  });

  it('a daily budget is needed for every container and GPU sandboxes only', () => {
    expect(needsDailyBudget(initialDraft('container'), null)).toBe(true);
    expect(needsDailyBudget(initialDraft('sandbox'), CATALOG.offers[3]!)).toBe(false);
    expect(needsDailyBudget(initialDraft('sandbox'), offer({ kind: 'sandbox', gpuCount: 1 }))).toBe(true);
  });

  it('switching kind resets kind-specific choices (lease, template, size)', () => {
    const d = ready('container');
    const s = withKind(d, 'sandbox');
    expect(s).toMatchObject({ kind: 'sandbox', templateId: null, offerId: null, lease: defaultLease('sandbox') });
    expect(withKind(d, 'container')).toBe(d);
  });

  it('ports and names', () => {
    expect(parsePorts('8000, 8888 8000')).toEqual([8000, 8888]);
    expect(parsePorts('70000')).toBeNull();
    expect(parsePorts('abc')).toBeNull();
    expect(defaultName(null, 'sandbox')).toBe('sandbox');
  });
});

describe('alarm placement', () => {
  it('all on the list, the resource’s own (plus critical) on its page, critical elsewhere', async () => {
    const { visibleAlarms } = await import('@renderer/pages/compute');
    const a = (id: string, resourceId: string | null, severity: 'info' | 'warning' | 'critical') => ({ id, resourceId, severity }) as never;
    const all = [a('1', 'r1', 'warning'), a('2', 'r2', 'info'), a('3', null, 'critical')];
    expect(visibleAlarms(all, 'resources', null)).toHaveLength(3);
    expect(visibleAlarms(all, 'resources', 'r1').map((x: { id: string }) => x.id)).toEqual(['1', '3']);
    expect(visibleAlarms(all, 'launch', null).map((x: { id: string }) => x.id)).toEqual(['3']);
  });
});
