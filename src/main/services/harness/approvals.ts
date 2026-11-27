/**
 * Main's approval broker (harness.md §9.4, §10.3, §13.3; threats H-T7, H-T8, H-T17).
 *
 * - The host asks (`approval.request`); main decides which decisions are allowed (`allowedDecisions`; the host's
 *   value is ignored), shows the card in the renderer (`code:approval`), notifies when the window is unfocused and
 *   expires the request after 24 h ("no answer" → deny).
 * - The renderer answers through CodeApi.respondApproval → `respond()`: anything outside `allowedDecisions` is
 *   refused; persistent or broader grants and high-risk requests need a native confirmation built here from
 *   structured fields only.
 * - An accepted `allow_once` for a paid / side-effect tool mints a one-shot token bound to the request id and
 *   sha256(canonical args); mcp-bridge.ts (H3-D) and the compute broker (H4-B) consume it.
 * - The host's `dialog.confirm` RPC (trust | destructive | sensitive_write) is rendered by `confirmStructured()`:
 *   no free text, control / bidi / zero-width characters stripped, lengths capped.
 */
import { createHash } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, PermissionRuleDraft, RiskFlag } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { Platform } from '../../core/context';
import type { Logger } from '../../core/logger';
import { canonicalJson, type ConfirmKind, type ConfirmSubject } from '@harness/protocol';

export const APPROVAL_LIMITS = {
  /** §9.4: pending approvals expire after 24 h → denied as "no answer". */
  ttlMs: 24 * 60 * 60 * 1000,
  /** One-shot tokens are used right after the decision; a stale one is refused. */
  tokenTtlMs: 10 * 60 * 1000,
  /** Desktop notifications per thread at most this often. */
  notifyThrottleMs: 60_000,
  /** §13.3 dialog caps. */
  commandChars: 2_048,
  maxPaths: 20,
  pathChars: 256,
  lineChars: 512,
} as const;

/** Tools whose every call needs its own approval and a one-shot token (§9.4, §10.3, §10.4). */
export const ONE_SHOT_TOOLS = [
  'mcp__gmi__submit_generation',
  'mcp__gmi__upload_media',
  'mcp__gmi__create_support_request',
  'sandbox_create',
  'sandbox_resume',
  'sandbox_extend',
] as const;

type DecisionKind = ApprovalDecision['kind'];

export interface BrokerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface ApprovalBrokerDeps {
  platform: Pick<Platform, 'confirm' | 'notify' | 'isAppFocused'>;
  /** `code:approval` to the renderer. */
  emit(payload: { request: ApprovalRequest; resolved: boolean }): void;
  /** Sends `approval.decision` to the host that asked (dropped if that host is gone). */
  deliver(hostId: string, requestId: string, decision: ApprovalDecision): void;
  clock: BrokerClock;
  log: Logger;
  /**
   * Extra loosening policy (H3-A's isLoosening, §9.4): lines for a native dialog, or null. It is asked in addition
   * to the built-in rules below.
   */
  extraConfirmation?: (request: ApprovalRequest, decision: ApprovalDecision) => string[] | null;
}

export interface ApprovalBroker {
  /** A host's request: normalised (allowedDecisions, timestamps) and shown. Returns what the renderer sees. */
  submit(hostId: string, request: ApprovalRequest): ApprovalRequest | null;
  /** The host withdrew it (run cancelled, tool aborted). With `hostId`, only a request of that host. */
  withdraw(requestId: string, hostId?: string): void;
  /** The host exited: its requests are withdrawn (it will never read the decisions). */
  dropHost(hostId: string): void;
  /** The renderer's answer. Throws not_found, invalid_input (not allowed), conflict (already deciding) or cancelled (dialog declined). */
  respond(requestId: string, decision: ApprovalDecision): Promise<void>;
  listPending(): ApprovalRequest[];
  /** One-shot token check for a paid call: true once per accepted request with the same tool and arguments. */
  consumeToken(input: { requestId: string; tool: string; args: unknown }): boolean;
  /** The host's `dialog.confirm` RPC. */
  confirmStructured(kind: ConfirmKind, subject: ConfirmSubject): Promise<boolean>;
  dispose(): void;
}

// ─── Text hygiene (H-T17) ─────────────────────────────────────────────────────────────────────────────────────

// C0/C1 controls (incl. newlines and tabs), bidi embeddings/overrides/isolates, marks, zero-width characters, BOM.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;

