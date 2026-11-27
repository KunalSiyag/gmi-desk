/**
 * The tool registry (harness.md §8.1, §7.1) and the H2-D built-in set.
 *
 * Ordering for the frozen tool block (byte-stable prefix, §7.1): built-ins sorted by name, then MCP tools
 * (`mcp__<server>__<tool>`) by server, then tool; parameters serialised as canonical JSON (sorted keys). The loop
 * freezes `definitions()` per turn.
 */
import { GmiError } from '@shared/contracts/errors';
import type { GwToolDef } from '@shared/contracts/gateway';
import { canonicalJson } from '../protocol';
import type { ApprovalClient, ToolDefinition, ToolRegistry } from '../types';
import { createEditTool } from './edit';
import { createReadTool, createWriteTool, type PolicyDeps } from './fs';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createListTool } from './list';
import { createPatchTool } from './patch';
import { createQuestionTool } from './question';
import { createTodoTool } from './todo';

/** Provider function-name rules (OpenAI-compatible): 1–64 of `[A-Za-z0-9_-]`. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function splitMcp(name: string): [string, string] | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  return i === -1 ? [rest, ''] : [rest.slice(0, i), rest.slice(i + 2)];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Built-ins by name, then MCP tools by (server, tool). */
export function compareToolNames(a: string, b: string): number {
  const ma = splitMcp(a);
  const mb = splitMcp(b);
  if (!ma && !mb) return cmp(a, b);
  if (!ma) return -1;
  if (!mb) return 1;
  return cmp(ma[0], mb[0]) || cmp(ma[1], mb[1]);
}

export function toolDef(def: ToolDefinition): GwToolDef {
  return { name: def.name, description: def.description, parameters: JSON.parse(canonicalJson(def.parameters)) as Record<string, unknown> };
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const sorted = () => [...tools.values()].sort((x, y) => compareToolNames(x.name, y.name));
  return {
    register<A>(def: ToolDefinition<A>) {
      if (!NAME.test(def.name)) throw new GmiError('invalid_input', `Invalid tool name ${JSON.stringify(def.name)}.`);
      if (tools.has(def.name)) throw new GmiError('conflict', `Tool ${def.name} is already registered.`);
      const stored = def as unknown as ToolDefinition;
      tools.set(def.name, stored);
      return () => {
        if (tools.get(def.name) === stored) tools.delete(def.name);
      };
    },
    get: (name) => tools.get(name) ?? null,
    list: () => sorted(),
    definitions: (filter) => sorted().filter((d) => !filter || filter(d)).map(toolDef),
  };
}

export interface FileToolsDeps extends PolicyDeps {
  /** Absolute rg path (`findRipgrep()` at host start), or null for the JS fallback. */
  ripgrep: string | null;
  /** Needed for `question`; without it the tool is not registered. */
  approvals?: ApprovalClient | null;
}

/** read, write, edit, apply_patch, grep, glob, list, todo_write and (with approvals) question. */
export function fileTools(deps: FileToolsDeps): ToolDefinition[] {
  const list: ToolDefinition[] = [
    createReadTool(deps) as unknown as ToolDefinition,
    createWriteTool(deps) as unknown as ToolDefinition,
    createEditTool(deps) as unknown as ToolDefinition,
    createPatchTool(deps) as unknown as ToolDefinition,
    createGrepTool(deps) as unknown as ToolDefinition,
    createGlobTool(deps) as unknown as ToolDefinition,
    createListTool(deps) as unknown as ToolDefinition,
    createTodoTool() as unknown as ToolDefinition,
  ];
  if (deps.approvals) list.push(createQuestionTool({ approvals: deps.approvals }) as unknown as ToolDefinition);
  return list;
}

/** Registers the H2-D tools; returns one function that unregisters all of them. */
export function registerFileTools(registry: ToolRegistry, deps: FileToolsDeps): () => void {
  const offs = fileTools(deps).map((d) => registry.register(d));
  return () => {
    for (const off of offs) off();
  };
}
