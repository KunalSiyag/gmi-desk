/**
 * Internal (main-process only) service interfaces that slices use to talk to each other.
 * Each slice implements its part; src/main/index.ts wires them together.
 */
import type { GmiApi, GmiNamespace } from '@shared/contracts';
import type { AuthState } from '@shared/contracts/auth';
import type { GmiError } from '@shared/contracts/errors';
import type { CatalogModel, CatalogSnapshot } from '@shared/contracts/catalog';
import type { GatewayRequest, GatewayEvent, GatewayStatus } from '@shared/contracts/gateway';
import type { BudgetCheck, BudgetStatus, SpendKind } from '@shared/contracts/usage';

/** Tools on GMI's MCP server (https://mcp.gmicloud.ai/mcp). */
export type GmiToolName =
  | 'search_models'
  | 'get_model'
  | 'estimate_generation'
  | 'submit_generation'
  | 'get_generation'
  | 'list_generations'
  | 'upload_media'
  | 'get_account_summary'
  | 'search_docs'
  | 'create_support_request';

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Calls a GMI MCP tool with the user's OAuth session and returns the tool's JSON result
 * (parsed from structuredContent or the first text content block).
 * Throws GmiError: not_signed_in, reauth_required, insufficient_scope, upstream, network, invalid_input...
 */
