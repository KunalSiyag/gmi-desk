// The Compute page (compute.md §15): tabs Resources · Launch · Network · Snapshots, alarms and the org-wide billing
// banner, signed-out browsing. URL params: tab, resource, step, idc (+ kind and snapshot for the wizard's deep links).
// Registered by pages/registry.compute.ts (default export).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Box, KeyRound, RefreshCw, Rocket, Server, SquareTerminal } from 'lucide-react';
import type { ComputeAlarm, ComputeKind, ComputeResource, ComputeState } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { useAuth, useBudget, useComputeEvents } from '@renderer/lib/hooks';
import { useCommandRegistry, useUi } from '@renderer/lib/store';
import { DinoLoader } from '@renderer/components/brand/Dino';
import { AccessChips } from '@renderer/components/connect/compute-parts';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { PageBody, PageHeader } from '@renderer/components/PageHeader';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, microLabel } from '@renderer/components/ui/misc';
import { TabStrip } from '@renderer/components/ui/tabs';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { AlarmList, ApiHealthBanner, OrgBillingBanner, useAlarmActions } from './AlarmBanner';
import { CatalogBrowse, ConnectComputeHero } from './CatalogBrowse';
import { formatPerHour, type ComputeKeyView } from './format';
import {
  computeKeyView,
  useStoreNow,
  useComputeCatalog,
  useComputeNetwork,
  useComputeResource,
  useComputeResources,
  useComputeSnapshots,
  useComputeState,
  useNow,
} from './hooks';
import { BudgetInline } from './launch/BudgetInline';
import { LaunchWizard } from './launch/LaunchWizard';
import { isLaunchStep, type LaunchStep } from './launch/state';
import { NetworkTab } from './NetworkTab';
import { Note } from './parts';
import { ResourceDetail } from './ResourceDetail';
import { ResourceList } from './ResourceList';
import { SnapshotsTab } from './SnapshotsTab';

export const COMPUTE_TABS = ['resources', 'launch', 'network', 'snapshots'] as const;
export type ComputeTab = (typeof COMPUTE_TABS)[number];

export function tabFromParams(params: Record<string, string>): ComputeTab {
  const tab = params.tab;
  if ((COMPUTE_TABS as readonly string[]).includes(tab ?? '')) return tab as ComputeTab;
  return params.step || params.snapshot ? 'launch' : 'resources';
}

/** "Running 2 · Burn $3.44/h · Today $1.20 · This month $8.10 · Budget left today $20.80" (compute at list price, estimated). */
export function SpendStrip({
  state,
  budgetLeftTodayUsd,
  unpricedBilling = 0,
}: {
  state: ComputeState;
  budgetLeftTodayUsd: number | null;
  /** Managed resources billing with an unknown price: the burn is then a lower bound, never a plain "$0.00/h". */
  unpricedBilling?: number;
}) {
  const burn =
    unpricedBilling > 0
      ? state.running.usdPerHour > 0
        ? `≥ ${formatPerHour(state.running.usdPerHour)}`
        : 'price unknown'
      : formatPerHour(state.running.usdPerHour);
  const items: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: 'Running', value: `${state.running.count}` },
    { label: 'Burn', value: burn, warn: unpricedBilling > 0 },
    { label: 'Today', value: formatUsd(state.todayUsd) },
    { label: 'This month', value: formatUsd(state.monthUsd) },
  ];
  if (budgetLeftTodayUsd !== null)
    items.push({ label: 'Budget left today', value: formatUsd(budgetLeftTodayUsd), warn: budgetLeftTodayUsd <= state.running.usdPerHour * 0.25 });
  return (
    <dl data-spend-strip="" className="flex flex-wrap items-center gap-x-5 gap-y-1">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt className={microLabel}>{item.label}</dt>
          <dd className={cn('font-mono text-xs tabular-nums', item.warn ? 'font-medium text-warning-foreground' : 'text-foreground')}>{item.value}</dd>
        </div>
      ))}
      <span className="text-3xs text-muted-foreground">compute at list price, estimated</span>
    </dl>
  );
}

/** Managed resources that bill now (CE: every phase until deleted; sandboxes: not paused / failed) with no known price. */
export function unpricedBilling(resources: readonly ComputeResource[] | undefined): number {
  return (resources ?? []).filter(
    (r) => r.managed && r.listUsdPerHour === null && r.phase !== 'deleted' && (r.kind === 'container' || (r.phase !== 'paused' && r.phase !== 'failed')),
  ).length;
}

/**
 * Which alarms a view shows: all of them on the resource list, the resource's own on its page, critical ones elsewhere
 * (the nav badge counts them all).
 */
export function visibleAlarms(alarms: ComputeAlarm[], tab: ComputeTab, resourceId: string | null): ComputeAlarm[] {
  if (resourceId) return alarms.filter((a) => a.resourceId === resourceId || a.severity === 'critical');
  if (tab === 'resources') return alarms;
  return alarms.filter((a) => a.severity === 'critical');
}

