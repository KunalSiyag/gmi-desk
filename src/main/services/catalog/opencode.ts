/**
 * Exports the live LLM catalog as an OpenCode provider config (also usable from T3 Code, which runs
 * OpenCode as an agent). Verified against opencode 1.18.35: `provider.<id>.npm/name/options/models`,
 * model `limit {context, output}`, `cost {input, output, cache_read, cache_write, context_over_200k}`
 * (USD per 1M tokens), `interleaved {field}`, and `{env:VAR}` substitution in option strings.
 */
import { GMI_URLS } from '@shared/app';
import type { CatalogModel } from '@shared/contracts/catalog';
import { formatDate } from '@shared/lib/format';
import { applyDiscount } from '@shared/lib/money';
import { idKey } from './text';

export const OPENCODE_PROVIDER_ID = 'gmi';
export const OPENCODE_ENV_VAR = 'GMI_API_KEY';
export const OPENCODE_FILE_NAME = 'opencode-gmi.json';
/**
 * Context declared when neither the catalog nor an earlier sign-in gave a model's window (only MCP lists them).
 * Every LLM in GMI's signed-out list has at least this much (DeepSeek-V3-0324 has exactly 128000); smaller
 * windows (Nemotron 32K/64K, listed to key users) are only known once the user has signed in.
 */
export const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 8_192;

interface OpenCodeCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: { input: number; output: number; cache_read?: number; cache_write?: number };
}

export interface OpenCodeModel {
  name: string;
  limit: { context: number; output: number };
  cost?: OpenCodeCost;
  interleaved?: { field: 'reasoning_content' };
}

export interface OpenCodeConfig {
  $schema: 'https://opencode.ai/config.json';
  provider: Record<
    string,
    {
      npm: '@ai-sdk/openai-compatible';
      name: string;
      options: { baseURL: string; apiKey: string };
      models: Record<string, OpenCodeModel>;
    }
  >;
}

/** Chat-completions LLMs only: OpenCode's openai-compatible adapter cannot drive the Responses or queue APIs. */
export function openCodeEligible(models: CatalogModel[]): CatalogModel[] {
  return models
    .filter((m) => m.kind === 'llm' && m.api === 'chat' && m.available)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** GMI does not publish max output tokens; stay well inside the context window. */
export function outputLimit(context: number): number {
  return Math.min(32_768, Math.max(4_096, Math.floor(context / 4)));
}

/** Families that stream their reasoning in `reasoning_content` alongside the answer. */
export function usesReasoningContent(id: string): boolean {
  return /deepseek|kimi|glm/i.test(id);
}

const price = (list: number | null | undefined, discount: number | null) => {
  const charged = applyDiscount(list ?? null, discount);
  return charged === null ? undefined : charged;
};

function costFor(model: CatalogModel): OpenCodeCost | undefined {
  const p = model.llmPricing;
  if (!p) return undefined;
  const input = price(p.inputPerMTok, model.discount);
  const output = price(p.outputPerMTok, model.discount);
  if (input === undefined || output === undefined) return undefined;
  const cost: OpenCodeCost = { input, output };
  const cacheRead = price(p.cacheReadPerMTok, model.discount);
  const cacheWrite = price(p.cacheWritePerMTok, model.discount);
  if (cacheRead !== undefined) cost.cache_read = cacheRead;
  if (cacheWrite !== undefined && cacheWrite > 0) cost.cache_write = cacheWrite;
  const tier = p.tiers?.find((t) => t.minPromptTokens === 200_000);
  if (tier) {
    const tIn = price(tier.inputPerMTok, model.discount);
    const tOut = price(tier.outputPerMTok, model.discount);
    if (tIn !== undefined && tOut !== undefined) {
      cost.context_over_200k = { input: tIn, output: tOut };
      const tRead = price(tier.cacheReadPerMTok, model.discount);
      if (tRead !== undefined) cost.context_over_200k.cache_read = tRead;
    }
  }
  return cost;
}

/**
 * `knownContext` (lower-case model id → context window) fills in models the current catalog has no context for:
 * the windows the app saw the last time MCP or the models API listed them (context is not org data).
 * `estimated` counts the models that got DEFAULT_CONTEXT.
 */
export function buildOpenCodeConfig(
  models: CatalogModel[],
  opts: { knownContext?: ReadonlyMap<string, number> } = {},
): { config: OpenCodeConfig; count: number; estimated: number } {
  const eligible = openCodeEligible(models);
  const entries: Record<string, OpenCodeModel> = {};
  let estimated = 0;
  for (const m of eligible) {
    const known = m.contextLength && m.contextLength > 0 ? m.contextLength : (opts.knownContext?.get(idKey(m.id)) ?? null);
    if (known === null) estimated += 1;
    const entry: OpenCodeModel = { name: m.name, limit: known ? { context: known, output: outputLimit(known) } : { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT } };
    const cost = costFor(m);
    if (cost) entry.cost = cost;
    if (usesReasoningContent(m.id)) entry.interleaved = { field: 'reasoning_content' };
    entries[m.id] = entry;
  }
  return {
    estimated,
    config: {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [OPENCODE_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'GMI Cloud',
          options: { baseURL: GMI_URLS.inference, apiKey: `{env:${OPENCODE_ENV_VAR}}` },
          models: entries,
        },
      },
    },
    count: eligible.length,
  };
}

