import type { DiffStat, RunStatus, TokenTotals, ToolStatus } from '@shared/contracts/code';

export const STATUS_LABEL: Record<RunStatus, string> = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Waiting for you',
  awaiting_user: 'Waiting for you',
  compacting: 'Compacting',
  completed: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/**
 * Status dots in theme tokens (legible on both themes): brand ink for running/done (lime on dark, olive on light; a
 * lime dot vanishes on the light surfaces), amber for anything that waits (on you, on the queue), red for failures.
 */
export const STATUS_DOT: Record<RunStatus, string> = {
  idle: 'bg-muted-foreground/50',
  queued: 'bg-warning',
  running: 'bg-primary-ink',
  awaiting_approval: 'bg-warning',
  awaiting_user: 'bg-warning',
  compacting: 'bg-warning',
  completed: 'bg-primary-ink',
  stopped: 'bg-muted-foreground',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  interrupted: 'bg-warning',
};

export const TOOL_LABEL: Record<ToolStatus, string> = {
  pending: 'Pending',
  awaiting_approval: 'Needs approval',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  denied: 'Denied',
  interrupted: 'Interrupted',
};

export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function tokenLine(tokens: TokenTotals): string {
  return `${shortTokens(tokens.input)} in · ${shortTokens(tokens.output)} out`;
}

export function diffLine(diff: DiffStat | null): string | null {
  if (!diff || diff.files === 0) return null;
  return `${diff.files} file${diff.files === 1 ? '' : 's'} · +${diff.additions} −${diff.deletions}`;
}

export function modelName(id: string): string {
  if (!id) return 'No model';
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}
