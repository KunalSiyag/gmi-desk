// The compute catalog (compute.md §5, §14 `catalog.ts`): sources, cache, schedule, aggregation, price join, and the
// PriceBook the cost guard prices with (§9.1). C1-B.
//
// Sources (§5.1), each optional and keeping its last good data (D7): `ok` / `stale` / `error` / `skipped`.
//   public (key-less, every 6 h + on request): idcs, publicTemplates, publicProducts (the billing feed)
//   account (Compute key, when the wizard opens an IDC; 5 min freshness): accountProducts, accountTemplates,
//     sandboxProducts, sandboxTemplates (+ EIP products per IDC, for `eipAvailable` and the EIP SKU)
// Signed out (no key), offers are aggregated by (kind, gpuModel, gpuCount, idc) — sandboxes also by size — with the
// lowest list price and no SKU (§5.2 rule 3). With a key, an IDC's container offers are exactly the rows of
// `/containers/products?idc=`, priced from the public feed joined on `name == instanceType` (rule 4); a SKU with no
// price is `listUsdPerHour: null` (it cannot be launched while budgets are enforced, §9.1).
// Cache: `data/compute-catalog.json` (atomic write), read back defensively. No description, credential or raw feed
// row ever reaches it.
import { join } from 'node:path';
import type {
  ComputeCatalog,
  ComputeCatalogSource,
  ComputeIdc,
  ComputeKind,
  ComputeOffer,
  ComputeSourceStatus,
  ComputeTemplate,
  IdcStatus,
} from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../core/logger';
import type { ComputeKeyProvider } from '../../core/services';
import { atomicWriteFile, readJsonFile } from '../../core/store';
import type { CeApi, CePublicApi } from './ce/client';
import type { CeIdc, CeProduct, CeTemplate } from './ce/dto';
import type { SandboxApi } from './sandbox/client';
import type { V2Product, V2Template } from './sandbox/dto';
import { feedPriceIndex, filterPublicProducts, redactSandboxTemplate, redactTemplate, type PublicProductRow } from './sanitize';
import { COMPUTE_DATA_FILES, type PriceBook, type PriceInfo } from './types';

export const CATALOG_CACHE_VERSION = 1;
export const CATALOG_TIMING = {
  /** Public feeds (§5.1). */
  publicRefreshMs: 6 * 60 * 60_000,
  /** Account sources of one IDC are re-read when the wizard opens it after this long. */
  accountFreshMs: 5 * 60_000,
  /** §9.1: prices older than this make the quote warn. */
  priceFreshMs: 24 * 60 * 60_000,
  /** An unforced public refresh is not re-attempted sooner than this after the last attempt (offline: no hammering). */
  publicRetryMs: 60_000,
} as const;

export const CATALOG_SOURCES: readonly ComputeCatalogSource[] = [
  'idcs',
  'publicProducts',
  'publicTemplates',
  'accountProducts',
  'accountTemplates',
  'sandboxProducts',
  'sandboxTemplates',
];
const ACCOUNT_SOURCES: ReadonlySet<ComputeCatalogSource> = new Set(['accountProducts', 'accountTemplates', 'sandboxProducts', 'sandboxTemplates']);

interface Stamped<T> {
  at: string;
  items: T;
}

/** One IDC as cached (kinds and EIP availability are derived at build time). */
interface CachedIdc {
  id: string;
  name: string;
  country: string | null;
  status: IdcStatus;
}

interface AccountIdcData {
  products?: Stamped<ComputeOffer[]>;
  sandboxProducts?: Stamped<ComputeOffer[]>;
  sandboxTemplates?: Stamped<ComputeTemplate[]>;
  /** EIP SKUs GMI offers this org there (with the joined list price). */
  eip?: Stamped<Array<{ sku: string; usdPerHour: number | null }>>;
}

export interface CatalogCacheFile {
  version: number;
  idcs: Stamped<CachedIdc[]> | null;
  publicProducts: Stamped<PublicProductRow[]> | null;
  publicTemplates: Stamped<ComputeTemplate[]> | null;
  accountTemplates: Stamped<ComputeTemplate[]> | null;
  accountByIdc: Record<string, AccountIdcData>;
  sources: Record<ComputeCatalogSource, ComputeSourceStatus>;
}

