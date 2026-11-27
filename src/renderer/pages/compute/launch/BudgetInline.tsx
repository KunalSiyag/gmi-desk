// "Set a daily budget" inline (§9.3): required before the first container or GPU sandbox. Nothing is pre-filled
// (DECISIONS "Defaults chosen"). Setting a limit where none exists tightens, so main needs no native dialog (D8).
import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { BUDGET_MAX_USD } from '@shared/contracts/usage';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { Button } from '@renderer/components/ui/button';
import { Input, Label } from '@renderer/components/ui/input';
import { Spinner } from '@renderer/components/ui/misc';
import { toastActionError } from '../hooks';
import { Note } from '../parts';

/** '' / junk → error text; otherwise a positive amount up to BUDGET_MAX_USD. */
export function parseDailyBudget(text: string): { value: number | null; error: string | null } {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!t) return { value: null, error: 'Enter an amount.' };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: 'Enter an amount above $0.' };
  if (n > BUDGET_MAX_USD) return { value: null, error: 'Use at most $1,000,000.' };
  return { value: Math.round(n * 100) / 100, error: null };
}

export function BudgetInline({
  primary,
  reason,
  className,
}: {
  /** The lime action of the screen (nothing else can be done until a budget exists). */
  primary: boolean;
  reason: string;
  className?: string;
}) {
  const ids = useId();
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const parsed = parseDailyBudget(text);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.value === null) return;
    setSaving(true);
    try {
      const status = await gmi.usage.setBudget({ dailyUsd: parsed.value });
      client.setQueryData(qk.budget, status);
      await client.invalidateQueries({ queryKey: qk.computeState });
    } catch (error) {
      toastActionError('Could not save the budget', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-budget-inline=""
      className={cn('flex flex-col gap-2.5 rounded-lg border border-warning/30 bg-warning/[0.06] px-4 py-3', className)}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <Wallet aria-hidden className="size-4 text-warning-foreground" /> Set a daily budget first
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-daily`}>Daily budget</Label>
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-xs text-muted-foreground">
              $
            </span>
            <Input
              id={`${ids}-daily`}
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Amount"
              aria-invalid={touched && Boolean(parsed.error)}
              className="w-36 pl-6 tabular-nums"
            />
          </div>
        </div>
        <Button type="submit" variant={primary ? 'default' : 'outline'} disabled={saving}>
          {saving ? <Spinner className="size-3.5 text-current" /> : null} Save daily budget
        </Button>
      </div>
      {touched && parsed.error ? <Note tone="danger">{parsed.error}</Note> : null}
      <Note>Compute spend counts toward it at list price, including what is already running. Change it any time in Usage.</Note>
    </form>
  );
}
