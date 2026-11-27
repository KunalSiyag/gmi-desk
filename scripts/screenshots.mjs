// Builds the app into an isolated folder and captures PNG screenshots of pages (mock data, offscreen).
//
//   node scripts/screenshots.mjs --name models --pages "models,models?model=zai-org/GLM-5.3#light"
//   npm run shots -- --pages "chat,usage"
//
// Page spec: page[?k=v&k2=v][#light|#dark][~waitMs]  (pages: chat models create usage docs settings welcome compute code)
// Output: .agent-builds/<name>/shots/<page>[-light][-n].png
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import { electronBuildOptions } from './build-electron.mjs';

const require = createRequire(import.meta.url);
/** @type {string} */
const electronBin = require('electron');

const { values } = parseArgs({
  options: {
    name: { type: 'string', default: 'default' },
    pages: { type: 'string', default: 'chat,models,create,usage,docs,settings,welcome' },
    'skip-build': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
  },
});

const name = String(values.name).replace(/[^\w.-]/g, '_');
const outDir = resolve('.agent-builds', name);
const shotsDir = join(outDir, 'shots');

function run(cmd, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))));
  });
}

if (!values['skip-build']) {
  mkdirSync(outDir, { recursive: true });
  process.env.GMI_DESK_OUT_DIR = outDir; // read by vite.config.ts
  await viteBuild({ configFile: 'vite.config.ts', logLevel: 'warn' });
  await Promise.all(electronBuildOptions({ outDir }).map((config) => esbuild.build(config)));
}

rmSync(shotsDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });
// A throwaway Electron profile, removed after the app has fully exited (Chromium writes into it until then).
// GMI_DESK_USER_DATA from the caller wins, e.g. to pre-seed a budget or a mock state.
const ownProfile = process.env.GMI_DESK_USER_DATA ? null : mkdtempSync(join(tmpdir(), 'gmi-desk-shots-'));
try {
  await run(electronBin, [join(outDir, 'dist-electron', 'main.cjs')], {
    GMI_DESK_SHOTS: shotsDir,
    GMI_DESK_SHOTS_PAGES: String(values.pages),
    ...(ownProfile ? { GMI_DESK_USER_DATA: ownProfile } : {}),
    ...(values.live ? { GMI_DESK_SHOTS_LIVE: '1' } : {}),
  });
} finally {
  if (ownProfile) rmSync(ownProfile, { recursive: true, force: true });
}

const files = readdirSync(shotsDir).filter((f) => f.endsWith('.png'));
console.log(`\n[shots] ${files.length} screenshot(s):`);
for (const f of files) console.log(join(shotsDir, f));
