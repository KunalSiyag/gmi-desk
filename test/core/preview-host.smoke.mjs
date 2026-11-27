// PreviewHost Electron smoke test (compute.md §21 C2-0; not a vitest test: it needs Electron).
//
//   node test/core/preview-host.smoke.mjs --name c2-0-smoke     # exits 0 on success, 1 on a failed check
//
// Like scripts/screenshots.mjs it builds into .agent-builds/<name>/ and runs Electron offscreen with a throwaway
// profile; no GMI network calls (two local HTTPS servers on 127.0.0.1, a self-signed certificate made with openssl,
// and Chromium's host-resolver-rules to map the test host names to 127.0.0.1). Checks: see preview-host.smoke-main.ts.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
/** @type {string} */
const electronBin = require('electron');

const { values } = parseArgs({ options: { name: { type: 'string', default: 'preview-smoke' } } });
const name = String(values.name).replace(/[^\w.-]/g, '_');
const outDir = resolve('.agent-builds', name);
const certDir = join(outDir, 'cert');
mkdirSync(certDir, { recursive: true });

execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=smoke-preview.example', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')],
  { stdio: 'ignore' },
);

const entry = join(outDir, 'preview-smoke-main.cjs');
await esbuild.build({
  entryPoints: ['test/core/preview-host.smoke-main.ts'],
  outfile: entry,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'ws'],
  tsconfig: 'tsconfig.node.json',
  logLevel: 'warning',
});

const profile = mkdtempSync(join(tmpdir(), 'gmi-desk-preview-smoke-'));
const resultFile = join(outDir, 'preview-smoke-result.json');
rmSync(resultFile, { force: true });
const code = await new Promise((resolvePromise) => {
  const child = spawn(electronBin, [entry, `--user-data-dir=${profile}`], {
    env: { ...process.env, SMOKE_CERT_DIR: certDir, SMOKE_RESULT_FILE: resultFile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Chromium's own warnings are noise here; keep them only for a run that produced no result.
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('exit', () => {
    if (!existsSync(resultFile)) process.stderr.write(stderr);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('exit', (c) => {
    clearTimeout(timer);
    resolvePromise(c ?? 1);
  });
});
rmSync(profile, { recursive: true, force: true });

if (!existsSync(resultFile)) {
  console.error(`[preview-smoke] no result (exit ${code})`);
  process.exit(1);
}
const result = JSON.parse(readFileSync(resultFile, 'utf8'));
console.log(JSON.stringify(result, null, 2));
console.log(result.failures.length === 0 ? '[preview-smoke] PASS' : `[preview-smoke] FAIL: ${result.failures.join('; ')}`);
process.exit(result.failures.length === 0 && code === 0 ? 0 : 1);
