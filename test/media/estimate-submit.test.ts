import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from '@shared/contracts/catalog';
import type { MediaJob } from '@shared/contracts/media';
import { createMediaSlice, type MediaSlice } from '@main/services/media';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch } from '../helpers/fetch';
import {
  catalogModel,
  createFakeAuth,
  createFakeBudget,
  createFakeCatalog,
  createFakeMcp,
  estimateReturning,
  type FakeBudget,
  type FakeMcp,
  type ToolHandler,
} from './fakes';
import { liveGetModel } from './live-models';

interface Harness {
  t: TestContext;
  slice: MediaSlice;
  mcp: FakeMcp;
  budget: FakeBudget;
  auth: ReturnType<typeof createFakeAuth>;
}

let h: Harness | null = null;

async function setup(
  opts: {
    tools?: Record<string, ToolHandler>;
    budget?: Parameters<typeof createFakeBudget>[0];
    discount?: number | null;
    signedIn?: boolean;
    /** Extra catalog entries. */
    catalog?: CatalogModel[];
  } = {},
) {
  // Background auto-saves of finished outputs hit this fake CDN, never the network.
  const cdn = createFakeFetch([{ match: 'cdn.example', respond: () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) }]);
  const t = await createTestContext({ fetch: cdn.fetch });
  const mcp = createFakeMcp({ estimate_generation: estimateReturning(70_000), ...opts.tools });
  const budget = createFakeBudget(opts.budget);
  const auth = createFakeAuth(opts.signedIn ?? true);
  const catalog = createFakeCatalog([
    catalogModel({ id: 'seedream-5.0-pro', kind: 'image', discount: opts.discount === undefined ? 0.5 : opts.discount }),
    catalogModel({ id: 'kling-3.0-turbo-t2v', kind: 'video', discount: null }),
    ...(opts.catalog ?? []),
  ]);
  const slice = await createMediaSlice(t.ctx, { auth, mcp, catalog, budget }, { resumeDelayMs: 60_000 });
  h = { t, slice, mcp, budget, auth };
  return h;
}

afterEach(async () => {
  if (h) {
    await h.slice.dispose();
    await h.t.cleanup();
    h = null;
  }
});

const request = { modelId: 'seedream-5.0-pro', prompt: 'A lighthouse at dusk', parameters: { size: '2K' } };