export interface ComputeCatalogDeps {
  dataDir: string;
  log: Logger;
  keys: ComputeKeyProvider;
  publicApi: CePublicApi;
  ce: Pick<CeApi, 'listProducts' | 'listTemplates' | 'eipProducts'>;
  sandbox: Pick<SandboxApi, 'products' | 'templates'>;
  now?: () => Date;
}

export interface ComputeCatalogService extends PriceBook {
  /** Reads the cache (missing or unreadable → empty). Call once before anything else. */
  load(): Promise<void>;
  /**
   * The catalog. Serves the cache at once (refreshing stale public feeds in the background); awaits the public feeds
   * only when nothing is cached, and the account sources of `idc` (with a key) when they are older than 5 min.
   * `refresh: true` awaits everything.
   */
  getCatalog(opts?: { refresh?: boolean; idc?: string | null }): Promise<ComputeCatalog>;
  /** The current catalog, synchronously (cached data). */
  snapshot(): ComputeCatalog;
  refreshPublic(force?: boolean): Promise<void>;
  refreshAccount(idc: string, force?: boolean): Promise<void>;
  /** The cheapest EIP SKU in an IDC (account list first, then the public feed). Null: none known. */
  eipSku(idc: string): { sku: string; usdPerHour: number | null } | null;
  /** Starts the 6-hourly public refresh (no network until the first timer or `getCatalog`). */
  start(): void;
  stop(): void;
  onChange(listener: () => void): () => void;
}

// ─── Defensive cache reading ───────────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const KINDS: ReadonlySet<string> = new Set<ComputeKind>(['container', 'sandbox']);
const IDC_STATUSES: ReadonlySet<string> = new Set<IdcStatus>(['available', 'full', 'maintenance', 'unknown']);
const SOURCE_STATES: ReadonlySet<string> = new Set(['ok', 'stale', 'error', 'skipped']);

function stamped<T>(v: unknown, item: (x: unknown) => T | null): Stamped<T[]> | null {
  if (!isObj(v) || !iso(v.at) || !Array.isArray(v.items)) return null;
  return { at: v.at as string, items: v.items.map(item).filter((x): x is T => x !== null) };
}

function readOffer(v: unknown): ComputeOffer | null {
  if (!isObj(v) || !str(v.id) || !KINDS.has(String(v.kind)) || !str(v.idc)) return null;
  return {
    id: v.id as string,
    kind: v.kind as ComputeKind,
    sku: str(v.sku),
    idc: v.idc as string,
    gpuModel: str(v.gpuModel),
    gpuCount: num(v.gpuCount) ?? 0,
    vcpu: num(v.vcpu),
    memoryGiB: num(v.memoryGiB),
    diskGiB: num(v.diskGiB),
    arch: v.arch === 'x86_64' || v.arch === 'arm64' ? v.arch : null,
    sizeLabel: str(v.sizeLabel),
    listUsdPerHour: num(v.listUsdPerHour),
    entitled: typeof v.entitled === 'boolean' ? v.entitled : null,
  };
}

function readTemplate(v: unknown): ComputeTemplate | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !KINDS.has(String(v.kind))) return null;
  const official = v.official === true;
  return {
    id: v.id as string,
    kind: v.kind as ComputeKind,
    name: v.name as string,
    official,
    image: str(v.image),
    description: official ? str(v.description) : null,
    defaultPorts: Array.isArray(v.defaultPorts)
      ? v.defaultPorts.flatMap((p) =>
          isObj(p) && Number.isInteger(p.port) && (p.protocol === 'TCP' || p.protocol === 'UDP') ? [{ port: p.port as number, protocol: p.protocol, label: str(p.label) }] : [],
        )
      : [],
    sshReady: typeof v.sshReady === 'boolean' ? v.sshReady : null,
    idc: str(v.idc),
  };
}

