// Background services and the resource snapshot of the computer (compute.md §8.3 "Services", §8.5, §9.5, T15; C2-B).
//
// - `start` runs `nohup sh -c "$GMID_CMD" > "/tmp/gmid-svc-$GMID_NAME.log" 2>&1 &`: the command and the name only
//   travel in env vars, and the server is detached from stdout/stderr as v2 requires [V]. Main first refuses a
//   command or name that contains a stored GMI secret (SecretScreen, T15). With a port, it then waits up to 30 s
//   for that port to listen (app-originated scans, never activity). The service is recorded in the registry so a
//   cold resume can offer "Restart services".
// - `restart` starts every recorded service again (after a cold resume), then waits for their ports together.
// - `usage` is the Resources popover: one exec on demand (`nproc; free -m; df -h /; nvidia-smi …` when present),
//   never polled. It is an app exec (usage snapshot, §9.5) and does not count as activity.
import type { ComputerService } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import type { Registry, SecretScreen } from '../types';
import { execFailure, plainText, type ComputerTarget, type ExecRunner } from './exec';
import type { PortScanner } from './ports';

export const SERVICE_START_TIMEOUT_SEC = 30;
/** How long `start` waits for the service's port (§8.3). */
export const SERVICE_PORT_WAIT_MS = 30_000;
export const SERVICE_PORT_POLL_MS = 1_000;
export const SERVICE_COMMAND_MAX_BYTES = 16 * 1024;
export const USAGE_TIMEOUT_SEC = 20;
/** Text of the Resources popover at most (characters). */
export const USAGE_MAX_CHARS = 16 * 1024;

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export const SERVICE_START_COMMAND = 'nohup sh -c "$GMID_CMD" > "/tmp/gmid-svc-$GMID_NAME.log" 2>&1 &';

export const USAGE_COMMAND = [
  'nproc 2>/dev/null',
  'free -m 2>/dev/null',
  'df -h / 2>/dev/null',
  'command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null',
  'true',
].join('; ');

export interface ServiceStartResult {
  service: ComputerService;
  /** False when a port was given and did not listen within 30 s (the service may still be starting). */
  portReady: boolean;
}

export interface ServiceManager {
  start(target: ComputerTarget, svc: { name: string; command: string; port?: number | null }): Promise<ServiceStartResult>;
  /** Starts every recorded service of the resource again (cold resume). */
  restart(target: ComputerTarget): Promise<ServiceStartResult[]>;
  /** The services recorded for a resource. */
  list(resourceId: string): ComputerService[];
  /** Resources popover snapshot (never polled; not activity). */
  usage(target: ComputerTarget): Promise<{ text: string; at: string }>;
}

export interface ServiceManagerDeps {
  runner: ExecRunner;
  ports: Pick<PortScanner, 'scan'>;
  registry: Pick<Registry, 'get' | 'update'>;
  secrets: SecretScreen;
  log: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Validates a service request; returns the cleaned values. Throws GmiError('invalid_input'). */
export function validateService(svc: { name: unknown; command: unknown; port?: unknown }): { name: string; command: string; port: number | null } {
  const name = typeof svc.name === 'string' ? svc.name.trim() : '';
  if (!SERVICE_NAME.test(name)) throw new GmiError('invalid_input', 'Service names use letters, digits, ".", "_" and "-" (at most 40).');
  const command = typeof svc.command === 'string' ? svc.command.trim() : '';
  if (!command) throw new GmiError('invalid_input', 'The service needs a command.');
  if (command.includes('\0') || Buffer.byteLength(command, 'utf8') > SERVICE_COMMAND_MAX_BYTES) throw new GmiError('invalid_input', 'The service command is too long or contains a NUL byte.');
  const port = svc.port === undefined || svc.port === null ? null : svc.port;
  if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new GmiError('invalid_input', 'The port must be a whole number from 1 to 65535.');
  }
  return { name, command, port };
}

export function createServiceManager(deps: ServiceManagerDeps): ServiceManager {
  const log = deps.log.child('computer.services');
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function launch(target: ComputerTarget, svc: { name: string; command: string }): Promise<void> {
    await deps.secrets.assertNoSecrets([
      { label: 'Service command', value: svc.command },
      { label: 'Service name', value: svc.name },
    ]);
    const result = await deps.runner.run(target, {
      command: SERVICE_START_COMMAND,
      envs: { GMID_CMD: svc.command, GMID_NAME: svc.name },
      timeoutSec: SERVICE_START_TIMEOUT_SEC,
      origin: 'user',
      activity: 'service_start',
    });
    if (result.status !== 'succeeded' || result.exit_code !== 0) throw execFailure(result, 'Starting the service');
  }

  /** Polls (app scans) until every port listens or the 30 s pass; returns the ports that listen. */
  async function waitForPorts(target: ComputerTarget, ports: number[]): Promise<Set<number>> {
    const want = new Set(ports);
    const seen = new Set<number>();
    if (want.size === 0) return seen;
    const deadline = Date.now() + SERVICE_PORT_WAIT_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        for (const p of await deps.ports.scan(target)) if (want.has(p.port)) seen.add(p.port);
      } catch (error) {
        log.debug('port wait scan failed', { code: error instanceof GmiError ? error.code : 'internal' });
      }
      if (seen.size === want.size) return seen;
      if (Date.now() >= deadline || attempt >= SERVICE_PORT_WAIT_MS / SERVICE_PORT_POLL_MS) return seen;
      await sleep(SERVICE_PORT_POLL_MS);
    }
  }

  async function record(resourceId: string, service: ComputerService): Promise<void> {
    try {
      await deps.registry.update(resourceId, (r) => ({ ...r, services: [...r.services.filter((s) => s.name !== service.name), service] }));
    } catch (error) {
      // An unmanaged or unknown resource has no record: the service runs, but cannot be offered after a resume.
      log.warn('service not recorded', { code: error instanceof GmiError ? error.code : 'internal' });
    }
  }

  return {
    async start(target, raw) {
      const svc = validateService(raw);
      await launch(target, svc);
      const service: ComputerService = { name: svc.name, command: svc.command, port: svc.port, startedAt: now().toISOString() };
      await record(target.resourceId, service);
      const ready = svc.port === null ? true : (await waitForPorts(target, [svc.port])).has(svc.port);
      log.info('service.started', { sid: target.sessionId, port: svc.port, portReady: ready });
      return { service, portReady: ready };
    },

    async restart(target) {
      const recorded = deps.registry.get(target.resourceId)?.services ?? [];
      const started: ComputerService[] = [];
      for (const s of recorded) {
        const svc = validateService(s);
        await launch(target, svc);
        const service: ComputerService = { ...svc, startedAt: now().toISOString() };
        await record(target.resourceId, service);
        started.push(service);
      }
      const ready = await waitForPorts(target, started.flatMap((s) => (s.port === null ? [] : [s.port])));
      return started.map((service) => ({ service, portReady: service.port === null || ready.has(service.port) }));
    },

    list(resourceId) {
      return (deps.registry.get(resourceId)?.services ?? []).map((s) => ({ ...s }));
    },

    async usage(target) {
      const result = await deps.runner.run(target, { command: USAGE_COMMAND, timeoutSec: USAGE_TIMEOUT_SEC, origin: 'app' });
      if (result.status === 'timed_out' || result.status === 'cancelled' || (!result.stdout && result.exit_code !== 0)) throw execFailure(result, 'Reading the resources');
      return { text: plainText(result.stdout, USAGE_MAX_CHARS).trimEnd(), at: now().toISOString() };
    },
  };
}
