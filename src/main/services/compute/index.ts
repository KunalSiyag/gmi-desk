// The compute slice's entry (compute.md §14 `index.ts`). C1-C: builds the service (catalog, clients, registry,
// journal, supervisor, guard, sweep) and the mock wiring when `ctx.mock` (simulators only: no client that could reach
// GMI is ever constructed in mock mode, T17).
//
// Startup order: registry + journal + catalog cache load → (mock: seed the demo resources) → every unresolved journal
// entry is reconciled → supervisor, guard and catalog timers start → entitlement probe → sweep (then every 10 min).
// Reads (getState, listResources, getCatalog) never wait for startup (first paint < 300 ms, §18); mutations do.
import { COMPUTE_API_METHODS, type ComputeApi } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { AppContext } from '../../core/context';
import type { AuthService, BudgetGuard, BudgetSources, CatalogService, ComputeKeyProvider } from '../../core/services';
import type { QuitCheck } from '../../core/shutdown';
import { createNotImplementedApi } from '../../ipc/registry';
import { createMockCompute, mockComputeFlags, type MockCompute } from '../../mock/compute';
import { createComputeCatalog, type ComputeCatalogService } from './catalog';
import { createCeClient, createCePublicClient, type CeApi, type CePublicApi } from './ce/client';
import { backfillPrice, openEipInterval } from './accrual';
import { createComputeGuard } from './guard';
import { createJournal } from './journal';
import { keyGated } from './mock-wiring';
import { installLabel, installTag } from './names';
import { blankRecord, createRegistry, defaultLease } from './registry';
import { createSandboxClient, type SandboxApi } from './sandbox/client';
import { createDataPlane, createTokenCache, type DataPlaneApi, type TokenCache } from './sandbox/dataplane';
import { createComputeTrace } from './sanitize';
import { createComputeService, createSecretScreen, type ComputeServiceInstance } from './service';
import { createServerClock, createSupervisor, observeContainer, observeSandbox, type ComputeSupervisor } from './supervisor';
import { createSweeper } from './sweep';
import { COMPUTE_TIMING, type ComputeInternals, type Registry, type ResourceActions } from './types';

export interface ComputeServiceDeps {
  auth: AuthService;
  /** The Compute key, owned by auth (DC1): the slice never stores a key itself. */
  keys: ComputeKeyProvider;
  catalog: CatalogService;
  budget: BudgetGuard;
  budgetSources: BudgetSources;
}

/** The clients behind the service (real or simulated), for the computer (C2) registration. Main only. */
export interface ComputeBackends {
  publicApi: CePublicApi;
  ce: CeApi;
  sandbox: SandboxApi;
  dataPlane: DataPlaneApi;
  tokens: TokenCache;
  /** Mock mode only: the simulator (C2-A wires its fake PTY). */
  mock: MockCompute | null;
}

/** What `createComputeSlice` returns; `src/main/slices/compute.ts` registers it. */
export interface ComputeService {
  /** The `compute` IPC namespace. */
  api: ComputeApi;
  /** Shared with the computer (C2) and the harness broker (H4). */
  internals: ComputeInternals | null;
  /** The cost guard's quit check (§9.7). */
  quitCheck: QuitCheck | null;
  /** Stops timers and flushes the registry and journal (runs at quit). */
  dispose(): Promise<void>;
  /** Clients for C2 (data plane, tokens, the mock PTY). */
  backends?: ComputeBackends;
}

/** The stub API: every method rejects with not_implemented. */
export function notImplementedComputeApi(): ComputeApi {
  return createNotImplementedApi<ComputeApi>('Compute', COMPUTE_API_METHODS);
}

/** Methods that change something remote: they wait until startup reconciled the journal. */
const MUTATING: ReadonlySet<keyof ComputeApi> = new Set([
  'quoteCreate',
  'create',
  'delete',
  'restart',
  'pause',
  'resume',
  'extend',
  'setLease',
  'createSnapshot',
  'deleteSnapshot',
  'releaseEip',
  'updateFirewallCidr',
  'adopt',
  'dismissAlarm',
]);

