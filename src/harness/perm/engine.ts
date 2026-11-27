/**
 * The permission engine (harness.md §9.1–§9.4). Pure decisions over the rules in the store, the thread's mode and
 * settings, and the sandbox state:
 *
 *   1. hard denies (§8.2.5; web fetch `off`; shell network `off`) → deny
 *   2. any matching deny rule (also project-file rules, which can only deny, §9.1) → deny
 *   3. kinds that ask in every mode: destructive, costs_money, unsandboxed shell, network without the proxy
 *      (`local_network`), execution-sensitive or outside-worktree edits (except full-access) → ask
 *   4. the most specific matching allow rule (thread > project > global) → allow
 *   5. the mode preset (§9.2) → allow | ask
 *   6. default → ask
 * Unattended runs turn every ask into a deny.
 *
 * Rule patterns: shell = a word-wise command prefix (`npm test`); a shell rule that also grants network is stored as
 * `net:<prefix>` (plain prefixes never cover network); fs tools = a path glob relative to the worktree (or absolute);
 * web_fetch = a host glob; MCP = a glob over the canonical JSON arguments. Allow rules never match compound commands.
 */
import { isAbsolute, posix, relative } from 'node:path';
import type { CodeThreadSettings, PermissionRule, PermissionRuleDraft, RiskFlag } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import {
  newId,
  type CommandClassification,
  type HostClock,
  type PermissionContext,
  type PermissionEngine,
  type PermissionSubject,
  type PermissionVerdict,
  type SandboxProfile,
  type Store,
} from '../types';
import { classifyCommand, commandSegments, patternArgv, prefixMatches } from './command';
import { hardDenyReason, type HardDenyEnv } from './hard';

/** §8.5 default web allowlist (plus the project's own list). */
export const DEFAULT_WEB_ALLOWLIST = [
  'docs.gmicloud.ai',
  'developer.mozilla.org',
  'nodejs.org',
  'docs.python.org',
  'pypi.org',
  'www.npmjs.com',
  'raw.githubusercontent.com',
  'github.com',
] as const;

/** Prefix of a shell rule pattern that also grants network for the command (§8.3). */
export const NET_PATTERN_PREFIX = 'net:';

export interface PermissionEngineDeps {
  store: Store;
  clock: HostClock;
  env: HardDenyEnv;
  /** The project's own web allowlist (§8.5); the defaults are always added. */
  webAllowlist?(projectId: string): readonly string[];
  /** Per-server MCP tool policy (H3-D, §10). Null = no policy (ask). */
  mcpPolicy?(server: string, tool: string): 'allow' | 'ask' | 'deny' | null;
  /** Preset rules (wildcards allowed), e.g. GMI read tools. */
  presets?: PermissionRule[];
}

export interface HarnessPermissionEngine extends PermissionEngine {
  /** Rules loaded from `.gmi-desk/permissions.json` (deny only), by project. */
  projectRules(projectId: string): PermissionRule[];
}

// ─── Matching helpers ─────────────────────────────────────────────────────────────────────────────────────────

const WILDCARD = /[*?]/;

/** Glob → RegExp: `**` any characters, `*` any but `/`, `?` one character but `/`. */
export function globToRegExp(glob: string, flags = ''): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, flags);
}

function toolMatches(ruleTool: string, tool: string): boolean {
  return WILDCARD.test(ruleTool) ? globToRegExp(ruleTool).test(tool) : ruleTool === tool;
}

function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return WILDCARD.test(p) ? globToRegExp(p).test(h) : p === h;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

type Facet = 'shell' | 'shell_net' | 'web' | 'read' | 'write' | 'mcp' | 'compute' | 'user' | 'other';

function facetOf(s: PermissionSubject): Facet {
  if (s.kind === 'question' || s.kind === 'mcp-elicitation') return 'user';
  if (s.tool === 'web_fetch') return 'web';
  if (s.command !== undefined && (s.kind === 'command' || s.kind === 'network')) return s.kind === 'network' ? 'shell_net' : 'shell';
  if (s.kind === 'file-change') return 'write';
  if (s.kind === 'file-read') return 'read';
  if (s.kind === 'mcp') return 'mcp';
  if (s.kind === 'compute') return 'compute';
  return 'other';
}

interface Evaluated {
  subject: PermissionSubject;
  facet: Facet;
  cls: CommandClassification | null;
  ctx: PermissionContext;
  settings: CodeThreadSettings | null;
}

