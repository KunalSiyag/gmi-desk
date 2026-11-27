// The dock's status and cost ticker (compute.md §8.5): phase, list price per hour, accrued (total and today), the
// countdowns to the server end, the lease end and the idle pause, and the actions — Extend, Pause/Resume, Snapshot,
// Resources (one exec on demand, never polled) and Delete. Main shows the native confirmations (resume, extend beyond
// the lease, delete); a declined one is silent.
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, Clock, Cpu, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { ComputeResource, ComputerSessionInfo } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input, Label } from '@renderer/components/ui/input';
import { DropdownMenu } from '@renderer/components/ui/menu';
import { MicroLabel, Spinner } from '@renderer/components/ui/misc';
import { Popover } from '@renderer/components/ui/popover';
import { Switch } from '@renderer/components/ui/switch';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { formatCountdown, formatDateTime, formatPerHour, minutesUntil } from '@renderer/pages/compute/format';
import { toastActionError, useNow, useResourceAction } from '@renderer/pages/compute/hooks';
import { PhaseBadge } from '@renderer/pages/compute/parts';
import { DeleteDialog, resourceAbilities } from '@renderer/pages/compute/ResourceDetail';
import { computerKeys } from './session';

/** Countdowns turn amber this close to the event (minutes). */
export const SOON_MIN = 15;

export const EXTEND_STEPS_MIN = [30, 60, 240] as const;

export interface Countdown {
  key: 'server' | 'lease' | 'idle';
  label: string;
  text: string;
  soon: boolean;
}

/** The countdowns that apply now, soonest first. */
export function countdowns(
  r: Pick<ComputeResource, 'phase' | 'serverEndsAt' | 'leaseEndsAt' | 'idlePauseAt' | 'kind' | 'lease'>,
  now: number,
): Countdown[] {
  if (r.phase !== 'running' && r.phase !== 'busy') return [];
  const out: Array<Countdown & { at: number }> = [];
  const add = (key: Countdown['key'], label: string, iso: string | null) => {
    const text = formatCountdown(iso, now);
    const min = minutesUntil(iso, now);
    if (!text || min === null) return;
    out.push({ key, label, text, soon: min <= SOON_MIN, at: min });
  };
  if (r.kind === 'sandbox') add('server', 'Server stop', r.serverEndsAt);
  add('lease', r.lease?.onExpiry === 'delete' ? 'Deleted' : r.lease?.onExpiry === 'pause' ? 'Lease pause' : 'Lease ends', r.leaseEndsAt);
  if (r.kind === 'sandbox') add('idle', 'Idle pause', r.idlePauseAt);
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...c }) => c);
}

/** "+30 min", "+1 h", "+4 h". */
export const extendLabel = (min: number) => (min < 60 ? `+${min} min` : `+${min / 60} h`);

