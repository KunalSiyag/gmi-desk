// The compute sanitiser (compute.md §5.2; every rule has a test in test/compute/sanitize.test.ts) and the dev trace
// writer (§17, `GMI_DESK_TRACE=1`).
//
// 1. Public product descriptions are read in memory ONLY to filter: never stored, logged, traced, emitted or written
//    to fixtures (they name third-party customers [V]). Rows whose description or name match DENY are dropped, and so
//    are rows with `valid !== true`.
// 2. SKU allowlist for the public feed: ^gmi\.(container\.(nv|intel|amd)\.|sandbox\.|eip\.|sole\.)
// 3. (catalog.ts) signed out, offers are aggregated; no raw SKU is shown.
// 5. Templates: `credential` removed entirely; descriptions kept only for official templates.
// 6. Resource responses: `envs[].value` removed (names only); `traces` never kept; the shell `urlPath` never traced.
// Traces: control-plane bodies go through `scrubForTrace` (these rules + token fields) and then the logger's
// key-name `sanitize()`. Data-plane bodies are never traced: status, sizes and request ids only.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComputeKind, ComputeTemplate } from '@shared/contracts/compute';
import { sanitize as logSanitize } from '../../core/logger';
import { CE_PRICE_UNITS_PER_USD, type CeBillingProduct, type CeContainer, type CeTemplate } from './ce/dto';
import type { V2Template } from './sandbox/dto';

// ─── Rule 1 + 2: the public billing feed ───────────────────────────────────────────────────────────────────────────

export const PUBLIC_SKU_ALLOWLIST = /^gmi\.(container\.(nv|intel|amd)\.|sandbox\.|eip\.|sole\.)/;
/** Description or name of a customer-specific / internal row (§5.2 rule 1). */
export const PUBLIC_ROW_DENY = /\bonly\b|\bfor\b.*\bteam\b|internal|test|poc|trial/i;

export type PublicSkuKind = ComputeKind | 'eip';

/** One public feed row after filtering: no description, no labels, nothing but what the catalog shows. */
export interface PublicProductRow {
  sku: string;
  /** GMI `dataCenter` (an IDC id). */
  idc: string;
  kind: PublicSkuKind;
  /** List USD per hour; null when the feed price is missing or not a number. */
  usdPerHour: number | null;
  gpuModel: string | null;
  gpuCount: number;
  vcpu: number | null;
  memoryGiB: number | null;
  diskGiB: number | null;
  /** Sandbox size label from the SKU (`gmi.sandbox.small` → SMALL). */
  sizeLabel: string | null;
}

export function publicSkuKind(sku: string): PublicSkuKind | null {
  if (!PUBLIC_SKU_ALLOWLIST.test(sku)) return null;
  if (sku.startsWith('gmi.container.')) return 'container';
  if (sku.startsWith('gmi.sandbox.')) return 'sandbox';
  return 'eip';
}

export function isPublicSkuAllowed(sku: string): boolean {
  return PUBLIC_SKU_ALLOWLIST.test(sku);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function toGiB(qty: number, unit: string | null): number | null {
  const u = (unit ?? 'GiB').toLowerCase();
  if (/^t/.test(u)) return qty * 1024;
  if (/^g/.test(u)) return qty;
  if (/^m/.test(u)) return Math.round((qty / 1024) * 100) / 100;
  return null;
}

function specFigures(spec: unknown): { vcpu: number | null; memoryGiB: number | null; diskGiB: number | null } {
  const out = { vcpu: null as number | null, memoryGiB: null as number | null, diskGiB: null as number | null };
  const lines = isObj(spec) && Array.isArray(spec.basic) ? spec.basic.filter(isObj) : [];
  for (const line of lines) {
    const name = nonEmpty(line.name) ?? '';
    const qty = Number(nonEmpty(line.qty) ?? (typeof line.qty === 'number' ? line.qty : NaN));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const unit = nonEmpty(line.unit);
    if (/gpu/i.test(name)) continue;
    if (/v?cpu|core/i.test(name) && out.vcpu === null) out.vcpu = qty;
    else if (/mem|ram/i.test(name) && out.memoryGiB === null) out.memoryGiB = toGiB(qty, unit);
    else if (/disk|storage|nvme|ssd/i.test(name) && out.diskGiB === null) out.diskGiB = toGiB(qty, unit);
  }
  return out;
}

const GPU_IN_SKU = /\.([A-Za-z][A-Za-z0-9]*|\d+[A-Za-z0-9]*)x(\d+)(?:\.|$)/;

/** GPU model and count from the row (`attributes.gpu_count`, `gpuModel`) or the SKU (`…nv.H200x8.tw3`). */
function gpuOf(row: Obj, sku: string): { gpuModel: string | null; gpuCount: number } {
  const declared = nonEmpty(row.gpuModel);
  const model = declared && !/cpu/i.test(declared) ? declared : null;
  const attrs = isObj(row.attributes) ? row.attributes : {};
  const fromAttr = typeof attrs.gpu_count === 'number' && Number.isInteger(attrs.gpu_count) && attrs.gpu_count >= 0 ? attrs.gpu_count : null;
  const m = sku.startsWith('gmi.container.nv.') || sku.startsWith('gmi.container.amd.') ? GPU_IN_SKU.exec(sku) : null;
  const fromSku = m?.[2] ? Number(m[2]) : null;
  const gpuModel = model ?? (m?.[1] && fromSku ? m[1] : null);
  const gpuCount = gpuModel ? (fromAttr ?? fromSku ?? 1) : 0;
  return { gpuModel, gpuCount };
}

/** micro-USD per hour → USD per hour (null when not a finite, non-negative number). */
export function microUsdToUsd(price: unknown): number | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  return price / CE_PRICE_UNITS_PER_USD;
}

