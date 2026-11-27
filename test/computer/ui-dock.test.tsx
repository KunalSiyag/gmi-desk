// C2-D: the computer dock (compute.md §8.6) rendered with react-dom/server against seeded caches: every state the
// dock can show, the tabs per resource kind, the status bar (§8.5), the preview frame (§8.4), and D16–D18 on each.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import {
  ComputerDock,
  ComputerToggle,
  dockCandidates,
  dockTabs,
  effectiveDockWidth,
  PAGE_MIN_PX,
  resolveTab,
  toggleDock,
  watchDockParams,
} from '@renderer/components/computer/ComputerDock';
import { PreviewFrame, previewHost, slotBounds, viewVisible } from '@renderer/components/computer/PreviewPane';
import { countdowns, extendLabel, StatusBar } from '@renderer/components/computer/StatusBar';
import { previewTab, useComputerUi } from '@renderer/components/computer/store';
import { DOCK_WIDTH, useUi } from '@renderer/lib/store';
import type { PreviewInfo } from '@shared/contracts/compute';
import { container, expectDesignRules, inMin, installBridge, limeButtons, now, PORTS, removeBridge, render, ROOT_LISTING, sandbox, session, text, type Seed } from './ui-fixtures';

const closedDock = { open: false, width: DOCK_WIDTH.default, resourceId: null };

function dock(seed: Seed, opts: { page?: 'chat' | 'code' | 'compute'; resourceId?: string | null; open?: boolean } = {}): string {
  const page = opts.page ?? 'chat';
  useUi.setState({
    page,
    params: {},
    dock: { chat: closedDock, code: closedDock, compute: closedDock, [page]: { open: opts.open ?? true, width: 480, resourceId: opts.resourceId ?? null } },
  });
  return render(<ComputerDock />, seed);
}

const preview = (patch: Partial<PreviewInfo> = {}): PreviewInfo => ({
  previewId: 'pv1',
  sessionId: 'cs_1',
  port: 8000,
  url: 'https://8000-sbxkey.sandbox.example.test/',
  title: null,
  state: 'ready',
  detail: null,
  canGoBack: false,
  canGoForward: true,
  ...patch,
});

beforeEach(() => void installBridge());
afterEach(() => {
  removeBridge();
  useUi.setState({ page: 'chat', params: {}, overlayCount: 0, dock: { chat: closedDock, code: closedDock, compute: closedDock } });
  useComputerUi.setState({ tabs: {}, previews: {}, transfers: [], selected: {}, expanded: {}, requestedTab: null, requestedPort: null, sheetMoving: false });
});

describe('review: deep-link params', () => {
  it('a chat link with computer=files opens the dock even when the page replaces its params in the same tick', () => {
    useUi.setState({ page: 'chat', params: {}, navSeq: 0, dock: { chat: closedDock, code: closedDock, compute: closedDock } });
    const stop = watchDockParams();
    try {
      useUi.getState().navigate('chat', { computer: 'files', computerResource: 'cr_mock_sb1' });
      // Chat's thread selection runs next and replaces the params.
      useUi.getState().setParams({ thread: '5eed0000-0000-4000-8000-000000000001' });
      expect(useUi.getState().dock.chat).toMatchObject({ open: true, resourceId: 'cr_mock_sb1' });
      expect(useComputerUi.getState().requestedTab).toBe('files');
    } finally {
      stop();
    }
  });

  it('computer=preview&computerPort=8000 asks for that port; other tabs and bad ports ask for none', () => {
    useUi.setState({ page: 'compute', params: {}, navSeq: 0, dock: { chat: closedDock, code: closedDock, compute: closedDock } });
    const stop = watchDockParams();
    try {
      useUi.getState().navigate('compute', { computer: 'preview', computerPort: '8000' });
      expect(useComputerUi.getState()).toMatchObject({ requestedTab: 'preview', requestedPort: 8000 });
      useUi.getState().navigate('compute', { computer: 'preview', computerPort: '70000' });
      expect(useComputerUi.getState().requestedPort).toBeNull();
      useUi.getState().navigate('compute', { computer: 'ports', computerPort: '8000' });
      expect(useComputerUi.getState()).toMatchObject({ requestedTab: 'ports', requestedPort: null });
    } finally {
      stop();
    }
  });
});

