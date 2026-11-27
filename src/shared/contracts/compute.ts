/**
 * Compute tab and the live "computer": GMI Cluster Engine containers and Agentbox sandboxes (Sandbox API v2).
 * Namespaces `compute` (resources, catalog, cost guard) and `computer` (terminal, files, ports, previews).
 * The compute key and every data-plane/traffic token stay in the main process.
 */
import type { ComputeKeyInfo } from './auth';
import type { GmiErrorShape } from './errors';
import type { BudgetCheck } from './usage';

export type ComputeKind = 'container' | 'sandbox';
/** Which GMI API manages a resource: CE `/api/v1/containers` or Sandbox API v2 `/api/v2/sandboxes`. */
export type ComputeBackend = 'ce' | 'sandbox_v2';

export type ComputeSourceState = 'ok' | 'stale' | 'error' | 'skipped';
export interface ComputeSourceStatus {
  state: ComputeSourceState;
  fetchedAt: string | null;
  error: string | null;
}

export type IdcStatus = 'available' | 'full' | 'maintenance' | 'unknown';

export interface ComputeIdc {
  /** GMI's idcId, e.g. "asia-east-taiwan3". */
  id: string;
  name: string;
  country: string | null;
  status: IdcStatus;
  /** What the catalog offers there. */
  kinds: ComputeKind[];
  /** Whether an EIP product exists there (public access possible). Null: unknown. */
  eipAvailable: boolean | null;
}

/** One launchable size. Signed out, offers are aggregated (no raw SKU). */
export interface ComputeOffer {
  /** Stable key: the SKU when known, else `${kind}:${gpuModel ?? 'cpu'}x${gpuCount}:${idc}`. */
  id: string;
  kind: ComputeKind;
  /** Billing instanceType (containers) / product (sandboxes). Null when aggregated. */
  sku: string | null;
  idc: string;
  gpuModel: string | null;
  gpuCount: number;
  vcpu: number | null;
  memoryGiB: number | null;
  diskGiB: number | null;
  arch: 'x86_64' | 'arm64' | null;
  /** Sandbox size label (SMALL, MEDIUM, ...). */
  sizeLabel: string | null;
  /** List price, USD per hour (lowest in the group when aggregated). Null: unknown. */
  listUsdPerHour: number | null;
  /** True: GMI lists it for this org (needs a Compute key). Null: unknown (signed out). */
  entitled: boolean | null;
}

export interface ComputeTemplatePort {
  port: number;
  protocol: 'TCP' | 'UDP';
  label: string | null;
}

export interface ComputeTemplate {
  id: string;
  kind: ComputeKind;
  name: string;
  official: boolean;
  /** Container image path. Registry credentials never leave main. */
  image: string | null;
  /** Only for official templates. */
  description: string | null;
  defaultPorts: ComputeTemplatePort[];
  /** Official CE templates pre-expose SSH (22). Null: unknown. */
  sshReady: boolean | null;
  /** Sandbox templates belong to one IDC. */
  idc: string | null;
}

export type ComputeCatalogSource =
  | 'idcs'
  | 'publicProducts'
  | 'publicTemplates'
  | 'accountProducts'
  | 'accountTemplates'
  | 'sandboxProducts'
  | 'sandboxTemplates';

export interface ComputeCatalog {
  idcs: ComputeIdc[];
  offers: ComputeOffer[];
  templates: ComputeTemplate[];
  /** `account` once a valid Compute key added the org's own products and templates. */
  scope: 'public' | 'account';
  sources: Record<ComputeCatalogSource, ComputeSourceStatus>;
  fetchedAt: string;
}

export type ComputeEntitlement = 'unknown' | 'checking' | 'entitled' | 'not_entitled' | 'error';

export interface ComputeAccess {
  key: ComputeKeyInfo;
  containers: ComputeEntitlement;
  sandboxes: ComputeEntitlement;
  checkedAt: string | null;
}

