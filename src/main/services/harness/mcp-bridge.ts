/**
 * The GMI MCP bridge in main (harness.md §10.3): the OAuth token never enters the host. Free tools are called
 * directly; side-effecting tools need the one-shot token an `allow_once` decision minted for the exact arguments.
 * Env values for third-party servers are read from the secure store on `secrets.mcpEnv` (names only travel in configs).
 */
import type { GmiToolName, BudgetGuard, McpGateway } from '../../core/services';
import type { SecureStore } from '../../core/secure-store';
import type { Logger } from '../../core/logger';
import type { Platform } from '../../core/context';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { BudgetCheck } from '@shared/contracts/usage';
import { applyDiscount, formatUsd } from '@shared/lib/money';
import { parseDiscount, parseEstimate, parseModel } from '../media/parse';
import type { RpcHandlers } from './bridge';
import type { ApprovalBroker } from './approvals';

/** Calls that cost money or file something: always one-shot, bound to the request id and the exact arguments. */
export const GMI_ONE_SHOT_TOOLS: readonly GmiToolName[] = ['submit_generation', 'upload_media', 'create_support_request'];

/** The only one-shot tool that spends (uploads and support tickets are free). */
const PRICED_TOOLS: readonly GmiToolName[] = ['submit_generation'];

export interface McpBridgeDeps {
  mcp: McpGateway;
  budget: BudgetGuard;
  secure: SecureStore;
  approvals: Pick<ApprovalBroker, 'consumeToken'>;
  /** Native dialog for a paid call above the budget's confirm threshold (never the renderer). */
  platform: Pick<Platform, 'confirm'>;
  log: Logger;
}

export interface McpBridge extends RpcHandlers {
  /** True for tools that need an approval's one-shot token. */
  isOneShot(tool: GmiToolName): boolean;
}

interface Price {
  modelId: string;
  listUsd: number;
  chargedUsd: number;
  note: string | null;
  check: BudgetCheck;
}

/** The estimate_generation arguments (a subset of submit_generation's: no nonce, no wait time). */
function priceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ['model_id', 'prompt', 'parameters', 'aspect_ratio', 'n']) {
    if (args[key] !== undefined) picked[key] = args[key];
  }
  return picked;
}

/** The request id a submit result carries, for the ledger's ref; a timestamped fallback otherwise. */
function requestIdOf(raw: unknown): string {
  const record = Array.isArray(raw) ? null : (raw as Record<string, unknown> | null);
  const nested = record && typeof record.structuredContent === 'object' && record.structuredContent !== null ? (record.structuredContent as Record<string, unknown>) : record;
  const direct = nested?.request_id ?? nested?.requestId ?? nested?.id ?? nested?.task_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 200);
  if (typeof raw === 'string') {
    const match = /request_id\s*[:=]\s*"?([\w.-]+)/.exec(raw);
    if (match?.[1]) return match[1].slice(0, 200);
  }
  return `mcp-${Date.now()}`;
}

/**
 * Prices a paid generation the way the media slice does: quote with the free estimate tool, read the org's discount
 * from get_model, then the local budget check on the charged price. An unpriced model is refused rather than approved
 * at a placeholder, exactly like a media job.
 */
async function priceGeneration(deps: McpBridgeDeps, args: Record<string, unknown>): Promise<Price> {
  const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : '';
  if (!modelId) throw new GmiError('invalid_input', 'submit_generation needs a model_id.');
  const [estimateRaw, modelRaw] = await Promise.all([
    deps.mcp.callTool('estimate_generation', priceArgs(args), { timeoutMs: 30_000 }),
    deps.mcp.callTool('get_model', { model_id: modelId }, { timeoutMs: 20_000 }).catch((error: unknown) => {
      deps.log.warn('get_model failed while pricing a paid GMI tool; charging the list price', { modelId, code: toGmiError(error).code });
      return null;
    }),
  ]);
  const estimate = parseEstimate(estimateRaw);
  if (estimate.listUsd === null) {
    throw new GmiError('invalid_input', `${modelId} has no price GMI can quote in advance. Paid agent calls need a price you can approve.`);
  }
  const discount = modelRaw === null ? null : parseModel(modelRaw, modelId).discount;
  const chargedUsd = applyDiscount(estimate.listUsd, discount);
  if (chargedUsd === null) throw new GmiError('invalid_input', `${modelId} could not be priced.`);
  return { modelId, listUsd: estimate.listUsd, chargedUsd, note: estimate.note, check: await deps.budget.check(chargedUsd, 'media') };
}

