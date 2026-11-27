// Registration of the GMI gateway (harness.md §4, §24 H1-0). Runs right after usage and before chat
// (src/main/index.ts): builds the gateway through a GatewayFactory (services/gateway/types.ts), registers its
// unflushed agent spend with the budget, forwards throttled status as `code:gateway`, and disposes it at quit.
// The default factory is H1-A's createGateway (services/gateway/index.ts); tests may pass another one, e.g.
// notImplementedGatewayFactory (the F0 refusal gateway).
import { GATEWAY_TPM_TIERS, type GatewayEvent } from '@shared/contracts/gateway';
import { GmiError } from '@shared/contracts/errors';
import type { AppContext } from '../core/context';
import type { BudgetGuard, BudgetSources, CatalogService, GmiGateway, KeyProvider, SliceHost } from '../core/services';
import { createGateway } from '../services/gateway';
import { redactSecret } from '../services/gateway/gateway';
import { systemClock, type ConnectivitySignals, type GatewayClock, type GatewayFactory, type GatewayRuntime } from '../services/gateway/types';

export interface GatewaySliceDeps {
  keys: KeyProvider;
  catalog: CatalogService;
  budget: BudgetGuard;
  budgetSources: BudgetSources;
  /** OS connectivity signals (Electron `net.isOnline()`, `powerMonitor` 'resume'). Default: always online. */
  signals?: ConnectivitySignals;
}

export interface GatewaySlice {
  gateway: GmiGateway;
  /**
   * Disposes the gateway (idempotent; also registered with the host). The composition root awaits it before the
   * usage slice shuts down: the gateway's final flush writes spend-ledger rows.
   */
  dispose(): Promise<void>;
}

export interface GatewaySliceOptions {
  /** Default: defaultGatewayFactory (H1-A's createGateway, services/gateway/index.ts). */
  factory?: GatewayFactory;
  clock?: GatewayClock;
}

const notYet = (): never => {
  throw new GmiError('not_implemented', 'The GMI gateway is not available yet.');
};

/** A gateway whose every method refuses (F0 stub). */
export function notImplementedGateway(): GmiGateway {
  return {
    async *stream(): AsyncGenerator<GatewayEvent> {
      notYet();
    },
    estimate: notYet,
    status: notYet,
    abortOwner: notYet,
    openRun: notYet,
    closeRun: notYet,
    setThreadCaps: notYet,
    approveThreadCaps: notYet,
    threadSpend: notYet,
  };
}

/** The runtime around notImplementedGateway(): no spend source, no status, nothing to dispose. */
export const notImplementedGatewayFactory: GatewayFactory = async () => notImplementedRuntime();

function notImplementedRuntime(): GatewayRuntime {
  return {
    gateway: notImplementedGateway(),
    spendSource: null,
    onStatus: () => () => undefined,
    reloadSettings: () => undefined,
    dispose: async () => undefined,
  };
}

/**
 * Defence in depth: the reason a refused credential is reported with never carries that credential (GMI may echo
 * the key in an error; the reason ends up in the auth state the renderer shows). The gateway core reports the
 * upstream message as is.
 */
export function redactingKeys(keys: KeyProvider): KeyProvider {
  return {
    getInferenceKey: () => keys.getInferenceKey(),
    requireInferenceKey: () => keys.requireInferenceKey(),
    reportInvalidKey: (reason, key, status) =>
      keys.reportInvalidKey(redactSecret({ code: 'invalid_api_key', message: reason }, key ?? null).message, key, status),
  };
}

/** The app's gateway: H1-A's createGateway, with refused-key reports redacted. */
export const defaultGatewayFactory: GatewayFactory = (deps) => createGateway({ ...deps, keys: redactingKeys(deps.keys) });

/** Without OS signals the gate relies on failures and its probe alone. */
export const alwaysOnlineSignals: ConnectivitySignals = {
  isOnline: () => true,
  onResume: () => () => undefined,
};

/**
 * The org's TPM limit. Settings › Code › "GMI rate-limit tier" is not in AppSettings yet (requested from the
 * integrator), so this is tier T1 (harness.md §4.5).
 */
export function gatewayTpmLimit(_ctx: AppContext): number {
  return GATEWAY_TPM_TIERS.t1;
}

export async function setupGatewaySlice(
  ctx: AppContext,
  deps: GatewaySliceDeps,
  host: SliceHost,
  opts: GatewaySliceOptions = {},
): Promise<GatewaySlice> {
  const factory = opts.factory ?? defaultGatewayFactory;
  const log = ctx.log.child('gateway');
  let runtime: GatewayRuntime;
  try {
    runtime = await factory({
      ctx,
      keys: deps.keys,
      catalog: deps.catalog,
      budget: deps.budget,
      signals: deps.signals ?? alwaysOnlineSignals,
      tpmLimit: () => gatewayTpmLimit(ctx),
      clock: opts.clock ?? systemClock,
    });
  } catch (error) {
    // A broken gateway must not stop the app from starting: everything else (catalog, usage, media) still works.
    log.error('gateway failed to start; model requests through it are refused', { error: error instanceof Error ? error.message : String(error) });
    runtime = notImplementedRuntime();
  }

  const unregisterSpend = runtime.spendSource ? deps.budgetSources.register(runtime.spendSource) : () => undefined;
  const offStatus = runtime.onStatus((status) => ctx.events.emit('code:gateway', status));
  const offSettings = ctx.settings.onChange(() => runtime.reloadSettings());

  let disposing: Promise<void> | null = null;
  const dispose = (): Promise<void> =>
    (disposing ??= (async () => {
      offStatus();
      offSettings();
      try {
        await runtime.dispose();
      } catch (error) {
        log.warn('gateway dispose failed', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        // After dispose: its flush moved the unflushed spend into the ledger, so nothing is uncounted in between.
        unregisterSpend();
      }
    })());
  host.onDispose(dispose);

  return { gateway: runtime.gateway, dispose };
}
