// The computer dock (compute.md §8.6): terminal, files, ports, previews and logs of a compute resource, to the right
// of the page on Chat, Code and Compute. Mounted once by App.tsx; renders nothing while the page's dock is closed.
// - Toggle: ⌘/Ctrl+J (also from inside the terminal) and <ComputerToggle> (for the top bar).
// - Width 360–960 px, dragged or arrow keys on the left edge, kept per page in the UI store.
// - Below 1,060 px the dock is a sheet over the page with a scrim; previews stay hidden while it slides in.
// - URL params (screenshots, deep links): `computer=<terminal|files|ports|logs|preview>` opens the dock on that tab
//   (`computerPort=<n>` with `preview` opens that port's preview when none is open),
//   `computerResource=<cr_…>` picks the resource.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, FileText, FolderTree, PanelRight, PanelRightClose, Play, Radio, SquareTerminal } from 'lucide-react';
import type { PageId } from '@shared/contracts/app';
import type { ComputeResource, ComputerSessionInfo } from '@shared/contracts/compute';
import { DinoLoader } from '@renderer/components/brand/Dino';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, Kbd, MicroLabel } from '@renderer/components/ui/misc';
import { Select } from '@renderer/components/ui/select';
import { TabStrip, type TabItem } from '@renderer/components/ui/tabs';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { gmi, isMac } from '@renderer/lib/gmi';
import { DOCK_WIDTH, isDockPage, useUi, type DockPageId, type DockState } from '@renderer/lib/store';
import { KIND_LABEL, PHASE_VIEW } from '@renderer/pages/compute/format';
import { useComputeResources, useResourceAction } from '@renderer/pages/compute/hooks';
import { SessionBanner, sessionBlocked } from './banners';
import { FilesView } from './FilesView';
import { LogsView } from './LogsView';
import { Placeholder } from './parts';
import { PortsView } from './PortsView';
import { PreviewPane } from './PreviewPane';
import { useComputerEvents, useComputerSession } from './session';
import { StatusBar } from './StatusBar';
import { previewIdOf, previewTab, useComputerUi, useStoreNow, type DockTab } from './store';
import { TerminalView } from './TerminalView';

/** Below this window width the dock is a sheet over the page (§8.6). */
export const SHEET_BELOW_PX = 1060;
/** The page keeps at least this much room next to an inline dock. */
export const PAGE_MIN_PX = 560;
/** Sheet slide-in (transform only, ease-out, ≤ 250 ms per D17); previews stay hidden this long. */
export const SHEET_MS = 200;
const KEY_STEP_PX = 16;

const BASE_TABS = ['terminal', 'files', 'ports', 'logs'] as const;
type BaseTab = (typeof BASE_TABS)[number];

/** Resources the dock can show: this install's, not gone, with something to open. */
export function dockCandidates(resources: readonly ComputeResource[]): ComputeResource[] {
  return resources.filter(
    (r) => r.managed && r.phase !== 'deleted' && (r.capabilities.terminal || r.capabilities.files || r.capabilities.logs || r.capabilities.previews),
  );
}

/** Which tabs a resource has: sandboxes get terminal, files and ports; containers terminal/files (explained) and logs. */
export function dockTabs(r: Pick<ComputeResource, 'kind' | 'capabilities'>): BaseTab[] {
  if (r.kind === 'container') return r.capabilities.logs ? ['logs', 'terminal', 'files'] : ['terminal', 'files'];
  const tabs: BaseTab[] = ['terminal', 'files', 'ports'];
  if (r.capabilities.logs) tabs.push('logs');
  return tabs;
}

/** The tab to show: the stored one when it still exists, else the resource's first. */
export function resolveTab(stored: DockTab | undefined, tabs: readonly BaseTab[], previewIds: readonly string[]): DockTab {
  if (stored) {
    const pid = previewIdOf(stored);
    if (pid ? previewIds.includes(pid) : (tabs as readonly string[]).includes(stored)) return stored;
  }
  return tabs[0] ?? 'terminal';
}