export function createMcpBridge(deps: McpBridgeDeps): McpBridge {
  const isOneShot = (tool: GmiToolName) => GMI_ONE_SHOT_TOOLS.includes(tool);

  return {
    isOneShot,
    'mcp.gmi.call': async ({ tool, args, requestId }) => {
      // H1 reservations do not yet cover MCP media charges. A check followed by a separate record is unsafe
      // across parallel runs, and bypasses thread caps. Keep generation in the reviewed Create workflow.
      if (PRICED_TOOLS.includes(tool)) throw new GmiError('not_implemented', 'Agent media generation is unavailable until shared budget reservations are connected. Use Create for an approved generation.');
      if (!isOneShot(tool)) {
        const result = await deps.mcp.callTool(tool, args);
        // Keep responses below the MessagePort envelope limit so the host never waits on a dropped message.
        if (Buffer.byteLength(JSON.stringify(result) ?? 'null') > 512 * 1024) throw new GmiError('upstream', 'GMI returned too much data. Narrow the query or reduce its limit.');
        return result;
      }
      if (!requestId) throw new GmiError('permission_denied', `${tool} needs your approval for this exact call.`);
      if (!deps.approvals.consumeToken({ requestId, tool: `mcp__gmi__${tool}`, args })) {
        throw new GmiError('permission_denied', 'That approval was for different arguments, or it was already used.');
      }
      const price = PRICED_TOOLS.includes(tool) ? await priceGeneration(deps, args) : null;
      const check = price?.check ?? (await deps.budget.check(null, 'agent'));
      if (!check.allowed) throw new GmiError('budget_exceeded', check.reason ?? 'Your budget does not allow this call.');
      if (price && check.needsConfirmation) {
        const ok = await deps.platform.confirm({
          title: 'Run paid GMI tool?',
          message: `The agent wants to run ${tool} (${price.modelId}) for about ${formatUsd(price.chargedUsd)}.`,
          detail: [price.note, 'Charged to your GMI account and recorded in your spend ledger.'].filter(Boolean).join('\n\n'),
          confirmLabel: `Approve ${formatUsd(price.chargedUsd)}`,
          cancelLabel: 'Cancel',
        });
        if (!ok) throw new GmiError('cancelled', 'The paid call was not approved.');
      }
      try {
        const result = await deps.mcp.callTool(tool, args);
        if (price) {
          await deps.budget
            .record({ kind: 'media', modelId: price.modelId, usd: price.chargedUsd, ref: requestIdOf(result) })
            .catch((error: unknown) => deps.log.warn('could not record paid GMI tool spend', error));
        }
        return result;
      } catch (error) {
        deps.log.warn('GMI MCP call failed', { tool, code: toGmiError(error).code });
        throw error;
      }
    },
    'secrets.mcpEnv': async ({ serverId }) => {
      if (!/^mcp_[a-z0-9]+$/.test(serverId)) throw new GmiError('invalid_input', 'Invalid MCP server id.');
      const raw = await deps.secure.get(`mcp.${serverId}.env`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        deps.log.warn('stored MCP environment is unreadable', { serverId });
        return {};
      }
    },
    'mcp.oauth.token': async () => {
      throw new GmiError('not_implemented', 'MCP OAuth sign-in arrives with the MCP transport milestone.');
    },
  };
}
