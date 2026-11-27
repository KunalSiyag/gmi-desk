// Layout regression check for the Models page at narrow window widths (not a vitest test: it needs Electron and a build).
//
//   node scripts/screenshots.mjs --name layout --pages models     # builds .agent-builds/layout
//   node test/catalog/models-layout.cdp.mjs .agent-builds/layout   # exits 1 on a failure
//
// Runs the mock build offscreen with remote debugging and, for window widths 980..1360, checks that
//  - every pricing-table cell of the selected model ends inside the table's frame (no "$0.2" for $0.24), and
//  - every Models tab (Leaderboard included) is left of the details panel and receives clicks.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const buildDir = resolve(process.argv[2] ?? '.agent-builds/default');
const WIDTHS = [980, 1100, 1270, 1280, 1360];
// MiniMax-M3 (selected first) is discounted with a long-context tier; Qwen3-Coder has two tiers.
const SCENARIOS = [
  { page: 'models', auth: '' },
  { page: 'models?model=Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', auth: '' },
  { page: 'models', auth: 'signed_out,no_key' },
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const aside = document.querySelector('aside[aria-label="Model details"]');
  const asideLeft = aside.getBoundingClientRect().left;
  const problems = [];
  const table = aside.querySelector('table');
  if (table) {
    const frame = table.parentElement.getBoundingClientRect();
    for (const cell of table.querySelectorAll('tbody td')) {
      const r = cell.getBoundingClientRect();
      if (r.width > 0 && r.right > frame.right - 1 + 0.5) problems.push('pricing cell "' + cell.textContent.trim() + '" ends ' + Math.round(r.right - frame.right + 1) + 'px outside the table');
    }
  }
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const r = tab.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (r.right > asideLeft) problems.push('tab "' + tab.textContent.trim() + '" runs under the details panel');
    else if (!hit || !tab.contains(hit)) problems.push('tab "' + tab.textContent.trim() + '" cannot be clicked');
  }
  return { model: aside.querySelector('h2')?.textContent?.trim() ?? null, problems };
})()`;

async function run({ page, auth }, port) {
  const shots = mkdtempSync(join(tmpdir(), 'gmi-layout-'));
  const child = spawn(electronBin, [join(buildDir, 'dist-electron', 'main.cjs'), `--remote-debugging-port=${port}`], {
    env: { ...process.env, GMI_DESK_SHOTS: shots, GMI_DESK_SHOTS_PAGES: `${page}#dark~600000`, ...(auth ? { GMI_DESK_MOCK_AUTH: auth } : {}) },
    stdio: 'ignore',
  });
  const results = [];
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      await delay(200);
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('index.html'));
      } catch {
        // not up yet
      }
    }
    if (!target) throw new Error(`no page to debug in ${buildDir}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      data.error ? p.rej(new Error(JSON.stringify(data.error))) : p.res(data.result);
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Runtime.enable');
    await delay(4000);
    for (const width of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await delay(700);
      const r = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      results.push({ width, ...r.result.value });
    }
    ws.close();
  } finally {
    child.kill('SIGTERM');
    await delay(500);
    if (!child.killed) child.kill('SIGKILL');
    rmSync(shots, { recursive: true, force: true });
  }
  return results;
}

let failed = 0;
for (const [i, scenario] of SCENARIOS.entries()) {
  for (const r of await run(scenario, 9500 + i)) {
    const label = `${scenario.page}${scenario.auth ? ` [${scenario.auth}]` : ''} @ ${r.width}px (${r.model})`;
    if (r.problems.length === 0) console.log(`ok    ${label}`);
    else {
      failed += 1;
      console.log(`FAIL  ${label}\n      ${r.problems.join('\n      ')}`);
    }
  }
}
process.exit(failed ? 1 : 0);
