// H2-C test helpers: a thread history in the memory store and a compactor wired to a scripted gateway.
import type { GatewayEvent } from '@shared/contracts/gateway';
import { contextIdOf, newId, type Ceiling, type CompactionRequest, type MessageRow, type StoredEvent, type ToolCallStatus } from '@harness/types';
import { computeCeiling, createCompactor, type CompactionPrefix } from '@harness/loop/compaction';
import { fakeClock, memoryLog, memoryStore, scriptedGatewayClient, textReply } from '../fakes';

export const T = 'c0de0000-0000-4000-8000-0000000000c1';
export const CTX = contextIdOf(T);
export const THREAD_MODEL = 'zai-org/GLM-5.3';
export const FLASH = 'deepseek-ai/DeepSeek-V4-Flash';
export const PREFIX_TOKENS = 5_000;

export const MODEL_SUMMARY = [
  '## Objective',
  '- Fix the failing parser test.',
  '## Requirements',
  '- Keep the public API.',
  '## Decisions',
  '- Use the streaming parser.',
  '## Work state',
  '### Completed',
  '- Located the bug in src/parser.ts.',
  '### Active',
  '- Writing the fix.',
  '### Blocked',
  '- Nothing.',
  '## Next move',
  '- Run npm test.',
  '## Relevant files',
  '- src/parser.ts: the bug.',
  '## Important context',
  '- None.',
].join('\n');

export const DEFAULT_CEILING: Ceiling = computeCeiling({
  modelContextTokens: 1_000_000,
  maxContextTokens: 160_000,
  maxOutputTokens: 16_384,
  economy: false,
  tierBoundaryTokens: null,
  prefixTokens: PREFIX_TOKENS,
});

export function errorReply(code: string, message = 'failed'): GatewayEvent[] {
  return [{ type: 'error', error: { code: code as never, message }, afterOutput: false }];
}

export interface Setup {
  clock: ReturnType<typeof fakeClock>;
  store: ReturnType<typeof memoryStore>;
  gateway: ReturnType<typeof scriptedGatewayClient>;
  log: ReturnType<typeof memoryLog>;
  emitted: StoredEvent[];
  compactor: ReturnType<typeof createCompactor>;
  h: History;
  req(over?: Partial<CompactionRequest>): CompactionRequest;
}

export function setup(opts: { ceiling?: Ceiling; prefixTokens?: number; prefix?: CompactionPrefix | null; noInfo?: boolean } = {}): Setup {
  const clock = fakeClock();
  const store = memoryStore(clock);
  const gateway = scriptedGatewayClient(() => textReply(MODEL_SUMMARY));
  const log = memoryLog();
  const emitted: StoredEvent[] = [];
  const ceiling = opts.ceiling ?? DEFAULT_CEILING;
  const compactor = createCompactor(
    { store, gateway, clock, log },
    {
      ...(opts.noInfo ? {} : { contextInfo: () => ({ ceiling, prefixTokens: opts.prefixTokens ?? PREFIX_TOKENS, prefix: opts.prefix ?? null }) }),
      onEvent: (e) => emitted.push(e),
    },
  );
  const req = (over: Partial<CompactionRequest> = {}): CompactionRequest => ({
    threadId: T,
    contextId: CTX,
    runId: 'run_1',
    turn: 1,
    model: THREAD_MODEL,
    compactionModel: FLASH,
    reason: 'tokens',
    signal: new AbortController().signal,
    ...over,
  });
  return { clock, store, gateway, log, emitted, compactor, h: history(store), req };
}

export interface History {
  user(content: string, turn: number, opts?: { tokens?: number; steering?: boolean }): MessageRow;
  /** One step: an assistant message with `calls` tool calls, then their results. */
  step(turn: number, opts?: { tokens?: number; calls?: number; tool?: string; args?: unknown; status?: ToolCallStatus; output?: string; text?: string }): MessageRow[];
  text(turn: number, content: string, tokens?: number): MessageRow;
  /** `n` steps of `tokens` each (assistant 10 %, results the rest). */
  steps(turn: number, n: number, tokens?: number): void;
}

export function history(store: ReturnType<typeof memoryStore>): History {
  let call = 0;
  const add = (row: Partial<MessageRow> & Pick<MessageRow, 'role' | 'content'>): MessageRow =>
    store.messages.append({
      id: newId('msg'),
      threadId: T,
      contextId: CTX,
      turn: 1,
      toolCalls: null,
      toolCallId: null,
      reasoning: null,
      reasoningFamily: null,
      model: THREAD_MODEL,
      inContext: true,
      pinned: false,
      partial: false,
      estTokens: null,
      ...row,
    });
  const h: History = {
    user: (content, turn, o = {}) => add({ role: 'user', content, turn, estTokens: o.tokens ?? null, ...(o.steering ? { steering: true } : {}) }),
    text: (turn, content, tokens) => add({ role: 'assistant', content, turn, estTokens: tokens ?? null }),
    step(turn, o = {}) {
      const n = o.calls ?? 1;
      const tokens = o.tokens ?? 2_000;
      const tool = o.tool ?? 'read';
      const calls = Array.from({ length: n }, () => {
        call += 1;
        return { id: `call_${call}`, name: tool, arguments: JSON.stringify(o.args ?? { path: `src/f${call}.ts` }) };
      });
      const rows = [add({ role: 'assistant', content: o.text ?? '', turn, toolCalls: calls, estTokens: Math.floor(tokens / 10) })];
      for (const c of calls) {
        store.toolCalls.insert({
          id: newId('tc'),
          wireId: c.id,
          providerCallId: c.id,
          threadId: T,
          contextId: CTX,
          runId: 'run_1',
          turn,
          step: call,
          tool,
          args: c.arguments,
          status: o.status ?? 'succeeded',
          resultMessageId: null,
          spillPath: null,
          exitCode: null,
          startedAt: null,
          finishedAt: null,
        });
        rows.push(add({ role: 'tool', content: o.output ?? `output of ${c.id}`, turn, toolCallId: c.id, estTokens: Math.floor((tokens * 0.9) / n) }));
      }
      return rows;
    },
    steps(turn, n, tokens = 2_000) {
      for (let i = 0; i < n; i++) h.step(turn, { tokens });
    },
  };
  return h;
}

/** Every tool result in `rows` follows the assistant message that called it, and every call has its result. */
export function pairedAndOrdered(rows: readonly MessageRow[]): boolean {
  const open = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.role === 'assistant') {
      if (open.size > 0) return false;
      for (const c of r.toolCalls ?? []) {
        open.add(c.id);
        seen.add(c.id);
      }
    } else if (r.role === 'tool') {
      if (!r.toolCallId || !open.has(r.toolCallId)) return false;
      open.delete(r.toolCallId);
    } else if (open.size > 0) return false;
  }
  return open.size === 0;
}