/** True when a public feed row is dropped (rule 1). Reads `description` here and nowhere else. */
export function isDeniedPublicRow(row: Pick<CeBillingProduct, 'valid'> & Partial<CeBillingProduct>): boolean {
  if (row.valid !== true) return true;
  const texts = [row.description, row.instanceType, row.productName, row.spec?.name, row.productLine];
  return texts.some((t) => typeof t === 'string' && PUBLIC_ROW_DENY.test(t));
}

/**
 * Rules 1 and 2 over `GET /api/v1/billing/products` (`{products}` or the bare array). Malformed rows are skipped,
 * never thrown on: one odd row must not hide the catalog. The returned rows hold no description.
 */
export function filterPublicProducts(feed: unknown): PublicProductRow[] {
  const rows = isObj(feed) && Array.isArray(feed.products) ? feed.products : Array.isArray(feed) ? feed : [];
  const out: PublicProductRow[] = [];
  for (const raw of rows) {
    if (!isObj(raw)) continue;
    const sku = nonEmpty(raw.instanceType);
    const idc = nonEmpty(raw.dataCenter);
    if (!sku || !idc) continue;
    if (isDeniedPublicRow(raw as unknown as CeBillingProduct)) continue;
    const kind = publicSkuKind(sku);
    if (!kind) continue;
    const { gpuModel, gpuCount } = kind === 'container' ? gpuOf(raw, sku) : { gpuModel: null, gpuCount: 0 };
    const figures = kind === 'eip' ? { vcpu: null, memoryGiB: null, diskGiB: null } : specFigures(raw.spec);
    out.push({
      sku,
      idc,
      kind,
      usdPerHour: microUsdToUsd(raw.price),
      gpuModel,
      gpuCount,
      ...figures,
      sizeLabel: kind === 'sandbox' ? sku.slice('gmi.sandbox.'.length).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() || null : null,
    });
  }
  return out;
}

/**
 * Prices of every valid row of the feed, by SKU and IDC, for joining the org's own products (§5.2 rule 4): the org's
 * products may carry SKUs the public allowlist drops. Only `{sku, idc, usdPerHour}`: no description, never emitted as
 * rows. Kept in memory by the catalog; only prices of SKUs the org can launch reach the cache.
 */
export function feedPriceIndex(feed: unknown): Map<string, Array<{ idc: string; usdPerHour: number }>> {
  const rows = isObj(feed) && Array.isArray(feed.products) ? feed.products : Array.isArray(feed) ? feed : [];
  const index = new Map<string, Array<{ idc: string; usdPerHour: number }>>();
  for (const raw of rows) {
    if (!isObj(raw) || raw.valid !== true) continue;
    const sku = nonEmpty(raw.instanceType);
    const usd = microUsdToUsd(raw.price);
    if (!sku || usd === null) continue;
    const list = index.get(sku) ?? [];
    list.push({ idc: nonEmpty(raw.dataCenter) ?? '', usdPerHour: usd });
    index.set(sku, list);
  }
  return index;
}

// ─── Rule 5: templates ─────────────────────────────────────────────────────────────────────────────────────────────

/** Ports official CE templates pre-expose (SSH and Jupyter) [V:C, D]. */
export const OFFICIAL_TEMPLATE_PORTS: ComputeTemplate['defaultPorts'] = [
  { port: 22, protocol: 'TCP', label: 'SSH' },
  { port: 8888, protocol: 'TCP', label: 'Jupyter' },
];

/** A CE template for the renderer: no `credential`, a description only when official (rule 5). Null: malformed. */
export function redactTemplate(t: unknown): ComputeTemplate | null {
  if (!isObj(t)) return null;
  const id = nonEmpty(t.id);
  const name = nonEmpty(t.name);
  if (!id || !name) return null;
  const official = t.official === true;
  const image = nonEmpty(t.path);
  return {
    id,
    kind: 'container',
    name: name.slice(0, 120),
    official,
    image: image && !/\s/.test(image) ? image.slice(0, 253) : null,
    description: official ? (nonEmpty(t.description)?.slice(0, 500) ?? null) : null,
    defaultPorts: official ? OFFICIAL_TEMPLATE_PORTS.map((p) => ({ ...p })) : [],
    sshReady: official ? true : null,
    idc: null,
  };
}

