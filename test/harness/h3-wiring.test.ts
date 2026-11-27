import { describe, expect, it, vi } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { CatalogModel } from '@shared/contracts/catalog';
import { createModelInfoHandlers } from '@main/services/harness/model-info';
import { createModelInfoCache, UNKNOWN_MODEL_INFO } from '@harness/loop/model-info';
import { hostRpcSchema } from '@harness/protocol';
import { registerGmiTools } from '@harness/mcp/gmi';
import { createToolRegistry } from '@harness/tools/registry';
import { createTaskTool } from '@harness/tools/task';
import { fakeTool, okResult } from './fakes';
import { bench, callsReply, MODEL, runTurn, text, THREAD_A } from './loop/helpers';

describe('catalog metadata across the main/host boundary', () => {
  it('supplies the real model window, discounted prices and first tier to the loop', async () => {
    const model = { contextLength: 32_768, discount: 0.25, llmPricing: { inputPerMTok: 2, outputPerMTok: 4, cacheReadPerMTok: 0.4, tiers: [{ minPromptTokens: 16_384 }] } } as CatalogModel;
    const handlers = createModelInfoHandlers({ findModel: async () => model, getSnapshot: vi.fn() });
    const cache = createModelInfoCache({ call: async (_method, params) => handlers['models.info']!(params as { models: string[] }, { hostId: 'test' }) });
    await cache.refresh([MODEL, MODEL, null, 'router']);
    expect(cache.get(MODEL)).toEqual({ contextTokens: 32_768, tierBoundaryTokens: 16_384, pricing: { inputPerMTok: 1.5, outputPerMTok: 3, cacheReadPerMTok: 0.3 + 0.00000000000000004 } });
    const b = bench({ deps: { modelInfo: cache.get } });
    await runTurn(b, 'Hi');
    const meters = b.link.events.sent.filter((e) => e.type === 'meter');
    expect(JSON.stringify(meters)).toContain('32768');
  });

  it('discards stale/invalid data and bounds RPC requests', async () => {
    const call = vi.fn().mockResolvedValue({ [MODEL]: { contextTokens: 8192, tierBoundaryTokens: null, pricing: null } });
    const cache = createModelInfoCache({ call });
    await cache.refresh([MODEL]);
    expect(cache.get(MODEL).contextTokens).toBe(8192);
    call.mockRejectedValue(new Error('offline'));
    await cache.refresh([MODEL]);
    expect(cache.get(MODEL)).toEqual(UNKNOWN_MODEL_INFO);
    call.mockResolvedValue({ [MODEL]: { contextTokens: -1, pricing: null, tierBoundaryTokens: null } });
    await cache.refresh([MODEL]);
    expect(cache.get(MODEL)).toEqual(UNKNOWN_MODEL_INFO);
    expect(hostRpcSchema.safeParse({ method: 'models.info', params: { models: Array(9).fill(MODEL) } }).success).toBe(false);
  });
});

describe('production GMI tool registration', () => {
  it('exposes read-only tools, rejects unknown arguments and forwards a real loop call', async () => {
    const registry = createToolRegistry();
    const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'GMI docs result' }] });
    registerGmiTools(registry, { call });
    expect(registry.get('mcp__gmi__submit_generation')).toBeNull();
    expect(registry.get('mcp__gmi__upload_media')).toBeNull();
    const docs = registry.get('mcp__gmi__search_docs')!;
    expect(docs.parse({ query: 'tools', token: 'not allowed' }).ok).toBe(false);
    const b = bench({ tools: registry.list() });
    b.link.gateway.script.push(callsReply([{ id: 'docs', name: docs.name, args: { query: 'tools', limit: 2 } }]), text('Done'));
    await runTurn(b, 'Read the docs');
    expect(call).toHaveBeenCalledWith('mcp.gmi.call', { tool: 'search_docs', args: { query: 'tools', limit: 2 }, requestId: null }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(b.messages().some((m) => m.role === 'tool' && m.content.includes('GMI docs result'))).toBe(true);
    b.assertPaired();
  });
});

describe('git ref guard integrated into the real loop', () => {
  it('persists the baseline before a request, then clears it after verification', async () => {
    const b = bench();
    b.tools.register(fakeTool('check', { readOnly: true, run: () => {
      expect(b.store.refSnapshots.list()).toHaveLength(1);
      return okResult('verified');
    } }));
    b.link.gateway.script.push(callsReply([{ id: 'p', name: 'check', args: {} }]), text('Done'));
    await runTurn(b, 'Check');
    expect(b.store.refSnapshots.list()).toHaveLength(0);
  });

  it('stops after an unexpected ref change and refuses to accept that baseline next turn', async () => {
    const b = bench();
    b.git.compareRefs = async () => [{ ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40) }];
    b.link.gateway.script.push(text('Done'));
    await runTurn(b, 'Run');
    expect(b.store.threads.get(THREAD_A)?.statusReason).toBe('ref_changed');
    expect(b.store.refSnapshots.list()).toHaveLength(1);
    const requests = b.link.gateway.requests.length;
    await runTurn(b, 'Continue');
    expect(b.link.gateway.requests).toHaveLength(requests);
  });

  it('fails closed before model traffic when the ref snapshot cannot be read', async () => {
    const b = bench();
    b.git.refSnapshot = async () => { throw new GmiError('permission_denied', 'unsafe git'); };
    await runTurn(b, 'Run');
    expect(b.link.gateway.requests).toHaveLength(0);
  });
});

describe('subagent task through the real loop', () => {
  it('isolates child context and tools, charges parent scope and returns a bounded report', async () => {
    const b = bench({ tools: [fakeTool('read', { readOnly: true }), fakeTool('edit', { mutates: true })] });
    b.tools.register(createTaskTool(() => b.loop));
    b.link.gateway.script.push(callsReply([{ id: 'task', name: 'task', args: { agent: 'explore', prompt: 'Look at one file only' } }]), text('x'.repeat(4000)), text('Done'));
    const run = await runTurn(b, 'Parent secret stays in parent context');
    const child = b.link.gateway.requests.find((r) => r.purpose === 'subagent')!;
    expect(child.scope.runId).toBe(run.runId);
    expect(child.priority).toBe('background');
    expect(child.tools?.map((t) => t.name)).toEqual(['read']);
    expect(JSON.stringify(child.messages)).not.toContain('Parent secret');
    expect(b.messages().filter((m) => m.role === 'tool')[0]!.content.length).toBeLessThan(2200);
    expect(b.link.events.sent.some((e) => e.type === 'item' && e.item.kind === 'subagent')).toBe(true);
    b.assertPaired();
  });
});
