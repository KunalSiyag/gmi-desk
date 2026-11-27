// One resource in the list (§15): kind, name, phase (Plates while working), $/h, accrued, the next automatic event.
import { Clock, RotateCw } from 'lucide-react';
import type { ComputeCatalog, ComputeResource } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';
import { cn } from '@renderer/lib/cn';
import { activeBarBefore } from '@renderer/components/ui/active-bar';
import { Badge } from '@renderer/components/ui/badge';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { actionPendingText, idcName, KIND_LABEL, nextEvent, PENDING_ACTION_LABEL } from './format';
import { KIND_ICON, PhaseBadge } from './parts';
import { PriceTag } from './PriceTag';

export function ResourceRow({
  resource: r,
  catalog,
  selected,
  now,
  onOpen,
}: {
  resource: ComputeResource;
  catalog: ComputeCatalog | undefined;
  selected: boolean;
  now: number;
  onOpen: (id: string) => void;
}) {
  const Icon = KIND_ICON[r.kind];
  const next = nextEvent(r, now);
  const retry = actionPendingText(r.actionPending);
  return (
    <li>
      <button
        type="button"
        data-resource={r.id}
        aria-current={selected || undefined}
        onClick={() => onOpen(r.id)}
        className={cn(
          // Full-width row (kit rowPressMotion): a press deepens the background, never scales. Selection and keyboard
          // focus stay instant (transition-none).
          'relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:transition-none sm:grid-cols-[minmax(0,1fr)_7rem_6.5rem_minmax(9rem,auto)]',
          rowPressMotion,
          selected && cn('bg-accent transition-none hover:bg-accent', activeBarBefore),
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <Icon aria-hidden className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium text-foreground" title={r.displayName}>
                {r.displayName}
              </span>
              {!r.managed ? <Badge variant="outline">Unmanaged</Badge> : null}
              {r.purpose === 'agent' ? <Badge variant="outline">Agent</Badge> : null}
            </span>
            <span className="truncate text-2xs text-muted-foreground" title={[KIND_LABEL[r.kind], idcName(catalog, r.idc), r.templateName].filter(Boolean).join(' · ')}>
              {KIND_LABEL[r.kind]} · {idcName(catalog, r.idc)}
              {r.templateName ? ` · ${r.templateName}` : ''}
            </span>
          </span>
        </span>
        <span className="flex items-center justify-end gap-1.5 sm:justify-start">
          <PhaseBadge phase={r.phase} pending={r.pendingAction ? PENDING_ACTION_LABEL[r.pendingAction] : null} />
        </span>
        <span className="hidden flex-col sm:flex">
          <PriceTag usdPerHour={r.listUsdPerHour} />
          <span className="font-mono text-3xs tabular-nums text-muted-foreground">{formatUsd(r.accruedUsd)} so far</span>
        </span>
        <span className="col-span-2 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground sm:col-span-1 sm:justify-end">
          {retry ? (
            <Badge variant="warning">
              <RotateCw /> {retry}
            </Badge>
          ) : next ? (
            <span className={cn('flex items-center gap-1 tabular-nums', next.soon && 'font-medium text-warning-foreground')}>
              <Clock aria-hidden className="size-3" /> {next.label}
            </span>
          ) : r.reason ? (
            <span className="truncate" title={r.reason}>
              {r.reason}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
