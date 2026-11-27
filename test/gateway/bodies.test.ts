import { describe, expect, it } from 'vitest';
import type { GatewayRequest, GwMessage, GwToolDef } from '@shared/contracts/gateway';
import { buildChatBody, withMaxCompletionTokens } from '@main/services/gateway/body-chat';
import { buildResponsesBody } from '@main/services/gateway/body-responses';
import { buildRouterBody } from '@main/services/gateway/body-router';
import { capabilitiesFor } from '@main/services/gateway/capabilities';
import { toChatMessages, toResponsesInput } from '@main/services/gateway/messages';
import type { ModelCapabilities } from '@main/services/gateway/types';

type BodyReq = Pick<GatewayRequest, 'messages' | 'tools' | 'toolChoice' | 'parallelToolCalls' | 'temperature' | 'reasoningEffort' | 'cacheKey'>;

const chat = (model: string, req: BodyReq, maxOut = 8192, caps: Partial<ModelCapabilities> = {}) =>
  JSON.stringify(buildChatBody(req, { model, maxOutputTokens: maxOut, capabilities: { ...capabilitiesFor(model, null), ...caps } }));
const responses = (model: string, req: BodyReq, maxOut = 4096) =>
  JSON.stringify(buildResponsesBody(req, { model, maxOutputTokens: maxOut, capabilities: capabilitiesFor(model, 'responses') }));

const tools: GwToolDef[] = [
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

/** A tool loop: an earlier turn (with reasoning), then the current turn's assistant call + result. */
const loop = (family = 'zai-org'): GwMessage[] => [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'What is in a.ts?' },
  { role: 'assistant', content: 'It exports sum.', reasoning: { text: 'old turn thinking', family } },
  { role: 'user', content: 'Fix the test.' },
  { role: 'assistant', content: '', reasoning: { text: 'need to read it', family }, toolCalls: [{ id: 'call_0', name: 'read', arguments: '{"path":"a.ts"}' }] },
  { role: 'tool', toolCallId: 'call_0', content: 'export const sum = (a, b) => a - b;' },
];

describe('parity with the chat slice (bodies byte-equal to today, plus the added parameters)', () => {
  // Today's bytes, produced by services/chat/stream-*.ts build*Body (H1-C deletes those; the literals stay).
  const TODAY_CHAT =
    '{"model":"zai-org/GLM-5.3","messages":[{"role":"system","content":"Be brief."},{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello"},{"role":"user","content":"More"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":8192,"temperature":0.2,"reasoning_effort":"high"}';
  const TODAY_CHAT_PLAIN = '{"model":"zai-org/GLM-5.3","messages":[{"role":"user","content":"Hi"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":8192}';
  const TODAY_RESPONSES =
    '{"model":"openai/gpt-5.3-codex","input":[{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello"},{"role":"user","content":"Fix it"}],"stream":true,"max_output_tokens":4096,"instructions":"You are terse.","reasoning":{"effort":"medium"}}';
  const TODAY_ROUTER = '{"messages":[{"role":"user","content":"Write a regex"}],"mode":"quality","stream":true}';
  const plus = (today: string, added: string) => `${today.slice(0, -1)},${added}}`;

  it('chat completions: identical except context_length_exceeded_behavior at the end', () => {
    const messages: GwMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello', reasoning: null },
      { role: 'user', content: 'More' },
    ];
    expect(chat('zai-org/GLM-5.3', { messages, temperature: 0.2, reasoningEffort: 'high', cacheKey: null })).toBe(plus(TODAY_CHAT, '"context_length_exceeded_behavior":"error"'));
    expect(chat('zai-org/GLM-5.3', { messages: [{ role: 'user', content: 'Hi' }], temperature: null, reasoningEffort: null })).toBe(plus(TODAY_CHAT_PLAIN, '"context_length_exceeded_behavior":"error"'));
  });

  it('responses: identical except store:false at the end', () => {
    const messages: GwMessage[] = [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Fix it' },
    ];
    // Temperature is never sent to the Responses-only models (chat never did).
    expect(responses('openai/gpt-5.3-codex', { messages, reasoningEffort: 'medium', temperature: 0.7 })).toBe(plus(TODAY_RESPONSES, '"store":false'));
  });

  it('router: identical', () => {
    expect(JSON.stringify(buildRouterBody({ messages: [{ role: 'user', content: 'Write a regex' }] }, 'quality'))).toBe(TODAY_ROUTER);
  });
});

