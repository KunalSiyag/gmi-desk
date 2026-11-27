/**
 * MCP servers (§10): configs, the native confirmation that approves a stdio command, env values in the secure
 * store (names only ever reach the host) and the status the Settings › Code panel shows. Third-party transports
 * start with H3-D; a configured server is reported honestly as `stopped` until then.
 */
import { randomUUID } from 'node:crypto';
import type { McpServerConfig, McpServerStatus } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { HarnessCommand, StoredMcpServer } from '@harness/protocol';
import { mcpConfigHash, unpinnedCommand, validateMcpServer } from '@harness/mcp/trust';
import type { AppContext } from '../../core/context';

export type CommandFn = (cmd: HarnessCommand) => Promise<unknown>;

export interface McpService {
  list(opts?: { projectId?: string }): Promise<McpServerStatus[]>;
  add(config: Omit<McpServerConfig, 'id'>, env?: Record<string, string>): Promise<McpServerStatus>;
  update(id: string, patch: Partial<Pick<McpServerConfig, 'enabled' | 'toolPolicy' | 'name'>>): Promise<McpServerStatus>;
  remove(id: string): Promise<void>;
  authorize(id: string): Promise<McpServerStatus>;
}

const envKey = (id: string) => `mcp.${id}.env`;

function statusOf(server: StoredMcpServer): McpServerStatus {
  const trusted = server.trustHash !== null && server.trustHash === mcpConfigHash(server);
  const needsAuth = server.transport.type === 'http' && server.transport.auth !== 'none';
  const state: McpServerStatus['state'] = !trusted ? 'needs_trust' : !server.enabled ? 'stopped' : needsAuth ? 'needs_auth' : 'stopped';
  const tools = Object.keys(server.toolHashes ?? {})
    .sort()
    .map((name) => ({ name, changed: false, policy: server.toolPolicy[name] ?? ('ask' as const) }));
  return {
    ...server,
    state,
    unpinned: unpinnedCommand(server.transport),
    tools,
    error: null,
  };
}

export function createMcpService(ctx: AppContext, command: CommandFn): McpService {
  const stored = async (opts?: { projectId?: string }): Promise<StoredMcpServer[]> =>
    (await command({ op: 'query', name: 'mcp', args: opts ?? {} })) as StoredMcpServer[];

  const find = async (id: string): Promise<StoredMcpServer> => {
    const row = (await stored()).find((s) => s.id === id);
    if (!row) throw new GmiError('not_found', 'MCP server not found.');
    return row;
  };

  const list = async (opts?: { projectId?: string }): Promise<McpServerStatus[]> => (await stored(opts)).map(statusOf);

  const add = async (config: Omit<McpServerConfig, 'id'>, env: Record<string, string> = {}): Promise<McpServerStatus> => {
    const id = `mcp_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const envNames = Object.keys(env).sort();
    const server: StoredMcpServer = {
      ...config,
      id,
      transport:
        config.transport.type === 'stdio'
          ? { ...config.transport, envNames: [...new Set([...config.transport.envNames, ...envNames])].sort() }
          : config.transport,
      trustHash: null,
      toolHashes: null,
      resolvedVersion: null,
    };
    validateMcpServer(server);
    const commandLine =
      server.transport.type === 'stdio'
        ? [server.transport.command, ...server.transport.args].join(' ')
        : `${server.transport.url} (${server.transport.auth})`;
    const message = [
      `The agent may start this MCP server:`,
      commandLine,
      ...(envNames.length > 0 ? ['', `Environment: ${envNames.join(', ')} (values stay in the encrypted store)`] : []),
      ...(server.transport.type === 'stdio' && server.transport.network ? ['', 'It may use the network through the app’s proxy.'] : []),
      ...(unpinnedCommand(server.transport) ? ['', 'This command names no package version: the package can change underneath you.'] : []),
      '',
      'Only add servers you trust.',
    ].join('\n');
    if (!(await ctx.platform.confirm({ title: `Add MCP server “${server.name}”?`, message, confirmLabel: 'Add server', cancelLabel: 'Cancel' }))) {
      throw new GmiError('cancelled', 'MCP server not added.');
    }
    if (envNames.length > 0) await ctx.secure.set(envKey(id), JSON.stringify(Object.fromEntries(envNames.map((n) => [n, env[n]!]))));
    server.trustHash = mcpConfigHash(server);
    await command({ op: 'mcp.upsert', server });
    return statusOf(server);
  };

  const update = async (id: string, patch: Partial<Pick<McpServerConfig, 'enabled' | 'toolPolicy' | 'name'>>): Promise<McpServerStatus> => {
    const current = await find(id);
    const next: StoredMcpServer = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.toolPolicy !== undefined ? { toolPolicy: patch.toolPolicy } : {}),
    };
    validateMcpServer(next);
    const allowing = Object.entries(patch.toolPolicy ?? {}).filter(([tool, effect]) => effect === 'allow' && current.toolPolicy[tool] !== 'allow');
    const enabling = patch.enabled === true && !current.enabled;
    if (enabling || allowing.length > 0) {
      const lines = [
        ...(enabling ? [`Enable “${next.name}”: its tools become available to the agent.`] : []),
        ...allowing.map(([tool]) => `Always allow ${tool} without asking.`),
        '',
        'This server runs with your user account’s files and network.',
      ];
      if (!(await ctx.platform.confirm({ title: `Widen access for “${next.name}”?`, message: lines.join('\n'), confirmLabel: 'Allow', cancelLabel: 'Cancel' }))) {
        throw new GmiError('cancelled', 'MCP server unchanged.');
      }
    }
    await command({ op: 'mcp.upsert', server: next });
    return statusOf(next);
  };

  const remove = async (id: string): Promise<void> => {
    await find(id);
    await command({ op: 'mcp.remove', serverId: id });
    await ctx.secure.delete(envKey(id)).catch(() => undefined);
  };

  const authorize = async (id: string): Promise<McpServerStatus> => {
    const server = await find(id);
    if (server.transport.type !== 'http' || server.transport.auth !== 'oauth') {
      throw new GmiError('invalid_input', 'This server does not use OAuth.');
    }
    throw new GmiError('not_implemented', 'MCP OAuth sign-in arrives with the MCP transport milestone.');
  };

  return { list, add, update, remove, authorize };
}
