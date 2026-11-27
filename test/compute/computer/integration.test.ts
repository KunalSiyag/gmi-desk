// C2 integration: the compute slice in mock mode → the computer service with every part (files, transfers, ports,
// services, previews). Every non-session ComputerApi method is served, end to end, on the simulator.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import { COMPUTER_API_METHODS, type PreviewInfo, type TerminalChunk } from '@shared/contracts/compute';
import type { AuthService } from '@main/core/services';
import { createComputeSlice } from '@main/services/compute';
import { createComputerService, type ComputerServiceInstance } from '@main/services/compute/computer';
import { computerParts } from '@main/services/compute/computer/parts';
import { screenshotRun } from '@main/slices/compute';
import { mainWindowHidden, watchPageGone } from '@main/slices/computer';
import { createBudgetService } from '@main/services/usage/budget';
import { openSpendLedger } from '@main/services/usage/ledger';
import { createTestContext, type TestContext } from '../../helpers/context';
import { fakeComputeKeys } from '../fakes';
import { until } from './c2a-fakes';

const COMPUTE_KEY = 'ck-compute-key-secret-000000000001';
const SB = 'cr_mock_sb1';

function fakeAuth(): AuthService {
  return { getState: () => ({}) as AuthState, isSignedIn: () => true, onChange: () => () => undefined };
}

let t: TestContext | null = null;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await t?.cleanup();
  t = null;
});

async function wire(): Promise<{ svc: ComputerServiceInstance }> {
  t = await createTestContext({ mock: true });
  const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => new Date() });
  const budgets = await createBudgetService({ ctx: t.ctx, ledger });
  // The mock Compute scenario's default daily budget (the usage slice seeds it in the app): the demo sandboxes' burn
  // must fit, or the cost guard holds them before the terminal prints a prompt.
  await budgets.setBudget({ dailyUsd: 25 });
  const slice = await createComputeSlice(t.ctx, { auth: fakeAuth(), keys: fakeComputeKeys(COMPUTE_KEY), catalog: {} as never, budget: budgets.guard, budgetSources: budgets.sources });
  await slice.api.dismissAlarm('none'); // waits for startup (seeded demo resources)
  const svc = createComputerService(t.ctx, {
    compute: { internals: slice.internals, backends: slice.backends ?? null },
    parts: [computerParts({ windowHidden: () => false, preview: { tokenSyncMs: 0 } })],
  });
  cleanups.push(async () => {
    await slice.dispose();
    budgets.dispose();
    await ledger.flush();
  });
  cleanups.push(() => svc.dispose());
  return { svc };
}

const emitted = (name: string) => t!.emitted.filter((e) => e.name === name).map((e) => e.payload);

