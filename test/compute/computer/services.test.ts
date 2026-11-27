// C2-B: services (§8.3) and the Resources snapshot (§8.5). Command and name only in envs, the secret screen runs
// before anything is sent, the 30 s port wait uses app scans (never activity), services are recorded for a cold
// resume, and the usage snapshot is an app exec.
import { describe, expect, it } from 'vitest';
import type { ComputerService } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createExecRunner } from '@main/services/compute/computer/exec';
import { createPortScanner } from '@main/services/compute/computer/ports';
import {
  SERVICE_PORT_POLL_MS,
  SERVICE_PORT_WAIT_MS,
  SERVICE_START_COMMAND,
  USAGE_COMMAND,
  createServiceManager,
  validateService,
} from '@main/services/compute/computer/services';
import type { ComputeRecord, Registry, SecretScreen } from '@main/services/compute/types';
import { TARGET, execResult, fakeActivity, fakeExecPort, mockStack, scriptedDataPlane } from './c2b-harness';

const SECRET = 'eyJhbGciOiJIUzI1NiJ9.stored-secret';

function fakeRegistry(services: ComputerService[] = []) {
  const records = new Map<string, ComputeRecord>([[TARGET.resourceId, { id: TARGET.resourceId, services } as unknown as ComputeRecord]]);
  const registry: Pick<Registry, 'get' | 'update'> & { updates: number } = {
    updates: 0,
    get: (id) => records.get(id) ?? null,
    async update(id, mutate) {
      const current = records.get(id);
      if (!current) throw new GmiError('not_found', 'unknown resource');
      const next = mutate(current);
      records.set(id, next);
      registry.updates += 1;
      return next;
    },
  };
  return registry;
}

function fakeSecrets(): SecretScreen & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    async assertNoSecrets(values) {
      for (const v of values) {
        checked.push(v.label);
        if (v.value.includes(SECRET)) throw new GmiError('invalid_input', `${v.label} contains a stored GMI key.`);
      }
    },
  };
}

const instantSleep = () => {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
};

