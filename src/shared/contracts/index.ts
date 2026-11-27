import type { AppApi, AppSettings, NavigateRequest, ToastMessage } from './app';
import type { AuthApi, AuthState } from './auth';
import type { CatalogApi, CatalogUpdate } from './catalog';
import type { ChatApi, ChatStreamEvent, ChatThreadSummary } from './chat';
import type { CodeApi, CodeState, CodeThreadEvent, CodeThreadSummary, ApprovalRequest } from './code';
import type {
  ComputeAlarm,
  ComputeApi,
  ComputeResource,
  ComputeState,
  ComputerApi,
  ComputerSessionInfo,
  PreviewInfo,
  TerminalChunk,
  TransferInfo,
} from './compute';
import type { GatewayStatus } from './gateway';
import type { IpcResult } from './errors';
import type { MediaApi, MediaJob } from './media';
import type { BudgetStatus, DocsApi, SupportApi, UsageApi } from './usage';

export type * from './app';
export type * from './auth';
export type * from './catalog';
export type * from './chat';
export type * from './code';
export type * from './compute';
export type * from './gateway';
export type * from './media';
export type * from './usage';
export { GmiError, isGmiError, toGmiError, ERROR_HINTS } from './errors';
export type { GmiErrorCode, GmiErrorShape, IpcResult } from './errors';
export { DEFAULT_SETTINGS } from './app';
export { GMI_SCOPES } from './auth';
export { DEFAULT_BUDGET } from './usage';
export { TERMINAL_JOB_STATUSES } from './media';
export {
  LEASE_LIMITS,
  TERMINAL_INPUT_MAX_BYTES,
  FILE_PREVIEW_MAX_BYTES,
  FILE_WRITE_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  COMPUTE_API_METHODS,
  COMPUTER_API_METHODS,
} from './compute';
export { CODE_DEFAULTS, CODE_API_METHODS } from './code';
export { GATEWAY_TPM_TIERS } from './gateway';

/** Everything the renderer can call in the main process, grouped by namespace. */
export interface GmiApi {
  app: AppApi;
  auth: AuthApi;
  catalog: CatalogApi;
  chat: ChatApi;
  media: MediaApi;
  usage: UsageApi;
  docs: DocsApi;
  support: SupportApi;
  /** Cluster Engine containers and Agentbox sandboxes (compute.md). */
  compute: ComputeApi;
  /** The live "computer": terminal, files, ports, previews of a compute resource (compute.md §8). */
  computer: ComputerApi;
  /** The Code tab: projects, agent threads, approvals, review (harness.md). */
  code: CodeApi;
}

export type GmiNamespace = keyof GmiApi;

export const API_NAMESPACES = [
  'app',
  'auth',
  'catalog',
  'chat',
  'media',
  'usage',
  'docs',
  'support',
  'compute',
  'computer',
  'code',
] as const satisfies readonly GmiNamespace[];

/** Events pushed from the main process to the renderer. */
export interface GmiEvents {
  'auth:changed': AuthState;
  'catalog:updated': CatalogUpdate;
  'chat:stream': ChatStreamEvent;
  'chat:threads': ChatThreadSummary[];
  'media:job': MediaJob;
  'usage:budget': BudgetStatus;
  'app:navigate': NavigateRequest;
  'app:toast': ToastMessage;
  /** Settings changed in the main process (any source). */
  'app:settings': AppSettings;
  /** Access, alarms and totals (throttled ≤ 1/s). */
  'compute:state': ComputeState;
  /** Managed + visible unmanaged resources, after every poll/mutation that changed something. */
  'compute:resources': ComputeResource[];
  /** A new alarm (also in compute:state). */
  'compute:alarm': ComputeAlarm;
  'computer:session': ComputerSessionInfo;
  /** ≤ 64 KiB, batched every 16 ms. */
  'computer:terminal': TerminalChunk;
  /** Throttled to 4/s per transfer. */
  'computer:transfer': TransferInfo;
  'computer:preview': PreviewInfo;
  /** Throttled ≤ 1/s. */
  'code:state': CodeState;
  'code:threads': CodeThreadSummary[];
  /** Durable events in thread_seq order; deltas/meters are ephemeral. */
  'code:event': CodeThreadEvent;
  'code:approval': { request: ApprovalRequest; resolved: boolean };
  /** Throttled 1/s, only while the Code page or Usage is visible. */
  'code:gateway': GatewayStatus;
}

export type GmiEventName = keyof GmiEvents;

export const EVENT_NAMES = [
  'auth:changed',
  'catalog:updated',
  'chat:stream',
  'chat:threads',
  'media:job',
  'usage:budget',
  'app:navigate',
  'app:toast',
  'app:settings',
  'compute:state',
  'compute:resources',
  'compute:alarm',
  'computer:session',
  'computer:terminal',
  'computer:transfer',
  'computer:preview',
  'code:state',
  'code:threads',
  'code:event',
  'code:approval',
  'code:gateway',
] as const satisfies readonly GmiEventName[];

export const IPC_INVOKE_PREFIX = 'gmi:invoke:';
export const IPC_EVENT_CHANNEL = 'gmi:event';

export function invokeChannel(ns: GmiNamespace, method: string): string {
  return `${IPC_INVOKE_PREFIX}${ns}:${method}`;
}

export const METHOD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

/** What the preload script exposes as `window.gmi`. */
export interface GmiBridge {
  invoke(ns: GmiNamespace, method: string, args: unknown[]): Promise<IpcResult<unknown>>;
  on(event: GmiEventName, listener: (payload: unknown) => void): () => void;
  platform: string;
}
