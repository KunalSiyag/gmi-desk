/**
 * The in-sandbox forwarder (harness.md §8.3). The sandbox has its own network namespace with only loopback, so a
 * proxy-aware tool connects to 127.0.0.1:3128; this script, run with the Electron binary as Node
 * (`ELECTRON_RUN_AS_NODE=1`, read-only mount), relays each connection to the host proxy's Unix socket at
 * /run/gmid-proxy/proxy.sock (macOS: `GMID_PROXY_SOCKET`). It starts listening first, then runs the command (argv after `--`), forwards
 * termination signals and exits with the command's status. It holds no policy: the host proxy decides.
 *
 * Written by the host into the proxy's private directory (netproxy.ts) and mounted read-only.
 */
export const FORWARDER_SOURCE = `'use strict';
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const SOCK = process.env.GMID_PROXY_SOCKET || '/run/gmid-proxy/proxy.sock';
const sep = process.argv.indexOf('--');
const argv = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (argv.length === 0) { process.stderr.write('gmid-forwarder: no command\\n'); process.exit(125); }
const server = net.createServer((c) => {
  const u = net.connect(SOCK);
  c.pipe(u); u.pipe(c);
  c.on('error', () => u.destroy());
  u.on('error', () => c.destroy());
  c.on('close', () => u.destroy());
  u.on('close', () => c.destroy());
});
server.on('error', (e) => { process.stderr.write('gmid-forwarder: ' + (e.code || 'error') + '\\n'); process.exit(125); });
server.listen(3128, '127.0.0.1', () => {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GMID_PROXY_SOCKET;
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch (_) {} });
  child.on('error', (e) => { process.stderr.write('gmid-forwarder: ' + (e.code || 'spawn failed') + '\\n'); process.exit(127); });
  child.on('exit', (code, sig) => {
    server.close();
    process.exit(code === null ? 128 + ((sig && os.constants.signals[sig]) || 0) : code);
  });
});
`;
