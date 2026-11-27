// Fakes for the C1-C lifecycle tests: a recording AlarmCenter, a scriptable Guard, a fixed PriceBook, and an
// environment that builds registry + journal + supervisor over a temp dir with either fake-HTTP clients (real CE / v2
// clients over a fake fetch) or the mock simulators.
import { GmiError } from '@shared/contracts/errors';
import type { ComputeAlarm, LeasePolicy } from '@shared/contracts/compute';
import { silentLogger } from '@main/core/logger';
import type { ComputeKeyProvider } from '@main/core/services';
import { createCeClient } from '@main/services/compute/ce/client';
import { createJournal, type Journal } from '@main/services/compute/journal';
import { blankRecord, createRegistry } from '@main/services/compute/registry';
import { createSandboxClient } from '@main/services/compute/sandbox/client';
import { createServerClock, createSupervisor, type ComputeSupervisor, type MutableServerClock } from '@main/services/compute/supervisor';
import type {
  AlarmCenter,
  AlarmInput,
  ComputeRecord,
  Guard,
  LeaseChangeAssessment,
  PriceBook,
  QuoteAssessment,
  QuoteAssessmentInput,
  Registry,
} from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeComputeKeys, fakeHttp, instantSleep, type FakeComputeKeys } from './fakes';

export interface FakeAlarms extends AlarmCenter {
  raised: AlarmInput[];
  byKind(kind: ComputeAlarm['kind']): ComputeAlarm[];
}

export function fakeAlarms(now: () => Date = () => new Date()): FakeAlarms {
  const map = new Map<string, ComputeAlarm>();
  const listeners = new Set<() => void>();
  let n = 0;
  const key = (k: string, r: string | null) => `${k}|${r ?? ''}`;
  const center: FakeAlarms = {
    raised: [],
    raise(input) {
      center.raised.push(input);
      const k = key(input.kind, input.resourceId);
      const existing = map.get(k);
      const alarm: ComputeAlarm = { ...input, id: existing?.id ?? `al_${++n}`, createdAt: existing?.createdAt ?? now().toISOString() };
      map.set(k, alarm);
      for (const l of listeners) l();
      return alarm;
    },
    resolve(kind, resourceId) {
      map.delete(key(kind, resourceId));
      for (const l of listeners) l();
    },
    dismiss(id) {
      for (const [k, a] of map) if (a.id === id) map.delete(k);
    },
    list: () => [...map.values()],
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    byKind: (kind) => [...map.values()].filter((a) => a.kind === kind),
  };
  return center;
}

export const PRICES: Record<string, number> = {
  'gmi.container.nv.H200x1.tw3': 3.35,
  'gmi.container.nv.H200x8.tw3': 26.8,
  'gmi.container.intel.x4660.large': 0.5,
  'gmi.container.nv.H100x1.tw1': 2.5,
  'gmi.eip.sole.shared': 0.1,
  'gmi.sandbox.small': 0.0911,
  'gmi.sandbox.medium': 0.1822,
};

export function fakePrices(table: Record<string, number> = PRICES): PriceBook {
  return { price: (sku) => ({ usdPerHour: table[sku] ?? null, fetchedAt: new Date().toISOString(), source: 'public_feed' }) };
}

export interface FakeGuard extends Guard {
  refusal: QuoteAssessment['refusal'];
  assessed: QuoteAssessmentInput[];
  leaseVerdict: LeaseChangeAssessment | null;
}

