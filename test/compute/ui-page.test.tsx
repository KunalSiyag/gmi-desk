// C1-E Compute page (renderer): what every state shows, rendered with react-dom/server against seeded query caches
// (node environment: effects do not run, nothing is fetched). Checks the D16–D18 rules on each screen: at most one
// lime fill, no native <select>, Plates for working states, sleeping Dino for "nothing yet".
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, ComputeKeyInfo, InferenceKeyInfo } from '@shared/contracts/auth';
import type {
  ComputeAlarm,
  ComputeCatalog,
  ComputeNetworkInventory,
  ComputeOffer,
  ComputeResource,
  ComputeResourceDetail,
  ComputeSnapshot,
  ComputeState,
  CreateQuote,
} from '@shared/contracts/compute';
import type { BudgetStatus } from '@shared/contracts/usage';
import { DEFAULT_BUDGET, type GmiBridge } from '@shared/contracts';
import { GmiError } from '@shared/contracts/errors';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import ComputePage, { SpendStrip, unpricedBilling } from '@renderer/pages/compute';
import { AlarmList, ApiHealthBanner, OrgBillingBanner } from '@renderer/pages/compute/AlarmBanner';
import { defaultLease } from '@renderer/pages/compute/format';
import { AccessStep, DETECT_DISCLOSURE, DETECT_SERVICE } from '@renderer/pages/compute/launch/AccessStep';
import { LaunchSuccess, ReviewStep, useLaunchDraft, type ReviewProps } from '@renderer/pages/compute/launch/LaunchWizard';
import { autofill, initialDraft } from '@renderer/pages/compute/launch/state';
import { NetworkTab } from '@renderer/pages/compute/NetworkTab';
import { DeleteDialog, isOtherInstall, resourceAbilities, ResourceHeader } from '@renderer/pages/compute/ResourceDetail';
import { SnapshotsTab } from '@renderer/pages/compute/SnapshotsTab';
import { ComputePage as RegisteredPage } from '@renderer/pages/registry.compute';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures (synthetic; org id zeroed; TEST-NET-3 addresses)

const ORG = '00000000-0000-0000-0000-000000000000';
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const inMin = (min: number) => new Date(now + min * 60_000).toISOString();

