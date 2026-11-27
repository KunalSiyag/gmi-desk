/**
 * Mock GMI MCP server for GMI_DESK_MOCK=1 (demo data, screenshots, offline development).
 * Each slice owns the handlers for the tools it uses, in src/main/mock/<slice>.ts,
 * backed by sanitised fixtures recorded from the real server in src/main/mock/fixtures/<slice>/.
 */
import { GmiError } from '@shared/contracts/errors';
import type { McpGateway } from '../core/services';
import { catalogMockTools } from './catalog';
import { mediaMockTools } from './media';
import type { MockToolTable } from './types';
import { usageMockTools } from './usage';

export function createMockMcp(opts: { latencyMs?: number } = {}): McpGateway {
  const table: MockToolTable = { ...catalogMockTools, ...usageMockTools, ...mediaMockTools };
  const latency = opts.latencyMs ?? 80;
  return {
    async callTool<T>(name: Parameters<McpGateway['callTool']>[0], args: Record<string, unknown> = {}) {
      const handler = table[name];
      if (!handler) throw new GmiError('not_implemented', `No mock for MCP tool ${name}`);
      if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
      return (await handler(args)) as T;
    },
  };
}