describe('open / closed', () => {
  it('renders nothing while the page’s dock is closed, and nothing on pages without a dock', () => {
    expect(dock({ resources: [sandbox()] }, { open: false })).toBe('');
    useUi.setState({ page: 'models' });
    expect(render(<ComputerDock />, { resources: [sandbox()] })).toBe('');
  });

  it('toggleDock flips the current page’s dock only, and is a no-op off dock pages', () => {
    useUi.setState({ page: 'code', dock: { chat: closedDock, code: closedDock, compute: closedDock } });
    toggleDock();
    expect(useUi.getState().dock.code.open).toBe(true);
    expect(useUi.getState().dock.chat.open).toBe(false);
    toggleDock(false);
    expect(useUi.getState().dock.code.open).toBe(false);
    useUi.setState({ page: 'settings' });
    toggleDock();
    expect(Object.values(useUi.getState().dock).every((d) => !d.open)).toBe(true);
  });

  it('ComputerToggle shows on Chat, Code and Compute, pressed while open', () => {
    useUi.setState({ page: 'chat', dock: { chat: { ...closedDock, open: true }, code: closedDock, compute: closedDock } });
    const html = render(<ComputerToggle />);
    expect(html).toContain('aria-label="Computer"');
    expect(html).toContain('aria-pressed="true"');
    useUi.setState({ page: 'usage' });
    expect(render(<ComputerToggle />)).toBe('');
  });
});

describe('empty and loading', () => {
  it('no computers yet: the sleeping Dino and a way to launch one (outline: the page owns the lime)', () => {
    const html = dock({ resources: [] });
    expect(text(html)).toContain('No computers yet');
    expect(html).toContain('data-mood="sleep"');
    expect(text(html)).toContain('Launch a computer');
    expect(limeButtons(html)).toBe(0);
    expectDesignRules(html);
  });

  it('only this install’s live resources with something to open are offered', () => {
    const other = sandbox({ id: 'cr_other', managed: false });
    const gone = sandbox({ id: 'cr_gone', phase: 'deleted' });
    const ce = container();
    expect(dockCandidates([other, gone, ce, sandbox()]).map((r) => r.id)).toEqual(['cr_mock_ce1', 'cr_mock_sb1']);
    expect(text(dock({ resources: [other, gone] }))).toContain('No computers yet');
  });

  it('loading resources: DinoLoader (a page-level wait)', () => {
    const html = dock({});
    expect(text(html)).toContain('Loading computers');
    expect(html).toContain('data-mood="loading"');
  });

  it('a running sandbox without a session yet: connecting', () => {
    const html = dock({ resources: [sandbox()] });
    expect(text(html)).toContain('Connecting');
  });
});