describe('golden bodies per family', () => {
  it('GLM (tool_loop): tools, reasoning replayed only inside the current turn, tool results', () => {
    expect(chat('zai-org/GLM-5.3', { messages: loop(), tools, toolChoice: 'auto', parallelToolCalls: true }, 16_384)).toBe(
      '{"model":"zai-org/GLM-5.3","messages":[' +
        '{"role":"system","content":"You are a coding agent."},' +
        '{"role":"user","content":"What is in a.ts?"},' +
        '{"role":"assistant","content":"It exports sum."},' +
        '{"role":"user","content":"Fix the test."},' +
        '{"role":"assistant","content":"","reasoning_content":"need to read it","tool_calls":[{"id":"call_0","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},' +
        '{"role":"tool","tool_call_id":"call_0","content":"export const sum = (a, b) => a - b;"}],' +
        '"stream":true,"stream_options":{"include_usage":true},"max_tokens":16384,' +
        '"tools":[{"type":"function","function":{"name":"read","description":"Read a file.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},' +
        '{"type":"function","function":{"name":"bash","description":"Run a command.","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],' +
        '"tool_choice":"auto","context_length_exceeded_behavior":"error"}',
    );
  });

  it('reasoning of another family is never replayed (model switch)', () => {
    const body = JSON.parse(chat('zai-org/GLM-5.3', { messages: loop('deepseek-ai') })) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.some((m) => 'reasoning_content' in m)).toBe(false);
    const ds = JSON.parse(chat('deepseek-ai/DeepSeek-V4-Flash', { messages: loop('deepseek-ai') })) as { messages: Array<Record<string, unknown>> };
    expect(ds.messages.filter((m) => 'reasoning_content' in m)).toHaveLength(1);
  });

  it('replay modes: never omits, always replays every turn of the family, empty sends ""', () => {
    const msgs = (body: string) => (JSON.parse(body) as { messages: Array<Record<string, unknown>> }).messages.filter((m) => m.role === 'assistant').map((m) => m.reasoning_content);
    expect(msgs(chat('acme/Model-1', { messages: loop('acme') }))).toEqual([undefined, undefined]);
    expect(msgs(chat('acme/Model-1', { messages: loop('acme') }, 8192, { reasoningReplay: 'always' }))).toEqual(['old turn thinking', 'need to read it']);
    expect(msgs(chat('acme/Model-1', { messages: loop('acme') }, 8192, { reasoningReplay: 'empty' }))).toEqual(['', '']);
  });

  it('OpenAI GPT: max_completion_tokens; developer role when the family wants it', () => {
    const body = JSON.parse(chat('openai/gpt-6.1-sol', { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] }, 1000, { developerRole: true })) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(1000);
    expect('max_tokens' in body).toBe(false);
    expect((body.messages as Array<{ role: string }>)[0]!.role).toBe('developer');
  });

  it('unknown parameters are never sent: parallel_tool_calls, strict and tool_choice "required" stay off until probed', () => {
    const body = JSON.parse(chat('zai-org/GLM-5.3', { messages: [{ role: 'user', content: 'x' }], tools, toolChoice: 'required', parallelToolCalls: false })) as Record<string, unknown>;
    expect(body.tool_choice).toBe('auto');
    expect('parallel_tool_calls' in body).toBe(false);
    expect(JSON.stringify(body.tools)).not.toContain('strict');
    const probed = JSON.parse(
      chat('zai-org/GLM-5.3', { messages: [{ role: 'user', content: 'x' }], tools, toolChoice: 'required', parallelToolCalls: false, cacheKey: 'thr-1' }, 8192, {
        toolChoiceRequired: true,
        parallelToolCalls: true,
        strictTools: true,
        cacheKeyParam: 'prompt_cache_key',
      }),
    ) as Record<string, unknown>;
    expect(probed).toMatchObject({ tool_choice: 'required', parallel_tool_calls: false, prompt_cache_key: 'thr-1' });
    expect(JSON.stringify(probed.tools)).toContain('"strict":true');
  });

  it('a family that rejects the overflow parameter does not get it', () => {
    const body = JSON.parse(chat('zai-org/GLM-5.3', { messages: [{ role: 'user', content: 'x' }] }, 100, { ctxExceededParam: false, temperature: false })) as Record<string, unknown>;
    expect('context_length_exceeded_behavior' in body).toBe(false);
  });

  it('responses: function tools, function_call items after the assistant text, function_call_output results', () => {
    const body = JSON.parse(responses('openai/gpt-5.3-codex', { messages: loop('openai'), tools, toolChoice: 'auto' })) as Record<string, unknown>;
    expect(body.instructions).toBe('You are a coding agent.');
    expect(body.input).toEqual([
      { role: 'user', content: 'What is in a.ts?' },
      { role: 'assistant', content: 'It exports sum.' },
      { role: 'user', content: 'Fix the test.' },
      { type: 'function_call', call_id: 'call_0', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_0', output: 'export const sum = (a, b) => a - b;' },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', name: 'read', description: 'Read a file.', parameters: tools[0]!.parameters },
      { type: 'function', name: 'bash', description: 'Run a command.', parameters: tools[1]!.parameters },
    ]);
    expect(body.store).toBe(false);
    expect('previous_response_id' in body).toBe(false);
    expect(Object.keys(body).at(-1)).toBe('store');
  });

  it('serialisation is deterministic: same input, same bytes; no undefined; history only appends', () => {
    const req: BodyReq = { messages: loop(), tools, toolChoice: 'auto', temperature: undefined, reasoningEffort: undefined };
    const a = chat('zai-org/GLM-5.3', req);
    expect(chat('zai-org/GLM-5.3', structuredClone(req))).toBe(a);
    expect(a).not.toContain('undefined');
    // Appending a step keeps the bytes of the earlier messages (the cacheable prefix).
    const longer = chat('zai-org/GLM-5.3', { ...req, messages: [...loop(), { role: 'assistant', content: 'Fixed.' }] });
    const prefix = a.slice(0, a.indexOf(',"stream":true'));
    expect(longer.startsWith(prefix.slice(0, -1))).toBe(true);
  });

  it('withMaxCompletionTokens renames the field in place (key order kept)', () => {
    const body = JSON.parse(chat('zai-org/GLM-5.3', { messages: [{ role: 'user', content: 'x' }] }, 50)) as Record<string, unknown>;
    const swapped = withMaxCompletionTokens(body)!;
    expect(Object.keys(swapped)).toEqual(Object.keys(body).map((k) => (k === 'max_tokens' ? 'max_completion_tokens' : k)));
    expect(withMaxCompletionTokens(swapped)).toBeNull();
  });

  it('content parts and tool names on results', () => {
    const wire = toChatMessages(
      [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { role: 'tool', toolCallId: 'c1', name: 'read', content: 'out' },
      ],
      { reasoningReplay: 'never', developerRole: false },
      'm/x',
    );
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'out', name: 'read' },
    ]);
    expect(toResponsesInput([{ role: 'user', content: [{ type: 'text', text: 'a' }] }]).input).toEqual([{ role: 'user', content: 'a' }]);
  });
});