/** Normalised lifecycle phase across CE statuses and v2 sandbox states (the raw value is in `rawState`). */
export type ComputePhase =
  | 'creating'
  | 'running'
  | 'busy'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'deleting'
  | 'deleted'
  | 'failed'
  | 'unknown';

export type ComputeAction = 'create' | 'delete' | 'restart' | 'pause' | 'resume' | 'extend' | 'snapshot' | 'network';

/** What the cost guard does at a limit. Containers support 'delete' | 'notify' only (no pause in CE). */
export type LeaseAction = 'delete' | 'pause' | 'notify';

export interface LeasePolicy {
  /** Max lifetime from the first `running`, minutes. Null = no limit (needs a native confirmation). */
  maxLifetimeMin: number | null;
  onExpiry: LeaseAction;
  /** Sandboxes: pause after this many idle minutes. Null = never. */
  idlePauseMin: number | null;
  /** Sandboxes: extend the server timeout while there is activity, up to maxLifetimeMin. */
  extendOnActivity: boolean;
  /** When a budget limit is reached while running (enforce on). */
  onBudget: LeaseAction;
}

export const LEASE_LIMITS = {
  minLifetimeMin: 10,
  maxLifetimeMin: 7 * 24 * 60,
  minIdlePauseMin: 5,
  maxIdlePauseMin: 24 * 60,
  sandboxTimeoutMinSec: 60,
  sandboxTimeoutMaxSec: 86_400,
} as const;

export interface FirewallRuleView {
  protocol: 'tcp' | 'udp' | 'icmp' | 'any';
  fromPort: number | null;
  toPort: number | null;
  cidr: string;
}

export interface ComputeNetwork {
  publicIp: string | null;
  eip: {
    id: string;
    address: string | null;
    /** Allocated by this app (it may release it). */
    managed: boolean;
    status: 'associated' | 'disassociated' | 'released' | 'unknown';
  } | null;
  firewalls: Array<{ id: string; name: string; managed: boolean; preset: boolean; rules: FirewallRuleView[] }>;
  ports: Array<{ containerPort: number; nodePort: number | null; protocol: 'TCP' | 'UDP' }>;
  /** A step of the EIP/firewall setup failed (see alarms). */
  degraded: boolean;
}

export interface ComputeCapabilities {
  terminal: boolean;
  files: boolean;
  previews: boolean;
  logs: boolean;
  restart: boolean;
  pause: boolean;
  snapshot: boolean;
  extend: boolean;
  network: boolean;
}

export interface ComputeResource {
  /** App handle `cr_<uuid>`, stable across restarts; also the v2 Idempotency-Key. */
  id: string;
  kind: ComputeKind;
  backend: ComputeBackend;
  /** CE container id / v2 sandbox id. Null while a create is pending. */
  remoteId: string | null;
  /** Remote name (containers: `gmid-<inst6>-<slug>-<nonce6>`). */
  name: string;
  displayName: string;
  /** Created or adopted by this install. False: someone else's, read-only. */
  managed: boolean;
  purpose: 'computer' | 'agent' | null;
  /** Code thread served by this resource (harness.md H4). */
  threadId: string | null;
  phase: ComputePhase;
  rawState: string | null;
  /** User-safe explanation (failure, pause or deletion reason). */
  reason: string | null;
  idc: string | null;
  sku: string | null;
  templateName: string | null;
  listUsdPerHour: number | null;
  createdAt: string | null;
  runningSince: string | null;
  /** Sandboxes: GMI's end_at (pause or deletion by the server). */
  serverEndsAt: string | null;
  /** App lease end (first running + maxLifetimeMin). */
  leaseEndsAt: string | null;
  /** Sandboxes: paused_expire_at (deleted by GMI after 7 days paused). */
  pausedExpiresAt: string | null;
  /** When the idle guard will pause it (sandboxes). */
  idlePauseAt: string | null;
  lease: LeasePolicy | null;
  /** Local estimate at list price since creation / today (local day). */
  accruedUsd: number;
  accruedTodayUsd: number;
  /** Containers only. */
  network: ComputeNetwork | null;
  /** Sandboxes: port previews need the traffic token. */
  secure: boolean | null;
  egressLocked: boolean | null;
  capabilities: ComputeCapabilities;
  pendingAction: ComputeAction | null;
  /** A lease or budget action that has not succeeded yet; retried every guard tick (§9.4). */
  actionPending: { action: LeaseAction; dueAt: string; attempts: number; lastError: string | null } | null;
  updatedAt: string;
}