describe('a running sandbox', () => {
  const seed: Seed = { resources: [sandbox()], session: session(), dirs: { '/root': ROOT_LISTING }, ports: PORTS };

  it('header, tabs Terminal · Files · Ports, the terminal, the status bar; calm (no banner, no Dino, no lime)', () => {
    const html = dock(seed);
    const t = text(html);
    expect(html).toContain('aria-label="Computer"');
    expect(t).toContain('python-dev');
    expect(t).toMatch(/Terminal.*Files.*Ports/);
    expect(t).not.toContain('Logs');
    expect(html).toContain('data-terminal-host');
    expect(html).toContain('data-status-bar');
    expect(html).not.toContain('data-banner');
    expect(limeButtons(html)).toBe(0);
    expectDesignRules(html, { dino: false });
  });

  it('the dock picks the first running resource when none was chosen', () => {
    const paused = sandbox({ id: 'cr_paused', displayName: 'paused-one', phase: 'paused' });
    const html = dock({ ...seed, resources: [paused, sandbox()] });
    expect(html).toContain('data-terminal-host');
  });

  it('status bar: price per hour (list), accrued total and today, countdowns soonest first, actions', () => {
    const html = dock(seed);
    const t = text(html);
    expect(t).toContain('$0.091/h list');
    expect(t).toMatch(/\$0\.06 total · \$0\.05 today/);
    expect(t).toMatch(/Idle pause in 1[12] min Server stop in (19|20) min Lease pause in 6 h (39|40) min/);
    for (const label of ['Extend', 'Pause', 'Take a snapshot', 'Resources', 'Delete']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="Resume"');
  });

  it('Files tab: the tree from $HOME, folders first, sizes, dot-files muted, upload target shown as ~', () => {
    useComputerUi.setState({ tabs: { cr_mock_sb1: 'files' } });
    const html = dock(seed);
    const t = text(html);
    expect(t).toContain('~');
    const order = [...html.matchAll(/data-path="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['/root/app', '/root/data', '/root/.bashrc', '/root/notes.txt']);
    expect(t).toMatch(/notes\.txt 1\.5 KB/);
    expect(html).toContain('aria-label="Upload files"');
    expect(html).toContain('aria-label="New folder"');
    expectDesignRules(html, { dino: false });
  });

  it('Files tab: a selected folder becomes the upload target and is marked like a selected row', () => {
    useComputerUi.setState({ tabs: { cr_mock_sb1: 'files' }, selected: { cs_1: { path: '/root/app', type: 'dir' } }, expanded: { cs_1: ['/root/app'] } });
    const html = dock({ ...seed, dirs: { ...seed.dirs, '/root/app': { path: '/root/app', truncated: true, entries: [{ name: 'main.py', path: '/root/app/main.py', type: 'file', size: 40, mtime: null, mode: '644' }] } } });
    expect(text(html)).toContain('~/app');
    expect(html).toMatch(/aria-selected="true"[^>]*data-path="\/root\/app"[^>]*class="[^"]*bg-accent[^"]*before:bg-primary-ink/);
    expect(text(html)).toContain('main.py');
    expect(text(html)).toContain('Showing the first 1 entries');
  });

  it('Ports tab: merged and sorted; Preview for previewable ports, "local only" for loopback', () => {
    useComputerUi.setState({ tabs: { cr_mock_sb1: 'ports' } });
    const html = dock(seed);
    const rows = [...html.matchAll(/data-port="(\d+)"/g)].map((m) => Number(m[1]));
    expect(rows).toEqual([5432, 8000]);
    const t = text(html);
    expect(t).toMatch(/5432 postgres · 127\.0\.0\.1 local only/);
    expect(t).toMatch(/8000 python3 · 0\.0\.0\.0 Preview/);
    expect(t).toContain('Services');
    expectDesignRules(html, { dino: false });
  });

  it('a preview tab: ":8000" next to the base tabs, the "untrusted content" frame and the slot', () => {
    useComputerUi.setState({ previews: { pv1: preview() }, tabs: { cr_mock_sb1: previewTab('pv1') } });
    const html = dock(seed);
    const t = text(html);
    expect(t).toMatch(/Ports\s*:8000/);
    expect(t).toContain('Preview of 8000-sbxkey.sandbox.example.test · untrusted content');
    expect(html).toContain('data-preview-slot="pv1"');
    expect(html).toMatch(/aria-label="Back"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Forward"[^>]*disabled/);
    expect(html).toContain('aria-label="Open externally"');
    expect(html).not.toContain('traffic');
  });

  it('a blocked preview explains itself and offers Reload', () => {
    useComputerUi.setState({ previews: { pv1: preview({ state: 'blocked', detail: 'Blocked a navigation to evil.example.' }) }, tabs: { cr_mock_sb1: previewTab('pv1') } });
    const t = text(dock(seed));
    expect(t).toContain('The preview tried to leave its address');
    expect(t).toContain('Blocked a navigation to evil.example.');
  });

  it('a stored tab that no longer exists (closed preview) falls back to the first tab', () => {
    useComputerUi.setState({ tabs: { cr_mock_sb1: previewTab('gone') } });
    expect(dock(seed)).toContain('data-terminal-host');
  });
});

describe('states (§8.7)', () => {
  it('paused with a session: the terminal stays visible under a read-only banner with Resume…', () => {
    const html = dock({ resources: [sandbox({ phase: 'paused' })], session: session({ state: 'paused' }) });
    const t = text(html);
    expect(t).toContain('Paused: the terminal is read-only');
    expect(t).toContain('Resume…');
    expect(html).toContain('data-terminal-host');
    expect(html).toContain('aria-label="Resume"');
    expect(html).not.toContain('aria-label="Pause"');
    expectDesignRules(html, { dino: false });
  });

  it('paused with no session: the reason and Resume… (files and ports wait)', () => {
    const t = text(dock({ resources: [sandbox({ phase: 'paused' })] }));
    expect(t).toContain('This computer is paused');
    expect(t).toContain('Resume…');
  });

  it('paused: Files and Ports say they come back when it runs', () => {
    useComputerUi.setState({ tabs: { cr_mock_sb1: 'files' } });
    const t = text(dock({ resources: [sandbox({ phase: 'paused' })], session: session({ state: 'paused' }) }));
    expect(t).toContain('Not available right now');
  });

  it('attached elsewhere: banner with Take over…', () => {
    const t = text(dock({ resources: [sandbox()], session: session({}, { state: 'attached_elsewhere' }) }));
    expect(t).toContain('This shell is open somewhere else');
    expect(t).toContain('Take over…');
  });

  it('closed (deleted remotely): the reason and Reconnect', () => {
    const t = text(dock({ resources: [sandbox()], session: session({ state: 'closed', reason: 'GMI deleted the sandbox (timeout).' }) }));
    expect(t).toContain('This computer’s session has ended');
    expect(t).toContain('GMI deleted the sandbox (timeout).');
  });

  it('starting: DinoLoader with the phase', () => {
    const html = dock({ resources: [sandbox({ phase: 'creating' })] });
    expect(text(html)).toContain('Starting');
    expect(html).toContain('data-mood="loading"');
  });

  it('cold resume: Restart services (n)', () => {
    const svc = { name: 'web', command: 'npm run dev', port: 5173, startedAt: new Date(now).toISOString() };
    expect(text(dock({ resources: [sandbox()], session: session({ coldResumed: true, services: [svc] }) }))).toContain('Restart services (1)');
  });
});

describe('containers (CE)', () => {
  it('Logs first; Terminal and Files explain why they are not available; no session is opened', () => {
    const calls = installBridge();
    const html = dock({ resources: [container()] });
    const t = text(html);
    expect(t).toMatch(/Logs.*Terminal.*Files/);
    expect(t).not.toContain('Ports');
    expect(html).toContain('Container log');
    expect(calls.invokes.filter((c) => c.ns === 'computer')).toHaveLength(0);
    useComputerUi.setState({ tabs: { cr_mock_ce1: 'terminal' } });
    expect(text(dock({ resources: [container()] }))).toContain('No terminal for containers yet');
    useComputerUi.setState({ tabs: { cr_mock_ce1: 'files' } });
    expect(text(dock({ resources: [container()] }))).toContain('Cluster Engine has no API for files');
  });

  it('status bar: $3.35/h list, no idle or server countdown, lease delete countdown', () => {
    const t = text(render(<StatusBar resource={container()} session={null} />));
    expect(t).toContain('$3.35/h list');
    expect(t).toMatch(/Deleted in 1 h 30 min|Deleted in 1 h 29 min/);
    expect(t).not.toContain('Idle pause');
  });
});

describe('dock logic', () => {
  it('dockTabs per kind', () => {
    expect(dockTabs(sandbox())).toEqual(['terminal', 'files', 'ports']);
    expect(dockTabs(container())).toEqual(['logs', 'terminal', 'files']);
  });

  it('resolveTab keeps a valid stored tab, else the first', () => {
    const tabs = dockTabs(sandbox());
    expect(resolveTab('files', tabs, [])).toBe('files');
    expect(resolveTab('logs', tabs, [])).toBe('terminal');
    expect(resolveTab(previewTab('p1'), tabs, ['p1'])).toBe('preview:p1');
    expect(resolveTab(previewTab('p2'), tabs, ['p1'])).toBe('terminal');
    expect(resolveTab(undefined, dockTabs(container()), [])).toBe('logs');
  });

  it('the inline dock leaves the page room; the sheet keeps a margin; the stored width never grows', () => {
    expect(effectiveDockWidth(480, 1360, false)).toBe(480);
    expect(effectiveDockWidth(960, 1360, false)).toBe(1360 - PAGE_MIN_PX);
    expect(effectiveDockWidth(960, 800, false)).toBe(DOCK_WIDTH.min);
    expect(effectiveDockWidth(480, 1000, true)).toBe(480);
    expect(effectiveDockWidth(960, 700, true)).toBe(652);
  });

  it('countdowns: soonest first, amber within 15 min, none unless running', () => {
    const r = sandbox({ serverEndsAt: inMin(20), idlePauseAt: inMin(12), leaseEndsAt: inMin(400) });
    const list = countdowns(r, now);
    expect(list.map((c) => c.key)).toEqual(['idle', 'server', 'lease']);
    expect(list.map((c) => c.soon)).toEqual([true, false, false]);
    expect(countdowns(sandbox({ phase: 'paused' }), now)).toEqual([]);
    expect(extendLabel(30)).toBe('+30 min');
    expect(extendLabel(240)).toBe('+4 h');
  });

  it('a pending action shows Plates in the phase badge', () => {
    const html = render(<StatusBar resource={sandbox({ pendingAction: 'extend' })} session={session()} />);
    expect(text(html)).toContain('Extending');
    expect(html).toContain('data-plates');
  });
});

describe('preview placement (§8.4)', () => {
  it('slot bounds are rounded; an empty slot hides the view', () => {
    expect(slotBounds({ left: 100.4, top: 80.6, width: 479.5, height: 600.2 })).toEqual({ x: 100, y: 81, width: 480, height: 600 });
    expect(slotBounds({ left: 0, top: 0, width: 0, height: 300 })).toBeNull();
    expect(slotBounds({ left: Number.NaN, top: 0, width: 10, height: 10 })).toBeNull();
  });

  it('the native view is shown only on its active tab, with no overlay open, the sheet at rest, and while live', () => {
    const base = { active: true, overlayCount: 0, sheetMoving: false, state: 'ready' as const };
    expect(viewVisible(base)).toBe(true);
    expect(viewVisible({ ...base, state: 'loading' })).toBe(true);
    expect(viewVisible({ ...base, overlayCount: 1 })).toBe(false);
    expect(viewVisible({ ...base, sheetMoving: true })).toBe(false);
    expect(viewVisible({ ...base, active: false })).toBe(false);
    expect(viewVisible({ ...base, state: 'blocked' })).toBe(false);
    expect(viewVisible({ ...base, state: 'failed' })).toBe(false);
  });

  it('the frame names the host, never the token', () => {
    expect(previewHost('https://8000-k.sandbox.example.test/app?x=1')).toBe('8000-k.sandbox.example.test');
    expect(previewHost('not a url')).toBe('not a url');
    const html = render(
      <PreviewFrame preview={preview({ state: 'loading' })} host="8000-k.example.test" onBack={() => {}} onForward={() => {}} onReload={() => {}} onExternal={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('data-plates');
    expect(text(html)).toContain('untrusted content');
  });
});

describe('narrow windows', () => {
  it('below 1,060 px the dock is a sheet over the page, with a scrim and a transform slide-in', () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window.innerWidth = 1000;
    const html = dock({ resources: [] });
    expect(html).toContain('data-dock="sheet"');
    expect(html).toContain('data-dock-scrim');
    const aside = /<aside[^>]*data-dock="sheet"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    for (const c of ['fixed', 'transition-transform', 'duration-200', 'ease-out', 'starting:translate-x-full', 'motion-reduce:transition-none']) expect(aside.split(' ')).toContain(c);
    expect(html).not.toMatch(/transition-all/);
  });

  it('opened from the keyboard, the sheet is simply there (no slide, no scrim fade), and only once', () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window.innerWidth = 1000;
    useComputerUi.setState({ sheetInstant: true });
    const html = dock({ resources: [] });
    const aside = /<aside[^>]*data-dock="sheet"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(aside.split(' ')).toContain('fixed');
    expect(aside).not.toMatch(/transition|starting:/);
    const scrim = /<div[^>]*data-dock-scrim=""[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(scrim).not.toMatch(/transition|starting:/);
    useComputerUi.setState({ sheetInstant: false });
    expect(/<aside[^>]*data-dock="sheet"[^>]*class="([^"]*)"/.exec(dock({ resources: [] }))?.[1]).toContain('starting:translate-x-full');
  });

  it('toggleDock marks keyboard opens instant and pointer opens animated', () => {
    useUi.setState({ page: 'chat', dock: { chat: { open: false, width: 480, resourceId: null }, code: { open: false, width: 480, resourceId: null }, compute: { open: false, width: 480, resourceId: null } } });
    toggleDock(undefined, { keyboard: true });
    expect(useComputerUi.getState().sheetInstant).toBe(true);
    toggleDock(false);
    toggleDock(true);
    expect(useComputerUi.getState().sheetInstant).toBe(false);
  });

  it('wide windows: inline, no scrim', () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window.innerWidth = 1360;
    const html = dock({ resources: [] });
    expect(html).toContain('data-dock="inline"');
    expect(html).not.toContain('data-dock-scrim');
  });
});
