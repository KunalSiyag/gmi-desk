// Shared fixtures for the computer dock's renderer tests (C2-D): synthetic resources and sessions, a fake bridge that
// records invokes, seeded query caches and static rendering (react-dom/server: effects do not run, nothing fetches).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeResource, ComputerSessionInfo, DirListing, PortInfo } from '@shared/contracts/compute';
import type { GmiBridge } from '@shared/contracts';
import { qk } from '@renderer/lib/query';
import { computerKeys } from '@renderer/components/computer/session';
import { defaultLease } from '@renderer/pages/compute/format';

export const now = Date.now();
export const ago = (min: number) => new Date(now - min * 60_000).toISOString();
export const inMin = (min: number) => new Date(now + min * 60_000).toISOString();

export const CAPS_SB = { terminal: true, files: true, previews: true, logs: false, restart: false, pause: true, snapshot: true, extend: true, network: false };
export const CAPS_CE = { terminal: false, files: false, previews: false, logs: true, restart: true, pause: false, snapshot: false, extend: true, network: true };

export function sandbox(patch: Partial<ComputeResource> = {}): ComputeResource {
  return {
    id: 'cr_mock_sb1',
    kind: 'sandbox',
    backend: 'sandbox_v2',
    remoteId: 'sbx-mock-0001',
    name: 'python-dev',
    displayName: 'python-dev',
    managed: true,
    purpose: 'computer',
    threadId: null,
    phase: 'running',
    rawState: 'running',
    reason: null,
    idc: 'us-central-iowa2',
    sku: 'gmi.sandbox.small',
    templateName: 'Python',
    listUsdPerHour: 0.0911,
    createdAt: ago(40),
    runningSince: ago(39),
    serverEndsAt: inMin(20),
    leaseEndsAt: inMin(400),
    pausedExpiresAt: null,
    idlePauseAt: inMin(12),
    lease: defaultLease('sandbox'),
    accruedUsd: 0.06,
    accruedTodayUsd: 0.05,
    network: null,
    secure: true,
    egressLocked: false,
    capabilities: CAPS_SB,
    pendingAction: null,
    actionPending: null,
    updatedAt: ago(1),
    ...patch,
  };
}

export function container(patch: Partial<ComputeResource> = {}): ComputeResource {
  return {
    ...sandbox(),
    id: 'cr_mock_ce1',
    kind: 'container',
    backend: 'ce',
    remoteId: '00000000-0000-4000-8000-00000000d001',
    name: 'gmid-a1b2c3-h200-notebook-a7k2qp',
    displayName: 'h200-notebook',
    idc: 'asia-east-taiwan3',
    sku: 'gmi.container.nv.H200x1.tw3',
    listUsdPerHour: 3.35,
    serverEndsAt: null,
    idlePauseAt: null,
    leaseEndsAt: inMin(90),
    lease: defaultLease('container'),
    accruedUsd: 8.37,
    accruedTodayUsd: 8.37,
    secure: null,
    egressLocked: null,
    capabilities: CAPS_CE,
    ...patch,
  };
}

export function session(patch: Partial<ComputerSessionInfo> = {}, terminal: Partial<ComputerSessionInfo['terminal']> = {}): ComputerSessionInfo {
  return {
    sessionId: 'cs_1',
    resourceId: 'cr_mock_sb1',
    state: 'ready',
    reason: null,
    terminal: { state: 'attached', cols: 80, rows: 24, lastSeq: 12, ...terminal },
    home: '/root',
    user: 'root',
    coldResumed: false,
    services: [],
    execInUse: 1,
    ...patch,
  };
}

export const ROOT_LISTING: DirListing = {
  path: '/root',
  truncated: false,
  entries: [
    { name: 'notes.txt', path: '/root/notes.txt', type: 'file', size: 1530, mtime: ago(5), mode: '644' },
    { name: 'app', path: '/root/app', type: 'dir', size: 4096, mtime: ago(9), mode: '755' },
    { name: '.bashrc', path: '/root/.bashrc', type: 'file', size: 3771, mtime: ago(90), mode: '644' },
    { name: 'data', path: '/root/data', type: 'dir', size: 4096, mtime: ago(20), mode: '755' },
  ],
};

export const PORTS: PortInfo[] = [
  { port: 8000, address: '0.0.0.0', process: 'python3', previewable: true },
  { port: 5432, address: '127.0.0.1', process: 'postgres', previewable: false },
  { port: 8000, address: '::', process: null, previewable: true },
];

export interface Calls {
  invokes: Array<{ ns: string; method: string; args: unknown[] }>;
}

/** A bridge whose every invoke resolves with `answer(ns, method, args)` (default null) and is recorded. */
export function installBridge(answer: (ns: string, method: string, args: unknown[]) => unknown = () => null): Calls {
  const calls: Calls = { invokes: [] };
  const bridge: GmiBridge = {
    invoke: async (ns, method, args) => {
      calls.invokes.push({ ns, method, args });
      return { ok: true, data: answer(ns, method, args) as never };
    },
    on: () => () => undefined,
    platform: 'linux',
  };
  (globalThis as { window?: unknown }).window = { gmi: bridge, setInterval, clearInterval, setTimeout, clearTimeout };
  return calls;
}

export function removeBridge(): void {
  delete (globalThis as { window?: unknown }).window;
}

export interface Seed {
  resources?: ComputeResource[];
  session?: ComputerSessionInfo | null;
  dirs?: Record<string, DirListing>;
  ports?: PortInfo[];
  extra?: (client: QueryClient) => void;
}

export function client(seed: Seed = {}): QueryClient {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed.resources) c.setQueryData(qk.computeResources(false), seed.resources);
  const s = seed.session;
  if (s) {
    c.setQueryData(computerKeys.session(s.resourceId), s);
    for (const [path, listing] of Object.entries(seed.dirs ?? {})) c.setQueryData(computerKeys.dir(s.sessionId, path), listing);
    if (seed.ports) c.setQueryData(computerKeys.ports(s.sessionId), seed.ports);
  }
  seed.extra?.(c);
  return c;
}

export function render(node: ReactNode, seed: Seed = {}): string {
  return renderToStaticMarkup(<QueryClientProvider client={client(seed)}>{node}</QueryClientProvider>);
}

/** Visible text of static markup. */
export const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

/** Buttons with the lime fill (Button variant="default"). */
export const limeButtons = (html: string) => (html.match(/<button[^>]*class="[^"]*\bbg-primary text-primary-foreground[^"]*"/g) ?? []).length;

/** D16–D18 on every dock screen: at most one lime fill, the kit Select only, no Dino outside empty/loading states. */
export function expectDesignRules(html: string, opts: { dino?: boolean } = {}): void {
  if (limeButtons(html) > 1) throw new Error(`more than one lime fill: ${limeButtons(html)}`);
  if (/<select[\s>]|<option[\s>]/.test(html)) throw new Error('native select');
  const dino = /data-mood="/.test(html);
  if (opts.dino === false && dino) throw new Error('Dino where it does not belong');
}