export interface ComputeResourceDetail extends ComputeResource {
  /** Env var names only; values never cross IPC. */
  envNames: string[];
  command: string | null;
  args: string[];
  sshKeyNames: string[];
  /** Snapshot it was launched from. */
  snapshotId: string | null;
  lastError: GmiErrorShape | null;
  /** Last 50 phase transitions, newest first. */
  history: Array<{ at: string; phase: ComputePhase; note: string | null }>;
}

export interface EnvVarInput {
  name: string;
  value: string;
  /** Secret values are kept in main memory until create, never stored or returned. */
  secret: boolean;
}

export interface ContainerCreateSpec {
  kind: 'container';
  /** 1–40 characters; the remote name becomes `gmid-<inst6>-<slug>-<nonce6>`. */
  displayName: string;
  idc: string;
  sku: string;
  templateId: string;
  command?: string | null;
  args?: string[];
  env?: EnvVarInput[];
  ports?: Array<{ containerPort: number; protocol: 'TCP' | 'UDP' }>;
  ssh: { mode: 'none' } | { mode: 'app_key' } | { mode: 'account_keys'; keyIds: string[] };
  /** Main treats any CIDR broader than /32 as open (native confirmation), whatever `allOpen` says (§6.3). */
  access: { mode: 'none' } | { mode: 'public'; allowCidrs: string[]; tcpPorts: number[]; allOpen?: boolean };
  lease: LeasePolicy;
}

export interface SandboxCreateSpec {
  kind: 'sandbox';
  displayName: string;
  /** Null: the org's default IDC. */
  idc: string | null;
  /** e.g. `gmi.sandbox.small`. */
  product: string;
  source: { templateId: string } | { snapshotId: string };
  /** Always sent (GMI's default is 300 s). */
  timeoutSec: number;
  onTimeout: 'pause' | 'kill';
  /** Traffic token on port previews. False needs a native confirmation. */
  secure: boolean;
  egress: { mode: 'open' } | { mode: 'allowlist'; hostnames: string[]; cidrs: string[] };
  env?: EnvVarInput[];
  purpose: 'computer' | 'agent';
  threadId?: string | null;
  lease: LeasePolicy;
}

export type ComputeCreateSpec = ContainerCreateSpec | SandboxCreateSpec;

export interface CostLine {
  label: string;
  usdPerHour: number | null;
  note: string | null;
}

export interface CreateQuote {
  quoteId: string;
  /** As normalised by main; secret env values are replaced by '••••'. */
  spec: ComputeCreateSpec;
  lines: CostLine[];
  /** List total per hour. Null: unknown. */
  usdPerHour: number | null;
  /** If it runs until the lease/timeout ends (list). Null: no limit. */
  maxUsd: number | null;
  priceSource: 'public_feed' | 'cached';
  priceAgeSec: number | null;
  budget: BudgetCheck;
  warnings: string[];
  expiresAt: string;
}

export type SnapshotState = 'creating' | 'ready' | 'error' | 'deleting' | 'delete_failed' | 'unknown';

export interface ComputeSnapshot {
  id: string;
  name: string;
  /** App resource it was taken from, when known. */
  sourceResourceId: string | null;
  sourceRemoteId: string | null;
  idc: string | null;
  state: SnapshotState;
  createdAt: string | null;
  sizeBytes: number | null;
  managed: boolean;
}

export interface ComputeNetworkInventory {
  eips: Array<{
    id: string;
    name: string;
    idc: string;
    address: string | null;
    status: 'associated' | 'disassociated' | 'released' | 'unknown';
    /** App resource id when attached to a managed container. */
    attachedTo: string | null;
    managed: boolean;
    listUsdPerHour: number | null;
  }>;
  firewalls: Array<{ id: string; name: string; idc: string; preset: boolean; managed: boolean; attachedCount: number; status: 'active' | 'building' | 'error' | 'unknown' }>;
  fetchedAt: string;
}

