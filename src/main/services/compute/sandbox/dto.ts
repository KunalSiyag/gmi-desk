// Agentbox Sandbox API v2 wire types (compute.md §7, §8, §14), hand-written from GMI's OpenAPI document. Frozen by C1-0.
//
// Source (SHA-256 of the file as downloaded; re-check before changing a type):
//   https://docs.gmicloud.ai/api-spec/sandbox_api.yaml   "GMI Sandbox API" 2.0 (OpenAPI 3.0.3, 5 641 lines)
//     sha256 5195b2eaadd814650fbd17276eb717944f3c6d85acd6587f3815c3bb0fa6b297
// Re-check: `curl -sA "gmi-client-research/0.1" <url> | sha256sum`; a different hash means: diff the spec, update
// these types and their normalisers (C1-B) with regression tests.
//
// Control plane: https://console.gmicloud.ai/api/v2 (Bearer compute key). Data plane: https://{sandbox_key}.{domain}
// (X-Access-Token). Port services: https://{port}-{sandbox_key}.{domain} (traffic-access-token when secure).
// `domain` is never built by the app: it comes only from create / connect (§7.2).
//
// Rules: wire shapes only (normalising is C1-B's); optional where GMI may omit; unknown enum values accepted
// (`| (string & {})`). Fields marked SECRET never leave main: not stored, logged, traced, emitted or written to
// fixtures (§5.2, §7.2, §17).

/** Accepts values outside a documented enum without losing autocompletion for the known ones. */
export type V2Open<T extends string> = T | (string & {});

// ─── Envelopes and errors ──────────────────────────────────────────────────────────────────────────────────────────

/** Control-plane success: `{request_id, data}`. */
export interface V2Envelope<T> {
  request_id: string;
  data: T;
}

/** Control-plane lists: page ≥ 1, page_size ≤ 100 (default 20). */
export interface V2Page<T> {
  request_id: string;
  total: number;
  page: number;
  page_size: number;
  items: T[];
}

export const V2_PAGE_SIZE_MAX = 100;

/**
 * `ErrorResponse` (control plane) and the data-plane error envelope (no `trace_id`). Switch on `code`, never on
 * `message`. Dotted codes: `Auth.*`, `Resource.*` (`NotFound`, `StateConflict`, `AlreadyExists`, `QuotaExceeded`),
 * `RateLimit.Exceeded`, `IDC.UnderMaintenance`, `Request.*`, `Parameter.Invalid`, `System.Internal`, `Sandbox.*`,
 * `Template.*`, `Snapshot.*`, `Execution.*`, `Shell.*`.
 */
export interface V2ErrorBody {
  code: string;
  message: string;
  request_id: string;
  trace_id?: string;
  details?: Record<string, unknown>;
}

/** `Resource.QuotaExceeded` / `RateLimit.Exceeded` details (429). */
export interface V2QuotaDetails {
  quota_name?: string;
  quota?: number;
  used?: number;
  requested?: number;
}

/** `SandboxMutationErrorResponse.details`: the state after a failed runtime mutation. */
export interface V2MutationErrorDetails {
  state?: V2SandboxState;
  last_mutation?: V2MutationResult;
}

// ─── Sandboxes (control plane) ─────────────────────────────────────────────────────────────────────────────────────

/** `SandboxControlState`. The v2 Python SDK also knows `ready`, `active`, `error`, `cancelled` (§7.4 maps them). */
export type V2SandboxState = V2Open<
  'provisioning' | 'running' | 'pausing' | 'paused' | 'resuming' | 'checkpointing' | 'updating' | 'failed' | 'deleting' | 'deleted'
>;

export const V2_SANDBOX_STATES = [
  'provisioning',
  'running',
  'pausing',
  'paused',
  'resuming',
  'checkpointing',
  'updating',
  'failed',
  'deleting',
  'deleted',
] as const;

/** Extra states the v2 Python SDK's `SandboxStatus` enum accepts [V]. */
export const V2_SDK_EXTRA_STATES = ['ready', 'active', 'error', 'cancelled'] as const;

/** `SandboxEgressPolicy`. Hostnames may start with `*.`; CIDRs are IPv4. */
export interface V2EgressPolicy {
  allowed_hostnames?: string[];
  allowed_cidrs?: string[];
}

/** `SandboxDefaultUser`: only `{username: 'root', uid: 0}` is accepted, and not in every IDC. */
export interface V2DefaultUser {
  username: 'root';
  uid: 0;
}