function readRow(v: unknown): PublicProductRow | null {
  if (!isObj(v) || !str(v.sku) || !str(v.idc) || !['container', 'sandbox', 'eip'].includes(String(v.kind))) return null;
  return {
    sku: v.sku as string,
    idc: v.idc as string,
    kind: v.kind as PublicProductRow['kind'],
    usdPerHour: num(v.usdPerHour),
    gpuModel: str(v.gpuModel),
    gpuCount: num(v.gpuCount) ?? 0,
    vcpu: num(v.vcpu),
    memoryGiB: num(v.memoryGiB),
    diskGiB: num(v.diskGiB),
    sizeLabel: str(v.sizeLabel),
  };
}

function readIdc(v: unknown): CachedIdc | null {
  if (!isObj(v) || !str(v.id) || !str(v.name)) return null;
  return { id: v.id as string, name: v.name as string, country: str(v.country), status: IDC_STATUSES.has(String(v.status)) ? (v.status as IdcStatus) : 'unknown' };
}

function emptySources(): Record<ComputeCatalogSource, ComputeSourceStatus> {
  return Object.fromEntries(CATALOG_SOURCES.map((s) => [s, { state: 'skipped', fetchedAt: null, error: null }])) as Record<ComputeCatalogSource, ComputeSourceStatus>;
}

export function emptyCache(): CatalogCacheFile {
  return { version: CATALOG_CACHE_VERSION, idcs: null, publicProducts: null, publicTemplates: null, accountTemplates: null, accountByIdc: {}, sources: emptySources() };
}

/** Parses a cache file; anything unusable is dropped. Sources read back as `stale` (not yet confirmed in this run). */
export function readCatalogCache(raw: unknown): CatalogCacheFile {
  const out = emptyCache();
  if (!isObj(raw) || raw.version !== CATALOG_CACHE_VERSION) return out;
  out.idcs = stamped(raw.idcs, readIdc);
  out.publicProducts = stamped(raw.publicProducts, readRow);
  out.publicTemplates = stamped(raw.publicTemplates, readTemplate);
  out.accountTemplates = stamped(raw.accountTemplates, readTemplate);
  if (isObj(raw.accountByIdc)) {
    for (const [idc, d] of Object.entries(raw.accountByIdc)) {
      if (!isObj(d) || !/^[A-Za-z0-9._-]{1,64}$/.test(idc)) continue;
      const eip = stamped(d.eip, (x) => (isObj(x) && str(x.sku) ? { sku: x.sku as string, usdPerHour: num(x.usdPerHour) } : null));
      out.accountByIdc[idc] = {
        ...(stamped(d.products, readOffer) ? { products: stamped(d.products, readOffer) as Stamped<ComputeOffer[]> } : {}),
        ...(stamped(d.sandboxProducts, readOffer) ? { sandboxProducts: stamped(d.sandboxProducts, readOffer) as Stamped<ComputeOffer[]> } : {}),
        ...(stamped(d.sandboxTemplates, readTemplate) ? { sandboxTemplates: stamped(d.sandboxTemplates, readTemplate) as Stamped<ComputeTemplate[]> } : {}),
        ...(eip ? { eip } : {}),
      };
    }
  }
  if (isObj(raw.sources)) {
    for (const s of CATALOG_SOURCES) {
      const v = (raw.sources as Obj)[s];
      if (!isObj(v) || !SOURCE_STATES.has(String(v.state))) continue;
      const fetchedAt = iso(v.fetchedAt);
      out.sources[s] = { state: fetchedAt ? 'stale' : v.state === 'skipped' ? 'skipped' : 'error', fetchedAt, error: str(v.error) };
    }
  }
  return out;
}

// ─── Normalisers (wire → contract) ─────────────────────────────────────────────────────────────────────────────────

export function normalizeIdcs(list: CeIdc[]): CachedIdc[] {
  const out: CachedIdc[] = [];
  for (const i of list) {
    const id = str(i?.idcId);
    if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) continue;
    const status = IDC_STATUSES.has(String(i.status)) ? (i.status as IdcStatus) : 'unknown';
    out.push({ id, name: str(i.name) ?? id, country: str(i.country), status });
  }
  return out;
}

