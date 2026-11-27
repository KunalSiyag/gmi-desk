import type { GmiToolName } from '../core/services';

/** Mock implementation of one GMI MCP tool (returns the tool's JSON result). */
export type MockToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type MockToolTable = Partial<Record<GmiToolName, MockToolHandler>>;
