/** GMI's account summary (MCP get_account_summary). LLM token spend only; media spend is not included. */
export interface AccountSummary {
  days: number;
  balanceUsd: number | null;
  balanceUnlimited: boolean;
  /** Separate pool; may be restricted to some products. Never add it to the balance. */
  promotionCreditUsd: number | null;
  llmRequests: number | null;
  llmTokens: number | null;
  llmTokenCostUsd: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  topModels: Array<{ model: string; requests: number; tokens: number; costUsd: number }>;
  orgId: string | null;
  /** Present when GMI could not measure usage (absent figures must not be shown as zero). */
  usageNote: string | null;
  fetchedAt: string;
}

/** Image/video/audio activity from MCP list_generations (counts only; GMI reports no per-job cost). */
export interface MediaActivity {
  days: number;
  total: number;
  byModel: Array<{ modelId: string; count: number; succeeded: number; failed: number }>;
  byModality: Record<string, number>;
  /** True when more jobs exist than were scanned. */
  truncated: boolean;
  /** Jobs read from GMI to build this summary (the scan stops after 10 pages of 100). */
  scanned?: number;
  /** created_at of the oldest job counted (ISO); with `truncated`, older jobs in the period were not counted. */
  oldestAt?: string | null;
  fetchedAt?: string;
}

/** `agent`: Code-tab agent turns (gateway); `compute`: containers and sandboxes. Neither counts as media. */
export type SpendKind = 'chat' | 'media' | 'compute' | 'agent';

/** One locally recorded spend (estimate) made through this app. */
export interface SpendEntry {
  id: string;
  at: string;
  kind: SpendKind;
  modelId: string;
  usd: number;
  ref: string | null;
}

export interface LocalSpend {
  days: number;
  chatUsd: number;
  mediaUsd: number;
  /** Compute spend recorded in the ledger (absent from older main processes). */
  computeUsd?: number;
  /** Code-tab agent spend recorded in the ledger (absent from older main processes). */
  agentUsd?: number;
  byModel: Array<{ modelId: string; kind: SpendKind; usd: number; count: number }>;
  /** Newest first. */
  entries: SpendEntry[];
  /** Entries in the period; `entries` is capped at LOCAL_SPEND_MAX_ENTRIES, the totals are not. */
  entryCount?: number;
}

/** At most this many entries are returned by getLocalSpend (totals still cover the whole period). */
export const LOCAL_SPEND_MAX_ENTRIES = 200;

/** Look-back periods GMI accepts for the account summary (whole days). */
export const USAGE_MIN_DAYS = 1;
export const USAGE_MAX_DAYS = 90;

/** Highest budget value accepted (USD). */
export const BUDGET_MAX_USD = 1_000_000;

/** GMI's limits for support requests (plus minimums so a ticket says something). */
export const SUPPORT_LIMITS = {
  subjectMin: 3,
  subjectMax: 200,
  descriptionMin: 10,
  descriptionMax: 5000,
} as const;

/** Docs search query length (characters, after trimming). */
export const DOCS_QUERY_LIMITS = { min: 2, max: 300 } as const;

/** Budgets are enforced by this app: GMI keeps generating even below a zero balance. */
export interface Budget {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  /** Ask before any single job estimated above this (0 = always ask). */
  confirmAboveUsd: number;
  /** When true, jobs that would exceed a budget are blocked instead of warned. */
  enforce: boolean;
}

export const DEFAULT_BUDGET: Budget = {
  dailyUsd: null,
  monthlyUsd: null,
  confirmAboveUsd: 0,
  enforce: true,
};

export interface BudgetStatus {
  budget: Budget;
  spentTodayUsd: number;
  spentMonthUsd: number;
  remainingTodayUsd: number | null;
  remainingMonthUsd: number | null;
  updatedAt: string;
}

export interface BudgetCheck {
  allowed: boolean;
  /** True when the caller must show a cost confirmation (above confirmAboveUsd). */
  needsConfirmation: boolean;
  reason: string | null;
  remainingTodayUsd: number | null;
  remainingMonthUsd: number | null;
}

export interface UsageApi {
  getAccountSummary(days: number): Promise<AccountSummary>;
  getMediaActivity(days: number): Promise<MediaActivity>;
  getLocalSpend(days: number): Promise<LocalSpend>;
  getBudget(): Promise<BudgetStatus>;
  setBudget(patch: Partial<Budget>): Promise<BudgetStatus>;
  /** Drops the cached GMI figures (account summaries, media activity) so the next reads fetch fresh ones. */
  refresh(): Promise<void>;
}

export interface DocHit {
  title: string;
  url: string;
  excerpt: string;
}

export interface DocsApi {
  search(query: string, limit?: number): Promise<DocHit[]>;
}

export interface SupportApi {
  /** Files a NEW ticket every call; the UI must confirm first and never auto-retry. */
  createRequest(input: { subject: string; description: string }): Promise<{ submissionId: string | null; message: string }>;
}
