import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { NavigateRequest, PageId, ThemePreference } from '@shared/contracts/app';
import type { EventBus } from '../core/events';
import type { Logger } from '../core/logger';
import type { SettingsService } from '../core/settings';

export interface ShotSpec {
  name: string;
  nav: NavigateRequest;
  theme: ThemePreference;
  waitMs: number;
}

/** Every page a spec may name (all of PageId). */
export const SHOT_PAGES: PageId[] = ['chat', 'models', 'create', 'usage', 'docs', 'settings', 'welcome', 'compute', 'code'];
/** Pages shot when no list is given (the original set; compute and code are opt-in). */
const DEFAULT_PAGES: PageId[] = ['chat', 'models', 'create', 'usage', 'docs', 'settings', 'welcome'];

/**
 * Parses GMI_DESK_SHOTS_PAGES, e.g. "models,models?model=zai-org/GLM-5.3#light,chat?thread=t1".
 * Each entry: page[?k=v&k2=v2][#light|#dark][~waitMs]
 */
export function parseShotSpecs(raw: string | undefined, defaultWaitMs = 1800): ShotSpec[] {
  const entries = (raw && raw.trim() ? raw : DEFAULT_PAGES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const used = new Map<string, number>();
  const specs: ShotSpec[] = [];
  for (const entry of entries) {
    let rest = entry;
    let waitMs = defaultWaitMs;
    let theme: ThemePreference = 'dark';
    // Suffixes may come in either order: "page~1500#light" or "page#light~1500".
    for (;;) {
      const m = /(?:#(light|dark)|~(\d+))$/.exec(rest);
      if (!m) break;
      if (m[1]) theme = m[1] as ThemePreference;
      else if (m[2]) waitMs = Number(m[2]);
      rest = rest.slice(0, m.index);
    }
    const [pagePart, queryPart] = rest.split('?', 2);
    const page = (pagePart ?? '').trim() as PageId;
    if (!SHOT_PAGES.includes(page)) continue;
    const params: Record<string, string> = {};
    if (queryPart) for (const [k, v] of new URLSearchParams(queryPart)) params[k] = v;
    const base = `${page}${theme === 'light' ? '-light' : ''}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    specs.push({
      name: count === 1 ? base : `${base}-${count}`,
      nav: Object.keys(params).length ? { page, params } : { page },
      theme,
      waitMs,
    });
  }
  return specs;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Navigates through the requested pages and saves a PNG of each, then resolves. */
export async function runScreenshots(
  win: BrowserWindow,
  opts: { dir: string; specs: ShotSpec[]; events: EventBus; settings: SettingsService; log: Logger },
): Promise<string[]> {
  await mkdir(opts.dir, { recursive: true });
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  }
  await delay(1500);
  const written: string[] = [];
  for (const spec of opts.specs) {
    if (opts.settings.get().theme !== spec.theme) await opts.settings.update({ theme: spec.theme });
    opts.events.emit('app:navigate', spec.nav);
    await delay(spec.waitMs);
    win.webContents.invalidate();
    await delay(150);
    const image = await win.webContents.capturePage();
    const file = join(opts.dir, `${spec.name}.png`);
    await writeFile(file, image.toPNG());
    written.push(file);
    opts.log.info(`screenshot ${spec.name} → ${file} (${image.getSize().width}x${image.getSize().height})`);
  }
  return written;
}
