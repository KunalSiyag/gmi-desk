// F0 shared foundation (compute.md §21.0, harness.md §24): the new namespaces, events, error codes and stubs.
import { describe, expect, it } from 'vitest';
import {
  API_NAMESPACES,
  CODE_API_METHODS,
  COMPUTE_API_METHODS,
  COMPUTER_API_METHODS,
  ERROR_HINTS,
  EVENT_NAMES,
  invokeChannel,
  isGmiError,
  type GmiErrorCode,
  type GmiEventName,
  type GmiNamespace,
} from '@shared/contracts';
import { CONSOLE_PAGES, consoleDeepLink, consoleUrl, GMI_URLS } from '@shared/app';
import { estimateTokenCostUsd } from '@shared/lib/money';
import { DEV_ENV_VARS, stripDevEnv } from '@main/core/dev-env';
import { silentLogger } from '@main/core/logger';
import { listDiagnosticsActions, registerDiagnosticsAction, type SliceHost } from '@main/core/services';
import { createNotImplementedApi, methodNames, QUIET_CODES, registerApi, type IpcMainLike } from '@main/ipc/registry';
import { createAuthSliceWith } from '@main/services/auth';
import { createUnavailableComputeKeys } from '@main/services/auth/compute-keys';
import { notImplementedCodeApi, setupCodeSlice } from '@main/slices/code';
import { notImplementedComputeApi, setupComputeSlice } from '@main/slices/compute';
import { notImplementedComputerApi, setupComputerSlice } from '@main/slices/computer';
import { notImplementedGateway, setupGatewaySlice } from '@main/slices/gateway';
import { setupHarnessSlice } from '@main/slices/harness';
import { createTestContext } from '../helpers/context';

// Compile-time: the runtime lists name every namespace and event of the GmiApi / GmiEvents types.
type MissingNamespaces = Exclude<GmiNamespace, (typeof API_NAMESPACES)[number]>;
type MissingEvents = Exclude<GmiEventName, (typeof EVENT_NAMES)[number]>;
const namespacesComplete: [MissingNamespaces] extends [never] ? true : false = true;
const eventsComplete: [MissingEvents] extends [never] ? true : false = true;

const NEW_EVENTS = [
  'compute:state',
  'compute:resources',
  'compute:alarm',
  'computer:session',
  'computer:terminal',
  'computer:transfer',
  'computer:preview',
  'code:state',
  'code:threads',
  'code:event',
  'code:approval',
  'code:gateway',
] as const satisfies readonly GmiEventName[];

const NEW_CODES = [
  'no_compute_key',
  'invalid_compute_key',
  'not_entitled',
  'quota_exceeded',
  'conflict',
  'context_overflow',
  'limit_reached',
  'permission_denied',
] as const satisfies readonly GmiErrorCode[];

const sorted = (list: readonly string[]) => [...list].sort();

function fakeIpc() {
  const handlers = new Map<string, (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
  };
  return { ipc, handlers };
}

function recordingHost() {
  const registered = new Map<GmiNamespace, object>();
  const disposers: Array<() => void | Promise<void>> = [];
  const host: SliceHost = {
    registerApi: (ns, api) => {
      registered.set(ns, api as object);
    },
    onDispose: (d) => {
      disposers.push(d);
    },
  };
  return { host, registered, disposers };
}

describe('namespaces and events', () => {
  it('lists compute, computer and code (and keeps the existing ones in place)', () => {
    expect(namespacesComplete && eventsComplete).toBe(true);
    expect(API_NAMESPACES.slice(0, 8)).toEqual(['app', 'auth', 'catalog', 'chat', 'media', 'usage', 'docs', 'support']);
    expect(API_NAMESPACES).toEqual(expect.arrayContaining(['compute', 'computer', 'code']));
    expect(new Set(API_NAMESPACES).size).toBe(API_NAMESPACES.length);
  });

  it('lists every new event exactly once', () => {
    for (const name of NEW_EVENTS) expect(EVENT_NAMES.filter((e) => e === name)).toHaveLength(1);
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });

  it('method lists are unique and valid IPC method names', () => {
    for (const list of [COMPUTE_API_METHODS, COMPUTER_API_METHODS, CODE_API_METHODS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const m of list) expect(m).toMatch(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/);
    }
  });
});