export function StatusBar({ resource: r, session }: { resource: ComputeResource; session: ComputerSessionInfo | null }) {
  const now = useNow(15_000);
  const can = resourceAbilities(r, true);
  const [deleting, setDeleting] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const pause = useResourceAction('Could not pause', (id: string) => gmi.compute.pause(id));
  const resume = useResourceAction('Could not resume', (id: string) => gmi.compute.resume(id));
  const extend = useResourceAction('Could not extend', (id: string, minutes: number) => gmi.compute.extend(id, minutes));
  const remove = useResourceAction('Could not delete', (id: string, opts: { releaseEip?: boolean; deleteFirewall?: boolean }) =>
    gmi.compute.delete(id, opts),
  );
  const times = countdowns(r, now);
  const busy = pause.isPending || resume.isPending || extend.isPending || remove.isPending;

  return (
    <footer aria-label="Computer status" className="shrink-0 border-t border-border bg-sidebar px-3 py-1.5" data-status-bar="">
      <div className="flex min-h-7 items-center gap-2">
        <PhaseBadge phase={r.phase} pending={r.pendingAction ? pendingLabel(r.pendingAction) : null} />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs tabular-nums text-muted-foreground">
          <span className="text-foreground">{formatPerHour(r.listUsdPerHour)}</span>
          {r.listUsdPerHour !== null ? ' list' : ''}
          <Tooltip label="Estimate at list price since it started (today: since local midnight)">
            <span className="cursor-default">
              {' '}
              · {formatUsd(r.accruedUsd)} total · {formatUsd(r.accruedTodayUsd)} today
            </span>
          </Tooltip>
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {can.extend ? (
            <DropdownMenu
              trigger={
                <Button variant="ghost" size="icon-xs" aria-label="Extend" disabled={busy}>
                  <Clock />
                </Button>
              }
              items={EXTEND_STEPS_MIN.map((min) => ({ label: `Extend ${extendLabel(min)}`, onSelect: () => extend.mutate([r.id, min]) }))}
            />
          ) : null}
          {can.pause ? (
            <Tooltip label="Pause (stops compute billing; processes stop)">
              <Button variant="ghost" size="icon-xs" aria-label="Pause" disabled={busy} onClick={() => pause.mutate([r.id])}>
                {pause.isPending ? <Spinner className="size-3" /> : <Pause />}
              </Button>
            </Tooltip>
          ) : null}
          {can.resume ? (
            <Tooltip label="Resume (the price is shown first)">
              <Button variant="ghost" size="icon-xs" aria-label="Resume" disabled={busy} onClick={() => resume.mutate([r.id])}>
                {resume.isPending ? <Spinner className="size-3" /> : <Play />}
              </Button>
            </Tooltip>
          ) : null}
          {can.snapshot ? (
            <Tooltip label="Take a snapshot">
              <Button variant="ghost" size="icon-xs" aria-label="Take a snapshot" onClick={() => setSnapshotting(true)}>
                <Camera />
              </Button>
            </Tooltip>
          ) : null}
          {session && r.phase === 'running' && r.kind === 'sandbox' ? <ResourcesButton sessionId={session.sessionId} /> : null}
          {can.delete ? (
            <Tooltip label="Delete…">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete"
                className="hover:text-destructive"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
      {times.length ? (
        <ul className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-0.5 pb-0.5" aria-label="Countdowns">
          {times.map((t) => (
            <li key={t.key} className={cn('text-2xs tabular-nums', t.soon ? 'text-warning-foreground' : 'text-muted-foreground')}>
              {t.label} <span className={cn('font-mono', t.soon ? 'font-medium' : 'text-foreground/80')}>{t.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <DeleteDialog
        r={r}
        open={deleting}
        onOpenChange={setDeleting}
        onConfirm={(opts) => {
          setDeleting(false);
          remove.mutate([r.id, opts]);
        }}
      />
      <SnapshotDialog r={r} open={snapshotting} onOpenChange={setSnapshotting} />
    </footer>
  );
}

function pendingLabel(action: NonNullable<ComputeResource['pendingAction']>): string {
  const labels: Record<typeof action, string> = {
    create: 'Starting',
    delete: 'Deleting',
    restart: 'Restarting',
    pause: 'Pausing',
    resume: 'Resuming',
    extend: 'Extending',
    snapshot: 'Snapshot',
    network: 'Network',
  };
  return labels[action];
}

/** "Resources": CPU, memory, disk and GPU from one exec when opened (never polled, §8.5). */
function ResourcesButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="end"
      className="w-[min(30rem,calc(100vw-2rem))]"
      trigger={
        <Button variant="ghost" size="icon-xs" aria-label="Resources">
          <Cpu />
        </Button>
      }
    >
      {open ? <ResourceUsage sessionId={sessionId} /> : null}
    </Popover>
  );
}

function ResourceUsage({ sessionId }: { sessionId: string }) {
  const usage = useQuery({
    queryKey: computerKeys.usage(sessionId),
    queryFn: () => gmi.computer.getResourceUsage(sessionId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <MicroLabel className="flex-1">Resources</MicroLabel>
        {usage.data ? <span className="text-3xs text-muted-foreground">{formatDateTime(usage.data.at)}</span> : null}
        <Button variant="ghost" size="icon-xs" aria-label="Measure again" disabled={usage.isFetching} onClick={() => void usage.refetch()}>
          {usage.isFetching ? <Spinner className="size-3" /> : <RefreshCw />}
        </Button>
      </div>
      {usage.error ? (
        <ErrorNotice error={usage.error} compact />
      ) : usage.data ? (
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background px-2.5 py-2 font-mono text-3xs leading-relaxed whitespace-pre text-foreground">
          {usage.data.text}
        </pre>
      ) : (
        <p className="flex items-center gap-2 text-2xs text-muted-foreground">
          <Spinner className="size-3" /> Measuring…
        </p>
      )}
    </div>
  );
}

/** Snapshot (§7.3): a name and the scrub step (on by default). */
function SnapshotDialog({ r, open, onOpenChange }: { r: ComputeResource; open: boolean; onOpenChange: (open: boolean) => void }) {
  const ids = useId();
  const [name, setName] = useState('');
  const [scrub, setScrub] = useState(true);
  const [pending, setPending] = useState(false);
  const submit = async () => {
    setPending(true);
    try {
      await gmi.compute.createSnapshot(r.id, { name: name.trim() || undefined, scrub });
      onOpenChange(false);
      setName('');
    } catch (error) {
      toastActionError('Could not take the snapshot', error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Take a snapshot"
      description="Saves this sandbox’s disk so you can launch copies of it later."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? <Spinner className="size-3.5 text-current" /> : <Camera />} Take snapshot
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${r.displayName} snapshot`} />
        </div>
        <div className="flex items-start gap-2.5">
          <Switch id={`${ids}-scrub`} checked={scrub} onCheckedChange={setScrub} />
          <Label htmlFor={`${ids}-scrub`} className="font-normal leading-relaxed">
            Remove saved credentials first (git credentials, gh, npm and pip caches)
          </Label>
        </div>
      </div>
    </Dialog>
  );
}