function relPath(path: string, worktree: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(worktree, path);
  return rel === '' ? '.' : rel.split('\\').join('/');
}

function pathMatches(pattern: string, path: string, worktree: string, fold: boolean): boolean {
  const re = globToRegExp(pattern, fold ? 'i' : '');
  const rel = relPath(path, worktree);
  return re.test(path) || (!rel.startsWith('..') && re.test(rel));
}

function ruleApplies(rule: PermissionRule, ctx: PermissionContext): boolean {
  if (rule.scope === 'thread') return rule.threadId === ctx.threadId;
  if (rule.scope === 'project') return rule.projectId === ctx.projectId;
  return true;
}

/** Does `rule`'s pattern cover the subject? Allow rules are strict; deny rules match any part. */
function patternMatches(rule: PermissionRule, e: Evaluated, fold: boolean): boolean {
  const { subject: s, facet } = e;
  const pattern = rule.pattern;
  if (facet === 'shell' || facet === 'shell_net') {
    const command = s.command ?? '';
    if (rule.effect === 'deny') {
      if (pattern === null) return true;
      const p = pattern.startsWith(NET_PATTERN_PREFIX) ? pattern.slice(NET_PATTERN_PREFIX.length) : pattern;
      if (WILDCARD.test(p)) {
        const re = globToRegExp(p.replace(/\*/g, '**'));
        return re.test(command) || commandSegments(command).some((seg) => re.test(seg.join(' ')));
      }
      const words = patternArgv(p);
      return words !== null && commandSegments(command).some((seg) => prefixMatches(words, seg));
    }
    // Allow: never a compound command; network only through a `net:` rule.
    if (!e.cls || e.cls.compound || e.cls.argv === null) return false;
    const isNet = pattern !== null && pattern.startsWith(NET_PATTERN_PREFIX);
    if (facet === 'shell_net' && !isNet) return false;
    if (pattern === null) return facet === 'shell';
    const words = patternArgv(isNet ? pattern.slice(NET_PATTERN_PREFIX.length) : pattern);
    return words !== null && prefixMatches(words, e.cls.argv);
  }
  if (pattern === null) return true;
  if (facet === 'read' || facet === 'write') {
    const paths = s.paths ?? [];
    if (paths.length === 0) return false;
    return rule.effect === 'deny' ? paths.some((p) => pathMatches(pattern, p, e.ctx.worktree, fold)) : paths.every((p) => pathMatches(pattern, p, e.ctx.worktree, fold));
  }
  if (facet === 'web') return s.host !== undefined && hostMatches(pattern, s.host);
  if (facet === 'mcp' || facet === 'compute' || facet === 'other') return globToRegExp(pattern.replace(/\*/g, '**')).test(canonical(s.args ?? null));
  return false;
}

// ─── Engine ───────────────────────────────────────────────────────────────────────────────────────────────────

const SCOPE_ORDER: Record<PermissionRule['scope'], number> = { thread: 0, project: 1, global: 2 };

