/**
 * The GMI gateway's composition (harness.md §4; H1-A): `createGateway` is the GatewayFactory that
 * src/main/slices/gateway.ts calls. It builds the money and flow parts (H1-B: thread ledger, estimator, meter,
 * reservations, breaker, connectivity gate, scheduler, retry policy, trace, status), the model resolver and run
 * registry (H1-A), and the core around them, with the real transport (ctx.http) or, in mock mode, the mock model.
 */
import { join } from 'node:path';
import { GMI_URLS } from '@shared/app';
import { GmiError } from '@shared/contracts/errors';
import { createBreaker } from './breaker';
import { createModelResolver, loadCapabilityOverrides } from './capabilities';
import { createConnectivityGate } from './connectivity';
import { createEstimator } from './estimate';
import { createGatewayCore, createRunRegistry, httpTransport, type GatewayCore, type Transport } from './gateway';
import { createMeter } from './meter';
import { mockPricing, mockTransport } from './mock';
import { createReservations } from './reservations';
import { createRetryPolicy } from './retry';
import { createScheduler } from './scheduler';
import { createStatusTracker } from './status';
import { createThreadLedger } from './threads';
import { createGatewayTrace } from './trace';
import type { GatewayFactory, GatewayFactoryDeps, GatewayParts, GatewayRuntime } from './types';

export { createGatewayCore, createRunRegistry, createEventBatcher, pumpGatewayEvents, httpTransport } from './gateway';
export type { GatewayCore, Transport, TransportRequest, EventBatcher } from './gateway';
export { createModelResolver, reasoningFamily, capabilitiesFor } from './capabilities';
export { mockTransport } from './mock';

/** Probe results that override the capability table (written by the dev-only probes, harness.md §23). */
export const CAPABILITIES_FILE = 'gateway-capabilities.json';

export interface GatewayRuntimeOptions {
  /** Replaces the transport (tests). Default: the mock model in mock mode, ctx.http otherwise. */
  transport?: Transport;
  /** Mock-mode pacing: 1 = realistic (default), 0 = as fast as possible (tests). */
  mockSpeed?: number;
}

/**
 * The connectivity gate's free probe (harness.md §4.6): a request to the API host without any credential. Any
 * HTTP answer (GMI says 401 to `/v1/models` without a key) proves the network is back; nothing is billed.
 */
export function apiHostProbe(deps: Pick<GatewayFactoryDeps, 'ctx'>): () => Promise<boolean> {
  return async () => {
    if (deps.ctx.mock) return true;
    try {
      await deps.ctx.http.request(`${GMI_URLS.inference}/models`, { method: 'GET', timeoutMs: 10_000 });
      return true;
    } catch (error) {
      return error instanceof GmiError && error.status !== null;
    }
  };
}

export async function createGatewayRuntime(deps: GatewayFactoryDeps, opts: GatewayRuntimeOptions = {}): Promise<GatewayRuntime & { core: GatewayCore; parts: GatewayParts }> {
  const { ctx, clock } = deps;
  const log = ctx.log.child('gateway');

  const overrides = await loadCapabilityOverrides(join(ctx.paths.data, CAPABILITIES_FILE), log);
  const resolver = createModelResolver({
    catalog: deps.catalog,
    overrides,
    fallbackPricing: ctx.mock ? mockPricing : undefined,
    now: () => clock.now(),
    log,
  });
  // Not awaited: a slow catalog must not delay startup; an unknown model triggers a reload before it is priced.
  void resolver.refresh(true);

  const threads = createThreadLedger({ dataDir: ctx.paths.data, budget: deps.budget, clock, log });
  // Loaded before the first agent request can be admitted (harness.md §4.4).
  await threads.load();
  const estimator = createEstimator({ clock });
  const meter = createMeter({ threads, budget: deps.budget, estimator, clock, log });
  const reservations = createReservations({ budget: deps.budget, threads });
  const breaker = createBreaker({ clock, log });
  const connectivity = createConnectivityGate({ signals: deps.signals, probe: apiHostProbe(deps), clock, log });
  const scheduler = createScheduler({ clock, breaker, connectivity, tpmLimit: deps.tpmLimit(), reservations, log });
  const retry = createRetryPolicy({ clock });
  const trace = createGatewayTrace({ log });
  const status = createStatusTracker({ scheduler, breaker, connectivity, meter, clock });
  const runs = createRunRegistry(clock);

  const parts: GatewayParts = { resolver, estimator, meter, reservations, threads, runs, scheduler, retry, breaker, connectivity, trace, status, clock };
  const transport = opts.transport ?? (ctx.mock ? mockTransport({ speed: opts.mockSpeed ?? 1 }) : httpTransport(ctx.http));
  const core = createGatewayCore(parts, {
    keys: deps.keys,
    transport,
    needsKey: !ctx.mock,
    log,
    learn: resolver.learn,
    refreshModels: (force) => resolver.refresh(force),
  });

  const offs = [
    breaker.onChange(() => status.changed()),
    connectivity.onChange(() => status.changed()),
    ctx.events.on('catalog:updated', () => void resolver.refresh(true)),
  ];

  let disposed = false;
  return {
    core,
    parts,
    gateway: core,
    spendSource: threads.source,
    onStatus: (listener) => status.onChange(listener),
    reloadSettings: () => scheduler.setTpmLimit(deps.tpmLimit()),
    async dispose() {
      if (disposed) return;
      disposed = true;
      // In-flight requests settle first (estimated charges, reservations released), then the ledger is flushed.
      await core.shutdown();
      for (const off of offs) off();
      try {
        await threads.flush();
      } finally {
        scheduler.dispose();
        status.dispose();
        breaker.dispose();
        connectivity.dispose();
        await threads.dispose();
      }
    },
  };
}

/** The factory for src/main/slices/gateway.ts (`setupGatewaySlice(ctx, deps, host, { factory: createGateway })`). */
export const createGateway: GatewayFactory = (deps) => createGatewayRuntime(deps);
