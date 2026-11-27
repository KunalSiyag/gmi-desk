// Bundles the Electron main process, the preload script and the harness host (utilityProcess) with esbuild.
// Usage: node scripts/build-electron.mjs [--watch]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** @param {{ dev?: boolean, outDir?: string }} [opts] */
export function electronBuildOptions(opts = {}) {
  const dev = Boolean(opts.dev);
  // GMI_DESK_OUT_DIR lets parallel builds (e.g. per-agent screenshot builds) use separate folders.
  const outDir = opts.outDir ?? process.env.GMI_DESK_OUT_DIR ?? '.';
  /** @type {import('esbuild').BuildOptions} */
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    // `ws` (compute data plane, C2) stays a runtime dependency loaded from node_modules: it has optional native
    // add-ons (bufferutil, utf-8-validate) that must not be bundled.
    external: ['electron', 'ws'],
    tsconfig: 'tsconfig.node.json',
    logLevel: 'warning',
    legalComments: 'none',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    },
  };
  return [
    { ...common, entryPoints: ['src/main/index.ts'], outfile: `${outDir}/dist-electron/main.cjs` },
    { ...common, entryPoints: ['src/preload/index.ts'], outfile: `${outDir}/dist-electron/preload.cjs` },
    // The agent harness host (harness.md §5), started by main in an Electron utilityProcess.
    { ...common, entryPoints: ['src/harness/host.ts'], outfile: `${outDir}/dist-electron/harness.cjs` },
  ];
}

async function main() {
  const watch = process.argv.includes('--watch');
  const configs = electronBuildOptions({ dev: watch });
  if (watch) {
    for (const config of configs) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    console.log('[build-electron] watching main + preload + harness');
    return;
  }
  await Promise.all(configs.map((config) => esbuild.build(config)));
  console.log('[build-electron] built dist-electron/main.cjs, preload.cjs and harness.cjs');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
