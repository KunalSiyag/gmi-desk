import { forwardRef, useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { BUDGET_MAX_USD, type Budget, type BudgetStatus } from '@shared/contracts/usage';
import { errorCode } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input, Label } from '@renderer/components/ui/input';
import { Skeleton, Spinner } from '@renderer/components/ui/misc';
import { Switch } from '@renderer/components/ui/switch';
import { Meter, Panel } from './parts';

interface Draft {
  daily: string;
  monthly: string;
  confirm: string;
  enforce: boolean;
}

/** 5 → "5", 0.5 → "0.50", 0.125 → "0.125". */
const toText = (v: number | null) => (v === null ? '' : Number.isInteger(v) || Math.round(v * 100) !== v * 100 ? String(v) : v.toFixed(2));
const toDraft = (b: Budget): Draft => ({ daily: toText(b.dailyUsd), monthly: toText(b.monthlyUsd), confirm: toText(b.confirmAboveUsd), enforce: b.enforce });
const sameDraft = (a: Draft, b: Draft) => a.daily === b.daily && a.monthly === b.monthly && a.confirm === b.confirm && a.enforce === b.enforce;

/** '' → null (no limit) when allowed; otherwise a number in 0..1,000,000 or an error message. */
function parseAmount(text: string, emptyMeansNone: boolean): { value: number | null; error: string | null } {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!t) return emptyMeansNone ? { value: null, error: null } : { value: null, error: 'Enter an amount (0 asks every time).' };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { value: null, error: 'Enter an amount of $0 or more.' };
  if (n > BUDGET_MAX_USD) return { value: null, error: 'Use at most $1,000,000.' };
  return { value: n, error: null };
}

const MoneyInput = forwardRef<
  HTMLInputElement,
  { id: string; value: string; onChange: (v: string, badInput: boolean) => void; placeholder: string; invalid: boolean; describedBy: string }