/**
 * `CreateSandboxControlRequest`: POST /sandboxes with `Idempotency-Key: <rid>` (remembered 24 h [V]). Exactly one of
 * `template_id` / `snapshot_id`. The app always sends `timeout` (GMI's default is 300 s).
 */
export interface V2CreateSandboxRequest {
  template_id?: string;
  snapshot_id?: string;
  product?: string;
  idc_name?: string;
  /** Seconds, 1..86400 (per IDC). */
  timeout?: number;
  /** SECRET values (kept in main memory until the POST, §6.1). */
  env_vars?: Record<string, string>;
  /** Visible to the whole org [V]: no PII (§7.1). */
  metadata?: Record<string, string>;
  secure?: boolean;
  auto_pause?: boolean;
  /** Immutable after creation; true = deny-all + `egress` allowlist. */
  egress_control?: boolean;
  egress?: V2EgressPolicy;
  default_user?: V2DefaultUser;
}

/**
 * `CreateSandboxControlResult` (201) and `ConnectSandboxControlResult` (POST /sandboxes/{id}/connect, which adds
 * `end_at`). SECRET: `sandbox_access_token`, `traffic_access_token` (memory only, the TokenCache, §7.2).
 */
export interface V2CreateSandboxResult {
  id: string;
  sandbox_key: string;
  template_id?: string;
  domain: string;
  sandbox_access_token: string;
  traffic_access_token: string;
}

/** `ConnectSandboxControlRequest`: `timeout > 0` extends only. */
export interface V2ConnectRequest {
  timeout?: number;
}

export interface V2ConnectResult extends V2CreateSandboxResult {
  /** Authoritative expiry after this connect. */
  end_at: string;
}

/** `SandboxResources`. */
export interface V2SandboxResources {
  vcpu?: number;
  memory_mb?: number;
  disk_mb?: number;
}

/** `SandboxMutationResult`: the most recent operation. */
export interface V2MutationResult {
  type: V2Open<'create' | 'delete' | 'set_timeout' | 'update_egress_policy' | 'update_ingress_policy' | 'rotate_traffic_token'>;
  status: V2Open<'pending' | 'succeeded' | 'failed'>;
  error_code?: string;
  /** Sanitised by GMI; never contains tokens. */
  message?: string;
  completed_at?: string;
}

/** `SandboxFailure`: only when `state = failed`. */
export interface V2Failure {
  code?: string;
  message?: string;
  occurred_at?: string;
}

/** `SandboxControlDetail.pause`: while pausing / paused / resuming. */
export interface V2PauseInfo {
  /** `Sandbox.UserPaused`, `Sandbox.BillingInsufficientBalance`, `Sandbox.Expired`. */
  code: string;
  initiator: V2Open<'user' | 'billing' | 'lifecycle'>;
  message: string;
  requested_at: string;
}

/** `SandboxDeletion`: while deleting / deleted. `requested_at` ends billing metering [V]. */
export interface V2Deletion {
  code: string;
  initiator: V2Open<'user' | 'billing' | 'lifecycle' | 'system'>;
  message: string;
  requested_at: string;
  completed_at: string | null;
}

/** `SandboxControlLifecycle`. */
export interface V2Lifecycle {
  auto_resume: boolean;
  on_timeout: V2Open<'pause' | 'kill'>;
}

/** `SandboxControlDetail`: GET /sandboxes/{id}. Timestamps are UTC strings ('' while not yet set). */
export interface V2SandboxDetail {
  id: string;
  sandbox_key?: string;
  template_id?: string;
  snapshot_id?: string;
  idc_name?: string;
  state: V2SandboxState;
  product?: string;
  product_name?: string;
  resources?: V2SandboxResources;
  metadata?: Record<string, string>;
  latest_operation?: V2MutationResult;
  failure?: V2Failure;
  created_at?: string;
  running_at?: string;
  started_at?: string;
  /** Frozen while paused (may be in the past); remaining run time = end_at − paused_at. */
  end_at?: string;
  paused_at?: string;
  paused_expire_at?: string;
  pause?: V2PauseInfo;
  domain?: string;
  deletion?: V2Deletion;
  lifecycle?: V2Lifecycle;
  egress_control?: boolean;
  egress?: V2EgressPolicy;
}

/**
 * `SandboxControlSummary`: GET /sandboxes?state=&idc_name=&metadata[k]=v&page=&page_size= (default: active states +
 * failed; `deleted` only when asked [V]; sorted by started_at desc).
 */
export interface V2SandboxSummary {
  id: string;
  sandbox_key?: string;
  template_id?: string;
  snapshot_id?: string;
  idc_name?: string;
  state: V2SandboxState;
  metadata?: Record<string, string>;
  created_at?: string;
  running_at?: string;
}