function NeedsKey({ what }: { what: string }) {
  const openConnect = useUi((s) => s.openConnect);
  return (
    <EmptyState
      dino="sleep"
      title={`${what} need a Compute key`}
      description="GMI Desk reads them from your organization with the key. Nothing is created or billed by connecting."
      action={
        <Button onClick={() => openConnect('compute')}>
          <KeyRound /> Connect Compute
        </Button>
      }
      className="rounded-lg border border-border"
    />
  );
}

export default function ComputePage() {
  useComputeEvents();
  const client = useQueryClient();
  const params = useStoreNow(useUi, (s) => s.params);
  const setParams = useUi((s) => s.setParams);
  const openConnect = useUi((s) => s.openConnect);
  const now = useNow(30_000);

  const auth = useAuth();
  const state = useComputeState();
  const budget = useBudget();
  const keyView: ComputeKeyView = computeKeyView(auth.data, state.data);
  const canManage = keyView === 'ready';

  const tab = tabFromParams(params);
  const resourceId = tab === 'resources' ? (params.resource ?? null) : null;
  const step: LaunchStep = isLaunchStep(params.step) ? params.step : 'template';
  const kindParam: ComputeKind | null = params.kind === 'container' || params.kind === 'sandbox' ? params.kind : null;

  const [includeUnmanaged, setIncludeUnmanaged] = useState(false);
  const catalog = useComputeCatalog(null);
  const resources = useComputeResources(includeUnmanaged, keyView !== 'none' && keyView !== 'loading');
  const detail = useComputeResource(resourceId);
  const snapshots = useComputeSnapshots(canManage && (tab === 'snapshots' || tab === 'launch'));
  const network = useComputeNetwork(canManage && tab === 'network');

  const go = (next: Record<string, string>) => setParams(next);
  const openResource = (id: string) => go({ tab: 'resources', resource: id });
  const launch = (kind?: ComputeKind, extra: Record<string, string> = {}) => go({ tab: 'launch', step: 'template', ...(kind ? { kind } : {}), ...extra });
  const alarms = useAlarmActions(openResource);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      if (canManage) await gmi.compute.refresh();
      await client.invalidateQueries({ queryKey: ['compute'] });
    } catch {
      // the queries show their own errors
    } finally {
      setRefreshing(false);
    }
  };

  // Palette entries while the page is open (§15).
  const ref = useRef({ launch, refresh, openResource, state: state.data, resources: resources.data });
  ref.current = { launch, refresh, openResource, state: state.data, resources: resources.data };
  useEffect(
    () =>
      useCommandRegistry.getState().register('compute', [
        { id: 'compute.new-sandbox', label: 'New sandbox', group: 'Compute', icon: <Box />, keywords: ['agentbox', 'launch'], run: () => ref.current.launch('sandbox') },
        { id: 'compute.new-container', label: 'New container', group: 'Compute', icon: <Server />, keywords: ['gpu', 'cluster engine', 'launch'], run: () => ref.current.launch('container') },
        {
          id: 'compute.open-computer',
          label: 'Open computer…',
          group: 'Compute',
          icon: <SquareTerminal />,
          keywords: ['terminal', 'shell'],
          run: () => {
            const running = ref.current.resources?.find((r) => r.managed && r.phase === 'running');
            if (running) useUi.getState().setDock('compute', { open: true, resourceId: running.id });
            else useUi.getState().setParams({ tab: 'resources' });
          },
        },
        { id: 'compute.alarms', label: 'Compute: show alarms', group: 'Compute', icon: <Bell />, run: () => useUi.getState().setParams({ tab: 'resources' }) },
        { id: 'compute.refresh', label: 'Compute: refresh', group: 'Compute', icon: <RefreshCw />, run: () => void ref.current.refresh() },
        { id: 'compute.connect', label: 'Connect Compute', group: 'Compute', icon: <KeyRound />, keywords: ['key', 'api key'], run: () => openConnect('compute') },
      ]),
    [openConnect],
  );

  if (keyView === 'loading')
    return (
      <PageBody className="h-full">
        <DinoLoader label="Loading compute" className="flex-1 pb-16" />
      </PageBody>
    );

  const s = state.data;
  const dailyBudgetSet = s?.dailyBudgetSet ?? (budget.data ? budget.data.budget.dailyUsd !== null : true);
  const showBrowse = keyView !== 'ready' && tab === 'resources' && !resourceId;

  return (
    <>
      <TopBarActions>
        <TabStrip
          value={tab}
          onValueChange={(t) => go({ tab: t })}
          items={[
            { value: 'resources', label: 'Resources', count: s && canManage ? s.running.count : undefined },
            { value: 'launch', label: 'Launch' },
            { value: 'network', label: 'Network' },
            { value: 'snapshots', label: 'Snapshots' },
          ]}
        />
        <Tooltip label="Refresh" side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh compute" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </Tooltip>
        {tab !== 'launch' && canManage ? (
          // Lime only on the list with rows (an empty list's own "Launch a computer" is the lime action there).
          <Button variant={tab === 'resources' && !resourceId && resources.data?.length ? 'default' : 'outline'} size="sm" onClick={() => launch()}>
            <Rocket /> Launch
          </Button>
        ) : null}
      </TopBarActions>

      <PageBody className="gap-6">
        <PageHeader
          title="Compute"
          description="GPU containers and Agentbox sandboxes on GMI Cloud, with their cost in view. GMI Desk asks before anything bills."
          actions={s && canManage ? <AccessChips access={s.access} /> : null}
        />

        {s && canManage ? <SpendStrip state={s} budgetLeftTodayUsd={budget.data?.remainingTodayUsd ?? null} unpricedBilling={unpricedBilling(resources.data)} /> : null}

        {/* No key, an invalid one or a locked keychain: one hero with the fix (the wizard's review step has its own). */}
        {keyView !== 'ready' && tab === 'resources' ? (
          <ConnectComputeHero keyView={keyView} />
        ) : null}

        {state.error && !s && keyView === 'ready' ? <ErrorNotice error={state.error} compact onRetry={() => void state.refetch()} /> : null}
        <ApiHealthBanner health={s?.apiHealth} />
        {s ? <AlarmList alarms={visibleAlarms(s.alarms, tab, resourceId)} onAction={alarms.onAction} busy={alarms.busy} /> : null}
        {s && tab === 'resources' && !resourceId ? (
          <OrgBillingBanner org={s.org} onOpenConsole={() => void gmi.app.openConsole('computeHome').catch(() => undefined)} />
        ) : null}
        {s && canManage && !s.dailyBudgetSet && tab === 'resources' && !resourceId ? (
          <BudgetInline
            primary={false}
            reason="GMI Desk needs a daily limit before your first container or GPU sandbox. Compute spend counts toward it, including what is already running."
          />
        ) : null}

        {tab === 'resources' ? (
          resourceId ? (
            <ResourceDetail
              id={resourceId}
              detail={detail.data}
              loading={detail.isLoading}
              error={detail.error}
              onRetry={() => void detail.refetch()}
              catalog={catalog.data}
              canManage={canManage}
              now={now}
              onBack={() => go({ tab: 'resources' })}
            />
          ) : showBrowse ? (
            <>
              {keyView !== 'none' && resources.data?.length ? (
                <ResourceList
                  resources={resources.data}
                  catalog={catalog.data}
                  loading={resources.isLoading}
                  error={resources.error}
                  onRetry={() => void resources.refetch()}
                  includeUnmanaged={includeUnmanaged}
                  onIncludeUnmanaged={setIncludeUnmanaged}
                  selectedId={null}
                  now={now}
                  onOpen={openResource}
                  onLaunch={() => launch()}
                  readOnly
                />
              ) : null}
              <CatalogBrowse
                catalog={catalog.data}
                loading={catalog.isLoading}
                error={catalog.error}
                onRetry={() => void catalog.refetch()}
                now={now}
                onLaunch={(kind) => launch(kind)}
              />
            </>
          ) : (
            <ResourceList
              resources={resources.data}
              catalog={catalog.data}
              loading={resources.isLoading}
              error={resources.error}
              onRetry={() => void resources.refetch()}
              includeUnmanaged={includeUnmanaged}
              onIncludeUnmanaged={setIncludeUnmanaged}
              selectedId={null}
              now={now}
              onOpen={openResource}
              onLaunch={() => launch()}
            />
          )
        ) : tab === 'launch' ? (
          catalog.error && !catalog.data ? (
            <ErrorNotice error={catalog.error} onRetry={() => void catalog.refetch()} />
          ) : (
            <LaunchWizard
              step={step}
              kind={kindParam}
              snapshot={params.snapshot ?? null}
              idc={params.idc ?? null}
              catalog={catalog.data}
              snapshots={snapshots.data}
              keyView={keyView}
              dailyBudgetSet={dailyBudgetSet}
              now={now}
              onStep={(next) => go({ ...params, tab: 'launch', step: next })}
              onOpenResource={openResource}
            />
          )
        ) : tab === 'network' ? (
          canManage ? (
            <NetworkTab
              inventory={network.data}
              loading={network.isLoading}
              error={network.error}
              onRetry={() => void network.refetch()}
              now={now}
              onReleased={() => void client.invalidateQueries({ queryKey: ['compute'] })}
              onOpenResource={openResource}
            />
          ) : (
            <NeedsKey what="Public IPs and firewalls" />
          )
        ) : canManage ? (
          <SnapshotsTab
            snapshots={snapshots.data}
            loading={snapshots.isLoading}
            error={snapshots.error}
            onRetry={() => void snapshots.refetch()}
            now={now}
            canManage={canManage}
            onLaunch={(id) => launch('sandbox', { snapshot: id })}
            onDeleted={() => void snapshots.refetch()}
          />
        ) : (
          <NeedsKey what="Snapshots" />
        )}

        {keyView === 'ready' && tab === 'resources' && !resourceId ? (
          <Note>Costs are GMI Desk’s estimate at list price; leases and budgets are enforced while GMI Desk runs and caught up when it starts.</Note>
        ) : null}
      </PageBody>
    </>
  );
}
