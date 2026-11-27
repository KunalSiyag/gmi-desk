import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, CheckCheck, FileCode2, FilterX, Info, LogIn, RefreshCw, Search, Sparkles, Star, Trophy, X } from 'lucide-react';
import { toast } from 'sonner';
import type { CatalogModel, CatalogSnapshot, CatalogSource, SourceStatus } from '@shared/contracts/catalog';
import { formatRelativeTime } from '@shared/lib/format';
import { gmi } from '@renderer/lib/gmi';
import { useAuth, useCatalog, useGmiEvent } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useCommandRegistry, useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { SignInPendingActions } from '@renderer/components/SignInPendingActions';
import { signInWithFeedback } from '@renderer/lib/sign-in';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Select } from '@renderer/components/ui/select';
import { DinoLoader } from '@renderer/components/brand/Dino';
import { EmptyState, Kbd, microLabel, Spinner } from '@renderer/components/ui/misc';
import { pressMotion } from '@renderer/components/ui/motion';
import { TabStrip } from '@renderer/components/ui/tabs';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { registerGlobalCatalogCommands } from './commands';
import { ExportDialog, useOpenCodeExport } from './ExportDialog';
import {
  buildCatalogView,
  DEFAULT_FILTERS,
  findById,
  isSortKey,
  isTabValue,
  KIND_TABS,
  revealModel,
  SORT_OPTIONS,
  type CatalogFilters,
  type KindFilter,
  type ModelsTab,
  type SortKey,
} from './filter';
import { LeaderboardView, topLeaderboardModel, useLeaderboard } from './LeaderboardView';
import { ModelDetailPanel } from './ModelDetail';
import { ModelList, type ModelListHandle } from './ModelList';
import { useNow } from './parts';

registerGlobalCatalogCommands();

const TAB_KEY = 'gmi.models.tab';
const SORT_KEY = 'gmi.models.sort';

function readStored<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage may be unavailable
  }
}

type Toggle = 'onlyNew' | 'onlyFeatured' | 'onlyDiscounted';
/** The kind comes from the selected tab, everything else lives here. */
type FilterState = Omit<CatalogFilters, 'kind'>;
const { kind: _defaultKind, ...INITIAL_FILTERS } = DEFAULT_FILTERS;

function ToggleChip({ pressed, onClick, icon, label, count }: { pressed: boolean; onClick: () => void; icon: ReactNode; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium [&_svg]:size-3',
        pressMotion,
        pressed
          ? 'border-primary-ink/35 bg-primary/20 text-primary-ink dark:border-primary/40 dark:bg-primary/[0.1]'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      {label}
      <span className={cn('text-3xs tabular-nums', pressed ? 'opacity-80' : 'opacity-60')}>{count}</span>
    </button>
  );
}

const PUBLIC_SOURCES: CatalogSource[] = ['public_media', 'public_prices', 'featured', 'leaderboard'];
const PUBLIC_LABELS: Record<string, string> = {
  public_media: 'Media catalog',
  public_prices: 'Price list',
  featured: 'Featured list',
  leaderboard: 'Leaderboard',
};

type Health = 'ok' | 'stale' | 'error' | 'skipped' | 'unknown';

function healthOf(status: SourceStatus | undefined): Health {
  if (!status) return 'unknown';
  return status.state ?? (status.ok ? 'ok' : status.count > 0 ? 'stale' : 'error');
}

const DOT: Record<Health, string> = {
  ok: 'bg-primary-ink',
  stale: 'bg-warning',
  error: 'bg-destructive',
  skipped: 'bg-muted-foreground/40',
  unknown: 'bg-muted-foreground/25',
};

function skippedReason(status: SourceStatus | undefined): string {
  const e = status?.error?.toLowerCase() ?? '';
  if (e.includes('signed')) return 'signed out';
  if (e.includes('rejected')) return 'key rejected';
  if (e.includes('key')) return 'no key';
  return 'off';
}