export type ComputeAlarmKind =
  | 'orphan'
  | 'eip_unattached'
  | 'lease_expiring'
  | 'lease_action'
  | 'budget_warning'
  | 'budget_exhausted'
  | 'paused_long'
  | 'price_unknown'
  | 'api_unavailable'
  | 'key_invalid'
  | 'create_unknown'
  | 'lease_action_failed';

export type ComputeAlarmAction = 'open' | 'extend' | 'pause' | 'delete' | 'release_eip' | 'connect_key' | 'open_console' | 'adopt' | 'dismiss';

export interface ComputeAlarm {
  id: string;
  kind: ComputeAlarmKind;
  severity: 'info' | 'warning' | 'critical';
  resourceId: string | null;
  title: string;
  body: string;
  usdPerHour: number | null;
  createdAt: string;
  actions: ComputeAlarmAction[];
}

export type ComputeApiHealth = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ComputeState {
  access: ComputeAccess;
  /** Managed resources billing now. */
  running: { count: number; usdPerHour: number };
  /** Estimated compute spend (list), local day / month. */
  todayUsd: number;
  monthUsd: number;
  alarms: ComputeAlarm[];
  apiHealth: { ce: ComputeApiHealth; sandbox: ComputeApiHealth };
  /** Everything billing in the organization that the key can see (no spend API exists). Null before the first sweep. */
  org: { containers: number; eips: number; usdPerHour: number | null } | null;
  /** True when a daily budget exists (required before the first container or GPU sandbox, §9.3). */
  dailyBudgetSet: boolean;
  lastSweepAt: string | null;
  mock: boolean;
}

export interface ComputeApi {
  getState(): Promise<ComputeState>;
  getCatalog(opts?: { refresh?: boolean; idc?: string | null }): Promise<ComputeCatalog>;
  listResources(opts?: { includeUnmanaged?: boolean }): Promise<ComputeResource[]>;
  getResource(id: string): Promise<ComputeResourceDetail>;
  /** Polls GMI now (both backends). */
  refresh(): Promise<void>;
  /** Validates and prices a spec. Nothing is created. */
  quoteCreate(spec: ComputeCreateSpec): Promise<CreateQuote>;
  /** Native cost confirmation in main, then creates exactly once. Declined: GmiError('cancelled'). */
  create(quoteId: string): Promise<ComputeResource>;
  /** Native confirmation. Containers: optionally release the app's EIP and firewall afterwards. */
  delete(id: string, opts?: { releaseEip?: boolean; deleteFirewall?: boolean }): Promise<ComputeResource>;
  restart(id: string): Promise<ComputeResource>;
  pause(id: string): Promise<ComputeResource>;
  /** Native confirmation with the price. */
  resume(id: string): Promise<ComputeResource>;
  /** Within the approved lease: no dialog. Beyond it: native confirmation with the price. */
  extend(id: string, minutes: number): Promise<ComputeResource>;
  /** Loosening (longer, notify instead of delete, idle off, no limit) needs a native confirmation; so does any change
   *  that makes a delete happen sooner (shorter than run time + 15 min, onExpiry/onBudget → 'delete'). */
  setLease(id: string, patch: Partial<LeasePolicy>): Promise<ComputeResource>;
  getLogs(id: string, opts?: { tailBytes?: number }): Promise<{ text: string; truncated: boolean; fetchedAt: string }>;
  /** Native save dialog; the full log. Null when cancelled. */
  saveLogs(id: string): Promise<string | null>;
  listSnapshots(): Promise<ComputeSnapshot[]>;
  createSnapshot(id: string, opts?: { name?: string; scrub?: boolean }): Promise<ComputeSnapshot>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  getNetwork(): Promise<ComputeNetworkInventory>;
  /** Native confirmation. Only EIPs this app allocated (`managed`); unmanaged ones get the alarm and Open in console. */
  releaseEip(eipId: string): Promise<void>;
  /** Replaces the firewall's source CIDR. A /32 needs only the renderer confirm; broader is "open" (native); reserved CIDRs rejected. */
  updateFirewallCidr(id: string, cidr: string): Promise<ComputeResource>;
  /** Takes over a `gmid-` resource with another install tag (native confirmation: it may be a colleague's). */
  adopt(id: string): Promise<ComputeResource>;
  /** Opt-in: asks a public IP echo service for this computer's IPv4 (one call per click, disclosed in the UI). */
  detectPublicIp(): Promise<{ ip: string | null; service: string }>;
  /** Re-runs the orphan / EIP sweep now. */
  sweep(): Promise<ComputeState>;
  dismissAlarm(alarmId: string): Promise<ComputeState>;
  /** Opens a fixed console page for a resource (validated id). */
  openInConsole(id: string, view: 'detail' | 'logs' | 'monitor' | 'reconfigure' | 'renew'): Promise<void>;
}