>(
  function MoneyInput({ id, value, onChange, placeholder, invalid, describedBy }, ref) {
    return (
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-xs text-muted-foreground">
          $
        </span>
        <Input
          ref={ref}
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          max={BUDGET_MAX_USD}
          step="0.01"
          value={value}
          placeholder={placeholder}
          // A number input reports '' for text like "5e": flag it instead of reading it as "no limit".
          onChange={(e) => onChange(e.target.value, e.target.validity.badInput)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn('pl-6 tabular-nums', invalid && 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/25')}
        />
      </div>
    );
  },
);

const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long' });

/** Daily/monthly limits GMI Desk enforces locally, the confirmation threshold and progress for today and this month. */
export const BudgetPanel = forwardRef<HTMLInputElement, { status: BudgetStatus | undefined; loading: boolean; highlight: boolean; id?: string }>(
  function BudgetPanel({ status, loading, highlight, id }, firstInputRef) {
    const client = useQueryClient();
    const ids = useId();
    const [draft, setDraft] = useState<Draft | null>(null);
    const [badInput, setBadInput] = useState<Partial<Record<'daily' | 'monthly' | 'confirm', boolean>>>({});
    const base = status ? toDraft(status.budget) : null;
    const current = draft ?? base;
    const dirty = draft !== null && base !== null && (!sameDraft(draft, base) || Object.values(badInput).some(Boolean));

    const withBad = (key: 'daily' | 'monthly' | 'confirm', parsed: ReturnType<typeof parseAmount>) =>
      badInput[key] ? { value: null, error: 'Enter a number, like 5 or 12.50.' } : parsed;
    const daily = withBad('daily', parseAmount(current?.daily ?? '', true));
    const monthly = withBad('monthly', parseAmount(current?.monthly ?? '', true));
    const confirm = withBad('confirm', parseAmount(current?.confirm ?? '', false));
    const invalid = Boolean(daily.error || monthly.error || confirm.error);

    const save = useMutation({
      mutationFn: (patch: Partial<Budget>) => gmi.usage.setBudget(patch),
      onSuccess: (next) => {
        client.setQueryData(qk.budget, next);
        setDraft(null);
        setBadInput({});
        toast.success('Budget saved');
      },
      onError: (error) => {
        // Loosening needs a yes in GMI Desk's own dialog; "Keep current budget" is not an error: show the saved budget again.
        if (errorCode(error) !== 'cancelled') return;
        setDraft(null);
        setBadInput({});
      },
    });
    const saveError = save.error && errorCode(save.error) !== 'cancelled' ? save.error : null;

    const edit = (patch: Partial<Draft>) => {
      if (!current) return;
      save.reset();
      setDraft({ ...current, ...patch });
    };

    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (!dirty || invalid || save.isPending) return;
      save.mutate({ dailyUsd: daily.value, monthlyUsd: monthly.value, confirmAboveUsd: confirm.value ?? 0, enforce: current?.enforce ?? true });
    };

    const enforced = status?.budget.enforce ?? true;

    return (
      <Panel
        id={id}
        title="Budget"
        meta="enforced by GMI Desk"
        actions={
          status ? (
            <Badge variant={enforced ? 'primary' : 'warning'}>
              {enforced ? <ShieldCheck /> : <ShieldOff />}
              {enforced ? 'Blocking' : 'Warn only'}
            </Badge>
          ) : null
        }
        className={cn('transition-shadow duration-200 ease-out', highlight && 'ring-2 ring-ring/50 ring-offset-2 ring-offset-background')}
        bodyClassName="flex flex-col gap-4"
      >
        {loading && !status ? (
          <div aria-hidden className="flex flex-col gap-4">
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {[0, 1].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-2.5 w-14" />
                  <Skeleton className="h-6 w-28" />
                  <Skeleton className="h-1.5" />
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-8" />
                </div>
              ))}
            </div>
            <Skeleton className="h-14" />
          </div>
        ) : status && current ? (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Meter label="Today" spent={status.spentTodayUsd} limit={status.budget.dailyUsd} noLimitLabel="no daily limit" />
              <Meter label={monthFmt.format(new Date(status.updatedAt))} spent={status.spentMonthUsd} limit={status.budget.monthlyUsd} noLimitLabel="no monthly limit" />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  { key: 'daily', label: 'Daily limit', parsed: daily, placeholder: 'No limit', help: 'Empty = no limit' },
                  { key: 'monthly', label: 'Monthly limit', parsed: monthly, placeholder: 'No limit', help: 'Empty = no limit' },
                  { key: 'confirm', label: 'Confirm jobs above', parsed: confirm, placeholder: '0.00', help: '0 = ask every time' },
                ] as const
              ).map((f, i) => (
                <div key={f.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={`${ids}-${f.key}`}>{f.label}</Label>
                  <MoneyInput
                    ref={i === 0 ? firstInputRef : undefined}
                    id={`${ids}-${f.key}`}
                    value={current[f.key]}
                    onChange={(v, bad) => {
                      setBadInput((prev) => ({ ...prev, [f.key]: bad }));
                      edit({ [f.key]: v } as Partial<Draft>);
                    }}
                    placeholder={f.placeholder}
                    invalid={Boolean(f.parsed.error)}
                    describedBy={`${ids}-${f.key}-help`}
                  />
                  <p id={`${ids}-${f.key}-help`} className={cn('text-2xs', f.parsed.error ? 'text-destructive' : 'text-muted-foreground')}>
                    {f.parsed.error ?? f.help}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5 dark:bg-white/[0.02]">
              <div className="min-w-0">
                <Label htmlFor={`${ids}-enforce`}>Block jobs that would go over a limit</Label>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  {current.enforce ? 'Jobs that would exceed a limit are stopped before they start.' : 'Off: GMI Desk warns but lets the job run.'}
                </p>
              </div>
              <Switch id={`${ids}-enforce`} checked={current.enforce} onCheckedChange={(checked) => edit({ enforce: checked })} />
            </div>

            {saveError ? <ErrorNotice error={saveError} compact /> : null}

            <div className="flex items-end justify-between gap-4 border-t border-border pt-3">
              <p className="max-w-md text-2xs text-muted-foreground">
                GMI keeps charging even when your balance is below zero, so GMI Desk enforces these limits for jobs started here.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {dirty ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(null);
                      setBadInput({});
                      save.reset();
                    }}
                    disabled={save.isPending}
                  >
                    Cancel
                  </Button>
                ) : null}
                {/* Lime only once there is something to save (an untouched form keeps an outline button). */}
                <Button type="submit" size="sm" variant={(dirty && !invalid) || save.isPending ? 'default' : 'outline'} disabled={!dirty || invalid || save.isPending}>
                  {save.isPending ? <Spinner className="text-primary-foreground" /> : null}
                  Save limits
                </Button>
              </div>
            </div>
          </form>
        ) : null}
      </Panel>
    );
  },
);