function SourcePill({ label, health, detail, tooltip }: { label: string; health: Health; detail: string; tooltip: ReactNode }) {
  return (
    <Tooltip label={tooltip} side="top">
      <span className="inline-flex shrink-0 cursor-default items-center gap-1.5">
        <span aria-hidden className={cn('size-1.5 rounded-full', DOT[health])} />
        <span className={cn(microLabel, 'text-foreground/75')}>{label}</span>
        {/* A narrow list column keeps the dots (the tooltip has the detail). */}
        <span className="hidden text-muted-foreground @lg/status:inline">{detail}</span>
      </span>
    </Tooltip>
  );
}

function sourceLine(status: SourceStatus | undefined, now: Date): string {
  if (!status) return 'not fetched yet';
  const when = status.fetchedAt ? `fetched ${formatRelativeTime(status.fetchedAt, now)}` : 'never fetched';
  const health = healthOf(status);
  if (health === 'ok') return `${status.count} rows, ${when}`;
  if (health === 'stale') return `failed (${status.error ?? 'error'}); using data ${when}`;
  if (health === 'skipped') return status.error ?? 'skipped';
  return status.error ?? 'failed';
}

function StatusLine({ snapshot, now }: { snapshot: CatalogSnapshot | undefined; now: Date }) {
  const models = snapshot?.models ?? [];
  const llms = models.filter((m) => m.kind === 'llm').length;
  const media = models.length - llms;
  const sources = snapshot?.sources ?? {};

  const mcp = sources.mcp;
  const api = sources.models_api;
  const publicHealth: Health[] = PUBLIC_SOURCES.map((s) => healthOf(sources[s]));
  const failed = publicHealth.filter((h) => h === 'error' || h === 'stale').length;
  const publicState: Health = publicHealth.every((h) => h === 'unknown')
    ? 'unknown'
    : failed === 0
      ? 'ok'
      : publicHealth.every((h) => h === 'error')
        ? 'error'
        : 'stale';
  const llmSource =
    snapshot?.llmListSource === 'models_api'
      ? 'LLM list from your API key (models API)'
      : snapshot?.llmListSource === 'mcp'
        ? 'LLM list from your GMI sign-in'
        : 'LLM list from GMI’s public feeds (best effort)';

  const describe = (h: Health, status: SourceStatus | undefined) =>
    h === 'ok' ? 'ok' : h === 'stale' ? 'stale' : h === 'error' ? 'failed' : h === 'skipped' ? `(${skippedReason(status)})` : '…';

  return (
    <footer className="@container/status flex h-7 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-t border-border px-5 text-3xs text-muted-foreground">
      <span className="truncate tabular-nums">{snapshot?.updatedAt ? `Updated ${formatRelativeTime(snapshot.updatedAt, now)}` : snapshot?.refreshing ? 'Loading…' : 'Not updated yet'}</span>
      <span aria-hidden>·</span>
      <Tooltip label={llmSource} side="top">
        <span className="shrink-0 cursor-default tabular-nums">
          {llms} LLMs · {media} media
        </span>
      </Tooltip>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <SourcePill label="MCP" health={healthOf(mcp)} detail={describe(healthOf(mcp), mcp)} tooltip={`GMI sign-in catalog: ${sourceLine(mcp, now)}`} />
        <SourcePill label="Models API" health={healthOf(api)} detail={describe(healthOf(api), api)} tooltip={`Inference models API: ${sourceLine(api, now)}`} />
        <SourcePill
          label="Public"
          health={publicState}
          detail={publicState === 'stale' ? `${failed} of ${PUBLIC_SOURCES.length} failed` : describe(publicState, undefined)}
          tooltip={
            <span className="flex flex-col gap-0.5">
              {PUBLIC_SOURCES.map((s) => (
                <span key={s}>
                  {PUBLIC_LABELS[s]}: {sourceLine(sources[s], now)}
                </span>
              ))}
            </span>
          }
        />
      </span>
    </footer>
  );
}

