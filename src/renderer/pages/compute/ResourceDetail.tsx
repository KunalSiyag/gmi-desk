// One resource (§15): header (name, phase, Open computer = the lime action, Delete), Overview, Lease editor, Network
// (containers), Logs (containers), History. Everything that starts, extends or stops billing asks natively in main.
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowUpRight,
  Camera,
  Clock,
  Download,
  EllipsisVertical,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
  Trash2,
  UserPlus,
} from 'lucide-react';
import type { ComputeCatalog, ComputeResource, ComputeResourceDetail, LeasePolicy } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { useUi } from '@renderer/lib/store';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input, Label } from '@renderer/components/ui/input';
import { DropdownMenu, type MenuItemSpec } from '@renderer/components/ui/menu';
import { EmptyState, microLabel, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { pressMotion } from '@renderer/components/ui/motion';
import { Switch } from '@renderer/components/ui/switch';
import {
  actionPendingText,
  checkCidr,
  cidrWarning,
  formatAgo,
  formatDateTime,
  idcName,
  sizeFact,
  KIND_LABEL,
  leaseChangeNotice,
  nextEvent,
  PENDING_ACTION_LABEL,
  PHASE_VIEW,
  sameLease,
} from './format';
import { isCancelled, toastActionError, useResourceAction } from './hooks';
import { LeaseEditor } from './launch/LeaseEditor';
import { Facts, KIND_ICON, Note, Panel, PhaseBadge, SectionHeading } from './parts';
import { PriceTag } from './PriceTag';

/** Another install's `gmid-` container (§7.5 step 4): can be adopted after a native confirmation. */
export function isOtherInstall(r: Pick<ComputeResource, 'managed' | 'name'>): boolean {
  return !r.managed && r.name.startsWith('gmid-');
}

/** What the header can do for this resource right now. */
export function resourceAbilities(r: ComputeResource, canManage: boolean) {
  const live = r.phase !== 'deleted' && r.phase !== 'deleting';
  const manage = canManage && r.managed && live && r.pendingAction === null;
  return {
    openComputer: canManage && r.managed && r.phase === 'running' && (r.capabilities.terminal || r.capabilities.files || r.capabilities.logs),
    pause: manage && r.capabilities.pause && r.phase === 'running',
    // Capabilities describe what the phase allows now; a paused sandbox can always be resumed.
    resume: manage && r.kind === 'sandbox' && r.phase === 'paused',
    restart: manage && r.capabilities.restart && r.phase === 'running',
    extend: manage && r.capabilities.extend && (r.phase === 'running' || r.phase === 'creating'),
    snapshot: manage && r.capabilities.snapshot && r.phase === 'running',
    // The console refuses deleting while creating or terminating (§6.4).
    delete: canManage && r.managed && live && r.phase !== 'creating' && r.pendingAction !== 'delete',
    adopt: canManage && isOtherInstall(r) && live,
  };
}

function openComputer(id: string) {
  useUi.getState().setDock('compute', { open: true, resourceId: id });
}

export function ResourceHeader({
  resource: r,
  canManage,
  now,
  onBack,
  onPause,
  onResume,
  onRestart,
  onExtend,
  onSnapshot,
  onDelete,
  onAdopt,
  busy,
}: {
  resource: ComputeResource;
  canManage: boolean;
  now: number;
  onBack: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onExtend: (minutes: number) => void;
  onSnapshot: () => void;
  onDelete: () => void;
  onAdopt: () => void;
  busy: boolean;
}) {
  const can = resourceAbilities(r, canManage);
  const Icon = KIND_ICON[r.kind];
  const next = nextEvent(r, now);
  const retry = actionPendingText(r.actionPending);
  const menu: Array<MenuItemSpec | 'separator'> = [];
  if (can.extend) {
    menu.push({ label: 'Extend 30 min', icon: <Clock />, onSelect: () => onExtend(30) });
    menu.push({ label: 'Extend 1 h', icon: <Clock />, onSelect: () => onExtend(60) });
    menu.push({ label: 'Extend 4 h', icon: <Clock />, onSelect: () => onExtend(240) });
  }
  if (can.pause) menu.push({ label: 'Pause', icon: <Pause />, onSelect: onPause });
  if (can.restart) menu.push({ label: 'Restart…', icon: <RotateCcw />, onSelect: onRestart });
  if (can.snapshot) menu.push({ label: 'Take snapshot…', icon: <Camera />, onSelect: onSnapshot });
  if (r.remoteId && r.kind === 'container') {
    if (menu.length) menu.push('separator');
    menu.push({ label: 'Open in GMI Console', icon: <ArrowUpRight />, onSelect: () => void gmi.compute.openInConsole(r.id, 'detail').catch((e) => toastActionError('Could not open GMI Console', e)) });
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={onBack} className={cn('-ml-1 flex w-fit items-center gap-1 rounded px-1 text-2xs font-medium text-muted-foreground hover:text-foreground', pressMotion)}>
        <ArrowLeft className="size-3" /> All resources
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
            <Icon aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span className="truncate" title={r.displayName}>
                {r.displayName}
              </span>
              <PhaseBadge phase={r.phase} pending={r.pendingAction ? PENDING_ACTION_LABEL[r.pendingAction] : null} />
              {!r.managed ? <Badge variant="outline">Unmanaged</Badge> : null}
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
              <span className="font-mono">{r.name}</span>
              <span>·</span>
              <PriceTag usdPerHour={r.listUsdPerHour} quiet />
              {next ? (
                <>
                  <span>·</span>
                  <span className={cn('tabular-nums', next.soon && 'font-medium text-warning-foreground')}>{next.label}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {can.adopt ? (
            <Button variant="outline" size="sm" onClick={onAdopt} disabled={busy}>
              <UserPlus /> Adopt…
            </Button>
          ) : null}
          {can.delete ? (
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} className="text-destructive hover:text-destructive">
              <Trash2 /> Delete…
            </Button>
          ) : null}
          {menu.length ? (
            <DropdownMenu
              items={menu}
              trigger={
                <Button variant="outline" size="icon-sm" aria-label="More actions" disabled={busy}>
                  <EllipsisVertical />
                </Button>
              }
            />
          ) : null}
          {can.resume ? (
            <Button size="sm" onClick={onResume} disabled={busy}>
              {busy ? <Spinner className="size-3.5 text-current" /> : <Play />} Resume…
            </Button>
          ) : can.openComputer ? (
            <Button size="sm" onClick={() => openComputer(r.id)}>
              <SquareTerminal /> Open computer
            </Button>
          ) : null}
        </div>
      </div>
      {retry ? (
        <Note tone="warning">
          {retry}. GMI Desk retries on every check{r.actionPending?.lastError ? `: ${r.actionPending.lastError}` : ''}. It keeps billing until this succeeds.
        </Note>
      ) : null}
      {r.reason ? <Note tone={r.phase === 'failed' ? 'danger' : 'info'}>{r.reason}</Note> : null}
      {!r.managed ? (
        <Note>
          {isOtherInstall(r)
            ? 'Created by another GMI Desk (a reinstall, a lost profile, or a colleague’s). Read-only until you adopt it.'
            : 'Created outside GMI Desk. Read-only: manage it in GMI Console.'}
        </Note>
      ) : null}
    </div>
  );
}

function Overview({ r, catalog, now }: { r: ComputeResourceDetail; catalog: ComputeCatalog | undefined; now: number }) {
  return (
    <Panel className="px-4 py-4">
      <div className="mb-4 grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-1">
          <span className={microLabel}>Rate</span>
          <PriceTag usdPerHour={r.listUsdPerHour} className="text-sm font-medium" />
        </div>
        <div className="flex flex-col gap-1">
          <span className={microLabel}>So far</span>
          <span className="font-mono text-sm font-medium tabular-nums">{formatUsd(r.accruedUsd)}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className={microLabel}>Today</span>
          <span className="font-mono text-sm font-medium tabular-nums">{formatUsd(r.accruedTodayUsd)}</span>
        </div>
      </div>
      <Facts
        rows={[
          { label: 'Kind', value: KIND_LABEL[r.kind], hint: r.purpose === 'agent' ? 'agent sandbox' : undefined },
          { label: 'Where', value: idcName(catalog, r.idc), hint: r.idc ?? undefined },
          sizeFact(catalog, r.sku),
          { label: 'Template', value: r.templateName ?? (r.snapshotId ? 'Snapshot' : '—') },
          { label: 'Created', value: formatDateTime(r.createdAt) ?? '—', hint: formatAgo(r.createdAt, now) ?? undefined },
          r.runningSince ? { label: 'Running since', value: formatDateTime(r.runningSince) ?? '—' } : null,
          r.leaseEndsAt ? { label: 'Lease ends', value: formatDateTime(r.leaseEndsAt) ?? '—' } : null,
          r.kind === 'sandbox' && r.serverEndsAt ? { label: 'GMI timeout', value: formatDateTime(r.serverEndsAt) ?? '—' } : null,
          r.kind === 'sandbox' && r.idlePauseAt ? { label: 'Idle pause', value: formatDateTime(r.idlePauseAt) ?? '—' } : null,
          r.pausedExpiresAt ? { label: 'Deleted by GMI', value: formatDateTime(r.pausedExpiresAt) ?? '—', hint: 'after 7 days paused' } : null,
          r.kind === 'sandbox' ? { label: 'Outbound', value: r.egressLocked ? 'Only listed hosts' : 'Open' } : null,
          r.envNames.length ? { label: 'Environment', value: <span className="font-mono text-xs">{r.envNames.join(', ')}</span>, hint: 'names only' } : null,
          r.command ? { label: 'Command', value: <span className="font-mono text-xs">{[r.command, ...r.args].join(' ')}</span> } : null,
        ]}
      />
      <p className="mt-4 text-2xs text-muted-foreground">Estimated at list price by GMI Desk. Your organization may pay less.</p>
    </Panel>
  );
}

function LeasePanel({ r, canManage, now }: { r: ComputeResourceDetail; canManage: boolean; now: number }) {
  const [draft, setDraft] = useState<LeasePolicy | null>(null);
  const save = useResourceAction('Could not change the lease', (patch: Partial<LeasePolicy>) => gmi.compute.setLease(r.id, patch));
  if (!r.lease) return null;
  const value = draft ?? r.lease;
  const dirty = draft !== null && !sameLease(draft, r.lease);
  const ranMin = r.runningSince ? (now - Date.parse(r.runningSince)) / 60_000 : null;
  const notice = dirty ? leaseChangeNotice(r.lease, value, ranMin) : null;
  return (
    <section aria-labelledby={`lease-${r.id}`} className="flex flex-col gap-3">
      <SectionHeading id={`lease-${r.id}`} title="Lease" />
      <Panel className="flex flex-col gap-4 px-4 py-4">
        <LeaseEditor kind={r.kind} value={value} onChange={setDraft} usdPerHour={r.listUsdPerHour} disabled={!canManage || !r.managed || save.isPending} />
        {dirty ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() =>
                save.mutate([value], {
                  onSuccess: () => setDraft(null),
                })
              }
            >
              {save.isPending ? <Spinner className="size-3.5" /> : null} Save lease
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={save.isPending}>
              Cancel
            </Button>
            {notice ? <Note className="basis-full">{notice}</Note> : null}
          </div>
        ) : null}
      </Panel>
    </section>
  );
}