/** The aggregate key of a signed-out offer (§5.2 rule 3). Sandboxes add their size, so sizes stay distinct. */
export function aggregateOfferId(row: Pick<PublicProductRow, 'kind' | 'gpuModel' | 'gpuCount' | 'idc' | 'sizeLabel'>): string {
  const base = `${row.kind}:${row.gpuModel ?? 'cpu'}x${row.gpuCount}:${row.idc}`;
  return row.kind === 'sandbox' && row.sizeLabel ? `${base}:${row.sizeLabel}` : base;
}

/** Signed-out offers: one per (kind, gpuModel, gpuCount, idc[, size]), lowest list price, no SKU. */
export function aggregatePublicOffers(rows: PublicProductRow[]): ComputeOffer[] {
  const groups = new Map<string, PublicProductRow>();
  for (const row of rows) {
    if (row.kind === 'eip') continue;
    const id = aggregateOfferId(row);
    const prev = groups.get(id);
    const cheaper = !prev || (row.usdPerHour !== null && (prev.usdPerHour === null || row.usdPerHour < prev.usdPerHour));
    if (cheaper) groups.set(id, row);
  }
  return [...groups.entries()]
    .map(([id, row]) => ({
      id,
      kind: row.kind as ComputeKind,
      sku: null,
      idc: row.idc,
      gpuModel: row.gpuModel,
      gpuCount: row.gpuCount,
      vcpu: row.vcpu,
      memoryGiB: row.memoryGiB,
      diskGiB: row.diskGiB,
      arch: null,
      sizeLabel: row.sizeLabel,
      listUsdPerHour: row.usdPerHour,
      entitled: null,
    }))
    .sort(compareOffers);
}

function compareOffers(a: ComputeOffer, b: ComputeOffer): number {
  return a.idc.localeCompare(b.idc) || a.kind.localeCompare(b.kind) || (a.listUsdPerHour ?? Infinity) - (b.listUsdPerHour ?? Infinity) || a.id.localeCompare(b.id);
}

type PriceIndex = Map<string, Array<{ idc: string; usdPerHour: number }>>;

/**
 * The price of a SKU in `idc`. When the feed has no row for that IDC (or no IDC is given), the highest price the feed
 * lists for the SKU elsewhere: a guess, so the conservative one for budgets and quotes (§9.1).
 */
export function pickPrice(hits: ReadonlyArray<{ idc: string; usdPerHour: number }>, idc: string | null | undefined): number | null {
  if (!hits.length) return null;
  const exact = idc ? hits.find((h) => h.idc === idc) : undefined;
  if (exact) return exact.usdPerHour;
  return Math.max(...hits.map((h) => h.usdPerHour));
}

function priceFrom(index: PriceIndex | null, rows: PublicProductRow[], sku: string, idc: string | null): number | null {
  const hits = index?.get(sku) ?? rows.filter((r) => r.sku === sku && r.usdPerHour !== null).map((r) => ({ idc: r.idc, usdPerHour: r.usdPerHour as number }));
  return pickPrice(hits, idc);
}

const GPU_IN_SKU = /\.([A-Za-z][A-Za-z0-9]*|\d+[A-Za-z0-9]*)x(\d+)(?:\.|$)/;

