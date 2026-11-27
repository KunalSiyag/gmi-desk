// F0 renderer foundation: Compute and Code pages (nav, shortcuts, palette, stubs), the store additions
// (openConnect(target), overlay counter, dock), query keys, the Settings section list, the dock and gateway stubs.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import type { GmiBridge } from '@shared/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import { parseShotSpecs, SHOT_PAGES } from '@main/dev/screenshots';
import { ComputerDock } from '@renderer/components/computer/ComputerDock';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { paletteFilter, paletteValue } from '@renderer/components/shell/palette-items';
import { GmiError } from '@shared/contracts/errors';
import { applyComputeResources } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import type { ComputeResource } from '@shared/contracts/compute';
import { DOCK_WIDTH, useUi } from '@renderer/lib/store';
import { CODE_SETTINGS_SECTIONS } from '@renderer/pages/registry.code';
import { COMPUTE_SETTINGS_SECTIONS, ComputeStubPage } from '@renderer/pages/registry.compute';
import { NAV_PAGES, PAGE_META } from '@renderer/pages/registry';
import SettingsPage from '@renderer/pages/settings';
import { BUILTIN_SETTINGS_SECTIONS, buildSettingsSections, SETTINGS_SECTIONS } from '@renderer/pages/settings/sections';
import { GatewayCard } from '@renderer/pages/usage/GatewayCard';

function installBridge() {
  const bridge: GmiBridge = {
    invoke: async () => ({ ok: false, error: { code: 'not_implemented', message: 'stub' } }),
    on: () => () => undefined,
    platform: 'linux',
  };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
}

