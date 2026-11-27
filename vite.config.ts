import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { dinoSvg } from './src/renderer/components/brand/dino-art.ts';
import { gmiLogoSvg } from './src/renderer/components/brand/gmi-logo.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const DEV_ORIGIN = 'http://127.0.0.1:5199';

/**
 * The renderer never talks to the network directly (all GMI calls go through the main process).
 * In production 'self' is app://gmi-desk (src/main/core/app-origin.ts), never file://. img-src keeps https: for model
 * icons, generated outputs and pasted media links; Markdown from models only loads remote images after a click.
 */
function csp(dev: boolean): string {
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: gmi-media:",
    "media-src 'self' blob: https: gmi-media:",
    "font-src 'self' data:",
    dev ? `connect-src 'self' ${DEV_ORIGIN} ws://127.0.0.1:5199` : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

function cspPlugin(): Plugin {
  let dev = false;
  return {
    name: 'gmi-csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('__GMI_CSP__', csp(dev));
    },
  };
}

/**
 * The boot splash (index.html) is painted before any script runs: inline Dino's SVG, GMI's logo and styles/dino.css there
 * (style-src allows inline styles; no inline script is needed). The same CSS styles every <Dino /> in the app.
 */
function bootSplashPlugin(): Plugin {
  const cssFile = fileURLToPath(new URL('./src/renderer/styles/dino.css', import.meta.url));
  return {
    name: 'gmi-boot-splash',
    configureServer(server) {
      server.watcher.add(cssFile);
    },
    transformIndexHtml(html) {
      const css = readFileSync(cssFile, 'utf8');
      return html
        .replace(/<!-- gmi:boot-style[^>]*-->/, () => `<style>${css}</style>`)
        .replace('<!-- gmi:boot-dino -->', () => dinoSvg('boot'))
        .replace('<!-- gmi:boot-logo -->', () => gmiLogoSvg('full', 'gmi-boot-logo'));
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin(), bootSplashPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  build: {
    // GMI_DESK_OUT_DIR lets parallel builds (e.g. per-agent screenshot builds) use separate folders.
    outDir: process.env.GMI_DESK_OUT_DIR
      ? `${process.env.GMI_DESK_OUT_DIR}/dist/renderer`
      : fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
  },
});