/** An org container product → an offer (exact SKU, entitled), priced from the feed. */
export function accountContainerOffer(p: CeProduct, price: number | null): ComputeOffer | null {
  const sku = str(p?.name);
  const idc = str(p?.idc);
  if (!sku || !idc || p.valid === false) return null;
  if (p.type && p.type !== 'Container') return null;
  const declared = str(p.gpuModel);
  const m = GPU_IN_SKU.exec(sku);
  const gpuModel = declared && !/cpu/i.test(declared) ? declared : m?.[1] && /^(gmi\.container\.(nv|amd)\.)/.test(sku) ? m[1] : null;
  const spec = isObj(p.spec) ? p.spec : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = Number(spec[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };
  return {
    id: sku,
    kind: 'container',
    sku,
    idc,
    gpuModel,
    gpuCount: gpuModel ? (pick('gpu', 'gpuCount', 'gpu_count') ?? (m?.[2] ? Number(m[2]) : 1)) : 0,
    vcpu: pick('cpu', 'vcpu', 'cpuCount'),
    memoryGiB: pick('memory', 'memoryGiB', 'memory_gb'),
    diskGiB: pick('disk', 'diskGiB', 'storage'),
    arch: null,
    sizeLabel: null,
    listUsdPerHour: price,
    entitled: true,
  };
}

/** A v2 sandbox product → an offer, priced from the public `gmi.sandbox.*` SKU (v2 has no price [V]). */
export function sandboxOffer(p: V2Product, idc: string, price: number | null): ComputeOffer | null {
  const sku = str(p?.product);
  if (!sku) return null;
  const res: Obj = isObj(p.resources) ? (p.resources as unknown as Obj) : {};
  const mb = (v: unknown) => (num(v) !== null ? Math.round(((num(v) as number) / 1024) * 100) / 100 : null);
  return {
    id: `${sku}@${idc}`,
    kind: 'sandbox',
    sku,
    idc,
    gpuModel: null,
    gpuCount: 0,
    vcpu: num(res.cpu_count),
    memoryGiB: mb(res.memory_mb),
    diskGiB: mb(res.disk_size_mb),
    arch: res.architecture === 'x86_64' || res.architecture === 'arm64' ? res.architecture : null,
    sizeLabel: str(p.name),
    listUsdPerHour: price,
    entitled: p.status === 'active',
  };
}

// ─── The service ───────────────────────────────────────────────────────────────────────────────────────────────────

export function createComputeCatalog(deps: ComputeCatalogDeps): ComputeCatalogService {
  const log = deps.log.child('compute.catalog');
  const now = deps.now ?? (() => new Date());
  const file = join(deps.dataDir, COMPUTE_DATA_FILES.catalog);
  let cache = emptyCache();
  /** Every valid feed price (memory only, this run): joins the org's own SKUs (rule 4). */
  let priceIndex: PriceIndex | null = null;
  let publicFetchedThisRun = false;
  /** Whether a key existed at the last refresh (never the key itself). */
  let keyPresent = false;
  const listeners = new Set<() => void>();
  let publicInflight: Promise<void> | null = null;
  let lastPublicAttempt = 0;
  const accountInflight = new Map<string, Promise<void>>();
  let templatesInflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeKeys: (() => void) | null = null;
  let writing: Promise<void> = Promise.resolve();

  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (error) {
        log.warn('catalog listener failed', { error });
      }
    }
  };

  const persist = () => {
    const snapshot = JSON.stringify(cache);
    writing = writing.then(() => atomicWriteFile(file, snapshot)).catch((error: unknown) => log.warn('catalog cache write failed', { error }));
    return writing;
  };

  const errorText = (error: unknown) => (error instanceof GmiError ? error.message : 'Unexpected error');

  function mark(source: ComputeCatalogSource, ok: boolean, error?: unknown, at?: string) {
    const prev = cache.sources[source];
    if (ok) cache.sources[source] = { state: 'ok', fetchedAt: at ?? now().toISOString(), error: null };
    else cache.sources[source] = { state: prev.fetchedAt ? 'stale' : 'error', fetchedAt: prev.fetchedAt, error: errorText(error) };
  }

  function clearAccount() {
    cache.accountTemplates = null;
    cache.accountByIdc = {};
    for (const s of ACCOUNT_SOURCES) cache.sources[s] = { state: 'skipped', fetchedAt: null, error: null };
  }

  async function currentKeyPresent(): Promise<boolean> {
    try {
      keyPresent = (await deps.keys.getComputeKey()) !== null;
    } catch {
      keyPresent = false;
    }
    return keyPresent;
  }

  async function refreshPublicNow(): Promise<void> {
    const at = now().toISOString();
    const [idcs, feed, templates] = await Promise.allSettled([deps.publicApi.idcs(), deps.publicApi.billingProducts(), deps.publicApi.publicTemplates()]);
    if (idcs.status === 'fulfilled') {
      const list = normalizeIdcs(idcs.value);
      if (list.length) {
        cache.idcs = { at, items: list };
        mark('idcs', true, undefined, at);
      } else mark('idcs', false, new GmiError('upstream', 'GMI returned no data centres.'));
    } else mark('idcs', false, idcs.reason);
    if (feed.status === 'fulfilled') {
      const rows = filterPublicProducts(feed.value);
      if (rows.length) {
        priceIndex = feedPriceIndex(feed.value);
        cache.publicProducts = { at, items: rows };
        publicFetchedThisRun = true;
        mark('publicProducts', true, undefined, at);
      } else mark('publicProducts', false, new GmiError('upstream', 'GMI returned no prices.'));
    } else mark('publicProducts', false, feed.reason);
    if (templates.status === 'fulfilled') {
      // The key-less endpoint serves GMI's official templates only.
      const list = templates.value.map((t) => redactTemplate(isObj(t) ? { ...t, official: true } : t)).filter((t): t is ComputeTemplate => t !== null);
      cache.publicTemplates = { at, items: list };
      mark('publicTemplates', true, undefined, at);
    } else mark('publicTemplates', false, templates.reason);
    for (const r of [idcs, feed, templates]) if (r.status === 'rejected') log.warn('public compute source failed', { code: r.reason instanceof GmiError ? r.reason.code : 'internal' });
    await persist();
    notify();
  }

  function refreshPublic(force = false): Promise<void> {
    const t = now().getTime();
    if (!force && cache.publicProducts && cache.idcs && t - Date.parse(cache.publicProducts.at) < CATALOG_TIMING.publicRefreshMs && publicFetchedThisRun) {
      return Promise.resolve();
    }
    if (publicInflight) return publicInflight;
    if (!force && lastPublicAttempt && t - lastPublicAttempt < CATALOG_TIMING.publicRetryMs) return Promise.resolve();
    lastPublicAttempt = t;
    publicInflight = refreshPublicNow().finally(() => (publicInflight = null));
    return publicInflight;
  }

  async function refreshTemplatesNow(): Promise<void> {
    const at = now().toISOString();
    try {
      const list = (await deps.ce.listTemplates()).map((t: CeTemplate) => redactTemplate(t)).filter((t): t is ComputeTemplate => t !== null);
      cache.accountTemplates = { at, items: list };
      mark('accountTemplates', true, undefined, at);
    } catch (error) {
      mark('accountTemplates', false, error);
    }
  }

  async function refreshAccountNow(idc: string): Promise<void> {
    const at = now().toISOString();
    const entry: AccountIdcData = { ...(cache.accountByIdc[idc] ?? {}) };
    const rows = cache.publicProducts?.items ?? [];
    const templatesStale = !cache.accountTemplates || now().getTime() - Date.parse(cache.accountTemplates.at) > CATALOG_TIMING.accountFreshMs;
    if (templatesStale && !templatesInflight) templatesInflight = refreshTemplatesNow().finally(() => (templatesInflight = null));
    const [products, sbProducts, sbTemplates, eips] = await Promise.allSettled([
      deps.ce.listProducts(idc),
      deps.sandbox.products(idc),
      deps.sandbox.templates(idc),
      deps.ce.eipProducts(idc),
    ]);
    if (products.status === 'fulfilled') {
      const offers = products.value
        .filter((p) => str(p?.idc) === idc || !str(p?.idc))
        .map((p) => accountContainerOffer({ ...p, idc: str(p?.idc) ?? idc }, priceFrom(priceIndex, rows, String(p?.name ?? ''), idc)))
        .filter((o): o is ComputeOffer => o !== null);
      entry.products = { at, items: offers };
      mark('accountProducts', true, undefined, at);
    } else mark('accountProducts', false, products.reason);
    if (sbProducts.status === 'fulfilled') {
      const offers = sbProducts.value
        .map((p: V2Product) => sandboxOffer(p, idc, priceFrom(priceIndex, rows, String(p?.product ?? ''), idc)))
        .filter((o): o is ComputeOffer => o !== null);
      entry.sandboxProducts = { at, items: offers };
      mark('sandboxProducts', true, undefined, at);
    } else mark('sandboxProducts', false, sbProducts.reason);
    if (sbTemplates.status === 'fulfilled') {
      entry.sandboxTemplates = { at, items: sbTemplates.value.map((t: V2Template) => redactSandboxTemplate(t)).filter((t): t is ComputeTemplate => t !== null).map((t) => ({ ...t, idc: t.idc ?? idc })) };
      mark('sandboxTemplates', true, undefined, at);
    } else mark('sandboxTemplates', false, sbTemplates.reason);
    if (eips.status === 'fulfilled') {
      entry.eip = {
        at,
        items: eips.value
          .filter((p) => p && p.valid !== false && str(p.name))
          .map((p) => ({ sku: p.name, usdPerHour: priceFrom(priceIndex, rows, p.name, idc) })),
      };
    }
    cache.accountByIdc[idc] = entry;
    if (templatesInflight) await templatesInflight;
    await persist();
    notify();
  }

  async function refreshAccount(idc: string, force = false): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(idc)) throw new GmiError('invalid_input', 'Not a valid data centre.');
    if (!(await currentKeyPresent())) {
      if (cache.accountTemplates || Object.keys(cache.accountByIdc).length) {
        clearAccount();
        await persist();
        notify();
      }
      return;
    }
    const entry = cache.accountByIdc[idc];
    const fresh = entry?.products && now().getTime() - Date.parse(entry.products.at) < CATALOG_TIMING.accountFreshMs;
    if (fresh && !force) return;
    const running = accountInflight.get(idc);
    if (running) return running;
    const p = refreshAccountNow(idc).finally(() => accountInflight.delete(idc));
    accountInflight.set(idc, p);
    return p;
  }

  function build(): ComputeCatalog {
    const rows = cache.publicProducts?.items ?? [];
    const account = keyPresent ? cache.accountByIdc : {};
    const offers: ComputeOffer[] = [];
    const publicOffers = aggregatePublicOffers(rows);
    const idcsWithAccount = new Set(Object.entries(account).filter(([, d]) => d.products).map(([idc]) => idc));
    const idcsWithSandbox = new Set(Object.entries(account).filter(([, d]) => d.sandboxProducts).map(([idc]) => idc));
    for (const o of publicOffers) {
      if (o.kind === 'container' && idcsWithAccount.has(o.idc)) continue;
      if (o.kind === 'sandbox' && idcsWithSandbox.has(o.idc)) continue;
      offers.push(o);
    }
    for (const d of Object.values(account)) {
      offers.push(...(d.products?.items ?? []), ...(d.sandboxProducts?.items ?? []));
    }
    offers.sort(compareOffers);

    const kindsByIdc = new Map<string, Set<ComputeKind>>();
    for (const o of offers) {
      if (o.entitled === false) continue;
      const set = kindsByIdc.get(o.idc) ?? new Set<ComputeKind>();
      set.add(o.kind);
      kindsByIdc.set(o.idc, set);
    }
    const publicEipIdcs = new Set(rows.filter((r) => r.kind === 'eip').map((r) => r.idc));
    const idcs: ComputeIdc[] = (cache.idcs?.items ?? []).map((i) => {
      const eip = account[i.id]?.eip;
      return {
        id: i.id,
        name: i.name,
        country: i.country,
        status: i.status,
        kinds: (['container', 'sandbox'] as const).filter((k) => kindsByIdc.get(i.id)?.has(k)),
        eipAvailable: eip ? eip.items.length > 0 : publicEipIdcs.has(i.id) ? true : null,
      };
    });

    const templates = new Map<string, ComputeTemplate>();
    for (const t of cache.publicTemplates?.items ?? []) templates.set(`container:${t.id}`, t);
    if (keyPresent) {
      for (const t of cache.accountTemplates?.items ?? []) if (!templates.has(`container:${t.id}`)) templates.set(`container:${t.id}`, t);
      for (const d of Object.values(account)) for (const t of d.sandboxTemplates?.items ?? []) templates.set(`sandbox:${t.idc ?? ''}:${t.id}`, t);
    }

    const sources = { ...cache.sources };
    if (!keyPresent) for (const s of ACCOUNT_SOURCES) sources[s] = { state: 'skipped', fetchedAt: null, error: null };
    const scope = keyPresent && (sources.accountProducts.state === 'ok' || sources.accountTemplates.state === 'ok' || sources.accountProducts.fetchedAt !== null) ? 'account' : 'public';
    const stamps = CATALOG_SOURCES.map((s) => sources[s].fetchedAt).filter((x): x is string => x !== null).sort();
    return {
      idcs,
      offers,
      templates: [...templates.values()],
      scope,
      sources,
      fetchedAt: stamps[stamps.length - 1] ?? now().toISOString(),
    };
  }

  function price(sku: string, idc?: string | null): PriceInfo {
    const rows = cache.publicProducts?.items ?? [];
    const at = cache.publicProducts?.at ?? null;
    const source: PriceInfo['source'] = publicFetchedThisRun ? 'public_feed' : 'cached';
    const fromRows = pickPrice(
      rows.filter((r) => r.sku === sku && r.usdPerHour !== null).map((r) => ({ idc: r.idc, usdPerHour: r.usdPerHour as number })),
      idc,
    );
    if (fromRows !== null) return { usdPerHour: fromRows, fetchedAt: at, source };
    const fromIndex = priceIndex ? priceFrom(priceIndex, [], sku, idc ?? null) : null;
    if (fromIndex !== null) return { usdPerHour: fromIndex, fetchedAt: at, source: 'public_feed' };
    for (const [key, d] of Object.entries(cache.accountByIdc)) {
      if (idc && key !== idc) continue;
      const hit = [...(d.products?.items ?? []), ...(d.sandboxProducts?.items ?? [])].find((o) => o.sku === sku && o.listUsdPerHour !== null);
      if (hit) return { usdPerHour: hit.listUsdPerHour, fetchedAt: d.products?.at ?? d.sandboxProducts?.at ?? null, source: 'cached' };
      const eip = d.eip?.items.find((e) => e.sku === sku && e.usdPerHour !== null);
      if (eip) return { usdPerHour: eip.usdPerHour, fetchedAt: d.eip?.at ?? null, source: 'cached' };
    }
    return { usdPerHour: null, fetchedAt: null, source };
  }

  return {
    async load() {
      try {
        cache = readCatalogCache(await readJsonFile<unknown>(file));
      } catch (error) {
        log.warn('catalog cache unreadable; starting empty', { error });
        cache = emptyCache();
      }
      await currentKeyPresent();
      if (!unsubscribeKeys) {
        unsubscribeKeys = deps.keys.onChange(() => {
          void (async () => {
            const had = keyPresent;
            const has = await currentKeyPresent();
            if (!has || had !== has) {
              clearAccount();
              await persist();
            }
            notify();
          })();
        });
      }
    },
    async getCatalog(opts = {}) {
      if (opts.refresh) {
        await refreshPublic(true);
      } else if (!cache.publicProducts || !cache.idcs) {
        await refreshPublic(false);
      } else {
        void refreshPublic(false).catch(() => undefined);
      }
      if (opts.idc) await refreshAccount(opts.idc, opts.refresh === true);
      else await currentKeyPresent();
      return build();
    },
    snapshot: build,
    refreshPublic: (force) => refreshPublic(force ?? false),
    refreshAccount,
    price,
    eipSku(idc) {
      const account = keyPresent ? cache.accountByIdc[idc]?.eip?.items : undefined;
      const list = account?.length
        ? account
        : (cache.publicProducts?.items ?? []).filter((r) => r.kind === 'eip' && r.idc === idc).map((r) => ({ sku: r.sku, usdPerHour: r.usdPerHour }));
      if (!list.length) return null;
      return [...list].sort((a, b) => (a.usdPerHour ?? Infinity) - (b.usdPerHour ?? Infinity))[0] ?? null;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void refreshPublic(true).catch(() => undefined), CATALOG_TIMING.publicRefreshMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribeKeys?.();
      unsubscribeKeys = null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
