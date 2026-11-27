/**
 * Turning a renderer request into GMI tool arguments: resolve the model (catalog + get_model schema), validate and
 * coerce parameters client-side (GMI's estimate does not validate), then price it with estimate_generation.
 */
import { GmiError } from '@shared/contracts/errors';
import {
  modalityFromKind,
  prepareMediaSchema,
  producesTextOnly,
  unpricedReason,
  type MediaEstimate,
  type MediaModality,
  type MediaRequest,
  type MediaRequestOptions,
  type PreparedMediaSchema,
} from '@shared/contracts/media';
import { applyDiscount } from '@shared/lib/money';
import { coerceParameterValues, validateParameterValues } from '@shared/lib/parameters';
import type { Logger } from '../../core/logger';
import type { BudgetGuard, CatalogService, McpGateway } from '../../core/services';
import { isObj, parseEstimate, parseModel, type ParsedModel } from './parse';

export interface ResolvedModel {
  id: string;
  name: string;
  modality: MediaModality;
  schema: PreparedMediaSchema;
  /** False when GMI publishes no parameter schema (Studio workflows) or it could not be loaded. */
  hasSchema: boolean;
  /** Fraction off the list price for the signed-in org. */
  discount: number | null;
  /**
   * True when GMI cannot price the model before it runs (list price 0, cost "depends on tokens", or text-only
   * output). GMI's estimate for such a model is a flat placeholder, so it is never approved, budgeted or recorded.
   */
  unpriced: boolean;
  /** Why (shown to the user), when `unpriced`. */
  unpricedReason: string | null;
}

export interface ModelResolver {
  resolve(modelId: string): Promise<ResolvedModel>;
  /** Drops cached schemas (e.g. after sign-in changes). */
  clear(): void;
}

const MODEL_TTL_MS = 15 * 60_000;

