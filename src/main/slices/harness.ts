// Registration of the harness host supervisor (harness.md §5, §24 H2-0): the supervisor that runs
// dist-electron/harness.cjs in an Electron utilityProcess, the approval broker and the host RPC router.
// The host starts lazily (first command, ping or Diagnostics run), so app startup is unchanged until the Code tab
// (H3) uses it. It stops at quit (shutdown grace 2.5 s, then kill).
import type { AppContext } from '../core/context';
import { registerDiagnosticsAction, type AuthService, type BudgetGuard, type CatalogService, type GmiGateway, type McpGateway, type SliceHost } from '../core/services';
import { buildHostEnv, createHarnessService, defaultHostModulePath, electronHostSpawner, systemSupervisorClock, type ApprovalBroker, type HarnessSupervisor, type HostSpawner, type RpcHandlers } from '../services/harness';
import { createMcpBridge } from '../services/harness/mcp-bridge';
import { createModelInfoHandlers } from '../services/harness/model-info';
import { runMockTurn } from '../services/harness/mock-turn';
import type { SupervisorClock } from '../services/harness/supervisor';
import type { ComputeSlice } from './compute';

export interface HarnessSliceDeps {
  gateway: GmiGateway;
  catalog?: CatalogService;
  /** GMI's MCP tools for `mcp.gmi.call` (mcp-bridge.ts, harness.md §10.3): the OAuth token stays in main. */
  mcp: McpGateway;
  auth: AuthService;
  /** Paid GMI MCP tools are budget-checked in main before the call (§10.3). */
  budget: BudgetGuard;
  /** The compute broker for the sandbox MCP (H4-B, §10.4). */
  compute: ComputeSlice;
}

/** What the code registration (H3) gets from the harness. */
export interface HarnessSlice {
  supervisor: HarnessSupervisor;
  approvals: ApprovalBroker;
  /** Adds RPC handlers (mcp-bridge.ts in H3-D, the compute broker in H4-B). */
  setRpcHandlers(handlers: RpcHandlers): void;
}

export interface HarnessSliceOptions {
  /** Default: Electron utilityProcess with dist-electron/harness.cjs. */
  spawn?: HostSpawner;
  clock?: SupervisorClock;
  /** Register the dev-only Diagnostics check. Default: only in unpackaged runs (`process.defaultApp`). */
  diagnostics?: boolean;
}

export const HARNESS_DIAGNOSTICS_ID = 'harness.host';
export const HARNESS_MOCK_TURN_ID = 'harness.mock-turn';

/** A secret-free one-paragraph report of the host (Diagnostics). */
export async function describeHost(supervisor: HarnessSupervisor): Promise<string> {
  await supervisor.ready();
  const { rttMs } = await supervisor.ping();
  const info = supervisor.info();
  const sandbox = info.sandbox ? `${info.sandbox.kind}${info.sandbox.ok ? '' : ` (unavailable${info.sandbox.detail ? `: ${info.sandbox.detail}` : ''})`}` : 'unknown';
  return [
    `Agent runtime ${info.hostState} (protocol 1, version ${info.version ?? '?'}), ping ${Math.round(rttMs)} ms.`,
    `Sandbox: ${sandbox}. Git: ${info.git?.ok ? (info.git.version ?? 'yes') : 'missing'}. Ripgrep: ${info.ripgrep ? 'yes' : 'missing'}.`,
    `Restarts: ${info.restarts}.`,
  ].join(' ');
}

export async function setupHarnessSlice(ctx: AppContext, deps: HarnessSliceDeps, host: SliceHost, opts: HarnessSliceOptions = {}): Promise<HarnessSlice> {
  const service = createHarnessService(ctx, { gateway: deps.gateway, spawn: opts.spawn, clock: opts.clock });
  service.setRpcHandlers(
    createMcpBridge({
      mcp: deps.mcp,
      budget: deps.budget,
      secure: ctx.secure,
      approvals: service.approvals,
      platform: ctx.platform,
      log: ctx.log.child('harness.mcp'),
    }),
  );
  if (deps.catalog) service.setRpcHandlers(createModelInfoHandlers(deps.catalog));

  const diagnostics = opts.diagnostics ?? (process as { defaultApp?: boolean }).defaultApp === true;
  const unregister = diagnostics
    ? registerDiagnosticsAction({
        id: HARNESS_DIAGNOSTICS_ID,
        label: 'Agent runtime check',
        description: 'Starts the harness host if needed and reports its state, sandbox, git and ripgrep. Free: no model calls.',
        paid: false,
        run: () => describeHost(service.supervisor),
      })
    : () => undefined;
  // One agent turn end to end with a scripted model, in a throwaway repo and data dir, on its own host (no network,
  // no key, nothing paid; the user's harness database is not touched).
  const unregisterTurn = diagnostics
    ? registerDiagnosticsAction({
        id: HARNESS_MOCK_TURN_ID,
        label: 'Agent runtime mock turn',
        description: 'Runs one agent turn (read, grep, edit, apply_patch, sandboxed bash, approval, checkpoint, compaction) against a scripted model in a throwaway repo. Free: no model calls.',
        paid: false,
        run: async () => {
          const result = await runMockTurn({
            spawn: opts.spawn ?? electronHostSpawner(defaultHostModulePath()),
            env: () => buildHostEnv(process.env),
            clock: opts.clock ?? systemSupervisorClock,
            log: ctx.log.child('harness.mock-turn'),
          });
          if (result.problems.length > 0) throw new Error(result.report);
          return result.report;
        },
      })
    : () => undefined;

  host.onDispose(async () => {
    unregister();
    unregisterTurn();
    await service.dispose();
  });

  return { supervisor: service.supervisor, approvals: service.approvals, setRpcHandlers: service.setRpcHandlers };
}