export interface McpGateway {
  callTool<T = unknown>(name: GmiToolName, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<T>;
}

/** Access to the inference API key (the raw key never reaches the renderer). */
export interface KeyProvider {
  /** The key, or null when none is stored. */
  getInferenceKey(): Promise<string | null>;
  /** The key, or throws GmiError('no_api_key'). */
  requireInferenceKey(): Promise<string>;
  /**
   * Call when GMI refused the credential (see credentialRefused), so the UI can prompt for a new one. Pass the key
   * the failing request used: a report about a key that has since been replaced is ignored. Pass the HTTP status:
   * a 403 for a real key is a permission problem (model, organization), not a dead key, while a 403 for the GMI
   * sign-in's token (e.g. RFC 6750 insufficient_scope) means GMI does not accept the sign-in for that call.
   */
  reportInvalidKey(reason: string, key?: string | null, status?: number | null): Promise<void>;
}

/**
 * Whether an inference call failed because GMI refused the credential: a 401 (`invalid_api_key`), or a 403 that is
 * not a Cloudflare block (a token that is valid but under-scoped answers 403 insufficient_scope).
 */
export function credentialRefused(error: Pick<GmiError, 'code' | 'status' | 'message'>): boolean {
  if (error.code === 'invalid_api_key') return true;
  return error.status === 403 && !/cloudflare/i.test(error.message);
}

export interface AuthService {
  getState(): AuthState;
  isSignedIn(): boolean;
  onChange(listener: (state: AuthState) => void): () => void;
}

export interface CatalogService {
  getSnapshot(): Promise<CatalogSnapshot>;
  findModel(id: string): Promise<CatalogModel | null>;
}

/** Local spend guard. GMI does not stop generation at a negative balance, so the app must. */
export interface BudgetGuard {
  check(estimatedUsd: number | null, kind: SpendKind): Promise<BudgetCheck>;
  record(entry: { kind: SpendKind; modelId: string; usd: number; ref?: string | null }): Promise<void>;
  /**
   * The budget status right now, synchronously (ledger + registered SpendSources), for check-and-insert callers
   * such as the gateway's reservations: no `await` between reading and reserving (harness.md §4.4).
   */
  statusSnapshot(): BudgetStatus;
}

/** Spend that is not in the ledger (continuous accrual), summed into budget status. */
export interface SpendSource {
  readonly kind: SpendKind;
  /** Estimated USD since `since` (list price). */
  totalSince(since: Date): number;
  /** Current burn rate (USD per hour) for projections. */
  burnUsdPerHour(): number;
}

export interface BudgetSources {
  /** Adds a source to every budget status from now on; returns the function that removes it. */
  register(source: SpendSource): () => void;
}

/** Access to the Compute API key (`ce_resource`; the raw key never reaches the renderer). */
export interface ComputeKeyProvider {
  getComputeKey(): Promise<string | null>;
  /** Throws GmiError('no_compute_key'). */
  requireComputeKey(): Promise<string>;
  /** 401 → key marked invalid. 403 is never treated as a dead key (not entitled / permission). */
  reportInvalidComputeKey(reason: string, key?: string | null, status?: number | null): Promise<void>;
  onChange(listener: () => void): () => void;
}

export interface ThreadCaps {
  perTurnUsd: number | null;
  perThreadUsd: number | null;
}

/** The GMI gateway (harness.md §4, §13.2): all model traffic, metering, reservations, one TPM scheduler. */
export interface GmiGateway {
  /**
   * Upstream failures end the stream with an `error` event; throws only GmiError('invalid_input').
   * `owner` is set by the harness supervisor (never by the host message): abortOwner() ends these requests.
   */
  stream(req: GatewayRequest, signal: AbortSignal, owner?: { hostId: string } | null): AsyncIterable<GatewayEvent>;
  /** Main's own estimate from the body: the worst-case reservation and the display estimate (§4.4). */
  estimate(req: Pick<GatewayRequest, 'target' | 'messages' | 'tools' | 'maxOutputTokens' | 'scope'>): {
    promptTokens: number;
    expectedCachedTokens: number;
    reserveUsd: number | null;
    expectedUsd: number | null;
  };
  status(): GatewayStatus;
  /** Aborts every request of a host that exited, settles them (estimated) and releases their reservations. */
  abortOwner(hostId: string): void;
  /** Runs main tracks; host requests outside a running run are refused (§4.4). */
  openRun(scope: { threadId: string; turnId: string; runId: string }): void;
  closeRun(runId: string): void;
  /** Persisted (gateway-threads.json). Accepted only when it tightens the stored caps. */
  setThreadCaps(threadId: string, caps: ThreadCaps): void;
  /** Called only by the code slice after its native loosening dialog. */
  approveThreadCaps(threadId: string, caps: ThreadCaps): void;
  /** Persisted spend, including unflushed agent spend. */
  threadSpend(threadId: string, turnId?: string | null): { turnUsd: number; threadUsd: number };
}

/**
 * A developer-only action shown in Settings › About › Diagnostics (inference/compute probes, eval recording).
 * Registered by slices at startup; never available in packaged builds.
 */
export interface DiagnosticsAction {
  /** Stable id, e.g. `compute.probes` (letters, digits, `.`, `-`, `_`). */
  id: string;
  label: string;
  description: string;
  /** True when running it can spend money (the action itself must still ask natively before every paid call). */
  paid: boolean;
  /** Returns a short, secret-free report for the UI/log. */
  run(): Promise<string>;
}

const DIAGNOSTICS_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const diagnosticsActions = new Map<string, DiagnosticsAction>();

/** Registers a Diagnostics action (ids are unique; a second registration replaces the first). Returns an unregister function. */
export function registerDiagnosticsAction(action: DiagnosticsAction): () => void {
  if (!DIAGNOSTICS_ID.test(action.id)) throw new Error(`invalid diagnostics action id: ${action.id}`);
  diagnosticsActions.set(action.id, action);
  return () => {
    if (diagnosticsActions.get(action.id) === action) diagnosticsActions.delete(action.id);
  };
}

/** Registered Diagnostics actions, in registration order. */
export function listDiagnosticsActions(): DiagnosticsAction[] {
  return [...diagnosticsActions.values()];
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

/**
 * What src/main/index.ts hands every registration file in src/main/slices/: a slice registers its own IPC
 * namespaces, disposers and quit checks, so later slices never edit the composition root.
 */
export interface SliceHost {
  /** Exposes `api` as gmi:invoke:<ns>:<method> (removed again at quit). */
  registerApi<N extends GmiNamespace>(ns: N, api: GmiApi[N]): void;
  /** Runs at quit (concurrently with the other disposers, up to the quit timeout). */
  onDispose(dispose: () => void | Promise<void>): void;
}