/** Width the dock gets in a window `windowWidth` wide (the stored width when it fits). */
export function effectiveDockWidth(stored: number, windowWidth: number, sheet: boolean): number {
  if (sheet) return Math.min(stored, Math.max(DOCK_WIDTH.min, windowWidth - 48));
  return Math.max(DOCK_WIDTH.min, Math.min(stored, windowWidth - PAGE_MIN_PX));
}

const isBaseTab = (v: string | undefined): v is BaseTab => (BASE_TABS as readonly string[]).includes(v ?? '');

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1360));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * Opens or closes the current page's dock (no-op on pages without one). `keyboard`: opened from the keyboard, so the
 * narrow-window sheet appears without its slide-in (keyboard actions never animate).
 */
export function toggleDock(open?: boolean, opts: { keyboard?: boolean } = {}): void {
  const s = useUi.getState();
  if (!isDockPage(s.page)) return;
  const next = open ?? !s.dock[s.page].open;
  if (next) useComputerUi.getState().setSheetInstant(opts.keyboard === true);
  s.setDock(s.page, { open: next });
}

/** ⌘/Ctrl+J anywhere (the terminal lets it through). */
function useDockShortcut(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = isMac() ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'j') return;
      if (!isDockPage(useUi.getState().page)) return;
      event.preventDefault();
      toggleDock(undefined, { keyboard: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Opens the dock for `computer=<tab>` / `computerResource=<id>` navigation params (deep links, screenshots). */
export function applyDockParams(page: PageId, params: Record<string, string>): void {
  const want = params.computer;
  if (!want || !isDockPage(page)) return;
  const resourceId = params.computerResource || undefined;
  useUi.getState().setDock(page, { open: true, ...(resourceId ? { resourceId } : {}) });
  const port = Number(params.computerPort);
  const requestedPort = want === 'preview' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  if (isBaseTab(want) || want === 'preview') useComputerUi.setState({ requestedTab: want, requestedPort });
}

/**
 * The params are read when the navigation happens (a store subscription), not in a later effect: a page may replace
 * them in the same commit (Chat's thread selection calls setParams({thread})), which used to drop `computer=…`.
 */
export function watchDockParams(): () => void {
  let handled = -1;
  const apply = (s: { navSeq: number; page: PageId; params: Record<string, string> }) => {
    if (s.navSeq === handled) return;
    handled = s.navSeq;
    applyDockParams(s.page, s.params);
  };
  apply(useUi.getState());
  return useUi.subscribe((s, prev) => {
    if (s.navSeq !== prev.navSeq) apply(s);
  });
}

function useDockParams(): void {
  useEffect(() => watchDockParams(), []);
}

/** Mounted once by App: listeners and the shortcut always; the dock itself only while open. */
export function ComputerDock() {
  const page = useStoreNow(useUi, (s) => s.page);
  const dock = useStoreNow(useUi, (s) => (isDockPage(s.page) ? s.dock[s.page] : null));
  useComputerEvents();
  useDockShortcut();
  useDockParams();
  if (!dock?.open || !isDockPage(page)) return null;
  return <DockFrame page={page} dock={dock} />;
}

/** The top-bar button: shows on Chat, Code and Compute; pressed while the dock is open. */
export function ComputerToggle({ className }: { className?: string }) {
  const page = useStoreNow(useUi, (s) => s.page);
  const open = useStoreNow(useUi, (s) => (isDockPage(s.page) ? s.dock[s.page].open : false));
  if (!isDockPage(page)) return null;
  return (
    <Tooltip
      label={
        <span className="flex items-center gap-1.5">
          {open ? 'Hide computer' : 'Show computer'} <Kbd>{isMac() ? '⌘J' : 'Ctrl+J'}</Kbd>
        </span>
      }
    >
      <Button variant="ghost" size="icon-sm" aria-label="Computer" aria-pressed={open} className={cn(open && 'bg-accent text-foreground', className)} onClick={(event) => toggleDock(undefined, { keyboard: event.detail === 0 })}>
        <PanelRight />
      </Button>
    </Tooltip>
  );
}

export function DockFrame({ page, dock }: { page: DockPageId; dock: DockState }) {
  const windowWidth = useWindowWidth();
  const sheet = windowWidth < SHEET_BELOW_PX;
  const width = effectiveDockWidth(dock.width, windowWidth, sheet);
  const setDock = useUi((s) => s.setDock);
  const setSheetMoving = useComputerUi((s) => s.setSheetMoving);
  // Read once at mount: a keyboard-opened sheet is simply there (no slide, no scrim fade).
  const [instant] = useState(() => useComputerUi.getState().sheetInstant);
  useEffect(() => {
    if (useComputerUi.getState().sheetInstant) useComputerUi.getState().setSheetInstant(false);
  }, []);

  // The sheet slides in from the right; native previews wait until it has landed.
  useEffect(() => {
    if (!sheet || instant) return undefined;
    setSheetMoving(true);
    const timer = setTimeout(() => setSheetMoving(false), SHEET_MS + 40);
    return () => {
      clearTimeout(timer);
      setSheetMoving(false);
    };
  }, [sheet, instant, setSheetMoving]);

  const close = () => setDock(page, { open: false });

  const aside = (
    <aside
      aria-label="Computer"
      data-dock={sheet ? 'sheet' : 'inline'}
      style={{ width }}
      className={cn(
        'relative flex shrink-0 flex-col border-l border-border bg-sidebar',
        sheet && 'fixed inset-y-0 right-0 z-40 shadow-2xl dark:shadow-[0_0_48px_rgb(0_0_0/0.7)]',
        sheet && !instant && 'transition-transform duration-200 ease-out starting:translate-x-full motion-reduce:transition-none',
      )}
    >
      <ResizeHandle width={dock.width} onWidth={(w) => setDock(page, { width: w })} />
      <DockBody page={page} dock={dock} onClose={close} />
    </aside>
  );
  if (!sheet) return aside;
  return (
    <>
      <div
        aria-hidden
        data-dock-scrim=""
        onClick={close}
        className={cn(
          'fixed inset-0 z-40 bg-black/30 dark:bg-black/60',
          !instant && 'transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none',
        )}
      />
      {aside}
    </>
  );
}

/** The left edge: drag to resize, or focus it and use the arrow keys (Home/End for the limits). */
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The dock sits on the right: dragging left makes it wider.
    onWidth(drag.current.width + (drag.current.x - e.clientX));
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_PX * 4 : KEY_STEP_PX;
    const next =
      e.key === 'ArrowLeft' ? width + step : e.key === 'ArrowRight' ? width - step : e.key === 'Home' ? DOCK_WIDTH.min : e.key === 'End' ? DOCK_WIDTH.max : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize computer"
      aria-valuemin={DOCK_WIDTH.min}
      aria-valuemax={DOCK_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidth(DOCK_WIDTH.default)}
      className="group/resize absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors duration-150 ease-out group-hover/resize:bg-foreground/15 group-focus-visible/resize:bg-ring group-active/resize:bg-primary-ink/60"
      />
    </div>
  );
}