/** A Guard whose quote and lease verdicts are scriptable (C1-D's real guard has its own tests). */
export function fakeGuard(alarms: AlarmCenter, prices: PriceBook = fakePrices()): FakeGuard {
  const g: FakeGuard = {
    refusal: null,
    assessed: [],
    leaseVerdict: null,
    start() {},
    async stop() {},
    async tick() {},
    async assessQuote(input) {
      g.assessed.push(input);
      const lines = input.lines.map((l) => ({ label: l.label, usdPerHour: prices.price(l.sku, l.idc).usdPerHour, note: null }));
      const usdPerHour = lines.some((l) => l.usdPerHour === null) ? null : lines.reduce((s, l) => s + (l.usdPerHour ?? 0), 0);
      return {
        lines,
        usdPerHour,
        maxUsd: usdPerHour === null ? null : usdPerHour * input.hours,
        committedUsd: 0,
        priceSource: 'public_feed',
        priceAgeSec: 0,
        budget: { allowed: g.refusal === null, needsConfirmation: false, reason: null, remainingTodayUsd: 25, remainingMonthUsd: null },
        dailyBudgetSet: true,
        warnings: [],
        refusal: g.refusal,
      };
    },
    assessLeaseChange(record, patch: Partial<LeasePolicy>) {
      if (g.leaseVerdict) return g.leaseVerdict;
      const cur = record.lease;
      const loosens = patch.maxLifetimeMin === null || (typeof patch.maxLifetimeMin === 'number' && (cur?.maxLifetimeMin ?? 0) < patch.maxLifetimeMin) || patch.onExpiry === 'notify';
      const deletesSooner = patch.onExpiry === 'delete' || patch.onBudget === 'delete';
      return { loosens, deletesSooner, reasons: [loosens ? 'longer' : '', deletesSooner ? 'sooner' : ''].filter(Boolean) };
    },
    dailyBudgetSet: () => true,
    spend: { kind: 'compute', totalSince: () => 0, burnUsdPerHour: () => 0 },
    cost: () => ({ accruedUsd: 0, accruedTodayUsd: 0, leaseEndsAt: null, idlePauseAt: null }),
    totals: () => ({ todayUsd: 0, monthUsd: 0, running: { count: 0, usdPerHour: 0 } }),
    alarms,
    activity: { record() {} },
    lastActivityAt: () => null,
    quitCheck: async () => 'quit',
    onChange: () => () => undefined,
  };
  return g;
}

export interface HttpEnv {
  t: TestContext;
  fake: ReturnType<typeof fakeHttp>;
  keys: FakeComputeKeys;
  registry: Registry;
  journal: Journal;
  clock: MutableServerClock;
  supervisor: ComputeSupervisor;
  alarms: FakeAlarms;
  prices: PriceBook;
  ce: ReturnType<typeof createCeClient>;
  sandbox: ReturnType<typeof createSandboxClient>;
  sleep: ReturnType<typeof instantSleep>;
  cleanup(): Promise<void>;
}

/** Real CE / v2 clients over a fake fetch, real registry + journal on disk, a real supervisor (not started). */
export async function httpEnv(routes: Parameters<typeof fakeHttp>[0] = [], opts: { keys?: FakeComputeKeys; memory?: boolean } = {}): Promise<HttpEnv> {
  const t = await createTestContext();
  const fake = fakeHttp(routes);
  const keys = opts.keys ?? fakeComputeKeys();
  const clock = createServerClock();
  const sleep = instantSleep();
  const ce = createCeClient({ http: fake.http, log: silentLogger, keys, onServerDate: (d) => clock.observe(d) });
  const sandbox = createSandboxClient({ http: fake.http, log: silentLogger, keys, sleep: sleep.sleep, onServerDate: (d) => clock.observe(d) });
  // `memory`: no disk writes (fake-timer tests must not wait on real file I/O).
  const write = opts.memory ? { write: async () => undefined } : {};
  const registry = createRegistry({ dataDir: t.ctx.paths.data, log: silentLogger, ...write });
  const journal = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger, ...write });
  await Promise.all([registry.load(), journal.load()]);
  const supervisor = createSupervisor({ registry, log: silentLogger, keys: keys as ComputeKeyProvider, ce, sandbox, clock });
  const alarms = fakeAlarms();
  return {
    t,
    fake,
    keys,
    registry,
    journal,
    clock,
    supervisor,
    alarms,
    prices: fakePrices(),
    ce,
    sandbox,
    sleep,
    async cleanup() {
      await supervisor.stop();
      await Promise.all([registry.flush(), journal.flush()]);
      await t.cleanup();
    },
  };
}

/** A managed record with sensible defaults. */
export function rec(over: Partial<ComputeRecord> & { id: string }, at = new Date().toISOString()): ComputeRecord {
  const kind = over.kind ?? 'container';
  return blankRecord(
    {
      kind,
      backend: kind === 'container' ? 'ce' : 'sandbox_v2',
      name: `gmid-abcdef-${over.id}-q1w2e3`,
      displayName: over.id,
      managed: true,
      remoteId: `remote-${over.id}`,
      idc: 'asia-east-taiwan3',
      sku: kind === 'container' ? 'gmi.container.nv.H200x1.tw3' : 'gmi.sandbox.small',
      listUsdPerHour: kind === 'container' ? 3.35 : 0.0911,
      phase: 'running',
      rawState: 'running',
      ...over,
    },
    at,
  );
}

export const notFound = () => new GmiError('not_found', 'gone');
