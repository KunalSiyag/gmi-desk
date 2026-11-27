// The lease editor (§9.3, §9.4): max lifetime and what happens then, idle pause (sandboxes), what happens when a
// budget runs out (an explicit choice, stated in the native create dialog). Used by the wizard and the detail view.
import { useId } from 'react';
import type { ComputeKind, LeaseAction, LeasePolicy } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';
import { Label } from '@renderer/components/ui/input';
import { Select, type SelectOption } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';
import {
  formatMinutes,
  IDLE_PRESETS_MIN,
  LEASE_ACTION_LABEL,
  leaseActionsFor,
  leaseMaxUsd,
  LIFETIME_PRESETS_MIN,
  onBudgetSentence,
} from '../format';
import { Note } from '../parts';

const NO_LIMIT = 'none';
const NEVER = 'never';

function lifetimeOptions(current: number | null): Array<SelectOption> {
  const values: number[] = [...LIFETIME_PRESETS_MIN];
  if (current !== null && !values.includes(current)) values.push(current);
  values.sort((a, b) => a - b);
  return [...values.map((v) => ({ value: String(v), label: formatMinutes(v) })), { value: NO_LIMIT, label: 'No limit' }];
}

function idleOptions(current: number | null): Array<SelectOption> {
  const values: number[] = [...IDLE_PRESETS_MIN];
  if (current !== null && !values.includes(current)) values.push(current);
  values.sort((a, b) => a - b);
  return [...values.map((v) => ({ value: String(v), label: `After ${formatMinutes(v)} idle` })), { value: NEVER, label: 'Never' }];
}

export function LeaseEditor({
  kind,
  value,
  onChange,
  usdPerHour,
  disabled,
}: {
  kind: ComputeKind;
  value: LeasePolicy;
  onChange: (next: LeasePolicy) => void;
  /** List price, for "at most $X" (null: unknown). */
  usdPerHour: number | null;
  disabled?: boolean;
}) {
  const ids = useId();
  const actions = leaseActionsFor(kind);
  const actionOptions = actions.map((a) => ({ value: a, label: LEASE_ACTION_LABEL[a] }));
  const set = (patch: Partial<LeasePolicy>) => onChange({ ...value, ...patch });
  const max = leaseMaxUsd(usdPerHour, value);

  return (
    <div className="flex flex-col gap-4" data-lease-editor={kind}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-life`}>Run for at most</Label>
          <Select
            id={`${ids}-life`}
            value={value.maxLifetimeMin === null ? NO_LIMIT : String(value.maxLifetimeMin)}
            onValueChange={(v) => set({ maxLifetimeMin: v === NO_LIMIT ? null : Number(v) })}
            options={lifetimeOptions(value.maxLifetimeMin)}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-expiry`}>Then</Label>
          <Select
            id={`${ids}-expiry`}
            value={actions.includes(value.onExpiry) ? value.onExpiry : actions[0]!}
            onValueChange={(v) => set({ onExpiry: v as LeaseAction })}
            options={actionOptions}
            disabled={disabled || value.maxLifetimeMin === null}
          />
        </div>
        {kind === 'sandbox' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-idle`}>Pause when idle</Label>
              <Select
                id={`${ids}-idle`}
                value={value.idlePauseMin === null ? NEVER : String(value.idlePauseMin)}
                onValueChange={(v) => set({ idlePauseMin: v === NEVER ? null : Number(v) })}
                options={idleOptions(value.idlePauseMin)}
                disabled={disabled}
              />
            </div>
            <div className="flex items-end gap-2.5 pb-1.5">
              <Switch
                id={`${ids}-extend`}
                checked={value.extendOnActivity}
                onCheckedChange={(on) => set({ extendOnActivity: on })}
                disabled={disabled}
              />
              <Label htmlFor={`${ids}-extend`} className="font-normal text-muted-foreground">
                Extend GMI’s timeout while I use it
              </Label>
            </div>
          </>
        ) : null}
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${ids}-budget`}>If a budget runs out</Label>
          <Select
            id={`${ids}-budget`}
            value={actions.includes(value.onBudget) ? value.onBudget : actions[0]!}
            onValueChange={(v) => set({ onBudget: v as LeaseAction })}
            options={actionOptions}
            disabled={disabled}
            className="sm:max-w-[calc(50%-0.5rem)]"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {value.maxLifetimeMin === null ? (
          <Note tone="warning">
            No automatic limit: this keeps billing{usdPerHour !== null ? ` ${formatUsd(usdPerHour)}/h` : ''} until you{' '}
            {kind === 'sandbox' ? 'pause or delete' : 'delete'} it. GMI Desk asks you to confirm in a system dialog.
          </Note>
        ) : max !== null ? (
          <Note>
            At most {formatUsd(max)} at list price over {formatMinutes(value.maxLifetimeMin)}
            {value.onExpiry === 'delete' ? ', then it is deleted with everything on it.' : value.onExpiry === 'pause' ? ', then it is paused.' : ', then GMI Desk keeps reminding you.'}
          </Note>
        ) : null}
        {kind === 'sandbox' && value.idlePauseMin !== null ? (
          <Note>Idle means no typing, file actions or clicks in a preview. Output and background traffic do not keep it awake.</Note>
        ) : null}
        <Note tone={value.onBudget === 'notify' ? 'warning' : 'info'}>{onBudgetSentence(kind, value.onBudget)}</Note>
      </div>
    </div>
  );
}
