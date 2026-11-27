import { useRef, type ReactNode } from 'react';
import { AlertTriangle, Globe, RotateCcw } from 'lucide-react';
import type { BudgetStatus } from '@shared/contracts/usage';
import { formatDiscount, formatUsd } from '@shared/lib/money';
import { truncate } from '@shared/lib/format';
import { useSettings } from '@renderer/lib/hooks';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Badge } from '@renderer/components/ui/badge';
import { Kbd, MicroLabel, Spinner } from '@renderer/components/ui/misc';
import { formatCents } from './form';
import { RUN_KBD } from './GeneratePane';
import type { RunTicket } from './hooks';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs tabular-nums">{children}</dd>
    </>
  );
}

function budgetLeft(status: BudgetStatus | undefined, after: number | null): ReactNode {
  if (!status) return '—';
  const { remainingTodayUsd: day, remainingMonthUsd: month } = status;
  if (day === null && month === null) return <span className="text-muted-foreground">No limits set</span>;
  const parts: string[] = [];
  if (day !== null) parts.push(`${formatCents(day)} today`);
  if (month !== null) parts.push(`${formatCents(month)} this month`);
  const tight = after !== null && [day, month].some((v) => v !== null && v - after < 0);
  return <span className={tight ? 'text-warning-foreground' : undefined}>{parts.join(' · ')}</span>;
}

/** Cost confirmation before a paid generation (the budget asks for it on every run by default). */
export function RunDialog({
  ticket,
  budget,
  submitting,
  error,
  onConfirm,
  onCancel,
}: {
  ticket: RunTicket | null;
  budget: BudgetStatus | undefined;
  submitting: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const settings = useSettings();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const estimate = ticket?.estimate;
  const charged = estimate?.chargedUsd ?? null;
  const discount = formatDiscount(estimate?.discount);
  const keepsCopy = settings.data?.saveMediaLocally ?? true;

  return (
    <Dialog
      open={ticket !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={ticket ? `Run ${ticket.modelName}?` : 'Run'}
      description="Charged to your GMI balance once GMI accepts the job."
      // Enter confirms: focus starts on Run, not on the corner close button.
      initialFocus={confirmRef}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button ref={confirmRef} onClick={onConfirm} disabled={submitting || charged === null} className="min-w-32 tabular-nums">
            {submitting ? <Spinner className="text-primary-foreground" /> : null}
            {submitting ? 'Submitting…' : `Run · ${formatUsd(charged)}`}
            {!submitting ? (
              <span aria-hidden className="ml-0.5 flex">
                <Kbd className={RUN_KBD}>↵</Kbd>
              </span>
            ) : null}
          </Button>
        </>
      }
    >
      {ticket && estimate ? (
        <div className="flex flex-col gap-3">
          {ticket.nonce ? (
            <Badge variant="primary" className="self-start">
              <RotateCcw /> New take of an earlier job
            </Badge>
          ) : null}

          <div className="flex items-end justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <MicroLabel>You pay</MicroLabel>
              <span className="text-[1.75rem] font-semibold leading-8 tracking-tight tabular-nums">{formatUsd(charged)}</span>
            </div>
            <div className="flex min-w-0 flex-col items-end gap-0.5 pb-0.5 text-right text-2xs tabular-nums text-muted-foreground">
              {discount ? (
                <span>
                  <span className="line-through decoration-muted-foreground/60">{formatUsd(estimate.listUsd)}</span>
                  <span className="ml-1.5 font-medium text-primary-ink">{discount}</span>
                </span>
              ) : (
                <span>No discount on this model</span>
              )}
              {estimate.unit ? <span>priced per {estimate.unit}</span> : null}
            </div>
          </div>

          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 px-1">
            <Row label="Budget left">{budgetLeft(budget, charged)}</Row>
            {estimate.note ? (
              <Row label="Note">
                <span className="text-muted-foreground">{estimate.note}</span>
              </Row>
            ) : null}
          </dl>

          {estimate.budget.reason ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
              <span>{estimate.budget.reason}</span>
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <MicroLabel>Prompt</MicroLabel>
            <p className="line-clamp-4 whitespace-pre-line rounded-md border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed dark:bg-white/[0.02]">
              {truncate(ticket.request.prompt, 600)}
            </p>
          </div>

          <div className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
            <Globe aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              GMI stores outputs and uploaded files at public, unsigned links: anyone with a link can open the file.
              {keepsCopy ? ' GMI Desk also saves a copy in your media folder.' : ''}
            </span>
          </div>
          {error ? <ErrorNotice error={error} compact /> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