export type ComputerSessionState = 'connecting' | 'ready' | 'reconnecting' | 'paused' | 'unavailable' | 'closed';
export type TerminalState = 'none' | 'connecting' | 'attached' | 'reconnecting' | 'attached_elsewhere' | 'closed';

export interface ComputerService {
  name: string;
  command: string;
  port: number | null;
  startedAt: string;
}

export interface ComputerSessionInfo {
  sessionId: string;
  resourceId: string;
  state: ComputerSessionState;
  reason: string | null;
  terminal: { state: TerminalState; cols: number; rows: number; lastSeq: number };
  /** File browser root ($HOME). */
  home: string | null;
  user: string | null;
  /** Resumed after a pause: earlier processes may be gone. */
  coldResumed: boolean;
  services: ComputerService[];
  /** Exec slots in use (of 10 per sandbox). */
  execInUse: number;
}

/** One batch of terminal output. `data` is raw PTY bytes (ANSI). */
export interface TerminalChunk {
  sessionId: string;
  seq: number;
  data: Uint8Array;
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
  mtime: string | null;
  /** Octal permission bits, e.g. "644". */
  mode: string | null;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  /** Null when binary or over the limit. */
  text: string | null;
  binary: boolean;
  truncated: boolean;
}

export interface TransferInfo {
  transferId: string;
  sessionId: string;
  direction: 'upload' | 'download';
  /** File name only (never a local path). */
  name: string;
  remotePath: string;
  bytes: number;
  totalBytes: number | null;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error: GmiErrorShape | null;
}

export interface PortInfo {
  port: number;
  address: string;
  process: string | null;
  previewable: boolean;
}

export type PreviewState = 'loading' | 'ready' | 'failed' | 'blocked' | 'closed';

