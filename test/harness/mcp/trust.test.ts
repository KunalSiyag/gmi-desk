import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { McpServerConfig } from '@shared/contracts/code';
import { mcpConfigHash, MCP_ID_PATTERN, unpinnedCommand, validateMcpServer, withTrustHash } from '@harness/mcp/trust';
import type { StoredMcpServer } from '@harness/protocol';

const stdio = (patch: Partial<Extract<McpServerConfig['transport'], { type: 'stdio' }>> = {}) =>
  ({ type: 'stdio' as const, command: 'npx', args: ['-y', '@scope/server@1.2.3'], envNames: ['B', 'A'], cwd: null, network: false, ...patch });

const server = (patch: Partial<StoredMcpServer> = {}): StoredMcpServer => ({
  id: 'mcp_1',
  name: 'Files',
  scope: 'global',
  projectId: null,
  transport: stdio(),
  enabled: true,
  toolPolicy: {},
  trustHash: null,
  toolHashes: null,
  resolvedVersion: null,
  ...patch,
});

describe('mcpConfigHash', () => {
  it('is stable across envNames order and ignores name, enabled and tool policy', () => {
    const a = server({ transport: stdio({ envNames: ['A', 'B'] }) });
    const b = server({ name: 'Other', enabled: false, toolPolicy: { read: 'allow' }, transport: stdio({ envNames: ['B', 'A'] }) });
    expect(mcpConfigHash(a)).toBe(mcpConfigHash(b));
    expect(mcpConfigHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the command, arguments, scope or project changes', () => {
    const base = mcpConfigHash(server());
    expect(mcpConfigHash(server({ transport: stdio({ command: 'uvx' }) }))).not.toBe(base);
    expect(mcpConfigHash(server({ transport: stdio({ args: ['-y', '@scope/server@1.2.4'] }) }))).not.toBe(base);
    expect(mcpConfigHash(server({ scope: 'project', projectId: 'prj_1' }))).not.toBe(base);
  });

  it('hashes an HTTP transport by url and auth', () => {
    const http = server({ transport: { type: 'http', url: 'https://example.com/mcp', auth: 'none' } });
    expect(mcpConfigHash(http)).toMatch(/^[0-9a-f]{64}$/);
    expect(mcpConfigHash({ ...http, transport: { type: 'http', url: 'https://example.com/mcp', auth: 'bearer' } })).not.toBe(mcpConfigHash(http));
  });
});

describe('unpinnedCommand', () => {
  it('flags package runners without a version and accepts pinned or unrelated commands', () => {
    expect(unpinnedCommand(stdio())).toBe(false);
    expect(unpinnedCommand(stdio({ args: ['-y', '@scope/server'] }))).toBe(true);
    expect(unpinnedCommand(stdio({ command: '/usr/bin/npx', args: ['@scope/server'] }))).toBe(true);
    expect(unpinnedCommand(stdio({ command: 'uvx', args: ['--from', 'pkg', 'pkg'] }))).toBe(true);
    expect(unpinnedCommand(stdio({ command: 'node', args: ['server.js'] }))).toBe(false);
    expect(unpinnedCommand({ type: 'http', url: 'https://example.com/mcp', auth: 'none' })).toBe(false);
  });
});

describe('validateMcpServer', () => {
  it('accepts a valid server and the id pattern', () => {
    expect(() => validateMcpServer(server())).not.toThrow();
    expect(MCP_ID_PATTERN.test('mcp_abc-1')).toBe(true);
    expect(MCP_ID_PATTERN.test('MCP')).toBe(false);
  });

  it.each([
    ['bad id', server({ id: 'Bad Id' })],
    ['empty name', server({ name: ' ' })],
    ['project scope without project', server({ scope: 'project' })],
    ['global scope with project', server({ projectId: 'prj_1' })],
    ['empty command', server({ transport: stdio({ command: ' ' }) })],
    ['relative cwd', server({ transport: stdio({ cwd: 'relative' }) })],
    ['duplicate env', server({ transport: stdio({ envNames: ['A', 'A'] }) })],
    ['invalid env name', server({ transport: stdio({ envNames: ['1BAD'] }) })],
    ['bad url', server({ transport: { type: 'http', url: 'not a url', auth: 'none' } })],
    ['ftp url', server({ transport: { type: 'http', url: 'ftp://example.com', auth: 'none' } })],
  ])('rejects %s', (_label, value) => {
    expect(() => validateMcpServer(value)).toThrow(GmiError);
  });
});

describe('withTrustHash', () => {
  it('keeps a hash that matches and clears one that does not', () => {
    const s = server();
    expect(withTrustHash(s).trustHash).toBeNull();
    const approved = server({ trustHash: mcpConfigHash(s) });
    expect(withTrustHash(approved).trustHash).toBe(mcpConfigHash(s));
    const changed = server({ trustHash: mcpConfigHash(s), transport: stdio({ args: ['other@1'] }) });
    expect(withTrustHash(changed).trustHash).toBeNull();
  });
});
