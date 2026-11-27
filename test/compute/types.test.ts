// C1-0 (compute.md §21 Phase C1, §14): the frozen internal interfaces, the DTOs and the compute slice stub.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { COMPUTE_API_METHODS, type ComputeResource, type LeasePolicy } from '@shared/contracts/compute';
import { isGmiError } from '@shared/contracts/errors';
import type { SpendSource } from '@main/core/services';
import { registeredQuitChecks } from '@main/core/shutdown';
import { methodNames } from '@main/ipc/registry';
import { createUnavailableComputeKeys } from '@main/services/auth/compute-keys';
import { createComputeSlice, notImplementedComputeApi } from '@main/services/compute';
import { CE_CONTAINER_STATUSES, CE_PRICE_UNITS_PER_USD } from '@main/services/compute/ce/dto';
import {
  V2_EXEC_CONCURRENCY_LIMIT,
  V2_EXEC_STATUSES,
  V2_EXEC_TERMINAL_STATUSES,
  V2_EXEC_WAIT_TIMEOUT_MAX_SEC,
  V2_SANDBOX_STATES,
  V2_SDK_EXTRA_STATES,
} from '@main/services/compute/sandbox/dto';
import {
  AGENT_EXEC_SLOTS_MAX,
  COMPUTE_DATA_FILES,
  COMPUTE_TIMING,
  EXEC_SLOTS_PER_SANDBOX,
  EXEC_WAIT_TIMEOUT_SEC,
  USER_ACTIVITY_KINDS,
  type ActionPending,
  type ActivitySink,
  type CeContainer,
  type ComputeActivity,
  type ComputeInternals,
  type ComputeRecord,
  type ExecPort,
  type ExecReleaseOutcome,
  type ExecSlot,
  type Guard,
  type Registry,
  type ResourceActions,
  type Supervisor,
  type V2ConnectResult,
  type V2SandboxDetail,
} from '@main/services/compute/types';
import { setupComputeSlice, type ComputeSlice } from '@main/slices/compute';
import { createTestContext } from '../helpers/context';

const fakeDeps = () => ({
  auth: { getState: () => ({}) as never, isSignedIn: () => false, onChange: () => () => undefined },
  keys: createUnavailableComputeKeys(),
  catalog: { getSnapshot: async () => ({}) as never, findModel: async () => null },
  budget: { check: async () => ({}) as never, record: async () => undefined, statusSnapshot: () => ({}) as never },
  budgetSources: { register: () => () => undefined },
});

describe('frozen constants (§8.1, §6.6, §9)', () => {
  it('exec slots: 10 per sandbox (the v2 limit), the agent at most 6, a 25 s wait', () => {
    expect(EXEC_SLOTS_PER_SANDBOX).toBe(10);
    expect(EXEC_SLOTS_PER_SANDBOX).toBe(V2_EXEC_CONCURRENCY_LIMIT);
    expect(AGENT_EXEC_SLOTS_MAX).toBe(6);
    expect(EXEC_SLOTS_PER_SANDBOX - AGENT_EXEC_SLOTS_MAX).toBeGreaterThanOrEqual(4);
    expect(EXEC_WAIT_TIMEOUT_SEC).toBe(25);
    expect(EXEC_WAIT_TIMEOUT_SEC).toBe(V2_EXEC_WAIT_TIMEOUT_MAX_SEC);
  });

  it('timers match the design', () => {
    expect(COMPUTE_TIMING).toMatchObject({
      pollTransitionalMs: 5_000,
      pollComputerOpenMs: 30_000,
      pollSteadyMs: 60_000,
      pollHiddenMs: 120_000,
      pollBackoffMinMs: 2_000,
      pollBackoffMaxMs: 300_000,
      healthDegradedAfterFailures: 5,
      healthDownAfterMs: 1_800_000,
      clockSkewMaxMs: 120_000,
      guardTickMs: 60_000,
      sweepMs: 600_000,
      quoteTtlMs: 300_000,
      leaseChangeGraceMs: 900_000,
      actionFailuresBeforeAlarm: 3,
      autoExtendByMs: 1_800_000,
      sessionWarmMs: 300_000,
    });
    expect(COMPUTE_TIMING.leaseWarningsMin).toEqual([15, 5, 1]);
    expect(COMPUTE_TIMING.actionRetryMs).toEqual([60_000, 120_000, 300_000, 600_000]);
  });

  it('data files live under data/ with the documented names', () => {
    expect(COMPUTE_DATA_FILES).toEqual({ registry: 'compute-resources.json', journal: 'compute-journal.json', catalog: 'compute-catalog.json' });
  });

  it('billing prices are micro-USD', () => {
    expect(3_350_000 / CE_PRICE_UNITS_PER_USD).toBe(3.35);
  });
});