export function createPermissionEngine(deps: PermissionEngineDeps): HarnessPermissionEngine {
  const fold = deps.env.platform === 'darwin' || deps.env.platform === 'win32';
  const projectFileRules = new Map<string, PermissionRule[]>();
  const iso = () => new Date(deps.clock.now()).toISOString();

  function allRules(): PermissionRule[] {
    const stored = deps.store.rules.list();
    const fromFiles = [...projectFileRules.values()].flat();
    return [...(deps.presets ?? []), ...stored, ...fromFiles];
  }

  function settingsOf(threadId: string): CodeThreadSettings | null {
    try {
      return deps.store.threads.get(threadId)?.settings ?? null;
    } catch {
      return null;
    }
  }

  function webAllowed(projectId: string, host: string): boolean {
    const list = [...DEFAULT_WEB_ALLOWLIST, ...(deps.webAllowlist?.(projectId) ?? [])];
    return list.some((p) => hostMatches(p, host));
  }

  function suggest(e: Evaluated): PermissionRuleDraft | null {
    const { subject: s, facet } = e;
    if (s.risk.includes('costs_money') || s.risk.includes('destructive') || s.risk.includes('local_network')) return null;
    switch (facet) {
      case 'shell':
      case 'shell_net': {
        const p = e.cls?.suggestedPattern ?? null;
        if (p === null) return null;
        return { tool: s.tool, pattern: facet === 'shell_net' ? `${NET_PATTERN_PREFIX}${p}` : p, effect: 'allow', scope: 'project' };
      }
      case 'read':
      case 'write': {
        const first = s.paths?.[0];
        if (!first) return null;
        const rel = relPath(first, e.ctx.worktree);
        if (rel.startsWith('..') || isAbsolute(rel)) return null;
        const dir = posix.dirname(rel);
        return { tool: s.tool, pattern: dir === '.' ? rel : `${dir}/**`, effect: 'allow', scope: 'project' };
      }
      case 'web':
        return s.host ? { tool: s.tool, pattern: s.host.toLowerCase(), effect: 'allow', scope: 'project' } : null;
      case 'mcp':
        return { tool: s.tool, pattern: null, effect: 'allow', scope: 'project' };
      default:
        return null;
    }
  }

  function ask(e: Evaluated, risk: RiskFlag[], reason: string): PermissionVerdict {
    if (e.ctx.unattended) return { effect: 'deny', via: 'unattended', ruleId: null, reason: `${reason} (unattended run)`, risk };
    return { effect: 'ask', risk, suggestedRule: suggest({ ...e, subject: { ...e.subject, risk } }), reason };
  }

  function profileOf(e: Evaluated): SandboxProfile | null {
    if (e.facet === 'shell') return e.cls?.readOnly && e.ctx.sandbox.ok ? 'readonly' : 'exec';
    if (e.facet === 'shell_net') return 'exec';
    return null;
  }

  const engine: HarnessPermissionEngine = {
    classifyCommand,

    evaluate(subject, ctx) {
      const facet = facetOf(subject);
      const cls = facet === 'shell' || facet === 'shell_net' ? classifyCommand(subject.command ?? '') : null;
      const settings = settingsOf(ctx.threadId);
      const e: Evaluated = { subject, facet, cls, ctx, settings };
      const flags = new Set<RiskFlag>(subject.risk);
      if (cls?.compound) flags.add('compound_command');
      if (cls?.destructive) flags.add('destructive');
      if (facet === 'shell_net' || facet === 'web') flags.add('network');
      if ((facet === 'shell' || facet === 'shell_net') && !ctx.sandbox.ok) flags.add('unsandboxed');
      if (facet === 'shell_net' && ctx.sandbox.network !== 'proxy') flags.add('local_network');
      const risk = [...flags];
      const full = ctx.mode === 'full-access';

      // 1. Hard denies.
      for (const p of subject.paths ?? []) {
        const why = hardDenyReason(p, facet === 'write' ? 'write' : 'read', deps.env, ctx.worktree);
        if (why) return { effect: 'deny', via: 'hard', ruleId: null, reason: `${why}: ${p}`, risk: [...risk, 'secret_path'] };
      }
      if (facet === 'web' && settings?.webFetch === 'off') return { effect: 'deny', via: 'hard', ruleId: null, reason: 'Web fetch is off for this thread.', risk };
      if (facet === 'shell_net' && settings?.network === 'off' && !full) return { effect: 'deny', via: 'hard', ruleId: null, reason: 'Network is off for this thread.', risk };

      // 2. Deny rules.
      const rules = allRules().filter((r) => ruleApplies(r, ctx) && toolMatches(r.tool, subject.tool));
      const deny = rules.find((r) => r.effect === 'deny' && patternMatches(r, e, fold));
      if (deny) return { effect: 'deny', via: 'rule', ruleId: deny.id, reason: 'A deny rule matches.', risk };

      // 3. Kinds that ask in every mode.
      if (flags.has('destructive')) return ask(e, risk, 'Destructive command.');
      if (flags.has('costs_money')) return ask(e, risk, 'This call costs money.');
      if (flags.has('unsandboxed')) return ask(e, risk, 'The sandbox is unavailable.');
      if (flags.has('local_network')) return ask(e, risk, 'Network without the proxy reaches the local network.');
      if (!full && (flags.has('execution_sensitive') || flags.has('outside_worktree') || flags.has('secret_path'))) return ask(e, risk, 'Sensitive path.');

      // 4. Allow rules: thread > project > global, newest first.
      const allow = rules
        .filter((r) => r.effect === 'allow' && patternMatches(r, e, fold))
        .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || b.createdAt.localeCompare(a.createdAt))[0];
      if (allow) return { effect: 'allow', via: allow.source === 'preset' ? 'preset' : 'rule', ruleId: allow.id, risk, profile: profileOf(e) };

      // 5. Mode presets (§9.2).
      const allowMode = (): PermissionVerdict => ({ effect: 'allow', via: 'mode', ruleId: null, risk, profile: profileOf(e) });
      switch (facet) {
        case 'user':
        case 'read':
          return allowMode();
        case 'write':
          return ctx.mode === 'approval-required' ? ask(e, risk, 'File edits ask in this mode.') : allowMode();
        case 'shell':
          if (cls?.readOnly && !cls.compound) return allowMode();
          if (ctx.mode === 'auto' || full) return allowMode();
          return ask(e, risk, 'Shell commands ask in this mode.');
        case 'shell_net':
          return full ? allowMode() : ask(e, risk, 'Network access asks in this mode.');
        case 'web':
          if (full) return allowMode();
          if (settings?.webFetch === 'allowlist' && subject.host && webAllowed(ctx.projectId, subject.host)) return allowMode();
          return ask(e, risk, 'Web fetch asks for this host.');
        case 'mcp': {
          const policy = subject.server ? (deps.mcpPolicy?.(subject.server, subject.tool) ?? null) : null;
          if (policy === 'deny') return { effect: 'deny', via: 'rule', ruleId: null, reason: 'The server policy denies this tool.', risk };
          if (policy === 'allow' && ctx.mode !== 'approval-required') return allowMode();
          return full ? allowMode() : ask(e, risk, 'MCP tools ask by default.');
        }
        default:
          return full ? allowMode() : ask(e, risk, 'Approval needed.');
      }
    },

    record(request, decision, ctx) {
      const oneShotOnly = request.risk.includes('costs_money') || request.risk.includes('destructive') || request.risk.includes('local_network');
      if (decision.kind === 'allow_thread') {
        const s = request.suggestedRule;
        if (oneShotOnly || !s || s.pattern === null) return null;
        const rule: PermissionRule = { tool: request.tool, pattern: s.pattern, effect: 'allow', scope: 'thread', id: newId('rule'), projectId: ctx.projectId, threadId: ctx.threadId, source: 'user', createdAt: iso() };
        deps.store.rules.insert(rule);
        return rule;
      }
      if (decision.kind === 'allow_always') {
        const d = decision.rule;
        if (d.effect === 'allow') {
          if (oneShotOnly) return null;
          // §9.1: user allow rules name exactly the requested tool, without wildcards (main checked the pattern).
          if (d.tool !== request.tool || WILDCARD.test(d.tool)) throw new GmiError('invalid_input', 'An allow rule must name exactly the requested tool.');
        }
        const rule: PermissionRule = {
          tool: d.tool,
          pattern: d.pattern,
          effect: d.effect,
          scope: d.scope,
          id: newId('rule'),
          projectId: d.scope === 'global' ? null : ctx.projectId,
          threadId: d.scope === 'thread' ? ctx.threadId : null,
          source: 'user',
          createdAt: iso(),
        };
        deps.store.rules.insert(rule);
        return rule;
      }
      return null;
    },

    listRules(opts) {
      return allRules().filter((r) => {
        if (opts?.projectId !== undefined && opts.projectId !== null && r.projectId !== null && r.projectId !== opts.projectId) return false;
        if (opts?.threadId !== undefined && opts.threadId !== null && r.threadId !== null && r.threadId !== opts.threadId) return false;
        return true;
      });
    },

    deleteRule(ruleId) {
      return deps.store.rules.delete(ruleId);
    },

    loadProjectRules(projectId, drafts) {
      const kept: PermissionRule[] = [];
      const ignored: PermissionRuleDraft[] = [];
      for (const d of drafts) {
        const valid = typeof d?.tool === 'string' && d.tool.length > 0 && d.tool.length <= 256 && (d.pattern === null || (typeof d.pattern === 'string' && d.pattern.length <= 4096));
        // A malicious repo cannot pre-approve itself: project files add denies only (§9.1).
        if (!valid || d.effect !== 'deny') {
          ignored.push(d);
          continue;
        }
        kept.push({ tool: d.tool, pattern: d.pattern, effect: 'deny', scope: 'project', id: `rule_pf_${projectId}_${kept.length}`, projectId, threadId: null, source: 'project_file', createdAt: iso() });
      }
      projectFileRules.set(projectId, kept);
      return ignored;
    },

    projectRules(projectId) {
      return [...(projectFileRules.get(projectId) ?? [])];
    },
  };
  return engine;
}