function DockHeader({
  resources,
  selected,
  onSelect,
  onClose,
}: {
  resources: ComputeResource[];
  selected: ComputeResource | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
      <MicroLabel dot={selected?.phase === 'running'} className="shrink-0">
        Computer
      </MicroLabel>
      <div className="min-w-0 flex-1">
        {resources.length > 0 && selected ? (
          <Select
            variant="ghost"
            aria-label="Resource"
            value={selected.id}
            onValueChange={onSelect}
            className="max-w-full"
            options={resources.map((r) => ({
              value: r.id,
              label: r.displayName,
              hint: `${KIND_LABEL[r.kind]} · ${PHASE_VIEW[r.phase].label}`,
            }))}
          />
        ) : null}
      </div>
      {selected ? (
        <Tooltip label="Show on the Compute page">
          <Button variant="ghost" size="icon-xs" aria-label="Show on the Compute page" onClick={() => navigate('compute', { resource: selected.id })}>
            <ArrowUpRight />
          </Button>
        </Tooltip>
      ) : null}
      <Tooltip
        label={
          <span className="flex items-center gap-1.5">
            Hide computer <Kbd>{isMac() ? '⌘J' : 'Ctrl+J'}</Kbd>
          </span>
        }
      >
        <Button variant="ghost" size="icon-xs" aria-label="Close computer" onClick={onClose}>
          <PanelRightClose />
        </Button>
      </Tooltip>
    </div>
  );
}

