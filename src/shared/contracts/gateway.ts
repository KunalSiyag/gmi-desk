/**
 * The GMI gateway (main process): every model request (chat, agents, compaction, side tasks) goes through it.
 * Types shared by the harness host protocol, the Code tab and the Usage gateway card (harness.md §4, §13.2).
 */
import type { RouterMode } from './app';
import type { ReasoningEffort, RoutingInfo, TokenUsage } from './chat';
import type { GmiErrorShape } from './errors';

export type GatewayPurpose = 'chat' | 'agent' | 'subagent' | 'compaction' | 'title' | 'commit_message' | 'probe' | 'eval';
export type GatewayPriority = 'interactive' | 'foreground' | 'background' | 'idle';

export type GwPart = { type: 'text'; text: string };
export interface GwToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it (replayed byte-for-byte). */
  arguments: string;
}
export interface GwMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | GwPart[];
  toolCalls?: GwToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: { text: string; family: string } | null;
}
export interface GwToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GatewayScope {
  threadId: string | null;
  turnId: string | null;
  runId: string | null;
  step: number | null;
}

export interface GatewayRequest {
  requestId: string;
  /** purpose, priority and scope of host requests are validated against the runs main tracks (§4.4). */
  purpose: GatewayPurpose;
  priority: GatewayPriority;
  scope: GatewayScope;
  /** GMI Router accepts plain text only (tools must be absent). */
  target: { model: string } | { router: RouterMode };
  messages: GwMessage[];
  tools?: GwToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  parallelToolCalls?: boolean;
  maxOutputTokens: number;
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  /** Diagnostics only. Token estimates are main's own (§4.4); the request carries none. */
  prefixHash: string | null;
  cacheKey?: string | null;
}

export type GatewayFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

export type GatewayEvent =
  | { type: 'queued'; position: number; etaMs: number | null; reason: 'tpm' | 'concurrency' | 'breaker' | 'budget' | 'offline' }
  | { type: 'started'; attempt: number; model: string | null; api: 'chat' | 'responses' | 'router' }
  | { type: 'retry'; attempt: number; delayMs: number; code: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id: string | null; name: string | null; argumentsDelta: string }
  | { type: 'tool_call'; call: GwToolCall }
  | { type: 'model'; model: string }
  | { type: 'routing'; routing: RoutingInfo }
  | { type: 'usage'; usage: TokenUsage; cacheWriteTokens: number | null; costUsd: number | null; estimated: boolean; maybeBilled: boolean }
  | { type: 'finish'; reason: GatewayFinishReason; raw: string | null }
  | { type: 'error'; error: GmiErrorShape; afterOutput: boolean };

export interface GatewayModelState {
  model: string;
  breaker: 'closed' | 'open' | 'half_open';
  reopenAt: string | null;
  inFlight: number;
}

export interface GatewayStatus {
  /** False while the connectivity gate is closed (§4.6). */
  online: boolean;
  tpmLimit: number;
  tpmEffective: number;
  tpmUsedLastMinute: number;
  queued: number;
  inFlight: number;
  models: GatewayModelState[];
  cacheHitRatio24h: number | null;
  last429At: string | null;
  updatedAt: string;
}

export const GATEWAY_TPM_TIERS = { t1: 1_000_000, t2: 3_000_000, t3: 50_000_000, t4: 100_000_000, t5: 300_000_000 } as const;