describe('estimate', () => {
  it('prices with GMI, applies the org discount and checks the budget', async () => {
    const { slice, mcp, budget } = await setup();
    const est = await slice.api.estimate(request);
    expect(est).toMatchObject({ listUsd: 0.07, discount: 0.5, chargedUsd: 0.035, unit: 'image', note: null });
    expect(est.budget).toMatchObject({ allowed: true, needsConfirmation: true, remainingTodayUsd: 5 });
    expect(budget.checks).toEqual([0.035]);
    expect(mcp.callsTo('estimate_generation')[0]).toEqual({ model_id: 'seedream-5.0-pro', prompt: 'A lighthouse at dusk', parameters: { size: '2K' } });
  });

  it("falls back to get_model's discount_to_user when the catalog has none", async () => {
    const { slice } = await setup({
      discount: null,
      tools: {
        get_model: () => ({ model_id: 'seedream-5.0-pro', discount_to_user: 0.2, multimodal: { model_type: 'image' }, parameters: [] }),
      },
    });
    const est = await slice.api.estimate({ ...request, parameters: {} });
    expect(est).toMatchObject({ discount: 0.2, chargedUsd: 0.056 });
  });

  it('validates parameters before asking GMI (which would price a bad value anyway)', async () => {
    const { slice, mcp } = await setup();
    await expect(slice.api.estimate({ ...request, parameters: { size: '8K', max_images: 99 } })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/Size must be one of.*Max images must be between 1 and 15/),
    });
    await expect(slice.api.estimate({ ...request, prompt: '   ' })).rejects.toMatchObject({ code: 'invalid_input', message: 'Prompt is required.' });
    expect(mcp.callsTo('estimate_generation')).toHaveLength(0);
  });

  it('sends the main text of prompt-less models as both prompt and parameter (text-to-speech)', async () => {
    const { slice, mcp } = await setup({ tools: { estimate_generation: estimateReturning(11_600, '1k character') } });
    await slice.api.estimate({ modelId: 'minimax-tts-speech-2.8-hd', prompt: 'Hello there', parameters: { speed: '1.5' } });
    expect(mcp.callsTo('estimate_generation')[0]).toEqual({
      model_id: 'minimax-tts-speech-2.8-hd',
      prompt: 'Hello there',
      parameters: { text: 'Hello there', speed: 1.5 },
    });
  });

  it("uses GMI's quote for several outputs as is: it already covers the count (no 'up to N×' note)", async () => {
    // Live estimate_generation: wan2.7-image n=1 → 30000, n=4 → 120000 micro-USD (gpt-image-2-generate scales too).
    const { slice, budget } = await setup({
      tools: {
        get_model: liveGetModel(),
        estimate_generation: (args) => {
          const n = Number((args.parameters as Record<string, unknown> | undefined)?.n ?? 1);
          return { currency: 'micro_usd', price_micro_usd: 30_000 * n, price_usd: String(0.03 * n), unit: 'image' };
        },
      },
    });
    const est = await slice.api.estimate({ modelId: 'wan2.7-image', prompt: 'A lighthouse', parameters: { size: '2K', n: 4 } });
    expect(est).toMatchObject({ listUsd: 0.12, chargedUsd: 0.12, note: null });
    expect(budget.checks).toEqual([0.12]);
    // seedream's max_images with sequential generation disabled makes one image: GMI's single-image quote stands.
    const seedream = await slice.api.estimate({ ...request, parameters: { max_images: 3 } });
    expect(seedream.note).toBeNull();
    expect(seedream.chargedUsd).toBe(0.015);
  });

  it("accepts GMI's own enum default when the enum leaves it out (seedream-5.0-lite size 2048x2048)", async () => {
    const { slice, mcp } = await setup({ tools: { get_model: liveGetModel(), estimate_generation: estimateReturning(35_000) } });
    await expect(slice.api.estimate({ modelId: 'seedream-5.0-lite', prompt: 'A lighthouse', parameters: { size: '2048x2048' } })).resolves.toMatchObject({
      listUsd: 0.035,
    });
    expect(mcp.callsTo('estimate_generation')[0]).toMatchObject({ model_id: 'seedream-5.0-lite', parameters: { size: '2048x2048' } });
    // Values outside the published options are still refused before GMI is asked.
    await expect(slice.api.estimate({ modelId: 'seedream-5.0-lite', prompt: 'A lighthouse', parameters: { size: '640x480' } })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/^Size must be one of: 2048x2048, 2K, 3K/),
    });
    expect(mcp.callsTo('estimate_generation')).toHaveLength(1);
  });

  it('rejects malformed IPC input', async () => {
    const { slice } = await setup();
    await expect(slice.api.estimate(null as never)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.estimate({ modelId: '', prompt: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.estimate({ modelId: 'm', prompt: 3 } as never)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.estimate({ modelId: 'm', prompt: 'x', parameters: [] } as never)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('submit', () => {
  const finished = (id: string): ToolHandler => () => ({
    request_id: id,
    model_id: 'seedream-5.0-pro',
    status: 'success',
    media: [{ type: 'image', mime_type: 'image/png', url: `https://cdn.example/${id}.png` }],
  });

  it('requires a GMI sign-in', async () => {
    const { slice, mcp } = await setup({ signedIn: false });
    await expect(slice.api.submit({ ...request, approvedUsd: 0.035 })).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(mcp.callsTo('submit_generation')).toHaveLength(0);
  });

  it('requires an approval that covers the charged price', async () => {
    const { slice, mcp } = await setup({ tools: { submit_generation: finished('r1') } });
    await expect(slice.api.submit({ ...request, approvedUsd: null })).rejects.toMatchObject({ code: 'confirmation_required' });
    await expect(slice.api.submit({ ...request, approvedUsd: 0.03 })).rejects.toMatchObject({
      code: 'confirmation_required',
      message: expect.stringContaining('now prices this at $0.035'),
    });
    expect(mcp.callsTo('submit_generation')).toHaveLength(0);
    const job = await slice.api.submit({ ...request, approvedUsd: 0.035 });
    expect(job.id).toBe('r1');
  });

  it('skips the approval when the budget does not ask for one', async () => {
    const { slice } = await setup({ budget: { needsConfirmation: false }, tools: { submit_generation: finished('r2') } });
    await expect(slice.api.submit({ ...request, approvedUsd: null })).resolves.toMatchObject({ id: 'r2' });
  });

  it('blocks jobs over budget even when approved', async () => {
    const { slice, mcp } = await setup({ budget: { allowed: false, reason: 'Daily budget of $1.00 reached.' } });
    await expect(slice.api.submit({ ...request, approvedUsd: 10 })).rejects.toMatchObject({ code: 'budget_exceeded', message: 'Daily budget of $1.00 reached.' });
    expect(mcp.callsTo('submit_generation')).toHaveLength(0);
  });

  it('submits once, stores the job, records spend and emits it', async () => {
    const { slice, mcp, budget, t } = await setup({ tools: { submit_generation: finished('r3') } });
    const job = await slice.api.submit({ ...request, approvedUsd: 0.035, nonce: 'take-2' });
    expect(job).toMatchObject({
      id: 'r3',
      modelId: 'seedream-5.0-pro',
      modality: 'image',
      status: 'success',
      prompt: 'A lighthouse at dusk',
      parameters: { size: '2K' },
      estimateUsd: 0.035,
      listUsd: 0.07,
      discount: 0.5,
      fromThisDevice: true,
      error: null,
    });
    expect(job.outputs[0]).toMatchObject({ url: 'https://cdn.example/r3.png', kind: 'image' });
    expect(job.finishedAt).toEqual(expect.any(String)); // GMI answered with the finished image
    const args = mcp.callsTo('submit_generation');
    expect(args).toHaveLength(1);
    expect(args[0]).toMatchObject({ model_id: 'seedream-5.0-pro', prompt: 'A lighthouse at dusk', parameters: { size: '2K' }, idempotency_nonce: 'take-2', wait_seconds: 8 });
    expect(budget.recorded).toEqual([{ kind: 'media', modelId: 'seedream-5.0-pro', usd: 0.035, ref: 'r3' }]);
    expect(t.emitted.filter((e) => e.name === 'media:job').map((e) => (e.payload as MediaJob).id)).toContain('r3');
    expect((await slice.api.listJobs()).jobs.map((j) => j.id)).toEqual(['r3']);
  });

  it('does not wait in place for video and polls instead', async () => {
    const { slice, mcp } = await setup({
      tools: {
        estimate_generation: estimateReturning(560_000, 'second'),
        submit_generation: () => 'Still running. This generation was accepted and is being charged; it did not fail.\nCall get_generation with request_id "vid-1" to get the result.',
      },
    });
    const job = await slice.api.submit({ modelId: 'kling-3.0-turbo-t2v', prompt: 'A fox in snow', parameters: { duration: '5' }, approvedUsd: 0.56 });
    expect(job).toMatchObject({ id: 'vid-1', status: 'processing', modality: 'video', outputs: [] });
    expect(mcp.callsTo('submit_generation')[0]).not.toHaveProperty('wait_seconds');
  });

  it('recognises a de-duplicated resubmission and does not record spend twice', async () => {
    const { slice, budget } = await setup({ tools: { submit_generation: finished('same') } });
    await slice.api.submit({ ...request, approvedUsd: 0.035 });
    const again = await slice.api.submit({ ...request, approvedUsd: 0.035 });
    expect(again).toMatchObject({ id: 'same', deduplicated: true });
    expect(budget.recorded).toHaveLength(1);
    expect((await slice.api.listJobs()).jobs).toHaveLength(1);
  });

  it('does not record spend for a submission GMI failed straight away', async () => {
    const { slice, budget } = await setup({
      tools: { submit_generation: () => ({ request_id: 'bad', status: 'failed', failure_reason: 'upstream_unavailable' }) },
    });
    const job = await slice.api.submit({ ...request, approvedUsd: 0.035 });
    expect(job).toMatchObject({ status: 'failed', error: 'upstream_unavailable' });
    expect(budget.recorded).toEqual([]);
  });

  it('warns that a timed-out submission may still have started, and never retries it', async () => {
    const { GmiError } = await import('@shared/contracts/errors');
    const { slice, mcp } = await setup({
      tools: {
        submit_generation: () => {
          throw new GmiError('timeout', 'GMI took too long to answer.');
        },
      },
    });
    await expect(slice.api.submit({ ...request, approvedUsd: 0.035 })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('may still have started'),
    });
    expect(mcp.callsTo('submit_generation')).toHaveLength(1);
  });

  it('rejects a result without a request id or outputs', async () => {
    const { slice } = await setup({ tools: { submit_generation: () => ({ status: 'queued' }) } });
    await expect(slice.api.submit({ ...request, approvedUsd: 0.035 })).rejects.toMatchObject({ code: 'upstream' });
  });
});

describe('models GMI cannot price before they run', () => {
  // Live: Gemini-batch-inference is an "image" model with a text output, list price 0 and "Actual cost depends on
  // input/output tokens"; estimate_generation answers a flat 10000 micro-USD ($0.01) whatever the batch size.
  const batch = catalogModel({
    id: 'Gemini-batch-inference',
    kind: 'image',
    outputs: [{ type: 'text', required: true }],
    mediaPricing: {
      usdPerUnit: 0,
      unit: 'request',
      pricingType: 'per-request',
      details: 'Batch inference is approximately 50% cheaper than online inference. Actual cost depends on input/output tokens.',
    },
  });
  const placeholderEstimate: ToolHandler = (args) => ({ currency: 'micro_usd', model_id: args.model_id, price_micro_usd: 10_000, price_usd: '0.01', unit: 'request' });
  const jsonl = Array.from({ length: 300 }, (_, i) => JSON.stringify({ request: { contents: [{ role: 'user', parts: [{ text: `Write 5000 words about topic ${i}` }] }] } })).join('\n');

  it('never approves, budgets or records the flat placeholder price (Gemini batch inference)', async () => {
    const { slice, mcp, budget } = await setup({
      catalog: [batch],
      tools: { get_model: liveGetModel(), estimate_generation: placeholderEstimate, submit_generation: () => ({ request_id: 'batch-1', status: 'queued' }) },
    });
    const req = { modelId: 'Gemini-batch-inference', prompt: jsonl, parameters: { model: 'gemini-3-pro-preview' } };
    const est = await slice.api.estimate(req);
    expect(est).toMatchObject({ listUsd: null, chargedUsd: null, unpriced: true });
    expect(est.note).toMatch(/can't price this model before it runs/);
    expect(budget.checks).toEqual([null]); // never the $0.01 placeholder
    expect(mcp.callsTo('estimate_generation')).toHaveLength(0);

    for (const approvedUsd of [0.01, 1000, null]) {
      await expect(slice.api.submit({ ...req, approvedUsd })).rejects.toMatchObject({ code: 'not_implemented', message: expect.stringContaining("can't price") });
    }
    expect(mcp.callsTo('submit_generation')).toHaveLength(0);
    expect(budget.record).not.toHaveBeenCalled();
    expect((await slice.api.listJobs()).jobs).toEqual([]);
  });

  it('treats a zero list price, cost that "depends on tokens" or text-only output as unpriced, from get_model or the catalog', async () => {
    const schema = [{ name: 'prompt', type: 'string', required: true }];
    const models: Record<string, unknown> = {
      // get_model only (not in the catalog): list price 0.
      'zero-price': { model_id: 'zero-price', multimodal: { model_type: 'video', output: [{ type: 'video' }], pricing: { price: 0, unit: 'request' } }, parameters: schema },
      // get_model only: text output (e.g. kling-identify-face), priced per request.
      'face-id': { model_id: 'face-id', multimodal: { model_type: 'video', output: [{ type: 'text' }], pricing: { price: 7000, unit: 'request' } }, parameters: schema },
      // Catalog notes only.
      'by-tokens': { model_id: 'by-tokens', multimodal: { model_type: 'video', output: [{ type: 'video' }], pricing: { price: 100_000, unit: 'second' } }, parameters: schema },
    };
    const { slice, budget } = await setup({
      catalog: [
        catalogModel({
          id: 'by-tokens',
          kind: 'video',
          mediaPricing: { usdPerUnit: 0.1, unit: 'second', pricingType: null, details: 'Pre-charge per second; actual cost depends on the tokens the model uses.' },
        }),
      ],
      tools: { get_model: (args) => models[String(args.model_id)], estimate_generation: placeholderEstimate },
    });
    for (const modelId of Object.keys(models)) {
      await expect(slice.api.estimate({ modelId, prompt: 'x' })).resolves.toMatchObject({ unpriced: true, chargedUsd: null });
      await expect(slice.api.submit({ modelId, prompt: 'x', approvedUsd: 1 })).rejects.toMatchObject({ code: 'not_implemented' });
    }
    expect(budget.recorded).toEqual([]);
  });

  it('keeps pricing image models whose notes merely mention tokens (priced per image)', async () => {
    const { slice } = await setup({
      catalog: [
        catalogModel({
          id: 'gpt-image-2.5-flare-generate',
          kind: 'image',
          outputs: [{ type: 'image', required: true }],
          mediaPricing: {
            usdPerUnit: 0.01325,
            unit: 'image',
            pricingType: 'per-image output ($30/1M tokens, resolution-based)',
            details: 'Token-based; the pre-charge is the final price. Prompt text billed at $5/M tokens (~1 token per 3 bytes).',
          },
        }),
      ],
      tools: { estimate_generation: estimateReturning(13_250) },
    });
    const est = await slice.api.estimate({ modelId: 'gpt-image-2.5-flare-generate', prompt: 'A lighthouse' });
    expect(est).toMatchObject({ chargedUsd: 0.01325, listUsd: 0.01325 });
    expect(est.unpriced).toBeFalsy();
  });
});