export function DockBody({ page, dock, onClose }: { page: DockPageId; dock: DockState; onClose: () => void }) {
  const resources = useComputeResources(false, true);
  const setDock = useUi((s) => s.setDock);
  const navigate = useUi((s) => s.navigate);
  const candidates = useMemo(() => dockCandidates(resources.data ?? []), [resources.data]);
  const selected = candidates.find((r) => r.id === dock.resourceId) ?? candidates.find((r) => r.phase === 'running') ?? candidates[0] ?? null;

  // Remember the resource actually shown (the first running one when none was chosen).
  useEffect(() => {
    if (selected && selected.id !== dock.resourceId) setDock(page, { resourceId: selected.id });
  }, [selected, dock.resourceId, page, setDock]);

  const header = (
    <DockHeader resources={candidates} selected={selected} onSelect={(id) => setDock(page, { resourceId: id })} onClose={onClose} />
  );
  if (resources.isPending) {
    return (
      <>
        {header}
        <DinoLoader label="Loading computers" className="flex-1" />
      </>
    );
  }
  if (resources.error) {
    return (
      <>
        {header}
        <div className="p-3">
          <ErrorNotice error={resources.error} onRetry={() => void resources.refetch()} />
        </div>
      </>
    );
  }
  if (!selected) {
    return (
      <>
        {header}
        <EmptyState
          dino="sleep"
          title="No computers yet"
          description="Launch a sandbox on the Compute page: its terminal, files and previews open here, next to your work."
          className="flex-1"
          action={
            <Button variant="outline" size="sm" onClick={() => navigate('compute', { tab: 'launch' })}>
              Launch a computer
            </Button>
          }
        />
      </>
    );
  }
  return (
    <>
      {header}
      <ResourceView key={selected.id} resource={selected} />
    </>
  );
}

const TAB_LABEL: Record<BaseTab, string> = { terminal: 'Terminal', files: 'Files', ports: 'Ports', logs: 'Logs' };