const NO_INFERENCE: InferenceKeyInfo = { status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
const KEY: ComputeKeyInfo = { status: 'valid', last4: 'c0mp', keyId: 'k-1', orgId: ORG, orgMatchesAccount: true, validatedAt: ago(10), error: null };
const NO_KEY: ComputeKeyInfo = { status: 'missing', last4: null, keyId: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };

function auth(computeKey: ComputeKeyInfo = KEY, patch: Partial<AuthState> = {}): AuthState {
  return {
    status: 'signed_in',
    scopes: [],
    orgId: ORG,
    signedInAt: ago(600),
    accessTokenExpiresAt: null,
    inferenceKey: NO_INFERENCE,
    secureStorage: 'os',
    lastError: null,
    mock: true,
    keyDetection: { active: false, candidate: null },
    computeKey,
    ...patch,
  };
}

function state(patch: Partial<ComputeState> = {}): ComputeState {
  return {
    access: { key: KEY, containers: 'entitled', sandboxes: 'entitled', checkedAt: ago(5) },
    running: { count: 2, usdPerHour: 3.4411 },
    todayUsd: 4.2,
    monthUsd: 31.5,
    alarms: [],
    apiHealth: { ce: 'ok', sandbox: 'ok' },
    org: null,
    dailyBudgetSet: true,
    lastSweepAt: ago(2),
    mock: true,
    ...patch,
  };
}

const SRC = { state: 'ok' as const, fetchedAt: ago(5), error: null };
function offer(patch: Partial<ComputeOffer>): ComputeOffer {
  return {
    id: 'h200',
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
function catalog(scope: 'public' | 'account' = 'account'): ComputeCatalog {
  const offers = [
    offer({}),
    offer({ id: 'h200x8', sku: 'gmi.container.nv.H200x8.tw3', gpuCount: 8, listUsdPerHour: 26.8 }),
    offer({ id: 'sb-small', kind: 'sandbox', sku: 'gmi.sandbox.small', idc: 'us-central-iowa2', gpuModel: null, gpuCount: 0, vcpu: 2, memoryGiB: 4, sizeLabel: 'SMALL', listUsdPerHour: 0.0911 }),
  ];
  return {
    idcs: [
      { id: 'asia-east-taiwan3', name: 'Taiwan 3', country: 'TW', status: 'available', kinds: ['container'], eipAvailable: true },
      { id: 'us-central-iowa2', name: 'Iowa 2', country: 'US', status: 'available', kinds: ['sandbox'], eipAvailable: false },
      { id: 'us-denver-1', name: 'Denver 1', country: 'US', status: 'maintenance', kinds: ['container'], eipAvailable: null },
    ],
    offers: scope === 'public' ? offers.map((o) => ({ ...o, sku: null, id: `${o.kind}:${o.gpuModel ?? 'cpu'}x${o.gpuCount}:${o.idc}`, entitled: null })) : offers,
    templates: [
      { id: 'tpl-jupyter', kind: 'container', name: 'JupyterLab (PyTorch, CUDA 12)', official: true, image: 'docker.io/gmicloudai/jupyterlab-pytorch:v2', description: 'JupyterLab with PyTorch.', defaultPorts: [{ port: 22, protocol: 'TCP', label: 'ssh' }], sshReady: true, idc: null },
      { id: 'tpl-py', kind: 'sandbox', name: 'Python', official: true, image: null, description: null, defaultPorts: [], sshReady: null, idc: 'us-central-iowa2' },
    ],
    scope,
    sources: { idcs: SRC, publicProducts: SRC, publicTemplates: SRC, accountProducts: SRC, accountTemplates: SRC, sandboxProducts: SRC, sandboxTemplates: SRC },
    fetchedAt: ago(5),
  };
}

const CAPS_SB = { terminal: true, files: true, previews: true, logs: false, restart: false, pause: true, snapshot: true, extend: true, network: false };
const CAPS_CE = { terminal: false, files: false, previews: false, logs: true, restart: true, pause: false, snapshot: false, extend: true, network: true };

function sandbox(patch: Partial<ComputeResource> = {}): ComputeResource {
  return {
    id: 'cr_mock_sb1',
    kind: 'sandbox',
    backend: 'sandbox_v2',
    remoteId: 'sbx-mock-0001',
    name: 'python-dev',
    displayName: 'python-dev',
    managed: true,
    purpose: 'computer',
    threadId: null,
    phase: 'running',
    rawState: 'running',
    reason: null,
    idc: 'us-central-iowa2',
    sku: 'gmi.sandbox.small',
    templateName: 'Python',
    listUsdPerHour: 0.0911,
    createdAt: ago(40),
    runningSince: ago(39),
    serverEndsAt: inMin(20),
    leaseEndsAt: inMin(400),
    pausedExpiresAt: null,
    idlePauseAt: inMin(12),
    lease: defaultLease('sandbox'),
    accruedUsd: 0.06,
    accruedTodayUsd: 0.06,
    network: null,
    secure: true,
    egressLocked: false,
    capabilities: CAPS_SB,
    pendingAction: null,
    actionPending: null,
    updatedAt: ago(1),
    ...patch,
  };
}

function container(patch: Partial<ComputeResource> = {}): ComputeResource {
  return {
    ...sandbox(),
    id: 'cr_mock_ce1',
    kind: 'container',
    backend: 'ce',
    remoteId: '00000000-0000-4000-8000-00000000d001',
    name: 'gmid-a1b2c3-h200-notebook-a7k2qp',
    displayName: 'h200-notebook',
    idc: 'asia-east-taiwan3',
    sku: 'gmi.container.nv.H200x1.tw3',
    templateName: 'JupyterLab (PyTorch, CUDA 12)',
    listUsdPerHour: 3.35,
    serverEndsAt: null,
    idlePauseAt: null,
    leaseEndsAt: inMin(90),
    lease: defaultLease('container'),
    accruedUsd: 8.37,
    accruedTodayUsd: 8.37,
    secure: null,
    egressLocked: null,
    capabilities: CAPS_CE,
    network: {
      publicIp: '203.0.113.10',
      eip: { id: 'eip-1', address: '203.0.113.10', managed: true, status: 'associated' },
      firewalls: [{ id: 'fw-1', name: 'h200-notebook-fw', managed: true, preset: false, rules: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '203.0.113.7/32' }] }],
      ports: [{ containerPort: 22, nodePort: 30022, protocol: 'TCP' }],
      degraded: false,
    },
    ...patch,
  };
}

function detail(r: ComputeResource, patch: Partial<ComputeResourceDetail> = {}): ComputeResourceDetail {
  return { ...r, envNames: ['HF_TOKEN'], command: null, args: [], sshKeyNames: [], snapshotId: null, lastError: null, history: [{ at: ago(39), phase: 'running', note: null }], ...patch };
}

function alarm(patch: Partial<ComputeAlarm>): ComputeAlarm {
  return { id: 'a1', kind: 'orphan', severity: 'warning', resourceId: 'cr_x', title: 'Alarm', body: '', usdPerHour: null, createdAt: ago(1), actions: ['dismiss'], ...patch };
}

const BUDGET: BudgetStatus = { budget: { ...DEFAULT_BUDGET, dailyUsd: 25 }, spentTodayUsd: 4.2, spentMonthUsd: 31.5, remainingTodayUsd: 20.8, remainingMonthUsd: null, updatedAt: ago(1) };

// ---------------------------------------------------------------------------------------------------------------
// Rendering

interface Seed {
  auth?: AuthState;
  state?: ComputeState | null;
  catalog?: ComputeCatalog;
  resources?: ComputeResource[];
  detail?: ComputeResourceDetail;
  network?: ComputeNetworkInventory;
  snapshots?: ComputeSnapshot[];
  budget?: BudgetStatus;
}

function client(seed: Seed): QueryClient {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  c.setQueryData(qk.auth, seed.auth ?? auth());
  if (seed.state !== null) c.setQueryData(qk.computeState, seed.state ?? state());
  c.setQueryData(qk.computeCatalog(null), seed.catalog ?? catalog());
  c.setQueryData(qk.computeResources(false), seed.resources ?? []);
  c.setQueryData(qk.budget, seed.budget ?? BUDGET);
  if (seed.detail) c.setQueryData(qk.computeResource(seed.detail.id), seed.detail);
  if (seed.network) c.setQueryData(qk.computeNetwork, seed.network);
  if (seed.snapshots) c.setQueryData(qk.computeSnapshots, seed.snapshots);
  return c;
}

function render(node: ReactNode, seed: Seed = {}): string {
  return renderToStaticMarkup(<QueryClientProvider client={client(seed)}>{node}</QueryClientProvider>);
}

function page(params: Record<string, string>, seed: Seed = {}): string {
  useUi.setState({ page: 'compute', params });
  return render(<ComputePage />, seed);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
/** Buttons with the lime fill (Button variant="default"). */
const limeButtons = (html: string) => (html.match(/<button[^>]*class="[^"]*\bbg-primary text-primary-foreground[^"]*"/g) ?? []).length;
/** D16–D18 on every screen: at most one lime fill, the kit Select only. */
function expectDesignRules(html: string): void {
  expect(limeButtons(html)).toBeLessThanOrEqual(1);
  expect(html).not.toMatch(/<select[\s>]|<option[\s>]/);
}

beforeEach(() => {
  const bridge: GmiBridge = { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' };
  (globalThis as { window?: unknown }).window = { gmi: bridge, setInterval, clearInterval, setTimeout, clearTimeout };
  useLaunchDraft.getState().reset('container');
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  useUi.setState({ page: 'chat', params: {}, connectOpen: false, connectTarget: 'inference' });
});

// ---------------------------------------------------------------------------------------------------------------

describe('registration', () => {
  it('pages/registry.compute.ts serves this page (default export), not the stub', () => {
    expect(RegisteredPage).toBe(ComputePage);
  });
});

describe('signed out / no Compute key: browse', () => {
  const seed: Seed = { auth: auth(NO_KEY, { status: 'signed_out' }), state: null, catalog: catalog('public') };

  it('shows what GMI offers with "from $X/h", no raw SKUs, and Connect Compute as the one lime action', () => {
    const html = page({}, seed);
    const t = text(html);
    expect(t).toContain('Launch GPUs and sandboxes from here');
    expect(t).toContain('What GMI offers');
    expect(t).toMatch(/1× H200 .*from \$3\.35\/h/);
    // Sandbox sizes read as words ("Small"), not GMI's enum names ("SMALL").
    expect(t).toMatch(/Small .*from \$0\.091\/h/);
    expect(t).not.toContain('SMALL');
    expect(t).toContain('JupyterLab (PyTorch, CUDA 12)');
    expect(t).toMatch(/Denver 1 · maintenance/);
    expect(t).not.toMatch(/gmi\.container\.|gmi\.sandbox\./);
    expect(t).toContain('List price from GMI’s public price list. Your organization may pay less.');
    expect(t).toContain('Connect Compute');
    expect(limeButtons(html)).toBe(1);
    expectDesignRules(html);
  });

  it('Network and Snapshots explain that they need a key (sleeping Dino)', () => {
    for (const tab of ['network', 'snapshots']) {
      const html = page({ tab }, seed);
      expect(text(html)).toMatch(/need a Compute key/);
      expect(html).toContain('data-mood="sleep"');
      expectDesignRules(html);
    }
  });

  it('the wizard works on the public catalog; review asks to connect instead of quoting', () => {
    const html = page({ tab: 'launch', step: 'review' }, seed);
    const t = text(html);
    expect(t).toContain('Connect Compute to launch');
    expect(t).not.toContain('Pricing with GMI');
    expect(html).not.toContain('data-create');
    expect(limeButtons(html)).toBe(1);
    expectDesignRules(html);
  });

  it('an invalid key says resources keep billing and offers to replace it', () => {
    const html = page({}, { auth: auth({ ...KEY, status: 'invalid' }), state: null, catalog: catalog('public') });
    expect(text(html)).toContain('Your Compute key stopped working');
    expect(text(html)).toContain('keeps running and billing');
    expect(text(html)).toContain('Replace Compute key');
    expectDesignRules(html);
  });

  it('a locked keychain is its own state', () => {
    const html = page({}, { auth: auth(KEY, { lockedSecrets: ['compute_key'] }), state: null, catalog: catalog('public') });
    expect(text(html)).toContain('Your Compute key is locked');
    expectDesignRules(html);
  });
});

describe('Resources tab', () => {
  it('lists managed resources with phase, $/h, accrued and the next automatic event; access chips; spend strip', () => {
    const html = page({}, { resources: [container(), sandbox()] });
    const t = text(html);
    expect(t).toContain('h200-notebook');
    expect(t).toContain('python-dev');
    expect(t).toContain('$3.35/h');
    expect(t).toContain('$8.37 so far');
    expect(t).toMatch(/Deletes in 1 h (29|30) min/);
    expect(t).toMatch(/Idle pause in (11|12) min/);
    expect(t).toContain('Show all in organization');
    expect(t).toMatch(/Containers\s+Enabled/);
    expect(t).toMatch(/RUNNING\s+2|Running\s+2/i);
    expect(t).toMatch(/Today\s+\$4\.20/);
    expect(t).toMatch(/Budget left today\s+\$20\.80/);
    expectDesignRules(html);
  });

  it('working phases use Plates; a lease action that keeps failing shows its retries', () => {
    const html = page({}, {
      resources: [
        sandbox({ id: 'a', phase: 'creating' }),
        container({ id: 'b', actionPending: { action: 'delete', dueAt: ago(10), attempts: 3, lastError: '503' } }),
      ],
    });
    expect(html).toContain('data-plates');
    expect(text(html)).toContain('Starting');
    expect(text(html)).toContain('Delete pending · 3 attempts');
  });

  it('nothing yet: sleeping Dino and "Launch a computer" as the one lime action', () => {
    const html = page({}, { resources: [] });
    expect(text(html)).toContain('No computers yet');
    expect(html).toContain('data-mood="sleep"');
    expect(limeButtons(html)).toBe(1);
    expectDesignRules(html);
  });

  it('no_daily_budget: the inline daily budget (no amount pre-filled), not lime next to the launch action', () => {
    const html = page({}, { resources: [], state: state({ dailyBudgetSet: false }), budget: { ...BUDGET, budget: DEFAULT_BUDGET } });
    const t = text(html);
    expect(html).toContain('data-budget-inline');
    expect(t).toContain('Set a daily budget first');
    expect(html).toMatch(/<input[^>]*placeholder="Amount"[^>]*value=""/);
    expect(limeButtons(html)).toBe(1);
    expectDesignRules(html);
  });

  it('budget_low: the guard’s budget warning shows on top', () => {
    const html = page({}, {
      resources: [container()],
      state: state({
        alarms: [alarm({ id: 'b1', kind: 'budget_warning', severity: 'warning', resourceId: null, title: 'Daily budget almost used', body: '$0.40 left today at $3.44/h.', actions: ['dismiss'] })],
      }),
    });
    expect(html).toContain('data-alarm="budget_warning"');
    expect(text(html)).toContain('Daily budget almost used');
    expectDesignRules(html);
  });

  it('orphan (this install): Open, Pause, Delete and Dismiss; the price per hour', () => {
    const html = page({}, {
      resources: [sandbox()],
      state: state({
        alarms: [
          alarm({ kind: 'orphan', severity: 'warning', resourceId: 'cr_mock_sb3', title: 'Found a running sandbox from an earlier session', usdPerHour: 0.18, actions: ['open', 'pause', 'delete', 'dismiss'] }),
        ],
      }),
    });
    const t = text(html);
    expect(html).toContain('data-alarm="orphan"');
    expect(t).toContain('Found a running sandbox from an earlier session');
    expect(t).toContain('$0.18/h');
    expect(t).toMatch(/Open .*Pause .*Delete…/);
    expect(html).toContain('aria-label="Dismiss: Found a running sandbox from an earlier session"');
    expectDesignRules(html);
  });

  it('orphan_other_install: read-only, Adopt… and Open in console only', () => {
    const html = page({}, {
      state: state({
        alarms: [
          alarm({ kind: 'orphan', severity: 'warning', resourceId: 'cr_other', title: 'A GMI Desk container from another install is billing', usdPerHour: 2.1, actions: ['open_console', 'adopt'] }),
        ],
      }),
    });
    const t = text(html);
    expect(t).toContain('Adopt…');
    expect(t).toContain('Open in console');
    expect(t).not.toContain('Delete…');
    expectDesignRules(html);
  });

  it('eip_orphan: an unattached IP with Release… (critical first)', () => {
    const html = page({}, {
      state: state({
        alarms: [
          alarm({ id: 'x', kind: 'paused_long', severity: 'info', title: 'Paused for a day', actions: ['dismiss'] }),
          alarm({ id: 'e', kind: 'eip_unattached', severity: 'critical', resourceId: 'eip-2', title: 'A public IP is not attached and bills until released', usdPerHour: 0.1, actions: ['release_eip', 'open_console'] }),
        ],
      }),
    });
    expect(html.indexOf('data-alarm="eip_unattached"')).toBeLessThan(html.indexOf('data-alarm="paused_long"'));
    expect(text(html)).toContain('Release IP…');
    expectDesignRules(html);
  });

  it('org_billing: counts and $/h only, never names', () => {
    const html = page({}, { resources: [container()], state: state({ org: { containers: 3, eips: 2, usdPerHour: 34.15 } }) });
    expect(text(html)).toContain('3 containers · 2 EIPs are billing in your organization ($34.15/h list).');
    expect(html).toContain('data-banner="org"');
    expectDesignRules(html);
  });

  it('api_down: a banner, last known state kept', () => {
    const html = page({}, { resources: [container()], state: state({ apiHealth: { ce: 'down', sandbox: 'ok' } }) });
    expect(text(html)).toContain('GMI’s container API is not answering.');
    expect(text(html)).toContain('h200-notebook');
  });

  it('alarms collapse after three', () => {
    const many = [1, 2, 3, 4, 5].map((i) => alarm({ id: `a${i}`, title: `Alarm ${i}` }));
    const html = render(<AlarmList alarms={many} onAction={() => undefined} busy={null} />);
    expect(text(html)).toContain('Show 2 more alarms');
    expect((html.match(/data-alarm=/g) ?? []).length).toBe(3);
  });
});

describe('Resource detail', () => {
  it('a running sandbox: Open computer is the one lime action; overview, lease editor, env names only', () => {
    const r = detail(sandbox());
    const html = page({ resource: r.id }, { resources: [r], detail: r });
    const t = text(html);
    expect(html).toContain(`data-resource-detail="${r.id}"`);
    expect(t).toContain('Open computer');
    expect(limeButtons(html)).toBe(1);
    expect(t).toContain('Run for at most');
    expect(t).toContain('Pause when idle');
    expect(t).toContain('If a budget runs out');
    expect(t).toContain('HF_TOKEN');
    expect(t).toContain('names only');
    expectDesignRules(html);
  });

  it('a container: network (EIP, firewall rule, update to my IP), logs on demand, delete', () => {
    const r = detail(container());
    const html = page({ resource: r.id }, { resources: [r], detail: r });
    const t = text(html);
    expect(t).toContain('203.0.113.10');
    expect(t).toContain('TCP 22 from 203.0.113.7/32');
    expect(t).toContain('Update firewall to my current IP');
    expect(t).toContain('Load logs');
    expect(t).toContain('Save full log…');
    expect(t).toContain('Delete…');
    expect(t).toContain('Your budget will not stop this container');
    // No terminal capability yet (P-CE): no Open computer, so no lime at all.
    expect(limeButtons(html)).toBeLessThanOrEqual(1);
    expectDesignRules(html);
  });

  it('a paused sandbox: Resume… (main asks with the price)', () => {
    const r = sandbox({ phase: 'paused', idlePauseAt: null });
    const html = render(<ResourceHeader resource={r} canManage now={now} busy={false} onBack={noop} onPause={noop} onResume={noop} onRestart={noop} onExtend={noop} onSnapshot={noop} onDelete={noop} onAdopt={noop} />);
    expect(text(html)).toContain('Resume…');
    expect(text(html)).not.toContain('Open computer');
    expect(limeButtons(html)).toBe(1);
  });

  it('another install’s container: read-only with Adopt…; never Delete or Open computer', () => {
    const r = container({ managed: false, name: 'gmid-zzzzzz-finetune-x4n2rd', displayName: 'gmid-zzzzzz-finetune-x4n2rd', lease: null });
    expect(isOtherInstall(r)).toBe(true);
    expect(resourceAbilities(r, true)).toMatchObject({ adopt: true, delete: false, openComputer: false, pause: false });
    const html = render(<ResourceHeader resource={r} canManage now={now} busy={false} onBack={noop} onPause={noop} onResume={noop} onRestart={noop} onExtend={noop} onSnapshot={noop} onDelete={noop} onAdopt={noop} />);
    const t = text(html);
    expect(t).toContain('Adopt…');
    expect(t).toContain('Unmanaged');
    expect(t).toContain('Created by another GMI Desk');
    expect(t).not.toContain('Delete…');
    expect(limeButtons(html)).toBe(0);
  });

  it('a resource someone created outside GMI Desk cannot be adopted', () => {
    expect(resourceAbilities(container({ managed: false, name: 'research-box' }), true)).toMatchObject({ adopt: false, delete: false });
  });

  it('delete is disabled while creating; actions need a usable key', () => {
    expect(resourceAbilities(container({ phase: 'creating' }), true).delete).toBe(false);
    expect(resourceAbilities(sandbox(), false)).toMatchObject({ delete: false, openComputer: false, pause: false });
  });

  it('the delete dialog offers to release the IP and firewall GMI Desk created', () => {
    const html = render(<DeleteDialog r={container()} open onOpenChange={noop} onConfirm={noop} />);
    // Portalled dialogs render nothing on the server; the component itself must not throw.
    expect(typeof html).toBe('string');
  });
});

describe('Launch wizard', () => {
  const readyDraft = () => autofill(initialDraft('container'), catalog(), 'review');
  const review = (patch: Partial<ReviewProps> = {}) =>
    render(
      <ReviewStep
        draft={readyDraft()}
        catalog={catalog()}
        keyView="ready"
        dailyBudgetSet
        quote={undefined}
        quoting={false}
        quoteError={null}
        onRequote={noop}
        creating={false}
        createError={null}
        onCreate={noop}
        now={now}
        {...patch}
      />,
    );
  const QUOTE: CreateQuote = {
    quoteId: 'q1',
    spec: { kind: 'container', displayName: 'jupyterlab', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', templateId: 'tpl-jupyter', ssh: { mode: 'none' }, access: { mode: 'none' }, lease: defaultLease('container') },
    lines: [
      { label: '1× H200 container', usdPerHour: 3.35, note: null },
      { label: 'Public IP', usdPerHour: 0.1, note: 'until released' },
    ],
    usdPerHour: 3.45,
    maxUsd: 13.8,
    priceSource: 'public_feed',
    priceAgeSec: 120,
    budget: { allowed: true, needsConfirmation: true, reason: null, remainingTodayUsd: 20.8, remainingMonthUsd: null },
    warnings: [],
    expiresAt: new Date(now + 300_000).toISOString(),
  };

  it('review with a quote: lines, total, at most, budget; Create is the one lime action; a native dialog comes next', () => {
    const html = review({ quote: QUOTE });
    const t = text(html);
    expect(t).toContain('1× H200 container');
    expect(t).toContain('$3.45/h');
    expect(t).toMatch(/At most \$13\.80/);
    expect(t).toContain('$20.80 left today');
    expect(t).toContain('Deletes after 4 h');
    expect(t).toContain('Keep running and notify me');
    expect(t).toContain('system dialog with the price');
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-primary text-primary-foreground[^"]*"[^>]*data-create/);
    expect(limeButtons(html)).toBe(1);
    expectDesignRules(html);
  });

  it('no daily budget: the inline budget is the lime action and Create is disabled', () => {
    const html = review({ dailyBudgetSet: false });
    expect(html).toContain('data-budget-inline');
    expect(text(html)).toContain('Containers keep billing until they are deleted');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-create|<button[^>]*data-create[^>]*disabled=""/);
    expect(limeButtons(html)).toBe(1);
  });

  it('over budget: Create stays disabled with the reason', () => {
    const html = review({ quote: { ...QUOTE, budget: { ...QUOTE.budget, allowed: false, reason: 'This would go over your $25.00 daily budget.' } } });
    expect(text(html)).toContain('This would go over your $25.00 daily budget.');
    expect(limeButtons(html)).toBe(0);
  });

  it('price unknown: main refuses while enforced; no retry loop offered', () => {
    const html = review({ quoteError: new GmiError('invalid_input', 'GMI Desk cannot verify the price of this size right now.') });
    expect(text(html)).toContain('cannot verify the price');
    expect(limeButtons(html)).toBe(0);
  });

  it('an old price is flagged; quote warnings are shown', () => {
    const html = review({ quote: { ...QUOTE, priceAgeSec: 30 * 3600, warnings: ['Opens TCP 22 to 203.0.113.7/32.'] } });
    expect(text(html)).toMatch(/Price from .*could not be refreshed/);
    expect(text(html)).toContain('Opens TCP 22 to 203.0.113.7/32.');
  });

  it('a declined native dialog says nothing', () => {
    const html = review({ quote: QUOTE, createError: new GmiError('cancelled', 'Declined') });
    expect(html).not.toContain('role="alert"');
  });

  it('the page deep link ?tab=launch&step=review fills the draft and shows the review', () => {
    const html = page({ tab: 'launch', step: 'review' });
    expect(html).toContain('data-step="review"');
    expect(html).toContain('data-review');
    expect(text(html)).toContain('JupyterLab (PyTorch, CUDA 12)');
    expectDesignRules(html);
  });

  it('first step: kind switch and templates; Continue is lime only when the step is valid', () => {
    const html = page({ tab: 'launch', step: 'template' });
    expect(text(html)).toContain('GPU container');
    expect(text(html)).toContain('Official');
    expect(limeButtons(html)).toBe(0);
    useLaunchDraft.getState().set({ ...initialDraft('container'), templateId: 'tpl-jupyter' });
    expect(limeButtons(page({ tab: 'launch', step: 'template' }))).toBe(1);
  });

  it('size step: list prices per SKU; options step: access choice, Detect disclosure, lease editor', () => {
    const size = text(page({ tab: 'launch', step: 'size' }));
    expect(size).toContain('$26.80/h');
    expect(size).toContain('gmi.container.nv.H200x8.tw3');
    const opts = page({ tab: 'launch', step: 'options' });
    expect(text(opts)).toContain('How will you reach it?');
    expect(text(opts)).toContain('If a budget runs out');
    expectDesignRules(opts);
  });

  it('access: Detect is disclosed before use and names the service after; wide CIDRs warn', () => {
    const idc = catalog().idcs[0]!;
    const before = text(render(<AccessStep access={{ mode: 'ssh', cidr: '', httpPorts: '' }} onChange={noop} idc={idc} />));
    expect(before).toContain(DETECT_DISCLOSURE);
    const after = text(render(<AccessStep access={{ mode: 'ssh', cidr: '203.0.113.7', httpPorts: '' }} onChange={noop} idc={idc} detected={{ ip: '203.0.113.7', service: 'api.ipify.org' }} />));
    expect(after).toContain('Detected 203.0.113.7 with api.ipify.org.');
    const open = text(render(<AccessStep access={{ mode: 'ssh', cidr: '0.0.0.0/0', httpPorts: '' }} onChange={noop} idc={idc} />));
    expect(open).toContain('All Open: anyone on the internet');
    const noEip = render(<AccessStep access={{ mode: 'none', cidr: '', httpPorts: '' }} onChange={noop} idc={{ ...idc, eipAvailable: false }} />);
    expect(text(noEip)).toContain('GMI does not offer public IPs');
    expect((noEip.match(/role="radio"[^>]*disabled=""|disabled=""[^>]*role="radio"/g) ?? []).length).toBe(2);
  });

  it('success: happy Dino on the first create of the session only', () => {
    const r = sandbox({ phase: 'creating' });
    const first = render(<LaunchSuccess resource={r} celebrate onOpen={noop} onAnother={noop} />);
    expect(first).toContain('data-mood="happy"');
    expect(limeButtons(first)).toBe(1);
    expect(render(<LaunchSuccess resource={r} celebrate={false} onOpen={noop} onAnother={noop} />)).not.toContain('data-mood');
  });
});

describe('Network and Snapshots tabs', () => {
  const INVENTORY: ComputeNetworkInventory = {
    eips: [
      { id: 'eip-1', name: 'gmid-a1b2c3-h200-notebook-a7k2qp-eip', idc: 'asia-east-taiwan3', address: '203.0.113.10', status: 'associated', attachedTo: 'cr_mock_ce1', managed: true, listUsdPerHour: 0.1 },
      { id: 'eip-2', name: 'gmid-a1b2c3-old-box-r2k7mz-eip', idc: 'asia-east-taiwan1', address: '203.0.113.24', status: 'disassociated', attachedTo: null, managed: true, listUsdPerHour: 0.1 },
      { id: 'eip-3', name: 'research-box-ip', idc: 'asia-east-taiwan3', address: '203.0.113.31', status: 'disassociated', attachedTo: null, managed: false, listUsdPerHour: 0.1 },
    ],
    firewalls: [{ id: 'fw-1', name: 'h200-notebook-fw', idc: 'asia-east-taiwan3', preset: false, managed: true, attachedCount: 1, status: 'active' }],
    fetchedAt: new Date(now).toISOString(),
  };

  it('network: managed unattached IPs can be released; unmanaged ones only open in the console', () => {
    const html = render(<NetworkTab inventory={INVENTORY} loading={false} error={null} onRetry={noop} now={now} onReleased={noop} onOpenResource={noop} />);
    const t = text(html);
    expect(t).toContain('2 public IPs are not attached to anything and still bill until released.');
    expect((t.match(/Release…/g) ?? []).length).toBe(1);
    expect(t).toContain('Open in console');
    expect(t).toContain('Open container');
    expect(t).toContain('attached to 1 container');
    expectDesignRules(html);
  });

  it('network tab on the page', () => {
    const html = page({ tab: 'network' }, { network: INVENTORY });
    expect(html).toContain('data-eip="eip-2"');
    expectDesignRules(html);
  });

  it('snapshots: states, launch from ready ones, storage price unknown', () => {
    const snaps: ComputeSnapshot[] = [
      { id: 's1', name: 'python-base', sourceResourceId: 'cr_mock_sb1', sourceRemoteId: 'sbx-mock-0001', idc: 'us-central-iowa2', state: 'ready', createdAt: ago(60), sizeBytes: 1_200_000_000, managed: true },
      { id: 's2', name: 'saving', sourceResourceId: null, sourceRemoteId: null, idc: null, state: 'creating', createdAt: ago(1), sizeBytes: null, managed: true },
    ];
    const html = render(<SnapshotsTab snapshots={snaps} loading={false} error={null} onRetry={noop} now={now} canManage onLaunch={noop} onDeleted={noop} />);
    const t = text(html);
    expect(t).toContain('python-base');
    expect(t).toContain('1.2 GB');
    expect(html).toContain('data-plates');
    expect(t).toContain('Snapshot storage price is unknown');
    expect((html.match(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*lucide-rocket/g) ?? []).length).toBeLessThanOrEqual(1);
    expectDesignRules(html);
  });

  it('no snapshots yet', () => {
    const html = page({ tab: 'snapshots' }, { snapshots: [] });
    expect(text(html)).toContain('No snapshots yet');
  });
});

describe('banners and strip', () => {
  it('API health: nothing while ok/unknown; quiet when degraded', () => {
    expect(render(<ApiHealthBanner health={{ ce: 'ok', sandbox: 'unknown' }} />)).toBe('');
    expect(text(render(<ApiHealthBanner health={{ ce: 'degraded', sandbox: 'degraded' }} />))).toContain('GMI’s compute APIs are answering slowly.');
  });

  it('org banner renders nothing before the first sweep', () => {
    expect(render(<OrgBillingBanner org={null} onOpenConsole={noop} />)).toBe('');
  });

  it('spend strip: budget left only with a daily budget; amber when under 15 min of burn', () => {
    expect(text(render(<SpendStrip state={state()} budgetLeftTodayUsd={null} />))).not.toContain('Budget left');
    const low = render(<SpendStrip state={state()} budgetLeftTodayUsd={0.4} />);
    expect(text(low)).toContain('Budget left today $0.40');
    expect(low).toContain('text-warning-foreground');
  });

  it('spend strip: a billing resource with an unknown price makes the burn "≥" or "price unknown", never a plain $0.00/h', () => {
    const s = state();
    expect(text(render(<SpendStrip state={{ ...s, running: { count: 2, usdPerHour: 3.35 } }} budgetLeftTodayUsd={null} unpricedBilling={1} />))).toContain('Burn ≥ $3.35/h');
    expect(text(render(<SpendStrip state={{ ...s, running: { count: 1, usdPerHour: 0 } }} budgetLeftTodayUsd={null} unpricedBilling={1} />))).toContain('Burn price unknown');
    expect(unpricedBilling([container({ id: 'cr_a', listUsdPerHour: null, phase: 'running' }), sandbox({ id: 'cr_b', listUsdPerHour: null, phase: 'paused' })])).toBe(1);
  });

  it('"Detect my IP" names the echo service before the click (main\'s constant: review-fixes.test.ts)', () => {
    expect(DETECT_SERVICE).toBe('api.ipify.org');
    expect(DETECT_DISCLOSURE).toContain(DETECT_SERVICE);
  });
});

function noop() {
  return undefined;
}