/** A v2 sandbox template (belongs to one IDC). v2 templates are the org's: no description is kept. */
export function redactSandboxTemplate(t: unknown): ComputeTemplate | null {
  if (!isObj(t)) return null;
  const id = nonEmpty(t.id);
  const name = nonEmpty(t.name);
  if (!id || !name) return null;
  const status = nonEmpty(t.status);
  if (status && status !== 'ready') return null;
  return {
    id,
    kind: 'sandbox',
    name: name.slice(0, 120),
    official: false,
    image: null,
    description: null,
    defaultPorts: [],
    sshReady: null,
    idc: nonEmpty(t.idc_name),
  };
}

/** The CE template wire type without its secret (for code that needs the raw fields, e.g. tests and traces). */
export type SafeCeTemplate = Omit<CeTemplate, 'credential'>;

// ─── Rule 6: resource responses ────────────────────────────────────────────────────────────────────────────────────

/** A container as main keeps it: env values gone (names only). Nothing in it is a secret. */
export type SafeCeContainer = Omit<CeContainer, 'envs'> & { envNames: string[] };

export function redactContainer(c: CeContainer): SafeCeContainer {
  const { envs, ...rest } = c as CeContainer & { traces?: unknown };
  delete (rest as { traces?: unknown }).traces;
  const envNames = Array.isArray(envs) ? envs.flatMap((e) => (isObj(e) && typeof e.name === 'string' ? [e.name] : [])) : [];
  return { ...rest, envNames };
}

export function redactContainers(list: unknown): SafeCeContainer[] {
  return Array.isArray(list)
    ? list.filter((c): c is CeContainer => isObj(c) && typeof c.id === 'string' && typeof c.name === 'string').map(redactContainer)
    : [];
}

// ─── Traces (§17) ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Keys removed from any traced body, whatever their value (secret, or third-party data). */
const TRACE_DROP_KEYS = new Set([
  'description',
  'credential',
  'traces',
  'trace_id',
  'sandbox_access_token',
  'traffic_access_token',
  'connect_url',
  'urlPath',
  'labels',
  'value',
]);

/** Compute-specific scrub of a control-plane body before the logger's key-name `sanitize()`. */
export function scrubForTrace(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubForTrace(v, depth + 1));
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (TRACE_DROP_KEYS.has(k)) continue;
    if ((k === 'envs' || k === 'env_vars') && v) {
      out[k === 'envs' ? 'envNames' : 'env_var_names'] = Array.isArray(v)
        ? v.flatMap((e) => (isObj(e) && typeof e.name === 'string' ? [e.name] : []))
        : isObj(v)
          ? Object.keys(v)
          : [];
      continue;
    }
    out[k] = scrubForTrace(v, depth + 1);
  }
  return out;
}

export type TraceApi = 'ce' | 'v2' | 'dataplane' | 'public';

export interface TraceRecord {
  api: TraceApi;
  method: string;
  /** Path only: no host (the sandbox host), no query string. */
  path: string;
  status: number | null;
  requestId: string | null;
  bytes: number | null;
  ms: number;
  error?: string;
  /** Control plane only; scrubbed and sanitised before it is written. */
  body?: unknown;
}

export interface ComputeTrace {
  record(rec: TraceRecord): void;
  /** Resolves once every queued line is on disk (tests, dispose). */
  flush(): Promise<void>;
  readonly file: string;
}

/** The line a trace record becomes. Data-plane records never carry a body, whatever the caller passed. */
export function traceLine(rec: TraceRecord, at: Date): string {
  const { body, ...meta } = rec;
  const line: Obj = { t: at.toISOString(), ...meta, path: rec.path.split('?')[0] ?? '' };
  if (rec.api !== 'dataplane' && body !== undefined) line.body = logSanitize(scrubForTrace(body));
  return JSON.stringify(logSanitize(line));
}

/** True when the dev trace is on (`GMI_DESK_TRACE=1`; the variable is stripped from packaged builds). */
export function traceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GMI_DESK_TRACE === '1';
}

/** Writes `logs/trace-compute-<YYYYMMDD>.jsonl`. Null when tracing is off. */
export function createComputeTrace(opts: { logsDir: string; enabled?: boolean; now?: () => Date }): ComputeTrace | null {
  if (!(opts.enabled ?? traceEnabled())) return null;
  const now = opts.now ?? (() => new Date());
  const day = now().toISOString().slice(0, 10).replace(/-/g, '');
  const file = join(opts.logsDir, `trace-compute-${day}.jsonl`);
  let queue: Promise<void> = Promise.resolve();
  let dirReady = false;
  return {
    file,
    record(rec) {
      const line = traceLine(rec, now());
      queue = queue
        .then(async () => {
          if (!dirReady) {
            await mkdir(opts.logsDir, { recursive: true });
            dirReady = true;
          }
          await appendFile(file, `${line}\n`, 'utf8');
        })
        .catch(() => undefined);
    },
    flush: () => queue,
  };
}

/** Type guard used by the clients for v2 templates. */
export function isV2Template(v: unknown): v is V2Template {
  return isObj(v) && typeof v.id === 'string' && typeof v.name === 'string';
}
