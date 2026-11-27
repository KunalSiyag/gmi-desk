import { GmiError } from '@shared/contracts/errors';
import type { MediaActivity } from '@shared/contracts/usage';
import type { McpGateway } from '../../core/services';
import { assertDays, createTtlCache, DAY_MS, isRecord, nonEmptyString, toNumberOrNull } from './util';

export const ACTIVITY_PAGE_SIZE = 100;
export const ACTIVITY_MAX_PAGES = 10;
export const ACTIVITY_TTL_MS = 60_000;

export interface GenerationRecord {
  requestId: string | null;
  modelId: string;
  modality: string;
  status: string;
  /** Epoch ms; NaN when GMI sent no usable date. */
  createdAt: number;
}

export interface GenerationPage {
  generations: GenerationRecord[];
  total: number | null;
}

/** Normalises one page of MCP list_generations. */
export function normalizeGenerationPage(raw: unknown): GenerationPage {
  if (!isRecord(raw) || !Array.isArray(raw.generations)) {
    throw new GmiError('upstream', 'GMI returned an unexpected generation list.');
  }
  const generations: GenerationRecord[] = [];
  for (const item of raw.generations) {
    if (!isRecord(item)) continue;
    const created = typeof item.created_at === 'string' || typeof item.created_at === 'number' ? item.created_at : null;
    let createdAt = Number.NaN;
    if (typeof created === 'number') createdAt = created < 1e12 ? created * 1000 : created;
    else if (typeof created === 'string') createdAt = /^\d+$/.test(created) ? Number(created) * 1000 : Date.parse(created);
    generations.push({
      requestId: nonEmptyString(item.request_id),
      modelId: nonEmptyString(item.model_id) ?? 'unknown',
      modality: (nonEmptyString(item.modality) ?? 'other').toLowerCase(),
      status: (nonEmptyString(item.status) ?? 'unknown').toLowerCase(),
      createdAt,
    });
  }
  const total = toNumberOrNull(raw.total);
  return { generations, total: total === null ? null : Math.max(0, Math.round(total)) };
}

/** Counts per model (with succeeded/failed) and per modality. */
export function aggregateGenerations(
  generations: Iterable<GenerationRecord>,
): Pick<MediaActivity, 'total' | 'byModel' | 'byModality'> {
  const byModel = new Map<string, { modelId: string; count: number; succeeded: number; failed: number }>();
  const byModality: Record<string, number> = {};
  let total = 0;
  for (const g of generations) {
    total += 1;
    byModality[g.modality] = (byModality[g.modality] ?? 0) + 1;
    let row = byModel.get(g.modelId);
    if (!row) {
      row = { modelId: g.modelId, count: 0, succeeded: 0, failed: 0 };
      byModel.set(g.modelId, row);
    }
    row.count += 1;
    if (g.status === 'success' || g.status === 'succeeded' || g.status === 'completed') row.succeeded += 1;
    else if (g.status === 'failed' || g.status === 'error') row.failed += 1;
  }
  return {
    total,
    byModel: [...byModel.values()].sort((a, b) => b.count - a.count || a.modelId.localeCompare(b.modelId)),
    byModality,
  };
}

/**
 * Pages through list_generations (newest first, 100 per page) until a job is older than the window,
 * GMI has no more, or 10 pages were read (then `truncated` is set).
 */
export async function scanMediaActivity(
  mcp: McpGateway,
  days: number,
  now: Date,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<MediaActivity> {
  const pageSize = opts.pageSize ?? ACTIVITY_PAGE_SIZE;
  const maxPages = opts.maxPages ?? ACTIVITY_MAX_PAGES;
  const since = now.getTime() - days * DAY_MS;
  const inWindow: GenerationRecord[] = [];
  let offset = 0;
  let pages = 0;
  let scanned = 0;
  let truncated = false;

  for (;;) {
    const page = normalizeGenerationPage(await mcp.callTool('list_generations', { limit: pageSize, offset }));
    pages += 1;
    scanned += page.generations.length;
    let reachedOlder = false;
    for (const g of page.generations) {
      if (Number.isNaN(g.createdAt)) continue;
      if (g.createdAt < since) {
        reachedOlder = true;
        continue;
      }
      inWindow.push(g);
    }
    offset += page.generations.length;
    const more =
      page.generations.length > 0 && (page.total !== null ? offset < page.total : page.generations.length >= pageSize);
    if (reachedOlder || !more) break;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
  }

  const oldest = inWindow.reduce<number | null>((min, g) => (min === null || g.createdAt < min ? g.createdAt : min), null);
  return {
    days,
    ...aggregateGenerations(inWindow),
    truncated,
    scanned,
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    fetchedAt: now.toISOString(),
  };
}

export interface ActivityService {
  get(days: number): Promise<MediaActivity>;
  clear(): void;
}

export function createActivityService(mcp: McpGateway, now: () => Date, ttlMs = ACTIVITY_TTL_MS): ActivityService {
  const cache = createTtlCache<number, MediaActivity>({ ttlMs, now: () => now().getTime(), maxEntries: 8 });
  return {
    async get(days) {
      const d = assertDays(days);
      return cache.get(d, () => scanMediaActivity(mcp, d, now()));
    },
    clear: () => cache.clear(),
  };
}
