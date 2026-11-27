import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type { GmiErrorCode } from '@shared/contracts/errors';
import { GmiError } from '@shared/contracts/errors';

/** Codes where retrying cannot help (the user has to act). */
const NO_RETRY: ReadonlySet<GmiErrorCode> = new Set([
  'not_signed_in',
  'reauth_required',
  'insufficient_scope',
  'no_api_key',
  'invalid_api_key',
  'unauthorized',
  'payment_required',
  'budget_exceeded',
  'confirmation_required',
  'invalid_input',
  'not_found',
  'not_implemented',
  'cancelled',
  'no_compute_key',
  'invalid_compute_key',
  'not_entitled',
  'quota_exceeded',
  'context_overflow',
  'limit_reached',
  'permission_denied',
]);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof GmiError && NO_RETRY.has(error.code)) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      retry: false,
    },
  },
});

/** Query keys, shared so pages can invalidate each other's data. */
export const qk = {
  appInfo: ['app', 'info'] as const,
  settings: ['app', 'settings'] as const,
  auth: ['auth'] as const,
  catalog: ['catalog', 'snapshot'] as const,
  model: (id: string) => ['catalog', 'model', id] as const,
  leaderboard: ['catalog', 'leaderboard'] as const,
  threads: ['chat', 'threads'] as const,
  thread: (id: string) => ['chat', 'thread', id] as const,
  accountSummary: (days: number) => ['usage', 'summary', days] as const,
  /** Prefix of every accountSummary(days) key. */
  accountSummaryAll: ['usage', 'summary'] as const,
  mediaActivity: (days: number) => ['usage', 'media', days] as const,
  localSpend: (days: number) => ['usage', 'local', days] as const,
  budget: ['usage', 'budget'] as const,
  mediaJobs: ['media', 'jobs'] as const,
  mediaJob: (id: string) => ['media', 'job', id] as const,
  docs: (q: string) => ['docs', q] as const,
  // Compute (compute.md): everything under ['compute'] (computer sessions under ['computer']).
  computeState: ['compute', 'state'] as const,
  computeCatalog: (idc: string | null = null) => ['compute', 'catalog', idc] as const,
  /** `listResources({includeUnmanaged})`: managed-only and "Show all in organization" are separate caches. */
  computeResources: (includeUnmanaged = false) => ['compute', 'resources', includeUnmanaged] as const,
  /** Prefix of both computeResources(…) keys. */
  computeResourcesAll: ['compute', 'resources'] as const,
  computeResource: (id: string) => ['compute', 'resource', id] as const,
  computeSnapshots: ['compute', 'snapshots'] as const,
  computeNetwork: ['compute', 'network'] as const,
  computerSession: (sessionId: string) => ['computer', 'session', sessionId] as const,
  // Code (harness.md): everything under ['code'].
  codeState: ['code', 'state'] as const,
  codeProjects: ['code', 'projects'] as const,
  codeThreads: ['code', 'threads'] as const,
  codeThread: (id: string) => ['code', 'thread', id] as const,
  codeTimeline: (id: string) => ['code', 'timeline', id] as const,
  codeDiff: (threadId: string) => ['code', 'diff', threadId] as const,
  codeApprovals: ['code', 'approvals'] as const,
  codeRules: ['code', 'rules'] as const,
  codeMcp: ['code', 'mcp'] as const,
  gatewayStatus: ['code', 'gateway'] as const,
};

/**
 * Invalidates `queryKey` once, `delayMs` after the last schedule() call (bursts of events → one refetch of
 * the active queries under that key).
 */
export function debouncedInvalidation(client: QueryClient, queryKey: QueryKey, delayMs: number): { schedule(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void client.invalidateQueries({ queryKey });
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
