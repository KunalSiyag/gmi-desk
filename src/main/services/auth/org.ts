/**
 * Best-effort lookup of the organization a GMI session belongs to (get_account_summary → org_id).
 * The lookup is marked pending in the hub without emitting (the caller's next emit carries it) and
 * emits once it is over. Transient failures (offline at startup, a GMI hiccup) are retried a few times.
 */
import { toGmiError } from '@shared/contracts/errors';
import type { Logger } from '../../core/logger';
import type { McpGateway } from '../../core/services';
import type { JsonStore } from '../../core/store';
import type { AuthFile, AuthStateHub } from './state';
import { TRANSIENT_CODES } from './tokens';

export const ORG_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

export interface OrgLookupDeps {
  hub: AuthStateHub;
  file: JsonStore<AuthFile>;
  mcp: McpGateway;
  /** Changes whenever the session changes; a result for an older session is dropped. */
  epoch: () => number;
  log: Logger;
  retryDelaysMs?: number[];
}

export interface OrgLookup {
  /** Looks the organization up for the current session (joins a lookup in flight); resets the retries. */
  start(): Promise<void>;
  /** Cancels a scheduled retry (sign-out, dispose). */
  stop(): void;
}

export function orgIdOf(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object') return null;
  const id = (summary as Record<string, unknown>).org_id;
  return typeof id === 'string' && id.trim() && id.trim().length <= 200 ? id.trim() : null;
}

export function createOrgLookup(deps: OrgLookupDeps): OrgLookup {
  const delays = deps.retryDelaysMs ?? ORG_RETRY_DELAYS_MS;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = (): Promise<void> => {
    if (running) return running;
    stop();
    deps.hub.runtime = { ...deps.hub.runtime, orgIdPending: true };
    const epoch = deps.epoch();
    running = (async () => {
      try {
        const orgId = orgIdOf(await deps.mcp.callTool('get_account_summary', { days: 1 }, { timeoutMs: 20_000 }));
        if (orgId && epoch === deps.epoch() && deps.file.get().orgId !== orgId) await deps.file.update((f) => ({ ...f, orgId }));
      } catch (error) {
        const { code } = toGmiError(error);
        deps.log.debug('could not learn the organization id', { code, attempt });
        const delay = delays[attempt];
        if (TRANSIENT_CODES.has(code) && delay !== undefined && epoch === deps.epoch()) {
          attempt += 1;
          timer = setTimeout(() => {
            timer = null;
            if (epoch === deps.epoch() && deps.hub.runtime.status === 'signed_in' && !deps.file.get().orgId) void run();
          }, delay);
          timer.unref?.();
        }
      }
    })().finally(() => {
      running = null;
      deps.hub.update({ orgIdPending: false });
    });
    return running;
  };

  return {
    start() {
      attempt = 0;
      return run();
    },
    stop,
  };
}