export default function ModelsPage() {
  const client = useQueryClient();
  const catalog = useCatalog();
  const auth = useAuth();
  const params = useUi((s) => s.params);
  const navSeq = useUi((s) => s.navSeq);
  const now = useNow();

  const snapshot = catalog.data;
  const models = useMemo(() => snapshot?.models ?? [], [snapshot]);
  const authStatus = auth.data?.status;
  const signedIn = authStatus === 'signed_in';

  const [tab, setTabState] = useState<ModelsTab>(() => readStored(TAB_KEY, isTabValue, 'all'));
  const [filters, setFilters] = useState<FilterState>(() => ({ ...INITIAL_FILTERS, sort: readStored(SORT_KEY, isSortKey, 'recommended') }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const listRef = useRef<ModelListHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const setTab = useCallback((next: ModelsTab) => {
    setTabState(next);
    store(TAB_KEY, next);
  }, []);
  const setSort = useCallback((sort: SortKey) => {
    setFilters((f) => ({ ...f, sort }));
    store(SORT_KEY, sort);
  }, []);
  const toggle = (key: Toggle) => setFilters((f) => ({ ...f, [key]: !f[key] }));
  const clearFilters = () => setFilters((f) => ({ ...INITIAL_FILTERS, sort: f.sort }));

  const kind: KindFilter = tab === 'leaderboard' ? 'all' : tab;
  const deferredQuery = useDeferredValue(filters.query);
  const view = useMemo(() => buildCatalogView(models, { ...filters, query: deferredQuery, kind }), [models, filters, deferredQuery, kind]);
  const byId = useMemo(() => new Map(models.map((m) => [m.id.toLowerCase(), m])), [models]);

  const board = useLeaderboard(tab === 'leaderboard');
  const picked = findById(models, selectedId);
  // On the leaderboard, a picked model that is not on it gives way to the best-ranked one.
  const selected =
    tab === 'leaderboard'
      ? ((picked?.leaderboard ? picked : null) ?? topLeaderboardModel(board.data?.entries, byId) ?? picked)
      : (view.rows.find((m) => m.id === selectedId) ?? view.rows[0] ?? null);

  const newCount = useMemo(() => models.filter((m) => m.isNew).length, [models]);

  // --- actions -------------------------------------------------------------------------------
  const refresh = useMutation({
    mutationFn: () => gmi.catalog.refresh(),
    onSuccess: (snap) => client.setQueryData(qk.catalog, snap),
    onError: () => toast.error('Could not refresh the model catalog'),
  });
  const refreshing = Boolean(snapshot?.refreshing) || refresh.isPending;

  const acknowledge = useMutation({
    mutationFn: (ids?: string[]) => gmi.catalog.acknowledgeNew(ids),
    onSuccess: (_data, ids) => {
      void client.invalidateQueries({ queryKey: qk.catalog });
      if (!ids) {
        toast.success('All models marked as seen');
        // Nothing is New any more: leaving the filter on would just show an empty list.
        setFilters((f) => (f.onlyNew ? { ...f, onlyNew: false } : f));
      }
    },
  });

  const exporter = useOpenCodeExport();
  const startExport = () => {
    setExportOpen(true);
    exporter.mutate();
  };

  const signIn = () => void signInWithFeedback();
  // The signed-out banner's "Sign in" is the page's sign-in CTA: the top bar hides its own meanwhile (before paint).
  const bannerSignIn = Boolean(authStatus) && !signedIn && authStatus !== 'signing_in';
  const registerSignInCta = useUi((s) => s.registerSignInCta);
  useLayoutEffect(() => (bannerSignIn ? registerSignInCta() : undefined), [bannerSignIn, registerSignInCta]);
  const navigate = useUi((s) => s.navigate);
  /** The primary action for a model: chat for LLMs, Create for media and workflows. */
  const openModel = (m: CatalogModel) => {
    if (!m.available) return;
    if (m.kind === 'llm') navigate('chat', { new: '1', model: m.id });
    else navigate('create', { model: m.id });
  };

  // Details and the leaderboard are derived from the last refresh.
  useGmiEvent('catalog:updated', () => {
    void client.invalidateQueries({ queryKey: qk.leaderboard });
    void client.invalidateQueries({ queryKey: ['catalog', 'model'] });
  });

  // The cached snapshot can miss `catalog:updated` while nothing that subscribes is mounted (the Welcome page has
  // no sidebar or top bar), leaving a stale "refreshing" snapshot. Refetch when the page opens, and poll while the
  // snapshot says a refresh is running.
  useEffect(() => {
    void client.invalidateQueries({ queryKey: qk.catalog });
  }, [client]);
  const snapshotRefreshing = Boolean(snapshot?.refreshing);
  useEffect(() => {
    if (!snapshotRefreshing) return;
    const timer = window.setInterval(() => void client.invalidateQueries({ queryKey: qk.catalog }), 1500);
    return () => window.clearInterval(timer);
  }, [snapshotRefreshing, client]);

  // --- navigation params: ?model=<id> selects, ?filter=new shows new models, ?tab=llm|…|leaderboard picks a tab,
  // ?q= searches, ?export=1 opens the OpenCode export.
  // Runs on every navigation to this page (navSeq), not when unrelated state changes.
  const handledSeq = useRef<number | null>(null);
  useEffect(() => {
    if (handledSeq.current === navSeq) return;
    handledSeq.current = navSeq;
    if (isTabValue(params.tab)) setTab(params.tab);
    if (params.filter === 'new') {
      setTab(isTabValue(params.tab) && params.tab !== 'leaderboard' ? params.tab : 'all');
      setFilters((f) => ({ ...INITIAL_FILTERS, sort: f.sort, onlyNew: true }));
      setSelectedId(null);
    }
    if (typeof params.q === 'string') setFilters((f) => ({ ...f, query: params.q?.slice(0, 200) ?? '' }));
    if (params.export === '1') startExport();
    if (params.model) setPendingModel(params.model);
  });

  // ?model= may arrive before the catalog has loaded: resolve it once models are here.
  useEffect(() => {
    if (!pendingModel || models.length === 0) return;
    const model = findById(models, pendingModel);
    setPendingModel(null);
    if (!model) {
      toast.error('That model is not in the GMI catalog', { description: pendingModel });
      return;
    }
    setSelectedId(model.id);
    if (tab === 'leaderboard' && model.leaderboard) return;
    const { kind: nextKind, ...rest } = revealModel({ ...filters, kind }, model);
    setFilters(rest);
    if (nextKind !== tab) setTab(nextKind);
  }, [pendingModel, models, tab, filters, kind, setTab]);

  // --- keyboard: "/" focuses search ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (tab === 'leaderboard') return;
      event.preventDefault();
      listRef.current?.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && tab !== 'leaderboard') {
      event.preventDefault();
      listRef.current?.focus();
    } else if (event.key === 'Escape') {
      if (filters.query) {
        event.preventDefault();
        setFilters((f) => ({ ...f, query: '' }));
      } else searchRef.current?.blur();
    }
  };

  // --- palette commands (while the page is open) ------------------------------------------------
  const actions = useRef({ refresh: () => refresh.mutate(), markSeen: () => acknowledge.mutate(undefined), leaderboard: () => setTab('leaderboard') });
  actions.current = { refresh: () => refresh.mutate(), markSeen: () => acknowledge.mutate(undefined), leaderboard: () => setTab('leaderboard') };
  useEffect(
    () =>
      useCommandRegistry.getState().register('models', [
        { id: 'models.refresh', label: 'Refresh catalog', group: 'Models', icon: <RefreshCw />, keywords: ['reload', 'update', 'models'], run: () => actions.current.refresh() },
        { id: 'models.markSeen', label: 'Mark all models as seen', group: 'Models', icon: <CheckCheck />, keywords: ['new', 'badge', 'clear'], run: () => actions.current.markSeen() },
        { id: 'models.leaderboard', label: 'Show the model leaderboard', group: 'Models', icon: <Trophy />, keywords: ['benchmark', 'quality', 'scores'], run: () => actions.current.leaderboard() },
      ]),
    [],
  );

  // --- render ----------------------------------------------------------------------------------
  const tabItems = [
    ...KIND_TABS.map((t) => ({ value: t.value as ModelsTab, label: t.label, count: models.length ? view.kindCounts[t.value] : undefined })),
    {
      value: 'leaderboard' as ModelsTab,
      label: (
        <span className="inline-flex items-center gap-1">
          <Trophy className="size-3" /> Leaderboard
        </span>
      ),
    },
  ];

  const chipsOn = filters.onlyNew || filters.onlyFeatured || filters.onlyDiscounted || filters.provider !== null;
  const loadingCatalog = catalog.isLoading || (models.length === 0 && Boolean(snapshot?.refreshing));
  const failedEmpty = !loadingCatalog && snapshot !== undefined && models.length === 0;

  let listBody: ReactNode;
  if (catalog.error && !snapshot) {
    listBody = (
      <div className="p-5">
        <ErrorNotice error={catalog.error} onRetry={() => void catalog.refetch()} />
      </div>
    );
  } else if (loadingCatalog) {
    // First load (nothing cached yet): the whole catalog is coming, so Dino waits with the user.
    listBody = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="h-7 shrink-0 border-b border-border" />
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden pb-12">
          <DinoLoader label="Loading the GMI catalog" size={84} className="relative isolate">
            <div aria-hidden className="grid-floor pointer-events-none absolute -inset-x-24 -inset-y-10 -z-10" />
          </DinoLoader>
        </div>
      </div>
    );
  } else if (failedEmpty) {
    listBody = (
      <EmptyState
        dino="idle"
        title="Couldn’t reach the GMI catalog"
        description="GMI’s catalog feeds did not answer. Check your connection, then try again."
        action={
          <Button size="sm" onClick={() => refresh.mutate()} disabled={refreshing}>
            {refreshing ? <Spinner className="text-primary-foreground" /> : <RefreshCw />} Try again
          </Button>
        }
        className="flex-1 pb-20"
      />
    );
  } else if (tab === 'leaderboard') {
    listBody = (
      <LeaderboardView
        query={deferredQuery}
        catalog={byId}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onClearQuery={() => setFilters((f) => ({ ...f, query: '' }))}
      />
    );
  } else {
    listBody = (
      <ModelList
        ref={listRef}
        rows={view.rows}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onActivate={openModel}
        sort={filters.sort}
        onSort={setSort}
        showKind={kind === 'all'}
        showContext={kind === 'all' || kind === 'llm'}
        empty={
          <EmptyState
            dino="idle"
            title="No models match"
            description={
              filters.query
                ? `Nothing in ${kind === 'all' ? 'the catalog' : KIND_TABS.find((t) => t.value === kind)?.label} matches “${filters.query}”${chipsOn ? ' with these filters' : ''}.`
                : 'No model passes these filters.'
            }
            action={
              <Button size="sm" variant="outline" onClick={clearFilters}>
                {chipsOn ? <FilterX /> : <X />} {chipsOn ? 'Clear filters' : 'Clear search'}
              </Button>
            }
            className="pt-16"
          />
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <TopBarActions>
        {newCount > 0 ? (
          <Tooltip label={`Clear the New badge on ${newCount} model${newCount === 1 ? '' : 's'}`} side="bottom">
            <Button variant="ghost" size="sm" onClick={() => acknowledge.mutate(undefined)} disabled={acknowledge.isPending}>
              <CheckCheck /> Mark all seen
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip label="Write the chat models as an OpenCode provider config (also works in T3 Code)" side="bottom">
          <Button variant="ghost" size="sm" onClick={startExport} disabled={models.length === 0}>
            <FileCode2 />
            <span>
              Export<span className="hidden xl:inline"> for OpenCode / T3 Code</span>
            </span>
          </Button>
        </Tooltip>
        <Tooltip label="Fetch the latest catalog from GMI" side="bottom">
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
          </Button>
        </Tooltip>
      </TopBarActions>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Model catalog">
        {authStatus && !signedIn ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/[0.04] px-5 py-1.5 text-xs dark:bg-primary/[0.07]">
            <Info className="size-3.5 shrink-0 text-primary-ink" />
            <span className="min-w-0 truncate">
              <span className="font-medium">
                {authStatus === 'reauth_required' ? 'Your GMI sign-in expired.' : 'Sign in to see your prices and availability.'}
              </span>
              {/* While the browser is open the pending row needs the room; the price note can wait. */}
              {authStatus === 'signing_in' ? null : <span className="text-muted-foreground"> Showing GMI’s public list prices.</span>}
            </span>
            {authStatus === 'signing_in' ? (
              <span className="ml-auto">
                <SignInPendingActions compact />
              </span>
            ) : (
              // Outline: the page's one lime action is the detail panel's "Chat / Create with this model".
              <Button variant="outline" size="xs" className="ml-auto" onClick={signIn}>
                <LogIn />
                Sign in
              </Button>
            )}
          </div>
        ) : null}

        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-2 pt-3">
          {/* A narrow list column wraps the tabs onto a second line instead of running them under the details panel. */}
          <div className="min-w-0 max-w-full">
            <TabStrip value={tab} onValueChange={setTab} items={tabItems} className="max-w-full flex-wrap" />
          </div>
          <div className="relative min-w-36 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={filters.query}
              onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              onKeyDown={onSearchKey}
              placeholder={tab === 'leaderboard' ? 'Search leaderboard' : 'Search models'}
              aria-label={tab === 'leaderboard' ? 'Search the leaderboard' : 'Search models by name, id, provider or tag'}
              spellCheck={false}
              className="h-7 pl-8 pr-7 text-xs"
            />
            {filters.query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setFilters((f) => ({ ...f, query: '' }));
                  searchRef.current?.focus();
                }}
                className={cn('absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground', pressMotion)}
              >
                <X className="size-3" />
              </button>
            ) : (
              <Kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
            )}
          </div>
        </div>

        <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 px-5 pb-2">
          {tab === 'leaderboard' ? (
            <p className="min-w-0 truncate text-2xs text-muted-foreground">
              GMI’s benchmark scores for the models it serves. Higher is better; the best score per column is highlighted. Click a column to sort.
            </p>
          ) : (
            <>
              <ToggleChip pressed={filters.onlyNew} onClick={() => toggle('onlyNew')} icon={<Sparkles />} label="New" count={view.toggleCounts.new} />
              <ToggleChip
                pressed={filters.onlyFeatured}
                onClick={() => toggle('onlyFeatured')}
                icon={<Star />}
                label="Featured"
                count={view.toggleCounts.featured}
              />
              <ToggleChip
                pressed={filters.onlyDiscounted}
                onClick={() => toggle('onlyDiscounted')}
                icon={<BadgePercent />}
                label="Discounted"
                count={view.toggleCounts.discounted}
              />
              {view.narrowed ? (
                <Button variant="ghost" size="xs" onClick={clearFilters} className="text-2xs">
                  <FilterX /> Clear
                </Button>
              ) : null}
              <div className="ml-auto flex items-center gap-1.5">
                {/* Model counts are list hints (right-aligned, mono); the trigger shows the provider name. */}
                <Select
                  aria-label="Provider"
                  size="sm"
                  value={filters.provider ?? ''}
                  onValueChange={(provider) => setFilters((f) => ({ ...f, provider: provider || null }))}
                  options={[
                    { value: '', label: 'All providers' },
                    ...(filters.provider && !view.providers.some((p) => p.name === filters.provider) ? [{ value: filters.provider, label: filters.provider, hint: 0 }] : []),
                    ...view.providers.map((p) => ({ value: p.name, label: p.name, hint: p.count })),
                  ]}
                  className="w-36 shrink-0"
                />
                <Select aria-label="Sort" size="sm" value={filters.sort} onValueChange={setSort} options={SORT_OPTIONS} className="w-36 shrink-0" />
              </div>
            </>
          )}
        </div>

        {listBody}
        <StatusLine snapshot={snapshot} now={now} />
      </section>

      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto overflow-x-hidden border-l border-border bg-sidebar xl:w-80" aria-label="Model details">
        <ModelDetailPanel
          key={selected?.id ?? 'none'}
          model={selected}
          signedIn={signedIn}
          loading={loadingCatalog || (tab === 'leaderboard' && board.isLoading)}
          onAcknowledge={(id) => acknowledge.mutate([id])}
          onSignIn={signIn}
        />
      </aside>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} state={exporter} signedIn={signedIn} />
    </div>
  );
}
