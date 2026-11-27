// Cluster Engine wire types (compute.md §5, §6, §14), hand-written from GMI's OpenAPI documents. Frozen by C1-0.
//
// Sources (SHA-256 of the file as downloaded; re-check before changing a type):
//   https://docs.gmicloud.ai/api-spec/service_api.yaml   "Cluster Engine API" 2.4.0
//     sha256 520a9b53386c7a064cf287833dfdba0cd15450e478ddcff0627164580560e6b8
//   https://docs.gmicloud.ai/api-spec/ids-public-api.yaml   (GET /api/v1/idcs)
//     sha256 74adf092555f6dcbc6ed7d212c6fbded18550d00279cf45e541afb02b84ee2b0
//   GET /api/v1/billing/products and /api/v1/public/templates: not in any spec; shapes recorded key-less on 2026-11-02
//     (docs/research/cluster-engine.md §3, §6).
// Re-check: `curl -sA "gmi-client-research/0.1" <url> | sha256sum`; a different hash means: diff the spec, update
// these types and their normalisers (C1-B) with regression tests.
//
// Rules for everything in this file:
// - Wire shapes only (field names exactly as GMI sends them). Normalising into contract types happens in C1-B.
// - Every field GMI may omit is optional, and unknown enum values must be accepted by the parsers (`| (string & {})`).
// - Fields marked SECRET never leave main: not stored, logged, traced, emitted or written to fixtures (§5.2, §17).

/** Accepts values outside a documented enum without losing autocompletion for the known ones. */
export type CeOpen<T extends string> = T | (string & {});

// ─── Errors (every shape a CE / IAM / billing endpoint answers with; errors.ts maps them) ─────────────────────────

/** `components.schemas.error`: 400/403/404/409/500/503 of /api/v1/containers, templates, EIPs, firewalls. */
export interface CeReasonError {
  code?: number;
  reason: string;
}

/** `validationDetail` (also in the IAM and IDC specs). */
export interface CeValidationDetail {
  argument?: string;
  expression?: string;
  field?: string;
  originalValue?: unknown;
  reason?: string;
}

/**
 * `components.schemas.errorStatusMessage` (IAM substatus): the documented 401 (`group: auth_verify`, code 0 invalid /
 * 1 expired), the observed 401s (`api-key`/200 without credentials, `auth`/2 for a malformed bearer) and 400s with
 * `group: request` + `validationDetail`. `traces` may hold internal detail: debug log only, never shown (§5.2).
 */
export interface CeStatusMessageError {
  group: string;
  code: number;
  message?: string;
  traces?: string[];
  validationDetail?: CeValidationDetail[];
}

/** Billing endpoints (`/api/v1/billing/*`) answer `{error}` (docs/RESEARCH.md). */
export interface CeBillingError {
  error: string;
}

export type CeErrorBody = CeReasonError | CeStatusMessageError | CeBillingError;

/** `components.responses.Done`: DELETE container, restart. */
export interface CeDone {
  result: string;
}

/** `components.schemas.UuidObject`: create responses (`[{id}]`, one per `count`), template create, reconfigure. */
export interface CeIdObject {
  id: string;
}

// ─── IDCs (public, key-less) ───────────────────────────────────────────────────────────────────────────────────────

export type CeIdcStatus = CeOpen<'available' | 'full' | 'maintenance'>;

/** GET https://console.gmicloud.ai/api/v1/idcs → `{idcs: CeIdc[]}`. */
export interface CeIdc {
  idcId: string;
  name: string;
  country: string;
  countrySubdivision: string;
  status: CeIdcStatus;
}

export interface CeIdcListResponse {
  idcs: CeIdc[];
}

// ─── Public billing feed (key-less): GET /api/v1/billing/products[?dataCenter=<idc>] → {products: [...]} ──────────

/** One `spec.basic` line of a container / bare-metal row (`qty` is a string, e.g. "24"). */
export interface CeBillingSpecLine {
  name: string;
  brand?: string;
  model?: string;
  qty?: string;
  unit?: string;
  /** EIP rows use name/value pairs instead (e.g. "Shared Bandwidth" → "10 Gbps"). */
  value?: string;
}