/** One line of dialog text from untrusted input: unsafe characters → space, collapsed, capped. */
export function sanitizeDialogText(value: string, maxChars: number = APPROVAL_LIMITS.lineChars): string {
  const clean = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

function pathLines(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const shown = paths.slice(0, APPROVAL_LIMITS.maxPaths).map((p) => `  ${sanitizeDialogText(p, APPROVAL_LIMITS.pathChars)}`);
  const more = paths.length - shown.length;
  return ['Paths:', ...shown, ...(more > 0 ? [`  … and ${more} more`] : [])];
}

const RISK_LABELS: Record<RiskFlag, string> = {
  network: 'uses the network',
  outside_worktree: 'outside the worktree',
  destructive: 'destructive',
  execution_sensitive: 'changes files that run code (hooks, scripts, CI)',
  secret_path: 'touches a secret file',
  unsandboxed: 'runs without the sandbox',
  costs_money: 'costs money',
  compound_command: 'compound command',
  changed_tool: 'the tool changed since it was trusted',
  local_network: 'can reach your local network and this computer’s services',
  unpinned: 'unpinned package version',
};

function riskLine(risk: readonly RiskFlag[]): string[] {
  const labels = [...new Set(risk)].map((r) => RISK_LABELS[r]).filter(Boolean);
  return labels.length ? [`Risk: ${labels.join('; ')}`] : [];
}

function subjectLines(s: { tool: string; command?: string; cwd?: string; paths?: string[]; host?: string; url?: string; server?: string }): string[] {
  return [
    `Tool: ${sanitizeDialogText(s.tool, 128)}`,
    ...(s.server ? [`Server: ${sanitizeDialogText(s.server, 128)}`] : []),
    ...(s.command !== undefined ? [`Command: ${sanitizeDialogText(s.command, APPROVAL_LIMITS.commandChars)}`] : []),
    ...(s.cwd ? [`Directory: ${sanitizeDialogText(s.cwd, APPROVAL_LIMITS.pathChars)}`] : []),
    ...(s.host ? [`Host: ${sanitizeDialogText(s.host, 256)}`] : []),
    ...(s.url ? [`URL: ${sanitizeDialogText(s.url, 1_024)}`] : []),
    ...pathLines(s.paths),
  ];
}

// ─── Policy (§9.4) ────────────────────────────────────────────────────────────────────────────────────────────

const WILDCARD = /[*?[\]{}]/;

export function isOneShot(request: Pick<ApprovalRequest, 'tool' | 'risk'>): boolean {
  return (ONE_SHOT_TOOLS as readonly string[]).includes(request.tool) || request.risk.includes('costs_money');
}

/** The decisions main allows for a request (the host's list is ignored). */
export function allowedDecisionsFor(request: Pick<ApprovalRequest, 'kind' | 'tool' | 'risk'>, argsKnown = true): DecisionKind[] {
  if (request.kind === 'question' || request.kind === 'mcp-elicitation') return ['answer', 'deny', 'cancel_run'];
  if (isOneShot(request)) return argsKnown ? ['allow_once', 'deny', 'cancel_run'] : ['deny', 'cancel_run'];
  // local_network: per command only (§8.3); destructive: asks in every mode (§9.3), so no standing grants.
  if (request.risk.includes('local_network') || request.risk.includes('destructive')) return ['allow_once', 'deny', 'cancel_run'];
  return ['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run'];
}

/** A rule no broader than the suggested one: the same pattern, or a longer one that starts with it and adds no wildcards. */
export function withinSuggested(rule: Pick<PermissionRuleDraft, 'pattern'>, suggested: PermissionRuleDraft | null): boolean {
  if (!suggested || suggested.pattern === null) return false;
  if (rule.pattern === null) return false;
  if (rule.pattern === suggested.pattern) return true;
  if (!rule.pattern.startsWith(suggested.pattern)) return false;
  return !WILDCARD.test(rule.pattern.slice(suggested.pattern.length));
}

const STANDING_GRANT_NEEDS_DIALOG = (request: ApprovalRequest) =>
  request.kind === 'network' ||
  request.kind === 'mcp' ||
  request.kind === 'compute' ||
  request.tool === 'web_fetch' ||
  request.tool.startsWith('mcp__') ||
  request.tool.startsWith('sandbox_') ||
  request.risk.includes('network');

/**
 * Why a decision needs a native confirmation (the dialog's lines), or null. Throws invalid_input for a decision
 * that is never acceptable (a rule for another tool or with a wildcard tool).
 */
export function confirmationFor(request: ApprovalRequest, decision: ApprovalDecision): string[] | null {
  const reasons: string[] = [];
  if (decision.kind === 'allow_always') {
    const rule = decision.rule;
    if (rule.tool !== request.tool || WILDCARD.test(rule.tool)) throw new GmiError('invalid_input', 'An "Always" rule must name exactly the requested tool.');
    // A rule within the suggested one for a local tool (fs, shell) is decided on the card; anything broader, and any
    // standing grant for network, web, MCP or sandbox tools, needs the native dialog.
    if (rule.effect === 'allow' && (!withinSuggested(rule, request.suggestedRule) || STANDING_GRANT_NEEDS_DIALOG(request))) {
      const where = rule.scope === 'global' ? 'all projects' : rule.scope === 'project' ? 'this project' : 'this thread';
      reasons.push(`Always allow in ${where}: ${rule.pattern === null ? 'any call of this tool' : sanitizeDialogText(rule.pattern, APPROVAL_LIMITS.commandChars)}`);
    }
  }
  if (decision.kind === 'allow_thread' && STANDING_GRANT_NEEDS_DIALOG(request)) reasons.push('Allow for the rest of this thread');
  const allows = decision.kind === 'allow_once' || decision.kind === 'allow_thread' || decision.kind === 'allow_always';
  if (allows && (request.risk.includes('destructive') || request.risk.includes('unsandboxed') || request.risk.includes('local_network'))) {
    if (reasons.length === 0) reasons.push('Allow once');
  }
  if (decision.kind === 'allow_once' && decision.sensitiveWrites) reasons.push('Also allow writes to files that run code (hooks, scripts, CI)');
  return reasons.length > 0 ? reasons : null;
}

function argsHashOf(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

function parseArgs(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** `mcp__gmi__submit_generation` and `submit_generation` name the same GMI tool. */
function sameTool(a: string, b: string): boolean {
  const strip = (t: string) => (t.startsWith('mcp__gmi__') ? t.slice('mcp__gmi__'.length) : t);
  return strip(a) === strip(b);
}

// ─── Broker ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Pending {
  hostId: string;
  request: ApprovalRequest;
  argsHash: string | null;
  timer: unknown;
  deciding: boolean;
}

export function createApprovalBroker(deps: ApprovalBrokerDeps): ApprovalBroker {
  const { clock, log } = deps;
  const pending = new Map<string, Pending>();
  const tokens = new Map<string, { tool: string; argsHash: string; expiresAt: number }>();
  const lastNotified = new Map<string, number>();

  const iso = (ms: number) => new Date(ms).toISOString();

  const resolveOut = (requestId: string): Pending | null => {
    const p = pending.get(requestId);
    if (!p) return null;
    pending.delete(requestId);
    clock.clearTimeout(p.timer);
    return p;
  };

  const finish = (p: Pending, decision: ApprovalDecision | null) => {
    if (decision) deps.deliver(p.hostId, p.request.requestId, decision);
    deps.emit({ request: p.request, resolved: true });
  };

  const notify = (request: ApprovalRequest) => {
    if (deps.platform.isAppFocused()) return;
    const now = clock.now();
    const last = lastNotified.get(request.threadId) ?? Number.NEGATIVE_INFINITY;
    if (now - last < APPROVAL_LIMITS.notifyThrottleMs) return;
    lastNotified.set(request.threadId, now);
    deps.platform.notify({ title: 'An agent is waiting for your approval', body: sanitizeDialogText(request.title, 160) });
  };

  const sweepTokens = () => {
    const now = clock.now();
    for (const [id, t] of tokens) if (t.expiresAt <= now) tokens.delete(id);
  };

  return {
    submit(hostId, raw) {
      if (pending.has(raw.requestId)) {
        log.warn('duplicate approval request ignored', { requestId: raw.requestId });
        return null;
      }
      const now = clock.now();
      let argsHash: string | null = null;
      let argsKnown = true;
      if (isOneShot(raw)) {
        const parsed = parseArgs(raw.detail.args);
        argsKnown = parsed.ok;
        argsHash = parsed.ok ? argsHashOf(parsed.value) : null;
        if (!parsed.ok) log.warn('paid tool approval without readable arguments: only deny is offered', { tool: raw.tool });
      }
      const request: ApprovalRequest = {
        ...raw,
        allowedDecisions: allowedDecisionsFor(raw, argsKnown).filter((d) => raw.suggestedRule !== null || (d !== 'allow_thread' && d !== 'allow_always')),
        createdAt: iso(now),
        expiresAt: iso(now + APPROVAL_LIMITS.ttlMs),
      };
      const timer = clock.setTimeout(() => {
        const p = resolveOut(request.requestId);
        if (!p) return;
        log.info('approval expired', { requestId: request.requestId });
        finish(p, { kind: 'deny', feedback: 'No answer within 24 hours.' });
      }, APPROVAL_LIMITS.ttlMs);
      pending.set(request.requestId, { hostId, request, argsHash, timer, deciding: false });
      deps.emit({ request, resolved: false });
      notify(request);
      return request;
    },

    withdraw(requestId, hostId) {
      const known = pending.get(requestId);
      if (!known || (hostId !== undefined && known.hostId !== hostId)) return;
      const p = resolveOut(requestId);
      if (p) finish(p, null);
    },

    dropHost(hostId) {
      for (const p of [...pending.values()]) {
        if (p.hostId !== hostId) continue;
        const out = resolveOut(p.request.requestId);
        if (out) finish(out, null);
      }
    },

    async respond(requestId, decision) {
      const p = pending.get(requestId);
      if (!p) throw new GmiError('not_found', 'This approval is no longer pending.');
      if (p.deciding) throw new GmiError('conflict', 'This approval is already being decided.');
      if (!p.request.allowedDecisions.includes(decision.kind)) throw new GmiError('invalid_input', 'That decision is not allowed for this request.');
      const reasons = [...(confirmationFor(p.request, decision) ?? []), ...(deps.extraConfirmation?.(p.request, decision) ?? [])];
      if (reasons.length > 0) {
        p.deciding = true;
        let ok = false;
        try {
          ok = await deps.platform.confirm({
            title: 'Allow this agent action?',
            message: sanitizeDialogText(p.request.title, 200) || 'An agent asks for permission.',
            detail: [...subjectLines({ ...p.request.detail, tool: p.request.tool }), ...riskLine(p.request.risk), '', ...reasons.map((r) => sanitizeDialogText(r, APPROVAL_LIMITS.commandChars))].join('\n'),
            confirmLabel: 'Allow',
            cancelLabel: 'Cancel',
          });
        } finally {
          p.deciding = false;
        }
        if (!ok) throw new GmiError('cancelled', 'Not confirmed.');
      }
      const out = resolveOut(requestId);
      if (!out) throw new GmiError('not_found', 'This approval is no longer pending.');
      if (decision.kind === 'allow_once' && isOneShot(out.request) && out.argsHash) {
        sweepTokens();
        tokens.set(requestId, { tool: out.request.tool, argsHash: out.argsHash, expiresAt: clock.now() + APPROVAL_LIMITS.tokenTtlMs });
      }
      finish(out, decision);
    },

    listPending: () => [...pending.values()].map((p) => p.request),

    consumeToken({ requestId, tool, args }) {
      sweepTokens();
      const token = tokens.get(requestId);
      if (!token || !sameTool(token.tool, tool)) return false;
      if (token.argsHash !== argsHashOf(args)) return false;
      tokens.delete(requestId);
      return true;
    },

    async confirmStructured(kind, subject) {
      const titles: Record<ConfirmKind, { title: string; message: string; confirm: string }> = {
        trust: { title: 'Trust this tool?', message: 'An agent tool asks to be trusted.', confirm: 'Trust' },
        destructive: { title: 'Run a destructive command?', message: 'The agent wants to run a command that can delete or overwrite data.', confirm: 'Run' },
        sensitive_write: { title: 'Allow writes to sensitive files?', message: 'The agent wants to change files that run code (hooks, scripts, CI).', confirm: 'Allow' },
      };
      const t = titles[kind];
      return deps.platform.confirm({
        title: t.title,
        message: t.message,
        detail: [...subjectLines(subject), ...riskLine(subject.risk)].join('\n'),
        confirmLabel: t.confirm,
        cancelLabel: 'Cancel',
      });
    },

    dispose() {
      for (const p of pending.values()) clock.clearTimeout(p.timer);
      pending.clear();
      tokens.clear();
    },
  };
}