/** `SandboxLifecycleAcceptedResponse.data` (202 for pause / resume): the state at acceptance, not the outcome. */
export interface V2LifecycleAccepted {
  id: string;
  state: V2Open<'pausing' | 'paused' | 'resuming' | 'running'>;
}

/** `ResumeSandboxControlRequest`: omitted or ≤ 0 keeps the runtime left at the pause. */
export interface V2ResumeRequest {
  timeout?: number;
}

/** `SetSandboxControlTimeoutRequest`: POST /sandboxes/{id}/timeout, seconds from now. */
export interface V2SetTimeoutRequest {
  timeout: number;
}

/** `SetSandboxControlTimeoutResponse.data`: `new_end_at` is authoritative. */
export interface V2SetTimeoutResult {
  id: string;
  old_end_at: string;
  new_end_at: string;
}

/** `SandboxDeleteAcceptedResponse.data`: 200 `deleted` or 202 `deleting`; replayable, never 409 [V]. */
export interface V2DeleteAccepted {
  id: string;
  state: V2Open<'deleted' | 'deleting'>;
}

/** `ExecuteSandboxNetworkActionRequest`: POST /sandboxes/{id}/actions (running + egress_control only; full replace). */
export interface V2NetworkActionRequest {
  action: 'update_egress_policy';
  params: V2EgressPolicy;
}

/** `UpdateSandboxEgressPolicyResult`. */
export interface V2EgressUpdateResult {
  state: V2SandboxState;
  last_mutation: V2MutationResult;
  applied: V2Open<'immediate' | 'eventual'>;
}

/** Timeout bounds (seconds) for create / timeout / resume; the IDC may allow less [V]. */
export const V2_TIMEOUT_MIN_SEC = 1;
export const V2_TIMEOUT_MAX_SEC = 86_400;

// ─── Products and templates ────────────────────────────────────────────────────────────────────────────────────────

/** `EffectiveResources`. */
export interface V2EffectiveResources {
  cpu_count: number;
  memory_mb: number;
  disk_size_mb: number;
  architecture: V2Open<'x86_64' | 'arm64'>;
}

/** `ProductCatalogItem`: GET /products?idc_name=(required)&resource_type=sandbox → `{request_id, data: [...]}`. No price [V]. */
export interface V2Product {
  resource_type: V2Open<'sandbox'>;
  /** SKU, e.g. `gmi.sandbox.small` (priced from the public billing feed). */
  product: string;
  /** Preset label: X_SMALL, SMALL, MEDIUM, LARGE, X_LARGE. */
  name: string;
  status: V2Open<'active' | 'unavailable'>;
  resources: V2EffectiveResources;
}

export interface V2ProductListResponse {
  request_id: string;
  data: V2Product[];
}

export type V2BuildStatus = V2Open<'waiting' | 'building' | 'ready' | 'error'>;

