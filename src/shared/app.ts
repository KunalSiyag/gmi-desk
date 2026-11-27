/**
 * App-wide constants shared by the main process and the renderer.
 * Rename the product in one place: APP_NAME.
 */
export const APP_NAME = 'GMI Desk';
export const APP_ID = 'ai.gmidesk.app';
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
export const USER_AGENT = `GMI-Desk/${APP_VERSION}`;

export const GMI_URLS = {
  /** OpenAI-compatible inference (chat/completions, responses, models). Needs an inference API key. */
  inference: 'https://api.gmi-serving.com/v1',
  /** Console host; public catalog feeds, IAM key verification, request queue, router. */
  console: 'https://console.gmicloud.ai',
  consoleApi: 'https://console.gmicloud.ai/api/v1',
  /** Sandbox API v2 (Agentbox sandboxes). Needs a Compute API key. */
  consoleApiV2: 'https://console.gmicloud.ai/api/v2',
  /** GMI Router (autoroute) base. Needs an inference API key. */
  router: 'https://console.gmicloud.ai/api/v1/ie/recommendation',
  /** OAuth-protected MCP server: models, billing summary, media generation, docs, support. */
  mcp: 'https://mcp.gmicloud.ai/mcp',
  docs: 'https://docs.gmicloud.ai',
  website: 'https://www.gmicloud.ai',
} as const;

/** Console pages the app deep-links to. Unauthenticated visits redirect to sign-in and come back. */
export const CONSOLE_PAGES = {
  home: '/user-console/ie',
  apiKeys: '/user-setting/ie/api-keys',
  computeApiKeys: '/user-setting/ce/access/api-keys',
  billing: '/user-setting/ie/usage-billing/credits-and-payment',
  invoices: '/user-setting/ie/usage-billing/invoices',
  subscription: '/user-setting/ie/usage-billing/subscription',
  usageInference: '/user-setting/ie/usage-billing/usage/inference',
  usageStudio: '/user-setting/ie/usage-billing/usage/studio',
  studio: '/user-console/ie/my-workflows',
  routerPlayground: '/user-console/ie/gmi-router/test-routing',
  computeHome: '/user-console/ce',
  computeUsage: '/user-setting/ce/usage-billing/usage',
  computeCredits: '/user-setting/ce/usage-billing/credits-and-payment',
  sshKeys: '/user-setting/ce/access/ssh-keys',
  containers: '/user-console/ce/containers',
  elasticIps: '/user-console/ce/elastic-ip',
  firewalls: '/user-console/ce/firewalls',
} as const;

export type ConsolePage = keyof typeof CONSOLE_PAGES;

export function consoleUrl(page: ConsolePage): string {
  const path = CONSOLE_PAGES[page];
  // Going through the sign-in route keeps the destination when the browser session is cold.
  return `${GMI_URLS.console}/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`;
}

/** Console views of one resource that the app deep-links to (fixed suffixes; nothing else is ever appended). */
export const CONSOLE_DEEP_LINK_VIEWS = {
  detail: '',
  logs: '/logs',
  monitor: '/monitor',
  reconfigure: '/reconfigure',
  renew: '/renew',
} as const;

export type ConsoleDeepLinkView = keyof typeof CONSOLE_DEEP_LINK_VIEWS;
export type ConsoleDeepLinkKind = 'container';

const CONSOLE_DEEP_LINK_BASE: Record<ConsoleDeepLinkKind, string> = { container: CONSOLE_PAGES.containers };

/** A canonical UUID (any version), e.g. a Cluster Engine container id. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Console URL of one resource's page (through the sign-in callback, like consoleUrl). The id must be a UUID and the
 * view one of CONSOLE_DEEP_LINK_VIEWS, so a value from GMI or the renderer can never steer the path. Throws otherwise.
 */
export function consoleDeepLink(kind: ConsoleDeepLinkKind, id: string, view: ConsoleDeepLinkView = 'detail'): string {
  const base = Object.prototype.hasOwnProperty.call(CONSOLE_DEEP_LINK_BASE, kind) ? CONSOLE_DEEP_LINK_BASE[kind] : undefined;
  if (!base) throw new Error(`unknown console resource kind: ${String(kind)}`);
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new Error('console deep link: the id is not a UUID');
  if (!Object.prototype.hasOwnProperty.call(CONSOLE_DEEP_LINK_VIEWS, view)) throw new Error(`unknown console view: ${String(view)}`);
  const path = `${base}/${id.toLowerCase()}${CONSOLE_DEEP_LINK_VIEWS[view]}`;
  return `${GMI_URLS.console}/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`;
}

/** GMI-owned hosts (used to label links as "GMI" in the UI). */
export const GMI_HOSTS = ['console.gmicloud.ai', 'docs.gmicloud.ai', 'www.gmicloud.ai', 'gmicloud.ai', 'mcp.gmicloud.ai'] as const;

export function isGmiUrl(raw: string): boolean {
  try {
    return (GMI_HOSTS as readonly string[]).includes(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a URL may be opened in the system browser: https only, no embedded credentials.
 * (file:, smb:, javascript:, custom schemes and plain http are refused.)
 */
export function isAllowedExternalUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}