export function createModelResolver(deps: {
  catalog: CatalogService;
  mcp: McpGateway;
  now: () => number;
  log: Logger;
  ttlMs?: number;
}): ModelResolver {
  const cache = new Map<string, { at: number; model: ParsedModel }>();
  const inflight = new Map<string, Promise<ParsedModel>>();
  const ttl = deps.ttlMs ?? MODEL_TTL_MS;

  const detail = (id: string): Promise<ParsedModel> => {
    const hit = cache.get(id);
    if (hit && deps.now() - hit.at < ttl) return Promise.resolve(hit.model);
    const pending = inflight.get(id);
    if (pending) return pending;
    const task = deps.mcp
      .callTool('get_model', { model_id: id }, { timeoutMs: 20_000 })
      .then((raw) => {
        const model = parseModel(raw, id);
        cache.set(id, { at: deps.now(), model });
        return model;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, task);
    return task;
  };

  return {
    async resolve(modelId) {
      const fromCatalog = await deps.catalog.findModel(modelId).catch(() => null);
      let parsed: ParsedModel | null = null;
      try {
        parsed = await detail(modelId);
      } catch (error) {
        if (!fromCatalog) throw error;
        deps.log.warn(`get_model ${modelId} failed; continuing without its parameter schema`, error);
      }
      const catalogModality = fromCatalog ? modalityFromKind(fromCatalog.kind) : 'other';
      const modality = catalogModality !== 'other' ? catalogModality : (parsed?.modality ?? 'other');
      const params = parsed?.parameters ?? null;
      const pricing = fromCatalog?.mediaPricing ?? null;
      // Either source is enough: a zero list price, "cost depends on tokens", or text-only output in get_model or the catalog.
      const reason = unpricedReason({
        usdPerUnit: parsed?.unitPriceUsd === 0 || pricing?.usdPerUnit === 0 ? 0 : null,
        details: pricing?.details ?? null,
        outputs: producesTextOnly(parsed?.outputs) ? parsed?.outputs : fromCatalog?.outputs,
      });
      return {
        id: parsed?.id ?? modelId,
        name: fromCatalog?.name ?? parsed?.name ?? modelId,
        modality,
        schema: prepareMediaSchema(params),
        hasSchema: Array.isArray(params) && params.length > 0,
        discount: fromCatalog?.discount ?? parsed?.discount ?? null,
        unpriced: reason !== null,
        unpricedReason: reason,
      };
    },
    clear: () => cache.clear(),
  };
}

// ------------------------------------------------------------------------------------------------ input checks

const MAX_PROMPT_CHARS = 50_000;
const MAX_PARAMETERS_JSON = 200_000;

/** Validates the shape of an untrusted (IPC) media request. */
export function sanitizeRequest(raw: unknown): MediaRequest {
  if (!isObj(raw)) throw new GmiError('invalid_input', 'Invalid request.');
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (!modelId || modelId.length > 200) throw new GmiError('invalid_input', 'Choose a model first.');
  if (typeof raw.prompt !== 'string') throw new GmiError('invalid_input', 'The prompt must be text.');
  if (raw.prompt.length > MAX_PROMPT_CHARS) throw new GmiError('invalid_input', 'The prompt is too long.');
  let parameters: Record<string, unknown> | undefined;
  if (raw.parameters !== undefined && raw.parameters !== null) {
    if (!isObj(raw.parameters)) throw new GmiError('invalid_input', 'Parameters must be an object.');
    let size = 0;
    try {
      size = JSON.stringify(raw.parameters).length;
    } catch {
      throw new GmiError('invalid_input', 'Parameters must be plain JSON values.');
    }
    if (size > MAX_PARAMETERS_JSON) throw new GmiError('invalid_input', 'Parameters are too large.');
    parameters = raw.parameters;
  }
  const req: MediaRequest = { modelId, prompt: raw.prompt, parameters };
  if (typeof raw.aspectRatio === 'string' && raw.aspectRatio.trim()) req.aspectRatio = raw.aspectRatio.trim().slice(0, 40);
  if (typeof raw.negativePrompt === 'string' && raw.negativePrompt.trim()) req.negativePrompt = raw.negativePrompt.slice(0, 10_000);
  if (typeof raw.n === 'number' && Number.isInteger(raw.n) && raw.n >= 1 && raw.n <= 100) req.n = raw.n;
  if (typeof raw.seed === 'number' && Number.isInteger(raw.seed) && raw.seed >= 0) req.seed = raw.seed;
  return req;
}

export function requestOptions(req: MediaRequest): MediaRequestOptions {
  const options: MediaRequestOptions = {};
  if (req.aspectRatio) options.aspectRatio = req.aspectRatio;
  if (req.negativePrompt) options.negativePrompt = req.negativePrompt;
  if (req.n !== undefined) options.n = req.n;
  if (req.seed !== undefined) options.seed = req.seed;
  return options;
}

export interface PreparedRequest {
  modelId: string;
  prompt: string;
  /** Coerced, schema-named parameters (the prompt is not among them unless the model names its text field otherwise). */
  parameters: Record<string, unknown>;
  options: MediaRequestOptions;
  model: ResolvedModel;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Validates a request against the model's schema and coerces values to what GMI expects.
 * Throws invalid_input listing every problem. The prompt is a top-level field, never a parameter.
 */
export async function prepareRequest(resolver: ModelResolver, req: MediaRequest): Promise<PreparedRequest> {
  const model = await resolver.resolve(req.modelId);
  const { schema } = model;
  const prompt = req.prompt.trim();
  const values: Record<string, unknown> = { ...(req.parameters ?? {}) };
  delete values.prompt;
  if (schema.promptName !== 'prompt' && isEmpty(values[schema.promptName])) values[schema.promptName] = prompt;

  const label = schema.promptParam?.label ?? 'Prompt';
  const issues: string[] = [];
  if (!prompt) issues.push(`${label} is required.`);
  const maxChars = schema.promptParam && (schema.promptParam.type === 'string' || schema.promptParam.type === 'text') ? schema.promptParam.max : null;
  if (maxChars && prompt.length > maxChars) issues.push(`${label} is too long (${prompt.length} of ${maxChars} characters).`);
  if (model.hasSchema) {
    for (const issue of validateParameterValues(schema.all, values, ['prompt'])) {
      if (issue.name === schema.promptName && !prompt) continue; // already reported
      issues.push(issue.message);
    }
  }
  if (issues.length) throw new GmiError('invalid_input', issues.join(' '));

  const parameters = model.hasSchema
    ? coerceParameterValues(schema.all, values, ['prompt'])
    : Object.fromEntries(Object.entries(values).filter(([, v]) => !isEmpty(v)));
  return { modelId: model.id, prompt, parameters, options: requestOptions(req), model };
}

/** estimate_generation arguments. */
export function estimateArgs(p: PreparedRequest): Record<string, unknown> {
  const args: Record<string, unknown> = { model_id: p.modelId, prompt: p.prompt, parameters: p.parameters };
  if (p.options.aspectRatio) args.aspect_ratio = p.options.aspectRatio;
  if (p.options.n !== undefined) args.n = p.options.n;
  return args;
}

/** submit_generation arguments. A deliberate retake sends a new `idempotency_nonce`; GMI de-duplicates otherwise. */
export function submitArgs(p: PreparedRequest, extra: { nonce?: string; waitSeconds?: number } = {}): Record<string, unknown> {
  const args = estimateArgs(p);
  if (p.options.negativePrompt) args.negative_prompt = p.options.negativePrompt;
  if (p.options.seed !== undefined) args.seed = p.options.seed;
  if (extra.nonce) args.idempotency_nonce = extra.nonce;
  if (extra.waitSeconds) args.wait_seconds = extra.waitSeconds;
  return args;
}

/** Why a model is refused for a paid run when GMI cannot price it in advance. */
export function unpricedRefusal(model: ResolvedModel): string {
  return `${model.unpricedReason ?? "GMI can't price this model before it runs."} GMI Desk only runs jobs whose cost you can approve and your budget can check.`;
}

/**
 * Prices a prepared request (free) and runs the local budget check on the charged price. GMI's quote already covers
 * every output the request asks for (n, max_images with sequential generation...), so it is used as is.
 * Models GMI cannot price in advance get no price at all (never its flat placeholder).
 */
export async function runEstimate(deps: { mcp: McpGateway; budget: BudgetGuard }, p: PreparedRequest): Promise<MediaEstimate> {
  const discount = p.model.discount;
  if (p.model.unpriced) {
    return { listUsd: null, discount, chargedUsd: null, note: unpricedRefusal(p.model), budget: await deps.budget.check(null, 'media'), unit: null, unpriced: true };
  }
  const parsed = parseEstimate(await deps.mcp.callTool('estimate_generation', estimateArgs(p), { timeoutMs: 30_000 }));
  const chargedUsd = applyDiscount(parsed.listUsd, discount);
  const budget = await deps.budget.check(chargedUsd, 'media');
  return {
    listUsd: parsed.listUsd,
    discount,
    chargedUsd,
    note: parsed.note,
    budget,
    unit: parsed.unit,
  };
}