describe('slice stubs (src/main/slices)', () => {
  const cases = [
    ['compute', notImplementedComputeApi, COMPUTE_API_METHODS],
    ['computer', notImplementedComputerApi, COMPUTER_API_METHODS],
    ['code', notImplementedCodeApi, CODE_API_METHODS],
  ] as const;

  it.each(cases)('the %s stub exposes exactly the interface methods, each rejecting with not_implemented', async (_ns, make, methods) => {
    const api = make() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    expect(sorted(methodNames(api))).toEqual(sorted(methods));
    for (const m of methods) {
      const error = await api[m]!().then(
        () => null,
        (e: unknown) => e,
      );
      expect(isGmiError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('not_implemented');
    }
  });

  it('registers compute, computer and code over IPC: compute answers (C1), the others not_implemented', async () => {
    const t = await createTestContext();
    try {
      const { host, registered } = recordingHost();
      const budget = { check: async () => ({}) as never, record: async () => undefined, statusSnapshot: () => ({}) as never };
      const sources = { register: () => () => undefined };
      const auth = { getState: () => ({}) as never, isSignedIn: () => false, onChange: () => () => undefined };
      const catalog = { getSnapshot: async () => ({}) as never, findModel: async () => null };
      const keys = { getInferenceKey: async () => null, requireInferenceKey: async () => '', reportInvalidKey: async () => undefined };
      const mcp = { callTool: async () => ({}) as never };
      const gw = await setupGatewaySlice(t.ctx, { keys, catalog, budget, budgetSources: sources }, host);
      const compute = await setupComputeSlice(t.ctx, { auth, keys: createUnavailableComputeKeys(), catalog, budget, budgetSources: sources }, host);
      await setupComputerSlice(t.ctx, { compute }, host);
      const harness = await setupHarnessSlice(t.ctx, { gateway: gw.gateway, mcp, auth, budget, compute }, host);
      await setupCodeSlice(t.ctx, { gateway: gw.gateway, harness, compute }, host);
      expect([...registered.keys()]).toEqual(['compute', 'computer', 'code']);

      const { ipc, handlers } = fakeIpc();
      const appFrame = { senderFrame: { url: 'app://gmi-desk/index.html' } };
      for (const [ns, api] of registered) registerApi(ipc, ns, api as never, { log: silentLogger, isTrustedSender: () => true });
      expect(handlers.size).toBe(COMPUTE_API_METHODS.length + COMPUTER_API_METHODS.length + CODE_API_METHODS.length);
      const result = await handlers.get(invokeChannel('compute', 'delete'))!(appFrame, 'cr_x');
      expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await handlers.get(invokeChannel('code', 'send'))!(appFrame, 't', 'hi')).toMatchObject({ ok: false, error: { code: 'internal' } });
    } finally {
      await t.cleanup();
    }
  });

  it('the gateway stub refuses every call (stream fails on first read)', async () => {
    const gw = notImplementedGateway();
    expect(() => gw.status()).toThrow(/not available/);
    expect(() => gw.threadSpend('t')).toThrow();
    const iterator = gw.stream({} as never, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'not_implemented' });
  });

  it('the Compute key provider until C1-A: no key, require → no_compute_key, reports and listeners are no-ops', async () => {
    const keys = createUnavailableComputeKeys();
    expect(await keys.getComputeKey()).toBeNull();
    await expect(keys.requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key' });
    await expect(keys.reportInvalidComputeKey('401', 'k', 401)).resolves.toBeUndefined();
    const off = keys.onChange(() => undefined);
    expect(() => off()).not.toThrow();
  });

  it('the auth slice hands out the Compute key provider (DC1), in mock and real mode', async () => {
    for (const mock of [true, false]) {
      const t = await createTestContext({ mock });
      try {
        const auth = await createAuthSliceWith(t.ctx, {
          // No network: any request fails (signed out anyway, so nothing should be sent).
          fetch: async () => {
            throw new Error('no network in tests');
          },
          envKey: null,
          mockScenario: '',
          learnOrgOnStart: false,
          probeInferenceOnStart: false,
        });
        try {
          expect(await auth.computeKeys.getComputeKey()).toBeNull();
          await expect(auth.computeKeys.requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key' });
        } finally {
          await auth.dispose();
        }
      } finally {
        await t.cleanup();
      }
    }
  });

  it('createNotImplementedApi only creates the listed methods', () => {
    const api = createNotImplementedApi<{ a(): Promise<void>; b(): Promise<void> }>('X', ['a', 'b']);
    expect(sorted(Object.keys(api))).toEqual(['a', 'b']);
  });
});

describe('error codes', () => {
  it('ERROR_HINTS has a distinct, non-empty hint for every code', () => {
    const hints = Object.entries(ERROR_HINTS);
    for (const code of NEW_CODES) expect(ERROR_HINTS[code]).toBeTruthy();
    for (const [, hint] of hints) expect(hint.trim().length).toBeGreaterThan(3);
    expect(new Set(hints.map(([, h]) => h)).size).toBe(hints.length);
  });

  it('compute and harness outcomes the user acts on are quiet in the IPC log', () => {
    for (const code of ['no_compute_key', 'not_entitled', 'permission_denied', 'limit_reached'] as const) expect(QUIET_CODES.has(code)).toBe(true);
    for (const code of ['not_signed_in', 'no_api_key', 'cancelled', 'budget_exceeded'] as const) expect(QUIET_CODES.has(code)).toBe(true);
    expect(QUIET_CODES.has('internal')).toBe(false);
  });
});

describe('console links', () => {
  const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

  it('adds the compute console pages and the v2 API base', () => {
    expect(GMI_URLS.consoleApiV2).toBe('https://console.gmicloud.ai/api/v2');
    expect(CONSOLE_PAGES).toMatchObject({ computeHome: '/user-console/ce', containers: '/user-console/ce/containers', firewalls: '/user-console/ce/firewalls' });
    expect(consoleUrl('sshKeys')).toContain(encodeURIComponent('/user-setting/ce/access/ssh-keys'));
  });

  it('consoleDeepLink builds fixed paths through the sign-in callback', () => {
    const detail = new URL(consoleDeepLink('container', ID));
    expect(detail.origin).toBe('https://console.gmicloud.ai');
    expect(detail.pathname).toBe('/auth/sign-in');
    expect(detail.searchParams.get('callbackUrl')).toBe(`/user-console/ce/containers/${ID}`);
    expect(new URL(consoleDeepLink('container', ID.toUpperCase(), 'logs')).searchParams.get('callbackUrl')).toBe(`/user-console/ce/containers/${ID}/logs`);
    for (const view of ['monitor', 'reconfigure', 'renew'] as const) {
      expect(new URL(consoleDeepLink('container', ID, view)).searchParams.get('callbackUrl')).toBe(`/user-console/ce/containers/${ID}/${view}`);
    }
  });

  it.each([
    '',
    'abc',
    '../../user-setting/ie/api-keys',
    `${ID}/../../x`,
    `${ID}?x=1`,
    ` ${ID}`,
    `${ID}0`,
    '3f2b8c1e9a4d4e6f8b2a1c3d5e7f9a0b',
    'zf2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b',
  ])('consoleDeepLink rejects the non-UUID %j', (id) => {
    expect(() => consoleDeepLink('container', id)).toThrow(/UUID/);
  });

  it('consoleDeepLink rejects unknown views and kinds', () => {
    expect(() => consoleDeepLink('container', ID, '/../billing' as never)).toThrow(/view/);
    expect(() => consoleDeepLink('toString' as never, ID)).toThrow(/kind/);
    expect(() => consoleDeepLink('container', 42 as never)).toThrow(/UUID/);
  });
});

describe('money: the cache-write term', () => {
  const pricing = { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 };

  it('charges cache writes at their own rate, as part of the prompt', () => {
    // (1000 − 200 − 300) × 1 + 200 × 0.1 + 300 × 1.25 + 100 × 4 = 500 + 20 + 375 + 400 = 1295 per 1e6
    expect(estimateTokenCostUsd({ promptTokens: 1000, cachedTokens: 200, cacheWriteTokens: 300, completionTokens: 100 }, pricing)).toBeCloseTo(0.001295, 9);
  });

  it('is unchanged without cache writes, and falls back to the input price', () => {
    const base = estimateTokenCostUsd({ promptTokens: 1000, cachedTokens: 200, completionTokens: 100 }, pricing);
    expect(base).toBeCloseTo((800 * 1 + 200 * 0.1 + 100 * 4) / 1e6, 12);
    const noWriteRate = { inputPerMTok: 1, outputPerMTok: 4 };
    expect(estimateTokenCostUsd({ promptTokens: 1000, cacheWriteTokens: 500, completionTokens: 0 }, noWriteRate)).toBeCloseTo(0.001, 12);
  });

  it('clamps cache writes to the uncached prompt and applies the discount', () => {
    const v = estimateTokenCostUsd({ promptTokens: 100, cachedTokens: 80, cacheWriteTokens: 999, completionTokens: 0 }, pricing, 0.5);
    expect(v).toBeCloseTo(((80 * 0.1 + 20 * 1.25) / 1e6) * 0.5, 12);
  });
});

describe('dev-only environment and diagnostics', () => {
  it('packaged builds drop the compute/code mock flags and the trace switch', () => {
    for (const name of ['GMI_DESK_MOCK_COMPUTE', 'GMI_DESK_MOCK_CODE', 'GMI_DESK_TRACE'] as const) expect(DEV_ENV_VARS).toContain(name);
    const env: Record<string, string | undefined> = { GMI_DESK_TRACE: '1', GMI_DESK_MOCK_COMPUTE: 'orphan', GMI_DESK_MOCK_CODE: 'queued', HOME: '/h' };
    expect(stripDevEnv(env, true)).toEqual(expect.arrayContaining(['GMI_DESK_TRACE', 'GMI_DESK_MOCK_COMPUTE', 'GMI_DESK_MOCK_CODE']));
    expect(env).toEqual({ HOME: '/h' });
  });

  it('registers, lists and unregisters Diagnostics actions; ids are validated', async () => {
    const off = registerDiagnosticsAction({ id: 'test.probe', label: 'Probe', description: 'd', paid: false, run: async () => 'ok' });
    expect(listDiagnosticsActions().map((a) => a.id)).toContain('test.probe');
    await expect(listDiagnosticsActions().find((a) => a.id === 'test.probe')!.run()).resolves.toBe('ok');
    off();
    expect(listDiagnosticsActions().map((a) => a.id)).not.toContain('test.probe');
    expect(() => registerDiagnosticsAction({ id: '../x', label: '', description: '', paid: false, run: async () => '' })).toThrow();
  });
});