describe('validateService', () => {
  it('accepts plain names, a command and an optional port', () => {
    expect(validateService({ name: 'web', command: ' npm run dev ', port: 5173 })).toEqual({ name: 'web', command: 'npm run dev', port: 5173 });
    expect(validateService({ name: 'api.v2_x-1', command: 'x', port: null })).toEqual({ name: 'api.v2_x-1', command: 'x', port: null });
  });

  it.each([
    [{ name: '../x', command: 'x' }],
    [{ name: 'a b', command: 'x' }],
    [{ name: '', command: 'x' }],
    [{ name: 'x'.repeat(41), command: 'x' }],
    [{ name: 'web', command: '   ' }],
    [{ name: 'web', command: 'a\0b' }],
    [{ name: 'web', command: 'x', port: 0 }],
    [{ name: 'web', command: 'x', port: 70000 }],
    [{ name: 'web', command: 'x', port: 80.5 }],
  ])('rejects %o', (svc) => {
    expect(() => validateService(svc)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('start', () => {
  function setup(stdoutForScan = '') {
    const dp = scriptedDataPlane((input) => (input.command === SERVICE_START_COMMAND ? execResult() : execResult({ stdout: stdoutForScan })));
    const activity = fakeActivity();
    const port = fakeExecPort();
    const runner = createExecRunner({ dataPlane: dp, execPort: port, activity, log: silentLogger });
    const registry = fakeRegistry();
    const secrets = fakeSecrets();
    const sleeper = instantSleep();
    const services = createServiceManager({ runner, ports: createPortScanner({ runner, log: silentLogger }), registry, secrets, log: silentLogger, sleep: sleeper.sleep, now: () => new Date('2026-11-02T10:00:00Z') });
    return { services, dp, activity, port, registry, secrets, sleeper };
  }

  it('passes the command and name only through envs, detached with nohup', async () => {
    const { services, dp, activity, secrets } = setup();
    const r = await services.start(TARGET, { name: 'web', command: 'npm run dev -- --host 0.0.0.0; echo "$HOME"' });
    expect(r).toEqual({ service: { name: 'web', command: 'npm run dev -- --host 0.0.0.0; echo "$HOME"', port: null, startedAt: '2026-11-02T10:00:00.000Z' }, portReady: true });
    expect(dp.inputs).toHaveLength(1);
    expect(dp.inputs[0]).toMatchObject({ command: SERVICE_START_COMMAND, envs: { GMID_CMD: 'npm run dev -- --host 0.0.0.0; echo "$HOME"', GMID_NAME: 'web' } });
    expect(SERVICE_START_COMMAND).toBe('nohup sh -c "$GMID_CMD" > "/tmp/gmid-svc-$GMID_NAME.log" 2>&1 &');
    expect(dp.inputs[0]?.timeoutSec).toBe(30);
    expect(secrets.checked).toEqual(['Service command', 'Service name']);
    expect(activity.records).toEqual([{ resourceId: TARGET.resourceId, activity: { kind: 'service_start' } }]);
  });

  it('refuses a command containing a stored secret before anything is sent', async () => {
    const { services, dp, port, registry } = setup();
    await expect(services.start(TARGET, { name: 'leak', command: `curl -H "Authorization: Bearer ${SECRET}" x` })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(services.start(TARGET, { name: 'web', command: 'x', port: 99999 })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(dp.inputs).toEqual([]);
    expect(port.acquired).toEqual([]);
    expect(registry.updates).toBe(0);
  });

  it('records the service in the registry (replacing one with the same name)', async () => {
    const { services, registry } = setup();
    await services.start(TARGET, { name: 'web', command: 'one' });
    await services.start(TARGET, { name: 'web', command: 'two' });
    await services.start(TARGET, { name: 'api', command: 'three' });
    expect(services.list(TARGET.resourceId).map((s) => [s.name, s.command])).toEqual([
      ['web', 'two'],
      ['api', 'three'],
    ]);
    expect(registry.updates).toBe(3);
  });

  it('waits up to 30 s for the port with app scans that never count as activity', async () => {
    const { services, dp, activity, sleeper } = setup('');
    const r = await services.start(TARGET, { name: 'slow', command: 'sleep 999', port: 8000 });
    expect(r.portReady).toBe(false);
    const scans = dp.inputs.filter((i) => i.command !== SERVICE_START_COMMAND);
    expect(scans.length).toBe(SERVICE_PORT_WAIT_MS / SERVICE_PORT_POLL_MS + 1);
    expect(sleeper.delays.every((d) => d === SERVICE_PORT_POLL_MS)).toBe(true);
    expect(activity.records.map((r) => r.activity.kind)).toEqual(['service_start']);
  });

  it('an unknown resource still starts the service (it just cannot be offered after a resume)', async () => {
    const { services } = setup();
    const r = await services.start({ ...TARGET, resourceId: 'cr_unknown' }, { name: 'web', command: 'x' });
    expect(r.service.name).toBe('web');
  });
});

describe('against the mock simulator', () => {
  function setup() {
    const stack = mockStack();
    const registry = fakeRegistry();
    const sleeper = instantSleep();
    const services = createServiceManager({ runner: stack.runner, ports: createPortScanner({ runner: stack.runner, log: silentLogger }), registry, secrets: fakeSecrets(), log: silentLogger, sleep: sleeper.sleep });
    return { ...stack, services, registry, sleeper };
  }

  it('starts a server, sees its port at once, and logs to /tmp/gmid-svc-<name>.log', async () => {
    const { services, port, sleeper, dataPlane } = setup();
    const r = await services.start(TARGET, { name: 'site', command: 'python3 -m http.server 8123', port: 8123 });
    expect(r.portReady).toBe(true);
    expect(sleeper.delays).toEqual([]);
    expect(port.inUse).toBe(0);
    // The simulator's nohup discards the output, but the redirect target exists.
    await expect(dataPlane.readFile(TARGET.sandboxId, '/tmp/gmid-svc-site.log')).resolves.toMatchObject({ truncated: false });
  });

  it('restart starts every recorded service again and waits for their ports', async () => {
    const { services, registry, activity } = setup();
    await registry.update(TARGET.resourceId, (r) => ({
      ...r,
      services: [
        { name: 'a', command: 'python3 -m http.server 8001', port: 8001, startedAt: '2026-11-01T00:00:00.000Z' },
        { name: 'b', command: 'echo hi', port: null, startedAt: '2026-11-01T00:00:00.000Z' },
      ],
    }));
    const results = await services.restart(TARGET);
    expect(results.map((r) => [r.service.name, r.portReady])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(results.every((r) => r.service.startedAt > '2026-11-01T00:00:00.000Z')).toBe(true);
    expect(activity.records.map((r) => r.activity.kind)).toEqual(['service_start', 'service_start']);
  });

  it('the Resources snapshot is one app exec (never activity)', async () => {
    const { services, activity, port } = setup();
    const u = await services.usage(TARGET);
    expect(u.text).toContain('Mem:');
    expect(u.text).toContain('Filesystem');
    expect(u.text.split('\n')[0]).toBe('2');
    expect(Number.isNaN(Date.parse(u.at))).toBe(false);
    expect(activity.records).toEqual([]);
    expect(port.bound.map((b) => b.origin)).toEqual(['app']);
  });
});

describe('usage', () => {
  it('sends the fixed command (no envs), strips terminal escapes and fails on a timeout', async () => {
    let status: 'succeeded' | 'timed_out' = 'succeeded';
    const dp = scriptedDataPlane(() => execResult({ status, exit_code: status === 'succeeded' ? 0 : null, stdout: status === 'succeeded' ? '\x1b[1m4\x1b[0m\nMem: 1\n' : '' }));
    const activity = fakeActivity();
    const runner = createExecRunner({ dataPlane: dp, execPort: fakeExecPort(), activity, log: silentLogger });
    const services = createServiceManager({ runner, ports: { scan: async () => [] }, registry: fakeRegistry(), secrets: fakeSecrets(), log: silentLogger });
    expect((await services.usage(TARGET)).text).toBe('4\nMem: 1');
    expect(dp.inputs[0]).toMatchObject({ command: USAGE_COMMAND, timeoutSec: 20 });
    expect(dp.inputs[0]?.envs).toBeUndefined();
    status = 'timed_out';
    await expect(services.usage(TARGET)).rejects.toMatchObject({ code: 'timeout' });
    expect(activity.records).toEqual([]);
  });
});