function render(node: ReactNode, ui: Partial<ReturnType<typeof useUi.getState>> = {}, seed?: (client: QueryClient) => void): string {
  installBridge();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  // Server rendering reads the store's initial state (getServerSnapshot).
  const initial = useUi.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, ui);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  } finally {
    Object.assign(initial, saved);
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

afterEach(() => {
  useUi.setState(useUi.getInitialState(), true);
});

describe('navigation', () => {
  it('pages 1–5 keep their order and shortcuts; Code is 6 and Compute is 7', () => {
    expect(NAV_PAGES).toEqual(['chat', 'models', 'create', 'usage', 'docs', 'code', 'compute']);
    NAV_PAGES.forEach((id, i) => expect(PAGE_META[id].shortcut).toBe(String(i + 1)));
    expect(PAGE_META.code).toMatchObject({ id: 'code', title: 'Code', shortcut: '6' });
    expect(PAGE_META.compute).toMatchObject({ id: 'compute', title: 'Compute', shortcut: '7' });
    expect(PAGE_META.settings.shortcut).toBe(',');
  });

  it('the palette finds the pages by their own words', () => {
    const value = (id: 'code' | 'compute') => paletteValue(PAGE_META[id].title, ['go to', 'page', ...(PAGE_META[id].keywords ?? [])]);
    expect(paletteFilter(value('compute'), 'sandbox')).toBeGreaterThan(0);
    expect(paletteFilter(value('compute'), 'gpu')).toBeGreaterThan(0);
    expect(paletteFilter(value('code'), 'worktree')).toBeGreaterThan(0);
    expect(paletteFilter(value('code'), 'agent')).toBeGreaterThan(0);
  });

  it('the screenshot runner knows compute and code (both themes)', () => {
    expect(SHOT_PAGES).toEqual(expect.arrayContaining(['compute', 'code']));
    const specs = parseShotSpecs('compute,code#light,compute?tab=launch#light~900');
    expect(specs.map((s) => s.name)).toEqual(['compute', 'code-light', 'compute-light']);
    expect(specs[2]).toMatchObject({ nav: { page: 'compute', params: { tab: 'launch' } }, theme: 'light', waitMs: 900 });
    // The default run is unchanged.
    expect(parseShotSpecs(undefined).map((s) => s.name)).toEqual(['chat', 'models', 'create', 'usage', 'docs', 'settings', 'welcome']);
  });
});

describe('store additions', () => {
  it('openConnect(target): compute or inference; a click event (used as onClick) means inference', () => {
    const s = () => useUi.getState();
    s().setPaletteOpen(true);
    s().openConnect('compute');
    expect(s()).toMatchObject({ connectOpen: true, connectTarget: 'compute', paletteOpen: false });
    s().openConnect({ type: 'click' });
    expect(s()).toMatchObject({ connectOpen: true, connectTarget: 'inference' });
    s().openConnect();
    expect(s().connectTarget).toBe('inference');
    s().navigate('compute', { connect: 'compute' });
    expect(s()).toMatchObject({ connectOpen: true, connectTarget: 'compute' });
    s().navigate('chat', { connect: '1' });
    expect(s()).toMatchObject({ connectOpen: true, connectTarget: 'inference' });
    s().navigate('models');
    expect(s().connectOpen).toBe(false);
  });

  it('overlayCount: push returns an idempotent pop; popOverlay never goes below zero', () => {
    const s = () => useUi.getState();
    const a = s().pushOverlay();
    const b = s().pushOverlay();
    expect(s().overlayCount).toBe(2);
    a();
    a();
    expect(s().overlayCount).toBe(1);
    b();
    s().popOverlay();
    expect(s().overlayCount).toBe(0);
  });

  it('dock state is per page, closed by default, width clamped', () => {
    const s = () => useUi.getState();
    expect(s().dock.chat).toEqual({ open: false, width: DOCK_WIDTH.default, resourceId: null });
    s().setDock('code', { open: true, width: 5000, resourceId: 'cr_1' });
    expect(s().dock.code).toEqual({ open: true, width: DOCK_WIDTH.max, resourceId: 'cr_1' });
    expect(s().dock.chat.open).toBe(false);
    s().setDock('code', { width: 10 });
    expect(s().dock.code.width).toBe(DOCK_WIDTH.min);
    s().setDock('code', { width: Number.NaN, resourceId: null });
    expect(s().dock.code).toEqual({ open: true, width: DOCK_WIDTH.min, resourceId: null });
  });
});

describe('query keys', () => {
  it('compute data lives under ["compute"], computer sessions under ["computer"], code under ["code"]', () => {
    expect(qk.computeState[0]).toBe('compute');
    expect(qk.computeResource('cr_1')).toEqual(['compute', 'resource', 'cr_1']);
    expect(qk.computeCatalog()).toEqual(['compute', 'catalog', null]);
    expect(qk.computerSession('s1')).toEqual(['computer', 'session', 's1']);
    expect(qk.codeThread('t1')).toEqual(['code', 'thread', 't1']);
    expect(qk.gatewayStatus[0]).toBe('code');
  });

  it('managed-only and "Show all in organization" resource lists are separate caches', () => {
    expect(qk.computeResources()).toEqual(['compute', 'resources', false]);
    expect(qk.computeResources(true)).toEqual(['compute', 'resources', true]);
    expect(qk.computeResources(false).slice(0, 2)).toEqual([...qk.computeResourcesAll]);
  });

  it('a compute:resources event keeps unmanaged rows out of the managed-only list', () => {
    const client = new QueryClient();
    const mine = { id: 'cr_mine', managed: true } as ComputeResource;
    const theirs = { id: 'cr_theirs', managed: false } as ComputeResource;
    applyComputeResources(client, [mine, theirs]);
    expect(client.getQueryData(qk.computeResources(false))).toEqual([mine]);
    expect(client.getQueryData(qk.computeResources(true))).toEqual([mine, theirs]);
    client.clear();
  });
});

describe('stub pages', () => {
  it.each([['compute', ComputeStubPage, 'No computers yet']] as const)('%s: sleeping Dino, the page description, no lime fill', (_id, Page, title) => {
    const html = render(<Page />);
    expect(html).toContain('data-mood="sleep"');
    expect(text(html)).toContain(title);
    expect(text(html)).toContain('Coming next');
    expect(html).not.toMatch(/\bbg-primary\b/);
  });

  it('the dock renders nothing while closed, and a panel when open on a dock page', () => {
    expect(render(<ComputerDock />, { page: 'chat' })).toBe('');
    expect(render(<ComputerDock />, { page: 'models' })).toBe('');
    const open = render(<ComputerDock />, {
      page: 'compute',
      dock: { chat: { open: false, width: 480, resourceId: null }, code: { open: false, width: 480, resourceId: null }, compute: { open: true, width: 400, resourceId: null } },
    });
    expect(open).toContain('aria-label="Computer"');
    expect(open).toContain('width:400px');
    // Still nothing on a page whose dock is closed, even when another page's is open.
    expect(
      render(<ComputerDock />, {
        page: 'chat',
        dock: { chat: { open: false, width: 480, resourceId: null }, code: { open: true, width: 480, resourceId: null }, compute: { open: true, width: 480, resourceId: null } },
      }),
    ).toBe('');
  });

  it('the gateway card renders nothing until the gateway exists', () => {
    expect(render(<GatewayCard />)).toBe('');
  });
});

describe('Settings sections', () => {
  it('built-ins keep their order (About last); features add sections through their registration', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['account', 'keys', 'compute-key', 'security', 'appearance', 'catalog', 'chat', 'media', 'code', 'about']);
    expect(COMPUTE_SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['compute-key']);
    expect(CODE_SETTINGS_SECTIONS[0]).toMatchObject({ id: 'code', label: 'Code' });
  });

  it('a feature can never replace a built-in section', () => {
    const fake = { id: 'account', label: 'Hijack', icon: BUILTIN_SETTINGS_SECTIONS[0]!.icon, order: 1, Component: () => null };
    const list = buildSettingsSections([fake]);
    expect(list.filter((s) => s.id === 'account')).toHaveLength(1);
    expect(list.find((s) => s.id === 'account')!.label).toBe('Account');
  });

  it('the Settings page lists and renders the Code section', () => {
    const state = {
      status: 'signed_in',
      scopes: [],
      orgId: null,
      signedInAt: null,
      accessTokenExpiresAt: null,
      inferenceKey: { status: 'valid', source: 'keychain', last4: 'abcd', keyId: 'k', scope: 'ie_model', orgId: null, orgMatchesAccount: null, validatedAt: null, error: null },
      secureStorage: 'os',
      lastError: null,
      mock: true,
    } satisfies AuthState;
    const html = render(<SettingsPage />, { page: 'settings' }, (client) => client.setQueryData(qk.auth, state));
    expect(html).toContain('id="settings-code"');
    expect(html).toContain('data-settings-section="code"');
    const nav = html.slice(html.indexOf('aria-label="Settings sections"'), html.indexOf('</nav>'));
    expect(text(nav)).toMatch(/Media Code About/);
    expect(html).toContain('id="settings-about"');
  });
});

describe('ErrorNotice actions for the new codes', () => {
  it.each([
    ['no_compute_key', 'Connect Compute'],
    ['invalid_compute_key', 'Replace Compute key'],
    ['not_entitled', 'GMI Console'],
    ['quota_exceeded', 'GMI Console'],
  ] as const)('%s → %s', (code, label) => {
    const html = render(<ErrorNotice error={new GmiError(code, 'x')} />);
    expect(text(html)).toContain(label);
  });

  it('harness codes show their hint without a misleading action', () => {
    for (const code of ['context_overflow', 'limit_reached', 'permission_denied', 'conflict'] as const) {
      const html = render(<ErrorNotice error={new GmiError(code, 'x')} />);
      expect(html).not.toContain('<button');
    }
  });
});