/** The public IP echo service behind "Detect my IP" (named in the wizard before the click: AccessStep DETECT_SERVICE). */
export const PUBLIC_IP_SERVICE = 'api.ipify.org';

/** How long startup waits for the public price feed before the first reconcile and sweep. */
const STARTUP_PRICE_WAIT_MS = 8_000;

/** `no_key` mock flag: behave as if no Compute key is stored. */
function noKeyProvider(): ComputeKeyProvider {
  return {
    getComputeKey: async () => null,
    requireComputeKey: async () => {
      throw new GmiError('no_compute_key', 'Compute needs a GMI Compute API key. Connect Compute to add one.');
    },
    reportInvalidComputeKey: async () => undefined,
    onChange: () => () => undefined,
  };
}

/** Electron's powerMonitor when running inside Electron (never in unit tests). */
async function electronPower(): Promise<{ onSuspend(l: () => void): () => void; onResume(l: () => void): () => void } | null> {
  if (!process.versions.electron) return null;
  try {
    const { powerMonitor } = await import('electron');
    return {
      onSuspend(listener) {
        powerMonitor.on('suspend', listener);
        return () => powerMonitor.off('suspend', listener);
      },
      onResume(listener) {
        powerMonitor.on('resume', listener);
        return () => powerMonitor.off('resume', listener);
      },
    };
  } catch {
    return null;
  }
}

/**
 * Mock mode: the simulator's demo resources of this install start as managed records (as if created earlier), so the
 * page has something to show. Resources behind the `orphan` flags are left for the sweep to find.
 */
async function seedMock(registry: Registry, supervisor: ComputeSupervisor, mock: MockCompute, catalog: ComputeCatalogService, tag: string, label: string, now: () => Date) {
  const seedContainers = new Set(['00000000-0000-4000-8000-00000000d001']);
  const seedSandboxRids = new Set(['cr_mock_sb1', 'cr_mock_sb2']);
  const at = now().toISOString();
  const leaseEndsInMin = mock.scenario.leaseEndsInMin;
  for (const c of await mock.ce.listContainers()) {
    if (!seedContainers.has(c.id) || registry.findByRemote('ce', c.id)) continue;
    const lease = defaultLease('container');
    const runningSince = leaseEndsInMin !== null ? new Date(now().getTime() - ((lease.maxLifetimeMin ?? 240) - leaseEndsInMin) * 60_000).toISOString() : c.createdAt ?? at;
    const rec = await registry.add(
      blankRecord(
        {
          id: 'cr_mock_ce1',
          kind: 'container',
          backend: 'ce',
          name: c.name,
          displayName: 'h200-notebook',
          managed: true,
          remoteId: c.id,
          installTag: tag,
          purpose: 'computer',
          idc: c.idc,
          sku: c.product,
          templateId: c.templateId ?? null,
          templateName: 'PyTorch + Jupyter',
          listUsdPerHour: catalog.price(c.product, c.idc).usdPerHour,
          requestedAt: c.createdAt ?? at,
          runningSince,
          lease,
          approvedMaxLifetimeMin: lease.maxLifetimeMin,
          envNames: c.envNames ?? [],
          // The demo EIP was allocated with the container: it bills from the same moment (§6.3).
          eipIntervals: c.eipId ? [{ from: c.createdAt ?? at, to: null, usdPerHour: catalog.eipSku(c.idc)?.usdPerHour ?? null }] : [],
          network: {
            publicIp: c.eipAddress ?? null,
            eip: c.eipId ? { id: c.eipId, address: c.eipAddress ?? null, managed: true, status: 'associated' } : null,
            firewalls: (c.firewalls ?? []).map((id) => ({ id, name: `${c.name}-fw`, managed: true, preset: false, rules: [{ protocol: 'tcp' as const, fromPort: 22, toPort: 22, cidr: '203.0.113.7/32' }] })),
            ports: [],
            degraded: false,
          },
        },
        at,
      ),
    );
    await supervisor.observe(rec.id, observeContainer(c, null), 'reconcile');
  }
  for (const s of await mock.sandbox.listAll({ metadata: { app: 'gmi-desk' } })) {
    const rid = s.metadata?.rid;
    if (!rid || !seedSandboxRids.has(rid) || registry.get(rid) || registry.findByRemote('sandbox_v2', s.id)) continue;
    const d = await mock.sandbox.get(s.id);
    const rec = await registry.add(
      blankRecord(
        {
          id: rid,
          kind: 'sandbox',
          backend: 'sandbox_v2',
          name: `sandbox-${d.sandbox_key ?? d.id}`,
          displayName: rid === 'cr_mock_sb1' ? 'python-dev' : 'node-api',
          managed: true,
          remoteId: d.id,
          installTag: label,
          purpose: 'computer',
          idc: d.idc_name ?? null,
          sku: d.product ?? null,
          templateId: d.template_id ?? null,
          templateName: d.template_id === 'tpl-mock-node' ? 'Node.js' : 'Python',
          listUsdPerHour: d.product ? catalog.price(d.product, d.idc_name ?? null).usdPerHour : null,
          requestedAt: d.created_at ?? at,
          lease: defaultLease('sandbox'),
          approvedMaxLifetimeMin: 480,
          secure: true,
          egressLocked: d.egress_control === true,
        },
        at,
      ),
    );
    await supervisor.observe(rec.id, observeSandbox(d), 'reconcile');
  }
}