export interface CeBillingProduct {
  id: string;
  /** The SKU, e.g. `gmi.container.nv.H200x1.tw3`, `gmi.sandbox.small`, `gmi.eip.sole.shared`. Joined to CE products on `name` [I]. */
  instanceType: string;
  /** IDC id, or "global" (credit rows). */
  dataCenter: string;
  /** List price in micro-USD per hour (1 000 000 = $1). */
  price: number;
  valid: boolean;
  /** "Container", "Sandbox", "EIP", "BareMetal", "Credit", … */
  productName: string;
  productLine?: string;
  /** "H200", "CPU-only" or "" (sandbox, EIP). */
  gpuModel?: string;
  attributes?: { gpu_count?: number } & Record<string, unknown>;
  spec: { name?: string; basic?: CeBillingSpecLine[] } | null;
  /** A JSON string ("{}"). */
  labels?: string;
  createdAt?: string;
  /**
   * SECRET-like (third-party customer names, [V]): read in memory ONLY to filter (§5.2 rule 1). Never stored,
   * logged, emitted or written to fixtures.
   */
  description?: string;
}

export interface CeBillingProductsResponse {
  products: CeBillingProduct[];
}

/** Micro-USD per USD in `price` fields of the billing feed and of `product`. */
export const CE_PRICE_UNITS_PER_USD = 1_000_000;

// ─── Products (key): GET /api/v1/containers/products?idc=, /api/v1/elastic-ips/products?idc= ──────────────────────

export type CeProductType = CeOpen<'Container' | 'BareMetal' | 'Storage' | 'EIP'>;

/** `components.schemas.product`. Entitlement-filtered for the org [I]. */
export interface CeProduct {
  idc: string;
  /** SKU (= billing feed `instanceType` [I]). */
  name: string;
  type: CeProductType;
  /** Micro-USD per hour (as the billing feed) [I]. */
  price: number;
  valid: boolean;
  spec: Record<string, unknown>;
  gpuModel?: string;
  productLine?: string;
}

// ─── Templates: GET /api/v1/public/templates (key-less), GET /api/v1/templates (key) ──────────────────────────────

/** `components.schemas.credential`. SECRET: removed entirely by the sanitiser (§5.2 rule 5). */
export interface CeCredential {
  username?: string;
  secret?: string;
}

export type CeTemplateStatus = CeOpen<'draft' | 'published' | 'unpublished'>;

/** `components.schemas.templateResp`. */
export interface CeTemplate {
  id: string;
  official: boolean;
  orgId?: string;
  name: string;
  /** Image URI, e.g. `docker.io/gmicloudai/…:v2`. */
  path: string;
  /** Kept only for `official: true` (§5.2 rule 5). */
  description?: string;
  status?: CeTemplateStatus;
  /** SECRET (registry password). */
  credential?: CeCredential;
}

// ─── Containers: /api/v1/containers ────────────────────────────────────────────────────────────────────────────────

/** `components.schemas.Env`. `value` is SECRET in responses (only names cross IPC, §5.2 rule 6). */
export interface CeEnv {
  /** `^[a-zA-Z_][a-zA-Z0-9_]*$`, ≤ 4096. */
  name: string;
  /** ≤ 1 MiB (the app caps at 64 KiB, §6.1). */
  value: string;
}

export type CeProtocol = 'TCP' | 'UDP';

/** `components.schemas.exposedPort`. `port` is the listening (Node)Port, auto-assigned when omitted. */
export interface CeExposedPort {
  containerPort: number;
  port?: number;
  protocol: CeProtocol;
}

/** `components.schemas.Storage`: a persistent file system mount (console-only product; read-only for the app). */
export interface CeStorage {
  id: string;
  containerPath: string;
}

/** `components.schemas.containerConfig` (also the PUT /containers/{id} body: reconfigure wipes data [V]). */
export interface CeContainerConfig {
  /** `^([A-Za-z0-9][A-Za-z0-9_\-. ]*)?[A-Za-z0-9]$`, ≤ 255. */
  name: string;
  templateId: string;
  command?: string;
  args?: string[];
  envs?: CeEnv[];
  /** At most 5 (spec writes it as `maxLength`). */
  ports?: CeExposedPort[];
  sshKeyIdList?: string[];
}

/** `components.schemas.containerReq`: POST /api/v1/containers → 200 `CeIdObject[]`. The app always sends `count: 1`. */
export interface CeContainerCreateRequest extends CeContainerConfig {
  count: number;
  idc: string;
  /** SKU. */
  product: string;
}

export type CeContainerCreateResponse = CeIdObject[];

export type CeContainerStatus = CeOpen<'unknown' | 'creating' | 'running' | 'terminating' | 'stopped' | 'error' | 'zombie'>;