describe('the computer, end to end in mock mode', () => {
  it('serves every ComputerApi method (none answers not_implemented)', async () => {
    const { svc } = await wire();
    const info = await svc.api.open(SB);
    for (const m of COMPUTER_API_METHODS) expect(typeof svc.api[m]).toBe('function');
    // A not_implemented stub would reject synchronously with that code for any input; these refuse the bad id instead.
    for (const m of ['listDir', 'listPorts', 'getResourceUsage', 'upload', 'download'] as const) {
      await expect((svc.api[m] as (sid: string, p?: string) => Promise<unknown>)('cs_00000000-0000-4000-8000-000000000000', '/')).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(info.state).toBe('ready');
  });

  it('terminal, files, ports, services, usage and a placeholder preview on the demo sandbox', async () => {
    const { svc } = await wire();
    const info = await svc.api.open(SB);
    expect(info).toMatchObject({ state: 'ready', home: '/root' });
    const sid = info.sessionId;

    // Terminal: live fake PTY.
    await svc.api.terminalVisibility(sid, true);
    await svc.api.terminalAttach(sid, { cols: 100, rows: 30 });
    const text = () =>
      (emitted('computer:terminal') as TerminalChunk[])
        .filter((c) => c.sessionId === sid)
        .map((c) => new TextDecoder().decode(c.data))
        .join('');
    await until(() => text().includes('# '), 2000, 'prompt');
    await svc.api.terminalInput(sid, 'echo integrated\r');
    await until(() => text().includes('integrated\r\n'), 2000, 'echo');

    // Files.
    const root = await svc.api.listDir(sid, '/root');
    expect(root.entries.map((e) => e.name)).toContain('app');
    await svc.api.makeDir(sid, '/root/c2');
    await svc.api.writeFile(sid, '/root/c2/hello.txt', 'hi from C2\n');
    expect((await svc.api.readFile(sid, '/root/c2/hello.txt')).text).toBe('hi from C2\n');
    await svc.api.movePath(sid, '/root/c2/hello.txt', '/root/c2/moved.txt');
    expect((await svc.api.listDir(sid, '/root/c2')).entries.map((e) => e.name)).toEqual(['moved.txt']);
    await svc.api.removePath(sid, '/root/c2');
    expect((await svc.api.listDir(sid, '/root')).entries.map((e) => e.name)).not.toContain('c2');

    // Services and ports.
    const after = await svc.api.startService(sid, { name: 'web', command: 'python3 -m http.server 8000', port: 8000 });
    expect(after.services.map((s) => s.name)).toContain('web');
    const ports = await svc.api.listPorts(sid);
    expect(ports.map((p) => p.port)).toContain(8000);

    // Resources popover.
    expect((await svc.api.getResourceUsage(sid)).text.length).toBeGreaterThan(0);

    // Preview: placeholder host in mock mode (no native view, no network).
    const pv = await svc.api.openPreview(sid, 8000, '/');
    expect(pv.url).toMatch(/^https:\/\/8000-/);
    await until(() => (emitted('computer:preview') as PreviewInfo[]).some((p) => p.previewId === pv.previewId && p.state === 'ready'), 2000, 'preview ready');

    // A renderer reload closes the previews (their ids are lost) and starts the warm period.
    svc.viewsGone();
    expect((emitted('computer:preview') as PreviewInfo[]).at(-1)).toMatchObject({ previewId: pv.previewId, state: 'closed' });
    await expect(svc.api.capturePreview(pv.previewId)).resolves.toBeNull();

    // Closing the session cancels everything of it.
    svc.sessions?.closeNow(sid, null);
    await expect(svc.api.listDir(sid, '/root')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('slice helpers', () => {
  it('review: the compute quit dialog is skipped only in a screenshot run', () => {
    expect(screenshotRun({ GMI_DESK_SHOTS: '/tmp/x' })).toBe(true);
    expect(screenshotRun({ GMI_DESK_SHOTS: '  ' })).toBe(false);
    expect(screenshotRun({})).toBe(false);
  });

  it('mainWindowHidden: minimised or hidden counts; an offscreen (screenshot) window does not', () => {
    const win = (o: { min?: boolean; vis?: boolean; off?: boolean; dead?: boolean }) => ({
      isDestroyed: () => Boolean(o.dead),
      isMinimized: () => Boolean(o.min),
      isVisible: () => Boolean(o.vis),
      webContents: { isOffscreen: () => Boolean(o.off) },
    });
    expect(mainWindowHidden(null)).toBe(true);
    expect(mainWindowHidden(win({ dead: true, vis: true }))).toBe(true);
    expect(mainWindowHidden(win({ vis: true }))).toBe(false);
    expect(mainWindowHidden(win({ vis: true, min: true }))).toBe(true);
    expect(mainWindowHidden(win({ vis: false }))).toBe(true);
    expect(mainWindowHidden(win({ vis: false, off: true }))).toBe(false);
  });

  it('watchPageGone: a main-frame cross-document navigation (reload) or a crash calls back; in-page and subframe ones do not', () => {
    const handlers = new Map<string, (...a: never[]) => void>();
    const win = { webContents: { on: (e: string, l: (...a: never[]) => void) => handlers.set(e, l) } };
    let gone = 0;
    watchPageGone(win as never, () => (gone += 1));
    const nav = handlers.get('did-start-navigation') as unknown as (d: { isMainFrame: boolean; isSameDocument: boolean }) => void;
    nav({ isMainFrame: true, isSameDocument: true });
    nav({ isMainFrame: false, isSameDocument: false });
    expect(gone).toBe(0);
    nav({ isMainFrame: true, isSameDocument: false });
    (handlers.get('render-process-gone') as unknown as () => void)();
    expect(gone).toBe(2);
  });
});