export async function createComputeSlice(ctx: AppContext, deps: ComputeServiceDeps): Promise<ComputeService> {
  const log = ctx.log.child('compute');
  const tag = installTag(ctx.installId);
  const label = installLabel(ctx.installId);
  const flags = ctx.mock ? mockComputeFlags() : new Set<string>();
  const keys = ctx.mock && flags.has('no_key') ? noKeyProvider() : deps.keys;
  const clock = createServerClock(() => ctx.now());

  // ── clients (simulated in mock mode: nothing here can reach GMI) ──
  let backends: ComputeBackends;
  let flushTrace: () => Promise<void> = async () => undefined;
  if (ctx.mock) {
    const mock = createMockCompute({ flags, installTag: tag, installLabel: label, now: () => ctx.now() });
    // Like the real clients, the simulated control and data planes need the Compute key (the public feeds do not).
    backends = { publicApi: mock.publicApi, ce: keyGated(mock.ce, keys), sandbox: keyGated(mock.sandbox, keys), dataPlane: keyGated(mock.dataPlane, keys), tokens: mock.tokens, mock };
    // The simulators answer with local time: treat it as GMI's clock (mock leases may run their catch-up).
    clock.observe(ctx.now());
  } else {
    const trace = createComputeTrace({ logsDir: ctx.paths.logs });
    flushTrace = async () => trace?.flush();
    const onServerDate = (d: Date) => clock.observe(d);
    const publicApi = createCePublicClient({ http: ctx.http, log, trace, onServerDate });
    const ce = createCeClient({ http: ctx.http, log, keys, trace, onServerDate });
    const sandbox = createSandboxClient({ http: ctx.http, log, keys, trace, onServerDate });
    const tokens = createTokenCache({ connect: (id) => sandbox.connect(id), now: () => ctx.now() });
    const dataPlane = createDataPlane({ http: ctx.http, log, tokens, trace });
    backends = { publicApi, ce, sandbox, dataPlane, tokens, mock: null };
  }

  const catalog = createComputeCatalog({ dataDir: ctx.paths.data, log, keys, publicApi: backends.publicApi, ce: backends.ce, sandbox: backends.sandbox, now: () => ctx.now() });
  const registry = createRegistry({ dataDir: ctx.paths.data, log, now: () => ctx.now() });
  const journal = createJournal({ dataDir: ctx.paths.data, log, now: () => ctx.now() });
  await Promise.all([registry.load(), journal.load(), catalog.load()]);

  const supervisor = createSupervisor({ registry, log, keys, ce: backends.ce, sandbox: backends.sandbox, clock, prices: catalog });
  const power = await electronPower();

  // The guard and the service need each other (the guard acts through ResourceActions): a late-bound proxy.
  let actionsImpl: ResourceActions | null = null;
  const actions: ResourceActions = {
    pause: (id, cause) => (actionsImpl ? actionsImpl.pause(id, cause) : Promise.reject(new GmiError('internal', 'Compute is starting.'))),
    delete: (id, cause) => (actionsImpl ? actionsImpl.delete(id, cause) : Promise.reject(new GmiError('internal', 'Compute is starting.'))),
    extendServerTimeout: (id, s, cause) => (actionsImpl ? actionsImpl.extendServerTimeout(id, s, cause) : Promise.reject(new GmiError('internal', 'Compute is starting.'))),
  };
  // H4 binds its run state later (ComputeInternals.setRunActive); until then agent tool calls never count as activity.
  let runActive: ((runId: string) => boolean) | null = null;
  // Usage seeds mock scenarios once. Every consumer reads the same budget, including edits made in the UI.
  const budget = deps.budget;
  const guard = createComputeGuard({
    ctx,
    registry,
    supervisor,
    actions,
    prices: catalog,
    budget,
    budgetSources: deps.budgetSources,
    auth: deps.auth,
    power,
    isRunActive: (runId) => runActive?.(runId) === true,
  });

  const secrets = createSecretScreen({ secure: ctx.secure, keys });
  const networkFree = { ce: backends.ce, registry, journal, alarms: guard.alarms, prices: catalog, supervisor, log };
  const lifecycleDeps = { sandbox: backends.sandbox, tokens: backends.tokens, dataPlane: backends.dataPlane, registry, journal, alarms: guard.alarms, prices: catalog, supervisor, log };
  const sweeper = createSweeper({
    ce: backends.ce,
    sandbox: backends.sandbox,
    registry,
    journal,
    alarms: guard.alarms,
    prices: catalog,
    supervisor,
    log,
    installTag: tag,
    installLabel: label,
    createDeps: networkFree,
    lifecycleDeps,
  });

  const service: ComputeServiceInstance = createComputeService({
    core: { platform: ctx.platform, log, installId: ctx.installId, mock: ctx.mock, now: () => ctx.now() },
    keys,
    auth: deps.auth,
    catalog,
    ce: backends.ce,
    sandbox: backends.sandbox,
    dataPlane: backends.dataPlane,
    tokens: backends.tokens,
    registry,
    journal,
    supervisor,
    guard,
    sweeper,
    secrets,
    detectIp: async () => {
      if (ctx.mock) return { ip: '203.0.113.7', service: PUBLIC_IP_SERVICE };
      const body = await ctx.http.json<{ ip?: unknown }>(`https://${PUBLIC_IP_SERVICE}/?format=json`, { timeoutMs: 10_000 });
      const ip = typeof body?.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(body.ip) ? body.ip : null;
      return { ip, service: PUBLIC_IP_SERVICE };
    },
  });
  actionsImpl = service.actions;

  // ── events: compute:resources and compute:state (≤ 1/s), compute:alarm comes from the alarm center ──
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;
  let disposed = false;
  const emitNow = async () => {
    emitTimer = null;
    if (disposed) return;
    lastEmit = Date.now();
    try {
      // Managed + visible unmanaged rows (the event's contract): the renderer replaces its "show all" list with it.
      ctx.events.emit('compute:resources', service.listVisible());
      ctx.events.emit('compute:state', await service.getState());
    } catch (error) {
      log.warn('compute event failed', { code: error instanceof GmiError ? error.code : 'internal' });
    }
  };
  const emitSoon = () => {
    if (emitTimer || disposed) return;
    const wait = Math.max(50, 1000 - (Date.now() - lastEmit));
    emitTimer = setTimeout(() => void emitNow(), wait);
    (emitTimer as { unref?: () => void }).unref?.();
  };
  /** Records made before the price feed loaded get their price (and their null-priced intervals) once it does. */
  const backfillPrices = async () => {
    for (const rec of registry.list({ includeTombstones: true })) {
      if (!rec.managed || !backfillPrice(rec, catalog)) continue;
      await registry.update(rec.id, (r) => backfillPrice(r, catalog) ?? r).catch(() => undefined);
    }
  };
  /**
   * With a key (resources can exist), the public price feed first, bounded: records adopted or seeded right after are
   * priced from the start instead of accruing $0 (§9.2). Without a key nothing bills and nothing is fetched.
   */
  const pricesFirst = async () => {
    if (!(await keys.getComputeKey().catch(() => null))) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      catalog.refreshPublic(false).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STARTUP_PRICE_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await backfillPrices();
  };
  const seedIfKeyed = async () => {
    if (!backends.mock || !(await keys.getComputeKey().catch(() => null))) return;
    await seedMock(registry, supervisor, backends.mock, catalog, tag, label, () => ctx.now()).catch((error: unknown) => log.warn('mock seed failed', { error }));
  };
  const unsubscribers: Array<() => void> = [
    catalog.onChange(() => void backfillPrices()),
    registry.onChange(emitSoon),
    supervisor.onChange(emitSoon),
    guard.onChange(emitSoon),
    service.onChange(emitSoon),
    deps.auth.onChange(emitSoon),
    keys.onChange(() => {
      supervisor.resetBackends();
      void pricesFirst()
        .then(() => seedIfKeyed())
        .then(() => service.checkAccess())
        .then(() => sweeper.run())
        .finally(emitSoon);
    }),
  ];
  if (power) {
    unsubscribers.push(power.onSuspend(() => supervisor.setHints({ suspended: true })));
    unsubscribers.push(power.onResume(() => supervisor.setHints({ suspended: false })));
  }

  // ── startup (in the background: reads answer from the registry at once) ──
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const ready = (async () => {
    await pricesFirst();
    await seedIfKeyed();
    await service.reconcileJournal();
    if (disposed) return;
    supervisor.start();
    guard.start();
    catalog.start();
    await service.checkAccess().catch(() => undefined);
    await sweeper.run();
    service.resumeSagas();
    emitSoon();
    sweepTimer = setInterval(() => {
      void sweeper.run().then(() => {
        service.resumeSagas();
        emitSoon();
      });
    }, COMPUTE_TIMING.sweepMs);
    (sweepTimer as { unref?: () => void }).unref?.();
  })().catch((error: unknown) => log.error('compute startup failed', { code: error instanceof GmiError ? error.code : 'internal' }));

  const api = {} as ComputeApi;
  for (const method of COMPUTE_API_METHODS) {
    const impl = service.api[method] as (...args: unknown[]) => Promise<unknown>;
    (api as unknown as Record<string, unknown>)[method] = MUTATING.has(method)
      ? async (...args: unknown[]) => {
          await ready;
          return impl(...args);
        }
      : (...args: unknown[]) => impl(...args);
  }

  return {
    api,
    internals: {
      registry,
      supervisor,
      guard,
      actions,
      secrets,
      prices: catalog,
      setRunActive(fn) {
        runActive = fn;
      },
    },
    quitCheck: () => guard.quitCheck(),
    backends,
    async dispose() {
      disposed = true;
      if (emitTimer) clearTimeout(emitTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      for (const off of unsubscribers.splice(0)) off();
      catalog.stop();
      await ready;
      await Promise.allSettled([supervisor.stop(), guard.stop()]);
      await Promise.allSettled([registry.flush(), journal.flush(), flushTrace()]);
    },
  };
}

