// Uploads and downloads of one session (compute.md §8.3), from `computer:transfer` events: name (never a local
// path), progress, state, cancel; finished rows can be cleared.
import { useMemo } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, CircleAlert, X } from 'lucide-react';
import type { TransferInfo } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { Button } from '@renderer/components/ui/button';
import { MicroLabel } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { formatBytes } from '@renderer/pages/compute/format';
import { toastActionError } from '@renderer/pages/compute/hooks';
import { useComputerUi, useStoreNow } from './store';

/** 0–1, or null when the total is unknown. */
export function transferProgress(t: Pick<TransferInfo, 'bytes' | 'totalBytes' | 'state'>): number | null {
  if (t.state === 'done') return 1;
  if (!t.totalBytes || t.totalBytes <= 0) return null;
  return Math.max(0, Math.min(1, t.bytes / t.totalBytes));
}

/** "1.2 MB of 4.5 MB", "820 KB", "Done · 4.5 MB", "Failed: …", "Cancelled". */
export function transferStatus(t: TransferInfo): string {
  const done = formatBytes(t.bytes) ?? '0 B';
  const total = formatBytes(t.totalBytes);
  switch (t.state) {
    case 'queued':
      return 'Waiting';
    case 'running':
      return total ? `${done} of ${total}` : done;
    case 'done':
      return `Done · ${total ?? done}`;
    case 'cancelled':
      return 'Cancelled';
    case 'failed': {
      // The event carries the error's plain shape; GmiError gives it the same title/hint as everywhere else.
      const view = t.error ? describeError(GmiError.fromShape(t.error)) : null;
      return `Failed${view ? `: ${view.message || view.title}` : ''}`;
    }
  }
}

export function TransferList({ sessionId }: { sessionId: string }) {
  const all = useStoreNow(useComputerUi, (s) => s.transfers);
  const clear = useComputerUi((s) => s.clearFinishedTransfers);
  const transfers = useMemo(() => all.filter((t) => t.sessionId === sessionId).reverse(), [all, sessionId]);
  if (!transfers.length) return null;
  const finished = transfers.some((t) => t.state === 'done' || t.state === 'failed' || t.state === 'cancelled');
  return (
    <section aria-label="Transfers" className="max-h-40 shrink-0 overflow-y-auto border-t border-border">
      <div className="flex h-7 items-center justify-between px-3">
        <MicroLabel>Transfers</MicroLabel>
        {finished ? (
          <Button variant="ghost" size="xs" className="-mr-1.5 h-5" onClick={() => clear(sessionId)}>
            Clear finished
          </Button>
        ) : null}
      </div>
      <ul className="pb-1">
        {transfers.map((t) => (
          <TransferRow key={t.transferId} t={t} />
        ))}
      </ul>
    </section>
  );
}

function TransferRow({ t }: { t: TransferInfo }) {
  const progress = transferProgress(t);
  const active = t.state === 'queued' || t.state === 'running';
  const Icon = t.state === 'done' ? Check : t.state === 'failed' ? CircleAlert : t.direction === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
  return (
    <li className="flex items-center gap-2 px-3 py-1" data-transfer={t.state}>
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          t.state === 'done' ? 'text-primary-ink' : t.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={t.remotePath}>
            {t.name}
          </span>
          <span className={cn('shrink-0 font-mono text-3xs tabular-nums', t.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {transferStatus(t)}
          </span>
        </div>
        {active ? (
          <div
            role="progressbar"
            aria-label={`${t.direction === 'upload' ? 'Uploading' : 'Downloading'} ${t.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
            className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn('h-full origin-left rounded-full bg-primary-ink transition-transform duration-200 ease-out', progress === null && 'w-1/3 opacity-60')}
              style={progress === null ? undefined : { transform: `scaleX(${progress})` }}
            />
          </div>
        ) : null}
      </div>
      {active ? (
        <Tooltip label="Cancel">
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label={`Cancel ${t.name}`}
            onClick={() => void gmi.computer.cancelTransfer(t.transferId).catch((error: unknown) => toastActionError('Could not cancel', error))}
          >
            <X />
          </Button>
        </Tooltip>
      ) : null}
    </li>
  );
}