describe('activity (§9.5): user intent and active agent runs only', () => {
  it('lists exactly the user kinds; output, preview traffic, polls and app execs are not among them', () => {
    expect([...USER_ACTIVITY_KINDS].sort()).toEqual(['file_op', 'preview_input', 'service_start', 'terminal_input', 'transfer', 'user_exec']);
    for (const notActivity of ['terminal_output', 'preview_traffic', 'app_exec', 'port_scan', 'poll', 'agent_tool'])
      expect((USER_ACTIVITY_KINDS as readonly string[]).includes(notActivity)).toBe(false);
  });

  it('the sink type refuses non-activity and agent calls without a run', () => {
    expectTypeOf<ComputeActivity>().toEqualTypeOf<{ kind: (typeof USER_ACTIVITY_KINDS)[number] } | { kind: 'agent_tool'; runId: string }>();
    const recorded: Array<[string, ComputeActivity]> = [];
    const sink: ActivitySink = { record: (id, activity) => void recorded.push([id, activity]) };
    sink.record('cr_1', { kind: 'terminal_input' });
    sink.record('cr_1', { kind: 'agent_tool', runId: 'run_1' });
    // @ts-expect-error terminal output never counts as activity
    sink.record('cr_1', { kind: 'terminal_output' });
    // @ts-expect-error an agent tool call counts only inside a run
    sink.record('cr_1', { kind: 'agent_tool' });
    expect(recorded).toHaveLength(4);
  });
});

describe('ExecPort (§8.1): priorities, terminal-state release, cancel', () => {
  it('acquire takes a user or agent priority; release takes only terminal outcomes', () => {
    expectTypeOf<Parameters<ExecPort['acquire']>[1]['priority']>().toEqualTypeOf<'user' | 'agent'>();
    expectTypeOf<ExecReleaseOutcome>().toEqualTypeOf<'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'not_started'>();
    expectTypeOf<ExecPort['cancel']>().parameters.toEqualTypeOf<[eid: string]>();
    expect([...V2_EXEC_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'failed', 'succeeded', 'timed_out']);
    // Non-terminal statuses keep the slot: they are not valid release outcomes.
    for (const s of ['pending', 'running', 'cancelling']) expect((V2_EXEC_TERMINAL_STATUSES as readonly string[]).includes(s)).toBe(false);
  });

  it('a slot cannot be released while its execution runs (compile-time)', async () => {
    const released: string[] = [];
    const slot: ExecSlot = {
      slotId: 's1',
      resourceId: 'cr_1',
      priority: 'agent',
      bind: async () => undefined,
      release: async (outcome) => void released.push(outcome),
    };
    await slot.bind({ eid: 'e1', origin: 'agent', grantId: 'g1', timeoutSec: 600 });
    await slot.release('timed_out');
    // @ts-expect-error `running` is not terminal: a 25 s wait that times out keeps the slot
    await slot.release('running');
    expect(released).toEqual(['timed_out', 'running']);
  });
});

describe('Registry, Supervisor, Guard, ResourceActions (§14)', () => {
  it('the registry stores actionPending and in-flight executions', () => {
    expectTypeOf<ActionPending>().toEqualTypeOf<NonNullable<ComputeResource['actionPending']>>();
    expectTypeOf<ComputeRecord['actionPending']>().toEqualTypeOf<ActionPending | null>();
    expectTypeOf<Registry>().toHaveProperty('setActionPending');
    expectTypeOf<Registry>().toHaveProperty('inflightExecs');
    expectTypeOf<Registry>().toHaveProperty('addInflightExec');
    expectTypeOf<Registry>().toHaveProperty('removeInflightExec');
    expectTypeOf<ComputeRecord['lease']>().toEqualTypeOf<LeasePolicy | null>();
  });

  it('a registry record has no field that could hold a secret (env values, tokens, urlPath, credentials)', () => {
    type Forbidden = Extract<keyof ComputeRecord, 'env' | 'envs' | 'envVars' | 'env_vars' | 'token' | 'accessToken' | 'trafficToken' | 'urlPath' | 'credential' | 'key'>;
    expectTypeOf<Forbidden>().toEqualTypeOf<never>();
    expectTypeOf<ComputeRecord['envNames']>().toEqualTypeOf<string[]>();
  });

  it('the supervisor exposes the mutex, the server clock and freshness for destructive catch-up', () => {
    expectTypeOf<Supervisor>().toHaveProperty('withResourceLock');
    expectTypeOf<Supervisor['clock']['verified']>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<Supervisor['freshSince']>().returns.toEqualTypeOf<string | null>();
  });

  it('the guard is a SpendSource provider with alarms, activity and a quit check', () => {
    expectTypeOf<Guard['spend']>().toEqualTypeOf<SpendSource>();
    expectTypeOf<Guard['quitCheck']>().returns.toEqualTypeOf<Promise<'quit' | 'cancel'>>();
    expectTypeOf<Guard['activity']>().toEqualTypeOf<ActivitySink>();
    expectTypeOf<keyof ResourceActions>().toEqualTypeOf<'pause' | 'delete' | 'extendServerTimeout'>();
    expectTypeOf<keyof ComputeInternals>().toEqualTypeOf<'registry' | 'supervisor' | 'guard' | 'actions' | 'secrets' | 'prices' | 'setRunActive'>();
  });
});

