// C2-B: listening-port detection. The /proc/net/tcp(6) parser, `ss` process names, loopback-only binds are not
// previewable, the scan is never activity, and main coalesces / caches / skips scans while the window is hidden.
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { createExecRunner } from '@main/services/compute/computer/exec';
import {
  PORT_SCAN_COMMAND,
  PORT_SCAN_MIN_INTERVAL_MS,
  createPortScanner,
  isLoopback,
  parsePortScan,
  parseProcNetTcp,
  parseSsProcesses,
  toPortInfos,
} from '@main/services/compute/computer/ports';
import { TARGET, execResult, fakeActivity, fakeExecPort, mockStack, scriptedDataPlane } from './c2b-harness';

const TCP4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F40 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000     0        0 1003 1 0000000000000000 20 4 30 10 -1
   3: 0B00A8C0:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1004 1 0000000000000000 100 0 0 10 0
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1
   1: 00000000000000000000000001000000:0CEA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2002 1
   2: 0000000000000000FFFF00000100007F:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2003 1
   3: B80D0120000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2004 1
garbage line
   9: XYZ:0050 00000000:0000 0A
`;

describe('parseProcNetTcp', () => {
  it('keeps LISTEN rows only and decodes little-endian IPv4 and IPv6 addresses', () => {
    expect(parseProcNetTcp(TCP4)).toEqual([
      { address: '0.0.0.0', port: 8000, loopback: false },
      { address: '127.0.0.1', port: 5432, loopback: true },
      { address: '192.168.0.11', port: 3000, loopback: false },
    ]);
    expect(parseProcNetTcp(TCP6)).toEqual([
      { address: '::', port: 8000, loopback: false },
      { address: '::1', port: 3306, loopback: true },
      { address: '::ffff:127.0.0.1', port: 9090, loopback: true },
      { address: '2001:db8::1', port: 80, loopback: false },
    ]);
  });

  it('knows loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['0.0.0.0', '::', '10.0.0.1', '::ffff:10.0.0.1']) expect(isLoopback(a)).toBe(false);
  });
});

describe('port infos', () => {
  it('merges binds per port: previewable when any bind is not loopback-only', () => {
    const infos = parsePortScan(`${TCP4}${TCP6}--GMID-SS--\nLISTEN 0 5 0.0.0.0:8000 0.0.0.0:* users:(("python3",pid=12,fd=3))\nLISTEN 0 128 [::1]:3306 [::]:* users:(("mysqld",pid=9,fd=20))\n`);
    expect(infos).toEqual([
      { port: 80, address: '2001:db8::1', process: null, previewable: true },
      { port: 3000, address: '192.168.0.11', process: null, previewable: true },
      { port: 3306, address: '::1', process: 'mysqld', previewable: false },
      { port: 5432, address: '127.0.0.1', process: null, previewable: false },
      { port: 8000, address: '0.0.0.0', process: 'python3', previewable: true },
      { port: 9090, address: '::ffff:127.0.0.1', process: null, previewable: false },
    ]);
  });

  it('reads ss process names across ss versions and ignores junk', () => {
    const names = parseSsProcesses(
      [
        'LISTEN 0      511          *:5173            *:*    users:(("node",pid=77,fd=21))',
        '0 4096 [::]:22 [::]:* users:(("sshd",pid=1,fd=4))',
        'LISTEN 0 5 0.0.0.0:99999 0.0.0.0:* users:(("bad",pid=1,fd=1))',
        'not a row',
      ].join('\n'),
    );
    expect([...names]).toEqual([
      [5173, 'node'],
      [22, 'sshd'],
    ]);
  });

  it('a port 0 is never previewable', () => {
    expect(toPortInfos([{ address: '0.0.0.0', port: 0, loopback: false }])[0]?.previewable).toBe(false);
  });
});

describe('scanner', () => {
  function setup(stdout = TCP4, opts: { hidden?: () => boolean } = {}) {
    let now = 1_000_000;
    const dp = scriptedDataPlane(() => execResult({ stdout, status: 'failed', exit_code: 1 }));
    const activity = fakeActivity();
    const port = fakeExecPort();
    const runner = createExecRunner({ dataPlane: dp, execPort: port, activity, log: silentLogger });
    const scanner = createPortScanner({ runner, log: silentLogger, windowHidden: opts.hidden, nowMs: () => now });
    return { scanner, dp, activity, port, tick: (ms: number) => (now += ms) };
  }

  it('one app exec with an explicit timeout; never activity', async () => {
    const { scanner, dp, activity, port } = setup();
    const ports = await scanner.listPorts(TARGET);
    expect(ports.map((p) => p.port)).toEqual([3000, 5432, 8000]);
    expect(dp.inputs).toHaveLength(1);
    expect(dp.inputs[0]).toMatchObject({ command: PORT_SCAN_COMMAND, timeoutSec: 10 });
    expect(dp.inputs[0]?.envs).toBeUndefined();
    expect(port.bound[0]?.origin).toBe('app');
    for (let i = 0; i < 20; i += 1) await scanner.scan(TARGET);
    expect(activity.records).toEqual([]);
  });

  it('coalesces concurrent calls and answers from a cache younger than 4 s', async () => {
    const { scanner, dp, tick } = setup();
    await Promise.all([scanner.listPorts(TARGET), scanner.listPorts(TARGET), scanner.listPorts(TARGET)]);
    expect(dp.inputs).toHaveLength(1);
    tick(PORT_SCAN_MIN_INTERVAL_MS - 1);
    await scanner.listPorts(TARGET);
    expect(dp.inputs).toHaveLength(1);
    tick(2);
    await scanner.listPorts(TARGET);
    expect(dp.inputs).toHaveLength(2);
    scanner.forget(TARGET.sessionId);
    await scanner.listPorts(TARGET);
    expect(dp.inputs).toHaveLength(3);
  });

  it('runs no exec while the window is hidden (cached or empty answer)', async () => {
    let hidden = true;
    const { scanner, dp, tick } = setup(TCP4, { hidden: () => hidden });
    expect(await scanner.listPorts(TARGET)).toEqual([]);
    expect(dp.inputs).toHaveLength(0);
    hidden = false;
    await scanner.listPorts(TARGET);
    hidden = true;
    tick(60_000);
    expect((await scanner.listPorts(TARGET)).map((p) => p.port)).toEqual([3000, 5432, 8000]);
    expect(dp.inputs).toHaveLength(1);
  });

  it('against the mock simulator: a started http.server shows up as previewable', async () => {
    const { runner, mock, activity } = mockStack();
    const scanner = createPortScanner({ runner, log: silentLogger });
    expect(await scanner.scan(TARGET)).toEqual([]);
    await mock.dataPlane.exec(TARGET.sandboxId, { command: 'python3 -m http.server 8000', timeoutSec: 5 });
    expect(await scanner.scan(TARGET)).toEqual([{ port: 8000, address: '0.0.0.0', process: null, previewable: true }]);
    expect(activity.records).toEqual([]);
  });

  it('the scan command parses this machine’s own /proc (a loopback listener is found, not previewable)', async () => {
    if (process.platform !== 'linux') return;
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const r = spawnSync('sh', ['-c', PORT_SCAN_COMMAND], { encoding: 'utf8' });
      const found = parsePortScan(r.stdout).find((p) => p.port === port);
      expect(found).toMatchObject({ port, address: '127.0.0.1', previewable: false });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