/** The documented `containerStatus` enum (§6.5 maps each one; anything else is `unknown`). */
export const CE_CONTAINER_STATUSES = ['unknown', 'creating', 'running', 'terminating', 'stopped', 'error', 'zombie'] as const;

/** `components.schemas.externalIP`. */
export interface CeExternalIp {
  ipAddress: string;
  status: CeOpen<'ready' | 'pending' | 'error' | 'not_applicable'>;
}

/** `components.schemas.containersResp`: GET /api/v1/containers (array, no paging [V]) and GET /containers/{id}. */
export interface CeContainer {
  id: string;
  orgId?: string;
  name: string;
  idc: string;
  product: string;
  templateId: string;
  status: CeContainerStatus;
  reason: string;
  createdAt?: string;
  modifiedAt?: string;
  command?: string;
  args?: string[];
  /** SECRET values (§5.2 rule 6). */
  envs?: CeEnv[];
  ports?: CeExposedPort[];
  sshKeyIdList?: string[];
  storages: CeStorage[];
  firewalls?: string[];
  eipId?: string;
  eipAddress?: string;
  inboundIP?: CeExternalIp;
  outboundIP?: CeExternalIp;
  publicIP?: CeExternalIp;
}

/** POST /api/v1/containers/{id}/shell. SECRET: `urlPath` is never logged or emitted (§5.2 rule 6, §8.8). */
export interface CeShellResponse {
  urlPath: string;
}

// ─── Elastic IPs: /api/v1/elastic-ips ──────────────────────────────────────────────────────────────────────────────

export type CeInstanceType = 'baremetal' | 'container';
export type CeEipStatus = CeOpen<'released' | 'associated' | 'disassociated'>;

/** `components.schemas.elasticIPAllocateReq` → 200 `CeIdObject[]`. */
export interface CeEipAllocateRequest {
  idc: string;
  count: number;
  name: string;
  product: string;
}

/** `components.schemas.elasticIPAssociateConfig`: POST /elastic-ips/{id}/associate. */
export interface CeEipAssociateRequest {
  instanceID: string | null;
  instanceType: CeInstanceType | null;
}

/** `components.schemas.elasticIPResp`. Billed in every state until released [V]. */
export interface CeElasticIp {
  id: string;
  orgId: string;
  idc: string;
  name: string;
  ipAddress: string;
  product: string;
  status: CeEipStatus;
  internetConnectionType?: CeOpen<'BGP' | 'Dual-Homed'>;
  maxBandwidth?: string;
  instanceID?: string | null;
  instanceType?: CeInstanceType | null;
}

// ─── Firewalls: /api/v1/firewalls ──────────────────────────────────────────────────────────────────────────────────

export interface CePortRange {
  min: number;
  max: number;
}

/** `FirewallRuleWithPortRange` | `FirewallRuleWithoutPortRange`. `remoteIpPrefix` is an IPv4 CIDR. */
export type CeFirewallRule =
  | { protocol: 'tcp' | 'udp'; portRange: CePortRange; remoteIpPrefix: string; description?: string }
  | { protocol: 'icmp' | 'any'; remoteIpPrefix: string; description?: string };

/** `FirewallUpdateReq` (PUT /firewalls/{id}). */
export interface CeFirewallUpdateRequest {
  name: string;
  description?: string;
  inboundRules: CeFirewallRule[];
}

/** `FirewallCreateReq` (POST /firewalls). */
export interface CeFirewallCreateRequest extends CeFirewallUpdateRequest {
  idc: string;
}

/** POST /firewalls/{id}/associate and /disassociate. `instanceType` defaults to baremetal: always send it. */
export interface CeFirewallAssociateRequest {
  instances: string[];
  instanceType: CeInstanceType;
}

/** `FirewallResp`. Preset ("All Open") firewalls are immutable. */
export interface CeFirewall extends CeFirewallCreateRequest {
  id: string;
  orgId?: string;
  isPreset?: boolean;
  status?: CeOpen<'active' | 'building' | 'error'>;
  assoInstances?: string[];
  assoContainers?: string[];
}

// ─── SSH keys (IAM): GET /api/v1/me/ssh-keys (API-key access [U]) ─────────────────────────────────────────────────

export interface CeSshKey {
  id: string;
  name: string;
  /** SHA256 fingerprint. */
  fingerprint: string;
  /** Unix seconds. */
  createdAt: number;
}

export interface CeSshKeyListResponse {
  keys: CeSshKey[];
}
