// Development runner: Vite dev server for the renderer, esbuild watch for main/preload,
// and an Electron process that restarts whenever main or preload is rebuilt.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';
import { electronBuildOptions } from './build-electron.mjs';

const require = createRequire(import.meta.url);
/** @type {string} */
const electronBin = require('electron');

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const devUrl = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5199/';
console.log(`[dev] renderer at ${devUrl}`);

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let restartTimer = null;
let shuttingDown = false;

function startElectron() {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  child = spawn(electronBin, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  });
  child.on('exit', async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    process.exit(code ?? 0);
  });
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(startElectron, 150);
}

const restartPlugin = {
  name: 'restart-electron',
  /** @param {import('esbuild').PluginBuild} build */
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) scheduleRestart();
    });
  },
};

for (const config of electronBuildOptions({ dev: true })) {
  const ctx = await esbuild.context({ ...config, plugins: [restartPlugin] });
  await ctx.watch();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    shuttingDown = true;
    child?.kill();
    await server.close();
    process.exit(0);
  });
}
