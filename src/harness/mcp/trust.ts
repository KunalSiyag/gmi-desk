/**
 * MCP server configs: validation, the trust hash main's native dialog approves (§10.2) and pinning detection.
 * Pure functions shared by the host (which stores a server) and main (which shows it and decides `needs_trust`).
 */
import { createHash } from 'node:crypto';
import { GmiError } from '@shared/contracts/errors';
import type { McpServerConfig } from '@shared/contracts/code';
import type { StoredMcpServer } from '../protocol';

export const MCP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Commands that download and run a package: their package argument is checked for a version (§10.2). */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'bunx', 'uvx', 'pipx']);

/** Canonical JSON with sorted keys (the same shape the tool block hashes). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** SHA-256 over what actually runs: scope, project binding and the transport. Not the name, enabled flag or tool policy. */
export function mcpConfigHash(config: McpServerConfig): string {
  const transport =
    config.transport.type === 'stdio'
      ? {
          type: 'stdio',
          command: config.transport.command,
          args: config.transport.args,
          envNames: [...config.transport.envNames].sort(),
          cwd: config.transport.cwd,
          network: config.transport.network,
        }
      : { type: 'http', url: config.transport.url, auth: config.transport.auth };
  return createHash('sha256').update(canonical({ scope: config.scope, projectId: config.projectId, transport })).digest('hex');
}

/** True when a package runner names a package without a version (`npx -y @scope/pkg`): a supply-chain risk (§10.2). */
export function unpinnedCommand(transport: McpServerConfig['transport']): boolean {
  if (transport.type !== 'stdio') return false;
  const runner = transport.command.split('/').pop()?.toLowerCase() ?? '';
  if (!PACKAGE_RUNNERS.has(runner)) return false;
  const args = transport.args.filter((a) => a !== '--yes' && a !== '-y' && !a.startsWith('-'));
  const pkg = args[0];
  if (!pkg) return false;
  if (/[=<>~^]=?\s*\d/.test(pkg)) return false;
  const at = pkg.lastIndexOf('@');
  if (at <= 0) return true;
  const tag = pkg.slice(at + 1).toLowerCase();
  return tag === 'latest' || tag === 'next' || tag === 'beta' || tag === 'alpha' || tag === 'canary';
}

/** Throws `invalid_input` for a config main or a hand-edited file could get wrong. */
export function validateMcpServer(server: StoredMcpServer): void {
  const bad = (message: string) => {
    throw new GmiError('invalid_input', message);
  };
  if (!MCP_ID_PATTERN.test(server.id)) bad('Invalid MCP server id.');
  if (server.name.trim().length === 0 || server.name.length > 200) bad('An MCP server needs a name of at most 200 characters.');
  if (server.scope === 'project' && !server.projectId) bad('A project-scoped MCP server needs a project.');
  if (server.scope === 'global' && server.projectId !== null) bad('A global MCP server cannot belong to a project.');
  if (server.transport.type === 'stdio') {
    const t = server.transport;
    if (t.command.trim().length === 0) bad('An MCP stdio server needs a command.');
    if (t.cwd !== null && !t.cwd.startsWith('/')) bad('An MCP server working directory must be absolute.');
    if (new Set(t.envNames).size !== t.envNames.length) bad('An environment variable name is repeated.');
    for (const name of t.envNames) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) bad(`Invalid environment variable name ${JSON.stringify(name)}.`);
  } else {
    let url: URL;
    try {
      url = new URL(server.transport.url);
    } catch {
      bad('An MCP HTTP server needs an http(s) URL.');
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') bad('An MCP HTTP server needs an http(s) URL.');
  }
  for (const name of Object.keys(server.toolPolicy)) if (name.length === 0) bad('A tool policy entry has no tool name.');
}

/** The config plus the hash of the server definition main's dialog approved (`null` when it has not been approved). */
export function withTrustHash(server: StoredMcpServer): StoredMcpServer {
  const hash = mcpConfigHash(server);
  return { ...server, trustHash: server.trustHash === hash ? hash : null };
}