/** Containers: public IP, EIP, firewalls, ports (§6.3), with "Update firewall to my IP". */
export function NetworkPanel({ r, canManage }: { r: ComputeResourceDetail; canManage: boolean }) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [cidr, setCidr] = useState('');
  const [confirming, setConfirming] = useState(false);
  const update = useResourceAction('Could not update the firewall', (value: string) => gmi.compute.updateFirewallCidr(r.id, value));
  const net = r.network;
  if (!net) return null;
  const check = checkCidr(cidr);
  const warning = cidrWarning(check);
  const managedFw = net.firewalls.some((f) => f.managed);
  const submit = () => {
    if (!check.cidr) return;
    // A /32 replacing a /32 needs only this confirmation; anything broader is "open" and main asks natively (§6.3).
    if (!check.open) setConfirming(true);
    else update.mutate([check.cidr], { onSuccess: () => setEditing(false) });
  };
  return (
    <section aria-labelledby={`net-${r.id}`} className="flex flex-col gap-3">
      <SectionHeading id={`net-${r.id}`} title="Network" />
      <Panel className="flex flex-col gap-4 px-4 py-4">
        {net.degraded ? <Note tone="danger">Part of the public access setup failed. Release the public IP from the alarm above, or delete the container.</Note> : null}
        <Facts
          rows={[
            { label: 'Public IP', value: net.publicIp ? <span className="font-mono text-xs">{net.publicIp}</span> : 'None' },
            net.eip
              ? {
                  label: 'Elastic IP',
                  value: <span className="font-mono text-xs">{net.eip.address ?? net.eip.id}</span>,
                  hint: `${net.eip.status}${net.eip.managed ? ' · created by GMI Desk' : ''}`,
                }
              : null,
            {
              label: 'Ports',
              value: net.ports.length ? (
                <span className="font-mono text-xs">{net.ports.map((p) => `${p.containerPort}${p.nodePort ? `→${p.nodePort}` : ''}/${p.protocol}`).join('  ')}</span>
              ) : (
                'None'
              ),
            },
          ]}
        />
        {net.firewalls.length ? (
          <ul className="flex flex-col gap-2">
            {net.firewalls.map((fw) => (
              <li key={fw.id} className="rounded-md border border-border px-3 py-2">
                <p className="flex items-center gap-2 text-xs font-medium">
                  {fw.name}
                  {fw.preset ? <Badge variant="outline">Preset</Badge> : null}
                  {fw.managed ? <Badge variant="outline">GMI Desk</Badge> : null}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 font-mono text-3xs text-muted-foreground">
                  {fw.rules.map((rule, i) => {
                    const open = rule.cidr === '0.0.0.0/0';
                    return (
                      <li key={i} className={cn(open && 'text-warning-foreground')}>
                        {rule.protocol.toUpperCase()} {rule.fromPort ?? '*'}
                        {rule.toPort && rule.toPort !== rule.fromPort ? `–${rule.toPort}` : ''} from {rule.cidr}
                        {open ? ' (All Open)' : ''}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}
        {managedFw && canManage && r.managed ? (
          editing ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-cidr`}>Allow connections from</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input id={`${ids}-cidr`} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="203.0.113.7" className="w-56 font-mono text-xs" spellCheck={false} />
                <Button variant="outline" size="sm" disabled={!check.cidr || update.isPending} onClick={submit}>
                  {update.isPending ? <Spinner className="size-3.5" /> : null} Update firewall
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
              {cidr.trim() && check.error ? <Note tone="danger">{check.error}</Note> : null}
              {warning ? <Note tone={check.allOpen ? 'danger' : 'warning'}>{warning}</Note> : null}
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-fit" onClick={() => setEditing(true)}>
              <RefreshCw /> Update firewall to my current IP
            </Button>
          )
        ) : null}
      </Panel>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replace the allowed address?"
        description={`Only ${check.cidr ?? ''} can connect afterwards. Connections from the old address stop working.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                if (check.cidr) update.mutate([check.cidr], { onSuccess: () => setEditing(false) });
              }}
            >
              Replace
            </Button>
          </>
        }
      />
    </section>
  );
}

/** Containers: the log tail on demand (§6.4); "Save full log…" streams to disk through a native dialog. */
function LogsPanel({ r }: { r: ComputeResourceDetail }) {
  const [enabled, setEnabled] = useState(false);
  const logs = useQuery({
    queryKey: ['compute', 'logs', r.id],
    queryFn: () => gmi.compute.getLogs(r.id, { tailBytes: 256 * 1024 }),
    enabled,
    staleTime: 0,
    retry: false,
    // §6.4: every 10 s while shown; a truncated (large) log is refreshed by hand only.
    refetchInterval: (query) => (query.state.data?.truncated ? false : 10_000),
    refetchIntervalInBackground: false,
  });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await gmi.compute.saveLogs(r.id);
    } catch (error) {
      toastActionError('Could not save the log', error);
    } finally {
      setSaving(false);
    }
  };
  if (!r.capabilities.logs) return null;
  return (
    <section aria-labelledby={`logs-${r.id}`} className="flex flex-col gap-3">
      <SectionHeading
        id={`logs-${r.id}`}
        title="Logs"
        meta={logs.data ? `${logs.data.truncated ? 'last part · ' : ''}fetched ${formatAgo(logs.data.fetchedAt, Date.now())}` : null}
        action={
          <>
            <Button variant="ghost" size="xs" onClick={() => (enabled ? void logs.refetch() : setEnabled(true))} disabled={logs.isFetching}>
              {logs.isFetching ? <Spinner className="size-3" /> : <RefreshCw />} {enabled ? 'Refresh' : 'Load logs'}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner className="size-3" /> : <Download />} Save full log…
            </Button>
          </>
        }
      />
      {logs.error ? (
        <ErrorNotice error={logs.error} compact onRetry={() => void logs.refetch()} />
      ) : logs.data ? (
        <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-card px-3 py-2 font-mono text-3xs leading-relaxed whitespace-pre-wrap break-all">
          {logs.data.text || 'The log is empty.'}
        </pre>
      ) : null}
    </section>
  );
}

function History({ r, now }: { r: ComputeResourceDetail; now: number }) {
  if (!r.history.length) return null;
  return (
    <section aria-labelledby={`hist-${r.id}`} className="flex flex-col gap-3">
      <SectionHeading id={`hist-${r.id}`} title="History" />
      <ol className="flex flex-col gap-1.5 text-xs">
        {r.history.slice(0, 12).map((h, i) => (
          <li key={`${h.at}-${i}`} className="flex items-baseline gap-3">
            <span className="w-24 shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">{formatAgo(h.at, now)}</span>
            <span className="font-medium">{PHASE_VIEW[h.phase].label}</span>
            {h.note ? <span className="min-w-0 truncate text-muted-foreground">{h.note}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Delete: a renderer step only when there is a choice (release the app's IP and firewall); main then asks natively. */
export function DeleteDialog({
  r,
  open,
  onOpenChange,
  onConfirm,
}: {
  r: ComputeResource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (opts: { releaseEip?: boolean; deleteFirewall?: boolean }) => void;
}) {
  const ids = useId();
  const managedEip = r.network?.eip?.managed ? r.network.eip : null;
  const managedFw = r.network?.firewalls.some((f) => f.managed) ?? false;
  const [releaseEip, setReleaseEip] = useState(true);
  const [deleteFirewall, setDeleteFirewall] = useState(true);
  useEffect(() => {
    if (open) {
      setReleaseEip(true);
      setDeleteFirewall(true);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${r.displayName}?`}
      description={
        r.kind === 'container'
          ? 'The container and everything on it are gone for good. Billing stops once GMI confirms.'
          : 'The sandbox and its files are gone for good. Snapshots you took are kept.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(r.kind === 'container' ? { releaseEip: Boolean(managedEip) && releaseEip, deleteFirewall: managedFw && deleteFirewall } : {})}
          >
            <Trash2 /> Delete…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {managedEip ? (
          <div className="flex items-start gap-2.5">
            <Switch id={`${ids}-eip`} checked={releaseEip} onCheckedChange={setReleaseEip} />
            <Label htmlFor={`${ids}-eip`} className="font-normal leading-relaxed">
              Also release its public IP{managedEip.address ? ` (${managedEip.address})` : ''}. A kept IP bills by the hour until released.
            </Label>
          </div>
        ) : null}
        {managedFw ? (
          <div className="flex items-start gap-2.5">
            <Switch id={`${ids}-fw`} checked={deleteFirewall} onCheckedChange={setDeleteFirewall} />
            <Label htmlFor={`${ids}-fw`} className="font-normal leading-relaxed">
              Also delete the firewall GMI Desk created for it (only when nothing else uses it).
            </Label>
          </div>
        ) : null}
        <Note>A system dialog asks you to confirm next.</Note>
      </div>
    </Dialog>
  );
}

/** Snapshot (§7.3): name, the scrub step (on by default), "storage price unknown". */
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
        <Note>Snapshot storage price: unknown. GMI has not published it yet.</Note>
      </div>
    </Dialog>
  );
}

export function ResourceDetail({
  id,
  detail,
  loading,
  error,
  onRetry,
  catalog,
  canManage,
  now,
  onBack,
}: {
  id: string;
  detail: ComputeResourceDetail | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  catalog: ComputeCatalog | undefined;
  canManage: boolean;
  now: number;
  onBack: () => void;
}) {
  const [dialog, setDialog] = useState<'delete' | 'restart' | 'snapshot' | null>(null);
  const pause = useResourceAction('Could not pause', () => gmi.compute.pause(id));
  const resume = useResourceAction('Could not resume', () => gmi.compute.resume(id));
  const restart = useResourceAction('Could not restart', () => gmi.compute.restart(id));
  const extend = useResourceAction('Could not extend', (minutes: number) => gmi.compute.extend(id, minutes));
  const remove = useResourceAction('Could not delete', (opts: { releaseEip?: boolean; deleteFirewall?: boolean }) => gmi.compute.delete(id, opts));
  const adopt = useResourceAction('Could not adopt', () => gmi.compute.adopt(id));
  const busy = [pause, resume, restart, extend, remove, adopt].some((m) => m.isPending);

  if (error && !detail)
    return (
      <div className="flex flex-col gap-3">
        <button type="button" onClick={onBack} className={cn('-ml-1 flex w-fit items-center gap-1 rounded px-1 text-2xs font-medium text-muted-foreground hover:text-foreground', pressMotion)}>
          <ArrowLeft className="size-3" /> All resources
        </button>
        <ErrorNotice error={error} onRetry={isCancelled(error) ? undefined : onRetry} />
      </div>
    );
  if (loading || !detail)
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-12" />
        <Skeleton className="h-48" />
      </div>
    );
  const r = detail;
  return (
    <div className="flex flex-col gap-6" data-resource-detail={r.id}>
      <ResourceHeader
        resource={r}
        canManage={canManage}
        now={now}
        busy={busy}
        onBack={onBack}
        onPause={() => pause.mutate([])}
        onResume={() => resume.mutate([])}
        onRestart={() => setDialog('restart')}
        onExtend={(m) => extend.mutate([m])}
        onSnapshot={() => setDialog('snapshot')}
        onDelete={() => setDialog('delete')}
        onAdopt={() => adopt.mutate([])}
      />
      {r.phase === 'deleted' ? (
        <EmptyState dino="sleep" title="Deleted" description="It no longer bills. GMI Desk keeps this record for its cost history." className="rounded-lg border border-border" />
      ) : null}
      {r.lastError ? <ErrorNotice error={r.lastError} compact /> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Overview r={r} catalog={catalog} now={now} />
          <History r={r} now={now} />
        </div>
        <div className="flex flex-col gap-6">
          <LeasePanel r={r} canManage={canManage} now={now} />
          {r.kind === 'container' ? <NetworkPanel r={r} canManage={canManage} /> : null}
          {r.kind === 'container' ? <LogsPanel r={r} /> : null}
        </div>
      </div>
      <DeleteDialog
        r={r}
        open={dialog === 'delete'}
        onOpenChange={(open) => setDialog(open ? 'delete' : null)}
        onConfirm={(opts) => {
          setDialog(null);
          remove.mutate([opts]);
        }}
      />
      <Dialog
        open={dialog === 'restart'}
        onOpenChange={(open) => setDialog(open ? 'restart' : null)}
        title={`Restart ${r.displayName}?`}
        description="Files outside mounted storage may be lost. Billing does not change."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                restart.mutate([]);
              }}
            >
              <RotateCcw /> Restart
            </Button>
          </>
        }
      />
      <SnapshotDialog r={r} open={dialog === 'snapshot'} onOpenChange={(open) => setDialog(open ? 'snapshot' : null)} />
    </div>
  );
}