export function ResourceView({ resource: r }: { resource: ComputeResource }) {
  const wantSession = r.managed && r.kind === 'sandbox' && (r.capabilities.terminal || r.capabilities.files) && r.phase === 'running';
  const session = useComputerSession(r.id, wantSession);
  const info = session.data ?? null;
  const allPreviews = useStoreNow(useComputerUi, (s) => s.previews);
  const previews = useMemo(
    () => (info ? Object.values(allPreviews).filter((p) => p.sessionId === info.sessionId) : []),
    [allPreviews, info],
  );
  const stored = useStoreNow(useComputerUi, (s) => s.tabs[r.id]);
  const requested = useStoreNow(useComputerUi, (s) => s.requestedTab);
  const setTab = useComputerUi((s) => s.setTab);
  const tabs = dockTabs(r);
  const tab = resolveTab(stored, tabs, previews.map((p) => p.previewId));

  // A tab asked for through URL params (applied once the resource is known).
  const sessionReady = info?.state === 'ready' ? info.sessionId : null;
  useEffect(() => {
    if (!requested) return;
    if (requested === 'preview') {
      if (previews[0]) setTab(r.id, previewTab(previews[0].previewId));
      else {
        // `computerPort=<n>`: open that port's preview once the session is ready (main builds the URL).
        const port = useComputerUi.getState().requestedPort;
        if (port !== null && sessionReady) {
          useComputerUi.setState({ requestedPort: null });
          gmi.computer
            .openPreview(sessionReady, port, '/')
            .then((p) => useComputerUi.getState().addPreview(p))
            .catch(() => useComputerUi.setState({ requestedTab: null }));
        }
        return;
      }
    } else setTab(r.id, requested);
    useComputerUi.setState({ requestedTab: null, requestedPort: null });
  }, [requested, previews, r.id, setTab, sessionReady]);

  const items: Array<TabItem<DockTab>> = [
    ...tabs.map((t) => ({ value: t as DockTab, label: TAB_LABEL[t] })),
    ...previews.map((p) => ({ value: previewTab(p.previewId), label: `:${p.port}` })),
  ];
  const blocked = info ? sessionBlocked(info, r) : false;
  const reconnect = () => void session.refetch();

  return (
    <>
      <div className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-border px-2 [scrollbar-width:none]">
        <TabStrip value={tab} onValueChange={(next) => setTab(r.id, next)} items={items} className="shrink-0" />
      </div>
      {info ? <SessionBanner session={info} resource={r} onReconnect={reconnect} /> : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <TabBody resource={r} tab={tab} session={session} info={info} blocked={blocked} onTab={(t) => setTab(r.id, t)} />
      </div>
      <StatusBar resource={r} session={info} />
    </>
  );
}

function TabBody({
  resource: r,
  tab,
  session,
  info,
  blocked,
  onTab,
}: {
  resource: ComputeResource;
  tab: DockTab;
  session: ReturnType<typeof useComputerSession>;
  info: ComputerSessionInfo | null;
  blocked: boolean;
  onTab: (tab: DockTab) => void;
}) {
  const previewId = previewIdOf(tab);
  const preview = useStoreNow(useComputerUi, (s) => (previewId ? (s.previews[previewId] ?? null) : null));

  if (tab === 'logs') return <LogsView resource={r} />;
  if (r.kind === 'container') {
    return tab === 'files' ? (
      <Placeholder icon={<FolderTree />} title="No file access for containers">
        Cluster Engine has no API for files. Use the container’s own tools (JupyterLab, SSH with public access), or a sandbox.
      </Placeholder>
    ) : (
      <Placeholder icon={<SquareTerminal />} title="No terminal for containers yet">
        GMI’s container shell has not been verified yet. Logs, status and network work today; SSH works when you set up public access.
      </Placeholder>
    );
  }
  if (!info) return <SessionGate resource={r} session={session} />;
  if (previewId) {
    if (!preview) return null;
    return <PreviewPane key={preview.previewId} preview={preview} active={!blocked} onClosed={() => onTab('ports')} />;
  }
  if (tab === 'files') {
    if (!r.capabilities.files) return <Placeholder icon={<FileText />} title="No file access for this computer" />;
    return blocked ? <BlockedNote /> : <FilesView session={info} />;
  }
  if (tab === 'ports') return blocked ? <BlockedNote /> : <PortsView session={info} previewsAllowed={r.capabilities.previews} />;
  if (!r.capabilities.terminal) return <Placeholder icon={<SquareTerminal />} title="No terminal for this computer" />;
  // The terminal stays mounted while paused: the screen remains readable under the banner.
  return <TerminalView key={info.sessionId} session={info} blocked={blocked} />;
}

function BlockedNote() {
  return (
    <Placeholder icon={<Radio />} title="Not available right now">
      Files and ports come back when the computer is running and connected.
    </Placeholder>
  );
}

/** Before a session exists: why (not running yet, paused, failed) or the connection in progress. */
function SessionGate({ resource: r, session }: { resource: ComputeResource; session: ReturnType<typeof useComputerSession> }) {
  const resume = useResourceAction('Could not resume', (id: string) => gmi.compute.resume(id));
  if (r.phase === 'paused') {
    return (
      <Placeholder
        title="This computer is paused"
        action={
          <Button variant="outline" size="sm" disabled={resume.isPending} onClick={() => resume.mutate([r.id])}>
            <Play /> Resume…
          </Button>
        }
      >
        Resume it to use its terminal and files. The price is shown before billing starts again.
      </Placeholder>
    );
  }
  if (r.phase === 'failed') {
    return <Placeholder title="This computer failed">{r.reason ?? 'GMI reported a failure. See the Compute page for details.'}</Placeholder>;
  }
  if (r.phase !== 'running') {
    return <DinoLoader label={PHASE_VIEW[r.phase].label} className="flex-1" />;
  }
  if (session.error) {
    return (
      <div className="p-3">
        <ErrorNotice error={session.error} onRetry={() => void session.refetch()} retryLabel="Connect again" />
      </div>
    );
  }
  return <DinoLoader label="Connecting" className="flex-1" />;
}