/**
 * Markdown shown in the export dialog. `orgPrices` says whether the costs are the signed-in organization's
 * (discount applied) or GMI's public list prices; `estimatedLimits` how many models got DEFAULT_CONTEXT.
 */
export function openCodeInstructions(opts: {
  configPath: string;
  count: number;
  exampleModel: string | null;
  platform: string;
  now: Date;
  orgPrices?: boolean;
  estimatedLimits?: number;
}): string {
  const win = opts.platform === 'win32';
  const setKey = win ? `$env:${OPENCODE_ENV_VAR} = "<your GMI inference key>"` : `export ${OPENCODE_ENV_VAR}="<your GMI inference key>"`;
  const setConfig = win ? `$env:OPENCODE_CONFIG = "${opts.configPath}"` : `export OPENCODE_CONFIG="${opts.configPath}"`;
  const model = opts.exampleModel ?? '<model-id>';
  const estimated = opts.estimatedLimits ?? 0;
  const limits =
    estimated > 0
      ? ` Context limits for ${estimated === opts.count ? 'these models' : `${estimated} of these models`} are estimates (${DEFAULT_CONTEXT.toLocaleString('en-US')} tokens): ${
          opts.orgPrices === false
            ? 'GMI lists context windows only to signed-in users, so sign in and export again for exact limits.'
            : 'GMI does not list their context windows.'
        }`
      : '';
  return [
    `**OpenCode** — ${opts.count} GMI chat models as the \`${OPENCODE_PROVIDER_ID}\` provider.`,
    '',
    '```sh',
    setKey,
    setConfig,
    `opencode models ${OPENCODE_PROVIDER_ID}`,
    `opencode -m ${OPENCODE_PROVIDER_ID}/${model}`,
    '```',
    '',
    `To keep it permanently, copy the \`"${OPENCODE_PROVIDER_ID}"\` provider block into \`~/.config/opencode/opencode.json\` instead of setting \`OPENCODE_CONFIG\`.`,
    '',
    '**T3 Code** — add two environment variables to the OpenCode provider instance:',
    '',
    `- \`OPENCODE_CONFIG\` = this file's path`,
    `- \`${OPENCODE_ENV_VAR}\` = your GMI inference API key`,
    '',
    `Then pick a \`${OPENCODE_PROVIDER_ID}/…\` model. The key is never written to the file: OpenCode reads it from \`${OPENCODE_ENV_VAR}\` at runtime. Costs in the file are ${
      opts.orgPrices === false ? "GMI's public list prices (sign in to export your organization's prices)" : 'your prices'
    } as of ${formatDate(opts.now.toISOString())}; export again when the catalog changes.${limits}`,
  ].join('\n');
}
