// Usage slice: GMI account summary, media activity, this device's spend ledger, budgets (BudgetGuard), docs search
// and support requests.
import { join } from 'node:path';
import type { Budget, DocsApi, SupportApi, UsageApi } from '@shared/contracts/usage';
import type { AppContext } from '../../core/context';
import type { AuthService, BudgetGuard, BudgetSources, McpGateway } from '../../core/services';
import { MOCK_BUDGET, mockLocalSpendSeed } from '../../mock/usage';
import { mockComputeFlags, mockComputeScenario } from '../../mock/compute';
import { createActivityService } from './activity';
import { createBudgetService } from './budget';
import { createDocsService } from './docs';
import { openSpendLedger } from './ledger';
import { createSummaryService } from './summary';
import { createSupportApi } from './support';
import { assertDays } from './util';

export interface UsageSlice {
  budget: BudgetGuard;
  /** Register spend that is not in the ledger (compute accrual, unflushed agent spend) so budgets include it. */
  budgetSources: BudgetSources;
  usage: UsageApi;
  docs: DocsApi;
  support: SupportApi;
  dispose(): void | Promise<void>;
}

export interface UsageDeps {
  auth: AuthService;
  mcp: McpGateway;
}

export async function createUsageSlice(ctx: AppContext, deps: UsageDeps): Promise<UsageSlice> {
  const log = ctx.log.child('usage');
  const ledger = await openSpendLedger(join(ctx.paths.data, 'spend-ledger.json'), {
    now: ctx.now,
    log,
    seed: ctx.mock ? mockLocalSpendSeed : undefined,
  });
  const scenario = ctx.mock ? mockComputeScenario(mockComputeFlags()) : null;
  const budgets = await createBudgetService({ ctx, ledger, seed: ctx.mock ? { ...MOCK_BUDGET, ...scenario?.budget } : undefined });
  const summary = createSummaryService(deps.mcp, ctx.now);
  const activity = createActivityService(deps.mcp, ctx.now);
  const docs = createDocsService(deps.mcp, ctx.now);

  const clearRemote = () => {
    summary.clear();
    activity.clear();
    docs.clear();
  };
  // A different sign-in may mean a different organization: never serve the previous one's figures.
  const offAuth = deps.auth.onChange(clearRemote);

  // Only IPC methods on these objects: registerApi exposes every function property.
  const usage: UsageApi = {
    getAccountSummary: (days: number) => summary.get(days),
    getMediaActivity: (days: number) => activity.get(days),
    async getLocalSpend(days: number) {
      return ledger.localSpend(assertDays(days));
    },
    async getBudget() {
      return budgets.status();
    },
    setBudget: (patch: Partial<Budget>) => budgets.setBudget(patch),
    async refresh() {
      clearRemote();
    },
  };

  return {
    budget: budgets.guard,
    budgetSources: budgets.sources,
    usage,
    docs: docs.api,
    support: createSupportApi(deps.mcp, log),
    async dispose() {
      offAuth();
      budgets.dispose();
      await Promise.all([ledger.flush(), budgets.flush()]);
    },
  };
}
