/**
 * §9.4 loosening: the changes to a thread that widen what the agent may do or spend. Main never trusts a
 * host-supplied cap; every widening goes through a native confirmation built from these lines.
 */
import { formatUsd } from '@shared/lib/money';
import type { CodeThreadSettings, RuntimeMode, ThreadBudget } from '@shared/contracts/code';

const MODE_RANK: Record<RuntimeMode, number> = {
  'approval-required': 0,
  'auto-accept-edits': 1,
  auto: 2,
  'full-access': 3,
};

const WEB_RANK = { off: 0, ask: 1, allowlist: 2 } as const;

const windowTokens = (value: number | null) => (value === null ? Infinity : value);
const money = (value: number | null) => (value === null ? Infinity : value);
const showWindow = (value: number | null) => (value === null ? 'the full model window' : `${value.toLocaleString('en-US')} tokens`);
const showMoney = (value: number | null) => (value === null ? 'unlimited' : formatUsd(value));

/** A settings patch with a partial budget (the host merges it into the thread's budget). */
export type SettingsPatch = Partial<Omit<CodeThreadSettings, 'budget'>> & { budget?: Partial<ThreadBudget> };

/** Human-readable reasons why `patch` widens `current` (`[]` = nothing widens). */
export function describeLoosening(current: CodeThreadSettings, patch: SettingsPatch): string[] {
  const reasons: string[] = [];
  if (patch.mode !== undefined && MODE_RANK[patch.mode] > MODE_RANK[current.mode]) {
    reasons.push(`approval mode ${current.mode} → ${patch.mode}`);
  }
  if (patch.maxContextTokens !== undefined && windowTokens(patch.maxContextTokens) > windowTokens(current.maxContextTokens)) {
    reasons.push(`context window ${showWindow(current.maxContextTokens)} → ${showWindow(patch.maxContextTokens)}`);
  }
  if (patch.network !== undefined && patch.network !== current.network) {
    reasons.push(`shell network ${current.network} → ${patch.network}`);
  }
  if (patch.webFetch !== undefined && WEB_RANK[patch.webFetch] > WEB_RANK[current.webFetch]) {
    reasons.push(`web access ${current.webFetch} → ${patch.webFetch}`);
  }
  if (patch.computerId !== undefined && patch.computerId !== current.computerId) {
    reasons.push(patch.computerId === null ? 'detach the computer' : 'attach a computer to this thread');
  }
  if (patch.budget) reasons.push(...describeBudgetLoosening(current.budget, patch.budget));
  return reasons;
}

function describeBudgetLoosening(current: ThreadBudget, patch: Partial<ThreadBudget>): string[] {
  const reasons: string[] = [];
  if (patch.perTurnUsd !== undefined && money(patch.perTurnUsd) > money(current.perTurnUsd)) {
    reasons.push(`per-turn budget ${showMoney(current.perTurnUsd)} → ${showMoney(patch.perTurnUsd)}`);
  }
  if (patch.perThreadUsd !== undefined && money(patch.perThreadUsd) > money(current.perThreadUsd)) {
    reasons.push(`per-thread budget ${showMoney(current.perThreadUsd)} → ${showMoney(patch.perThreadUsd)}`);
  }
  if (patch.maxStepsPerTurn !== undefined && patch.maxStepsPerTurn > current.maxStepsPerTurn) {
    reasons.push(`step cap per turn ${current.maxStepsPerTurn} → ${patch.maxStepsPerTurn}`);
  }
  if (patch.maxTurnMinutes !== undefined && patch.maxTurnMinutes > current.maxTurnMinutes) {
    reasons.push(`minutes per turn ${current.maxTurnMinutes} → ${patch.maxTurnMinutes}`);
  }
  return reasons;
}

export function isLoosening(current: CodeThreadSettings, patch: SettingsPatch): boolean {
  return describeLoosening(current, patch).length > 0;
}

/** The native dialog's body: what gets wider, and the fact that only this thread changes. */
export function looseningMessage(title: string, reasons: string[]): string {
  return [`This widens what ${title || 'this thread'} may do:`, ...reasons.map((r) => `• ${r}`), '', 'Only this thread changes. Continue?'].join('\n');
}
