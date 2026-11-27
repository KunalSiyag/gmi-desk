// Alarms (§9.6), the org-wide billing banner (§7.5 step 8) and the API health banner (§6.6). Actions that start,
// stop or take over billing (delete, adopt, release, pause) ask natively in main; a declined dialog is silent.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Building2, CircleAlert, CloudOff, TriangleAlert, X } from 'lucide-react';
import type { ComputeAlarm, ComputeAlarmAction, ComputeApiHealth, ComputeState } from '@shared/contracts/compute';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { Button } from '@renderer/components/ui/button';
import { Spinner } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { ALARM_ACTION_LABEL, orgBillingText, sortAlarms } from './format';
import { toastActionError } from './hooks';
import { PriceTag } from './PriceTag';

/** Collapsed past this many alarms ("Show n more"). */
export const ALARMS_VISIBLE = 3;

function AlarmIcon({ severity }: { severity: ComputeAlarm['severity'] }) {
  if (severity === 'critical') return <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />;
  if (severity === 'warning') return <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />;
  return <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

/** One alarm row: icon, title, body, $/h when it bills, its actions (outline/ghost; never lime). */
export function AlarmRow({
  alarm,
  onAction,
  busy,
}: {
  alarm: ComputeAlarm;
  onAction: (alarm: ComputeAlarm, action: ComputeAlarmAction) => void;
  busy: ComputeAlarmAction | null;
}) {
  const actions = alarm.actions.filter((a) => a !== 'dismiss');
  const dismissible = alarm.actions.includes('dismiss');
  return (
    <li
      data-alarm={alarm.kind}
      data-severity={alarm.severity}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-[13px]',
        alarm.severity === 'critical' && 'bg-destructive/[0.05] dark:bg-destructive/[0.08]',
        alarm.severity === 'warning' && 'bg-warning/[0.06]',
      )}
    >
      <div className="flex min-w-[16rem] flex-1 items-start gap-3">
        <AlarmIcon severity={alarm.severity} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 font-medium leading-snug text-foreground">
            {alarm.title}
            {alarm.usdPerHour !== null ? <PriceTag usdPerHour={alarm.usdPerHour} quiet /> : null}
          </p>
          {alarm.body ? <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{alarm.body}</p> : null}
        </div>
      </div>
      <div className="ml-7 flex shrink-0 items-center gap-1.5 sm:ml-0">
        {actions.map((action) => (
          <Button
            key={action}
            size="xs"
            variant={action === actions[0] || action === 'delete' || action === 'release_eip' ? 'outline' : 'ghost'}
            className={cn((action === 'delete' || action === 'release_eip') && 'text-destructive hover:text-destructive')}
            disabled={busy !== null}
            onClick={() => onAction(alarm, action)}
          >
            {busy === action ? <Spinner className="size-3" /> : null}
            {ALARM_ACTION_LABEL[action]}
            {action === 'open_console' ? <ArrowUpRight className="text-muted-foreground" /> : null}
          </Button>
        ))}
        {dismissible ? (
          <Button variant="ghost" size="icon-xs" aria-label={`Dismiss: ${alarm.title}`} disabled={busy !== null} onClick={() => onAction(alarm, 'dismiss')}>
            <X />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** The alarm stack: most severe first, then newest; collapsed after ALARMS_VISIBLE. */
export function AlarmList({
  alarms,
  onAction,
  busy,
  expanded: expandedProp,
}: {
  alarms: ComputeAlarm[];
  onAction: (alarm: ComputeAlarm, action: ComputeAlarmAction) => void;
  busy: { id: string; action: ComputeAlarmAction } | null;
  expanded?: boolean;
}) {
  const [expandedState, setExpanded] = useState(false);
  const expanded = expandedProp ?? expandedState;
  if (!alarms.length) return null;
  const sorted = sortAlarms(alarms);
  const shown = expanded ? sorted : sorted.slice(0, ALARMS_VISIBLE);
  const hidden = sorted.length - shown.length;
  return (
    <section aria-label="Compute alarms" className="overflow-hidden rounded-lg border border-border bg-card">
      <ul className="divide-y divide-border">
        {shown.map((alarm) => (
          <AlarmRow key={alarm.id} alarm={alarm} onAction={onAction} busy={busy?.id === alarm.id ? busy.action : null} />
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn('w-full border-t border-border px-4 py-2 text-left text-2xs font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground', rowPressMotion)}
        >
          Show {hidden} more {hidden === 1 ? 'alarm' : 'alarms'}
        </button>
      ) : null}
    </section>
  );
}

/** Wires alarm actions to the compute API. `open` / `extend` / … act on `alarm.resourceId`. */
export function useAlarmActions(onOpenResource: (id: string) => void) {
  const client = useQueryClient();
  const openConnect = useUi((s) => s.openConnect);
  const [busy, setBusy] = useState<{ id: string; action: ComputeAlarmAction } | null>(null);

  const run = async (alarm: ComputeAlarm, action: ComputeAlarmAction) => {
    const id = alarm.resourceId;
    if (action === 'connect_key') return openConnect('compute');
    if (action === 'open') return id ? onOpenResource(id) : undefined;
    if (action === 'open_console') {
      try {
        if (id && alarm.kind !== 'eip_unattached') await gmi.compute.openInConsole(id, 'detail');
        else await gmi.app.openConsole('computeHome');
      } catch (error) {
        toastActionError('Could not open GMI Console', error);
      }
      return;
    }
    setBusy({ id: alarm.id, action });
    try {
      if (action === 'dismiss') {
        client.setQueryData<ComputeState>(qk.computeState, await gmi.compute.dismissAlarm(alarm.id));
      } else if (id) {
        if (action === 'extend') await gmi.compute.extend(id, 60);
        else if (action === 'pause') await gmi.compute.pause(id);
        else if (action === 'delete') await gmi.compute.delete(id);
        else if (action === 'adopt') await gmi.compute.adopt(id);
        // eip_unattached carries the EIP's id (only managed EIPs are released; main checks).
        else if (action === 'release_eip') await gmi.compute.releaseEip(id);
        void client.invalidateQueries({ queryKey: ['compute'] });
      }
    } catch (error) {
      toastActionError(ALARM_ACTION_LABEL[action].replace('…', ''), error);
    } finally {
      setBusy(null);
    }
  };
  return { busy, onAction: (alarm: ComputeAlarm, action: ComputeAlarmAction) => void run(alarm, action) };
}

/** "2 containers · 1 EIP are billing in your organization ($27.40/h list)": counts and $/h only, never names. */
export function OrgBillingBanner({ org, onOpenConsole }: { org: ComputeState['org']; onOpenConsole: () => void }) {
  const text = orgBillingText(org);
  if (!text) return null;
  return (
    <div data-banner="org" className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
      <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">{text}.</span> GMI has no spend API, so this counts everything your key can see, including resources
        created outside GMI Desk.
      </p>
      <Button variant="ghost" size="xs" onClick={onOpenConsole}>
        Open in console <ArrowUpRight className="text-muted-foreground" />
      </Button>
    </div>
  );
}

const HEALTH_RANK: Record<ComputeApiHealth, number> = { ok: 0, unknown: 0, degraded: 1, down: 2 };

/** GMI's compute APIs failing (§6.6): degraded = quiet note, down = banner. Nothing while healthy or unknown. */
export function ApiHealthBanner({ health }: { health: ComputeState['apiHealth'] | undefined }) {
  if (!health) return null;
  const worst = HEALTH_RANK[health.ce] >= HEALTH_RANK[health.sandbox] ? health.ce : health.sandbox;
  if (worst !== 'degraded' && worst !== 'down') return null;
  const which = health.ce === worst && health.sandbox === worst ? 'GMI’s compute APIs are' : health.ce === worst ? 'GMI’s container API is' : 'GMI’s sandbox API is';
  return (
    <div
      role="status"
      data-banner="api"
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-2.5 text-xs',
        worst === 'down' ? 'border-destructive/25 bg-destructive/[0.05] dark:bg-destructive/[0.08]' : 'border-border bg-card',
      )}
    >
      <CloudOff aria-hidden className={cn('size-4 shrink-0', worst === 'down' ? 'text-destructive' : 'text-warning-foreground')} />
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">{worst === 'down' ? `${which} not answering.` : `${which} answering slowly.`}</span> Showing the last known
        state; costs keep being estimated, and GMI Desk keeps retrying.
      </p>
    </div>
  );
}