/** `Template` (GET /templates?idc_name= → `V2Page<V2Template>`). Templates belong to one IDC. */
export interface V2Template {
  id: string;
  name: string;
  description?: string;
  idc_name: string;
  status: V2Open<'creating' | 'ready' | 'error' | 'deleting' | 'delete_failed' | 'deleted'>;
  source_type: V2Open<'image' | 'template' | 'sandbox' | 'dockerfile'>;
  product?: string | null;
  product_name?: string | null;
  resources: V2EffectiveResources;
  labels?: Record<string, string>;
  current_build_id?: string | null;
  latest_build_id: string;
  latest_build_status: V2BuildStatus;
  rebuildable?: boolean;
  failure_code?: string;
  status_reason?: string;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Snapshots ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type V2SnapshotStatus = V2Open<'creating' | 'ready' | 'error' | 'deleting' | 'delete_failed'>;

/** `SandboxSnapshot` (GET /snapshots → `V2Page<V2Snapshot>`; GET/PATCH /snapshots/{id} → envelope). */
export interface V2Snapshot {
  snapshot_id: string;
  idc_name?: string;
  name?: string;
  status: V2SnapshotStatus;
  source_sandbox_id?: string;
  source_template_id?: string;
  source_build_id?: string;
  vcpu?: number;
  ram_mb?: number;
  disk_size_mb?: number;
  architecture?: string;
  product?: string;
  product_name?: string;
  metadata?: Record<string, string>;
  failure_code?: string;
  status_reason?: string;
  ready_at?: string;
  created_at?: string;
  updated_at?: string;
}

/** `CreateSandboxSnapshotRequest`: only from `running` [V]; names unique per org (409 `Resource.AlreadyExists`). */
export interface V2CreateSnapshotRequest {
  sandbox_id: string;
  name?: string;
  metadata?: Record<string, string>;
}

// ─── Data plane: executions ────────────────────────────────────────────────────────────────────────────────────────

export type V2ExecStatus = V2Open<'pending' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;

export const V2_EXEC_STATUSES = ['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;

/** Statuses after which an execution no longer counts toward the 10-execution limit: the only ones that free a slot. */
export const V2_EXEC_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export type V2ExecTerminalStatus = (typeof V2_EXEC_TERMINAL_STATUSES)[number];

/**
 * `SandboxExecRequest`: POST /executions?wait=true&wait_timeout_seconds=1..25 (+ optional Idempotency-Key). The app
 * always sets `execution_timeout_seconds` (§8.1) and passes paths through `envs`, never in `command` (§8.3).
 */
export interface V2ExecRequest {
  action: 'exec';
  parameters: {
    /** ≤ 128 KiB, no NUL. */
    command: string;
    /** Names `[A-Za-z_][A-Za-z0-9_]*` ≤ 128 B; values ≤ 64 KiB. */
    envs?: Record<string, string>;
    /** Absolute and normalised. */
    cwd?: string;
    /** 1..3600. */
    execution_timeout_seconds: number;
  };
}

/** `SandboxExecAcceptedResponse` (202: accepted or still running after the wait; a wait timeout never cancels). */
export interface V2ExecAccepted {
  request_id: string;
  execution_id: string;
  /** The sandbox_key (data-plane identity). */
  sandbox_id: string;
  status: V2ExecStatus;
}

/** `SandboxExecResultResponse` (200 and GET /executions/{eid}). stdout/stderr ≤ 1 MiB each, then `*_truncated`. */
export interface V2ExecResult {
  request_id: string;
  execution_id: string;
  sandbox_id: string;
  status: V2ExecStatus;
  termination_reason?: V2Open<'explicit_cancel' | 'execution_timeout' | 'runtime_terminated'>;
  failure_reason?: V2Open<'cwd_not_found' | 'cwd_not_directory' | 'permission_denied'>;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  stdout_truncated: boolean | null;
  stderr_truncated: boolean | null;
  started_at: string | null;
  completed_at: string | null;
}

export const V2_EXEC_WAIT_TIMEOUT_MAX_SEC = 25;
export const V2_EXEC_TIMEOUT_MIN_SEC = 1;
export const V2_EXEC_TIMEOUT_MAX_SEC = 3600;
export const V2_EXEC_COMMAND_MAX_BYTES = 128 * 1024;
export const V2_EXEC_ENV_VALUE_MAX_BYTES = 64 * 1024;
/** Non-terminal executions per sandbox; the 11th gets 429 `Execution.ConcurrencyLimitExceeded` [V]. */
export const V2_EXEC_CONCURRENCY_LIMIT = 10;

// ─── Data plane: files ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `SandboxFileEntry`: POST /files?path=/abs (multipart, part `name="file"`) → `V2FileEntry[]`. A misnamed part returns
 * 200 with `[]`: an empty array is an error (C1-B). GET /files?path= returns raw bytes.
 */
export interface V2FileEntry {
  path: string;
  name: string;
  type: V2Open<'file'>;
}

// ─── Data plane: shell ─────────────────────────────────────────────────────────────────────────────────────────────

export type V2ShellStatus = V2Open<'creating' | 'ready' | 'attached' | 'closed'>;

/** `SandboxShellLaunchResponse`: POST /shell → 200. `connect_url` is relative (`/shell/connect`). */
export interface V2ShellLaunch {
  request_id: string;
  sandbox_key: string;
  status: V2ShellStatus;
  /** SECRET-adjacent: never logged with the host (§17); the app connects to wss://{sandbox_key}.{domain}{connect_url}. */
  connect_url: string;
}

/** `SandboxShellCreatingResponse`: POST /shell → 202; retry after ~1 s (never duplicates the PTY). */
export interface V2ShellCreating {
  request_id: string;
  sandbox_key: string;
  status: 'creating';
  code: 'Shell.Creating';
}

/** `SandboxShellControlRequest`: resize needs an active attach; close is irrevocable [V]. */
export type V2ShellControlRequest = { action: 'resize'; cols: number; rows: number } | { action: 'close' };

/** `SandboxShellControlResponse`. */
export interface V2ShellControlResponse {
  request_id: string;
  sandbox_key: string;
  status: V2ShellStatus;
}

export const V2_SHELL_SIZE_MAX = 1000;