export interface PreviewInfo {
  previewId: string;
  sessionId: string;
  port: number;
  /** The preview URL without any token (tokens travel in headers only). */
  url: string;
  title: string | null;
  state: PreviewState;
  /** Blocked navigation target or load error, user-safe. */
  detail: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;
export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const FILE_WRITE_MAX_BYTES = 1024 * 1024;
export const UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

export interface ComputerApi {
  open(resourceId: string): Promise<ComputerSessionInfo>;
  close(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<ComputerSessionInfo>;
  /** Starts or rejoins the shell; returns what was already on screen (ring buffer) and its last seq. */
  terminalAttach(sessionId: string, size: { cols: number; rows: number }): Promise<{ replay: Uint8Array; seq: number }>;
  terminalInput(sessionId: string, data: string): Promise<void>;
  terminalResize(sessionId: string, size: { cols: number; rows: number }): Promise<void>;
  /** Flow control: the renderer has written everything up to `seq`. */
  terminalAck(sessionId: string, seq: number): Promise<void>;
  /** Ack backpressure applies only while a view is attached and visible (§8.2). */
  terminalVisibility(sessionId: string, visible: boolean): Promise<void>;
  /** Closes the remote shell (irrevocable) and starts a new one. Native confirmation in main. */
  terminalTakeOver(sessionId: string): Promise<void>;
  listDir(sessionId: string, path: string): Promise<DirListing>;
  readFile(sessionId: string, path: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  writeFile(sessionId: string, path: string, text: string): Promise<void>;
  makeDir(sessionId: string, path: string): Promise<void>;
  movePath(sessionId: string, from: string, to: string): Promise<void>;
  removePath(sessionId: string, path: string): Promise<void>;
  /** Native multi-file picker in main, then uploads into `remoteDir`. Null when cancelled. */
  upload(sessionId: string, remoteDir: string): Promise<TransferInfo[] | null>;
  /** Native save dialog in main. Null when cancelled. */
  download(sessionId: string, remotePath: string): Promise<TransferInfo | null>;
  cancelTransfer(transferId: string): Promise<void>;
  listPorts(sessionId: string): Promise<PortInfo[]>;
  startService(sessionId: string, svc: { name: string; command: string; port?: number | null }): Promise<ComputerSessionInfo>;
  restartServices(sessionId: string): Promise<ComputerSessionInfo>;
  /** Snapshot of CPU/memory/disk/GPU via one exec (never polled). */
  getResourceUsage(sessionId: string): Promise<{ text: string; at: string }>;
  /** `path` must start with '/'; main builds the URL and checks its host (§8.4). */
  openPreview(sessionId: string, port: number, path?: string): Promise<PreviewInfo>;
  /** Null hides the native view (e.g. while a dialog covers it). */
  setPreviewBounds(previewId: string, bounds: PreviewBounds | null): Promise<void>;
  previewCommand(previewId: string, command: 'reload' | 'back' | 'forward' | 'stop'): Promise<void>;
  /** Native confirmation; opens the preview URL in the system browser (it gets no token). */
  openPreviewExternally(previewId: string): Promise<void>;
  closePreview(previewId: string): Promise<void>;
  /** PNG data URL of the preview, shown while an overlay hides the native view. */
  capturePreview(previewId: string): Promise<string | null>;
}

/** Every ComputeApi method name (checked against the interface at compile time; used by stubs and contract tests). */
export const COMPUTE_API_METHODS = [
  'getState',
  'getCatalog',
  'listResources',
  'getResource',
  'refresh',
  'quoteCreate',
  'create',
  'delete',
  'restart',
  'pause',
  'resume',
  'extend',
  'setLease',
  'getLogs',
  'saveLogs',
  'listSnapshots',
  'createSnapshot',
  'deleteSnapshot',
  'getNetwork',
  'releaseEip',
  'updateFirewallCidr',
  'adopt',
  'detectPublicIp',
  'sweep',
  'dismissAlarm',
  'openInConsole',
] as const satisfies readonly (keyof ComputeApi)[];

/** Every ComputerApi method name (checked against the interface at compile time). */
export const COMPUTER_API_METHODS = [
  'open',
  'close',
  'getSession',
  'terminalAttach',
  'terminalInput',
  'terminalResize',
  'terminalAck',
  'terminalVisibility',
  'terminalTakeOver',
  'listDir',
  'readFile',
  'writeFile',
  'makeDir',
  'movePath',
  'removePath',
  'upload',
  'download',
  'cancelTransfer',
  'listPorts',
  'startService',
  'restartServices',
  'getResourceUsage',
  'openPreview',
  'setPreviewBounds',
  'previewCommand',
  'openPreviewExternally',
  'closePreview',
  'capturePreview',
] as const satisfies readonly (keyof ComputerApi)[];

/** Compile-time proof that the lists above name every method (a missing one makes this `false`). */
export type ComputeApiMethodsComplete = [
  Exclude<keyof ComputeApi, (typeof COMPUTE_API_METHODS)[number]> | Exclude<keyof ComputerApi, (typeof COMPUTER_API_METHODS)[number]>,
] extends [never]
  ? true
  : false;
const computeMethodsComplete: ComputeApiMethodsComplete = true;
void computeMethodsComplete;