describe('DTOs (hand-written from the OpenAPI documents)', () => {
  const read = (rel: string) => readFile(fileURLToPath(new URL(`../../src/main/services/compute/${rel}`, import.meta.url)), 'utf8');

  it('each DTO file records the SHA-256 of its spec', async () => {
    expect(await read('ce/dto.ts')).toMatch(/service_api\.yaml[\s\S]{0,120}sha256 520a9b53386c7a064cf287833dfdba0cd15450e478ddcff0627164580560e6b8/);
    expect(await read('sandbox/dto.ts')).toMatch(/sandbox_api\.yaml[\s\S]{0,120}sha256 5195b2eaadd814650fbd17276eb717944f3c6d85acd6587f3815c3bb0fa6b297/);
  });

  it('the enums are the documented ones', () => {
    expect(CE_CONTAINER_STATUSES).toEqual(['unknown', 'creating', 'running', 'terminating', 'stopped', 'error', 'zombie']);
    expect(V2_SANDBOX_STATES).toEqual(['provisioning', 'running', 'pausing', 'paused', 'resuming', 'checkpointing', 'updating', 'failed', 'deleting', 'deleted']);
    expect(V2_SDK_EXTRA_STATES).toEqual(['ready', 'active', 'error', 'cancelled']);
    expect(V2_EXEC_STATUSES).toEqual(['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out']);
  });

  it('types.ts re-exports both DTO sets; unknown enum values are accepted', () => {
    expectTypeOf<CeContainer['status']>().toExtend<string>();
    const odd: CeContainer['status'] = 'hibernating';
    const state: V2SandboxDetail['state'] = 'ready';
    expect([odd, state]).toHaveLength(2);
    expectTypeOf<V2ConnectResult>().toHaveProperty('end_at');
  });
});

describe('the compute slice (C1-0 registration, C1-C service)', () => {
  it('createComputeSlice serves exactly the ComputeApi methods, with internals and a quit check', async () => {
    const t = await createTestContext();
    try {
      const service = await createComputeSlice(t.ctx, fakeDeps());
      expect(methodNames(service.api as unknown as object).sort()).toEqual([...COMPUTE_API_METHODS].sort());
      // Without a key: no access, nothing managed (never not_implemented any more).
      await expect(service.api.listResources()).resolves.toEqual([]);
      expect(service.internals).not.toBeNull();
      expect(typeof service.quitCheck).toBe('function');
      await expect(service.dispose()).resolves.toBeUndefined();
      expect(methodNames(notImplementedComputeApi() as unknown as object)).toHaveLength(COMPUTE_API_METHODS.length);
    } finally {
      await t.cleanup();
    }
  });

  it('setupComputeSlice registers compute, a disposer and the quit check, and makes no network call without a key', async () => {
    const calls: string[] = [];
    const t = await createTestContext({
      fetch: async (input) => {
        calls.push(String(input));
        throw new Error('no network without a Compute key');
      },
    });
    try {
      const registered: string[] = [];
      const disposers: Array<() => void | Promise<void>> = [];
      const checksBefore = registeredQuitChecks().length;
      const slice: ComputeSlice = await setupComputeSlice(t.ctx, fakeDeps(), {
        registerApi: (ns) => void registered.push(ns),
        onDispose: (d) => void disposers.push(d),
      });
      expect(registered).toEqual(['compute']);
      expect(disposers).toHaveLength(2);
      expect(registeredQuitChecks()).toHaveLength(checksBefore + 1);
      expect(slice.internals).not.toBeNull();
      await expect(slice.api.delete('cr_x')).rejects.toMatchObject({ code: 'not_found' });
      for (const d of disposers) await d();
      expect(registeredQuitChecks()).toHaveLength(checksBefore);
      expect(calls).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
