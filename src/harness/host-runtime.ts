/**
 * The host runtime (harness.md §5, §24 "integration by H2-0"): wires the store (H2-A), the agent loop (H2-B), the
 * compactor (H2-C), the file tools (H2-D), the sandbox, permissions, shell and web (H2-E) and git (H2-G) behind the
 * `HostRuntime` seam host.ts drives.
 *
 * Start (§5.1): open the store (migrations run in the worker), the git service, the sandbox runner (self-test for
 * `ready.sandbox`), the permission engine and the tool registry; then recovery — quarantined threads are marked
 * failed, every other thread with an active status or unsettled calls is recovered (journal fsynced before each),
 * half-made worktrees are reconciled, old spill files are swept.
 *
 * Commands (§13.3) map to the loop (run.*), the store's projections (queries) and the git service (review actions).
 * Mutating commands go through the receipt guard, so a replayed command id returns the stored result (§5.1).
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  defaultCodeThreadSettings,
  type CodeProject,
  type CodeThreadSettings,
  type ThreadStrategy,
} from '@shared/contracts/code';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { LateUsageHandler } from './gateway-client';
import { createGitService } from './git';
import { createCompactor } from './loop/compaction';
import { threadGitRecord } from './loop/context';
import { createModelInfoCache } from './loop/model-info';
import { createAgentLoop, type AgentLoop, type ModelInfo } from './loop/runner';
import { mcpConfigHash, unpinnedCommand, validateMcpServer, withTrustHash } from './mcp/trust';
import { GMI_READ_TOOLS, registerGmiTools } from './mcp/gmi';
import { createPermissionEngine } from './perm/engine';
import type { HarnessCommand, StoredMcpServer } from './protocol';
import { createSandboxRunner, type HarnessSandboxRunner } from './sandbox/runner';
import { createReceiptGuard, openSqliteStore, type SqliteStore } from './store';
import { findRipgrep } from './tools/grep';
import { deleteThreadSpills, readSpillFile, sweepSpills } from './tools/output';
import { createToolRegistry, registerFileTools } from './tools/registry';
import { createShellTool } from './tools/shell';
import { createWebFetchTool } from './tools/web';
import { createTaskTool } from './tools/task';
import {
  harnessPaths,
  type CreateHostRuntime,
  type GitService,
  type HostReadyInfo,
  type HostRuntime,
  type HostRuntimeDeps,
  type McpServerRow,
  type MutationLock,
  type ProjectRow,
  type ThreadGitRecord,
  type ThreadRow,
} from './types';

// ─── Mutation lock (§6.1 invariant 4): one FIFO lock per thread ──────────────────────────────────────────────

export function createMutationLock(): MutationLock {
  const held = new Set<string>();
  const queues = new Map<string, Array<{ grant: () => void }>>();
  const release = (threadId: string) => {
    const q = queues.get(threadId);
    const next = q?.shift();
    if (q && q.length === 0) queues.delete(threadId);
    if (next) next.grant();
    else held.delete(threadId);
  };
  const releaser = (threadId: string) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release(threadId);
    };
  };
  return {
    acquire(threadId, signal) {
      if (signal?.aborted) return Promise.reject(new GmiError('cancelled', 'Cancelled.'));
      if (!held.has(threadId)) {
        held.add(threadId);
        return Promise.resolve(releaser(threadId));
      }
      return new Promise((resolvePromise, reject) => {
        const entry = {
          grant: () => {
            signal?.removeEventListener('abort', onAbort);
            resolvePromise(releaser(threadId));
          },
        };
        const onAbort = () => {
          const q = queues.get(threadId);
          const i = q?.indexOf(entry) ?? -1;
          if (q && i >= 0) q.splice(i, 1);
          reject(new GmiError('cancelled', 'Cancelled.'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const q = queues.get(threadId) ?? [];
        q.push(entry);
        queues.set(threadId, q);
      });
    },
    isHeld: (threadId) => held.has(threadId),
  };
}

// ─── Argument helpers (commands come validated by protocol.ts; `args` of queries are free-form) ──────────────

function obj(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new GmiError('invalid_input', 'Arguments must be an object.');
  return args as Record<string, unknown>;
}
function str(o: Record<string, unknown>, key: string, max = 4_096): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max || v.includes('\0')) throw new GmiError('invalid_input', `\`${key}\` must be a non-empty string.`);
  return v;
}
function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new GmiError('invalid_input', `\`${key}\` must be a string.`);
  return v;
}
function optInt(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new GmiError('invalid_input', `\`${key}\` must be a non-negative integer.`);
  return v;
}

export function defaultThreadSettings(over: Partial<CodeThreadSettings> = {}): CodeThreadSettings {
  return defaultCodeThreadSettings(over);
}

function projectRow(p: CodeProject, existing: ProjectRow | null): ProjectRow {
  return {
    id: p.id,
    rootPath: p.rootPath,
    name: p.name,
    defaultBranch: p.defaultBranch,
    worktreeDir: p.worktreeDir,
    setupCommand: p.setupCommand,
    trustState: p.trust.state,
    trustHash: p.trust.configHash,
    trustedAt: p.trust.trustedAt,
    refFormat: existing?.refFormat ?? 'files',
    addedAt: existing?.addedAt ?? p.addedAt,
  };
}

/** The public project row (adds the thread count the renderer shows). */
function codeProject(p: ProjectRow, threadCount: number): CodeProject {
  return {
    id: p.id,
    name: p.name,
    rootPath: p.rootPath,
    defaultBranch: p.defaultBranch,
    trust: { state: p.trustState, configHash: p.trustHash, trustedAt: p.trustedAt },
    worktreeDir: p.worktreeDir,
    setupCommand: p.setupCommand,
    addedAt: p.addedAt,
    threadCount,
  };
}

/** An MCP row as main reads it: the config stored at add time, plus the host's trust/pinning metadata. */
function storedMcp(row: McpServerRow): StoredMcpServer | null {
  const config = row.config as StoredMcpServer | null;
  if (!config || typeof config !== 'object' || typeof config.id !== 'string') return null;
  return {
    ...config,
    scope: row.scope,
    projectId: row.projectId,
    enabled: row.enabled,
    trustHash: row.trustHash,
    toolHashes: row.toolHashes,
    resolvedVersion: row.resolvedVersion,
  };
}

/** A branch/worktree slug from the title: lower-case ASCII words, at most 40 characters. */
export function slugOf(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'task';
}

// ─── The runtime ──────────────────────────────────────────────────────────────────────────────────────────────

export interface RealHostRuntimeOptions {
  /** Default: os.homedir(). */
  home?: string;
  /** The host's own (scrubbed) env for sandboxed commands and git. Default: process.env. */
  hostEnv?: Record<string, string | undefined>;
  /** Default: findRipgrep() on PATH. Null: the JS fallback. */
  ripgrep?: string | null;
  /** What the host knows of a model (prices, window); default: unknown (no cost trigger). */
  modelInfo?: (model: string) => ModelInfo;
  /** Default: the production sandbox runner. */
  sandbox?: (dataDir: string, platform: NodeJS.Platform) => HarnessSandboxRunner;
}

export interface RealHostRuntime extends HostRuntime {
  /** Tests and the Diagnostics runner: the parts, once started. */
  parts(): { store: SqliteStore; loop: AgentLoop; git: GitService; sandbox: HarnessSandboxRunner } | null;
}

export function createRealHostRuntime(deps: HostRuntimeDeps, opts: RealHostRuntimeOptions = {}): RealHostRuntime {
  const { link, worker, clock } = deps;
  const log = deps.log;
  const modelInfo = createModelInfoCache(link.rpc);
  let store: SqliteStore | null = null;
  let loop: AgentLoop | null = null;
  let git: (GitService & { hooksPath(r: ThreadGitRecord): Promise<string | null> }) | null = null;
  let sandbox: HarnessSandboxRunner | null = null;
  let perm: ReturnType<typeof createPermissionEngine> | null = null;
  let guard: ReturnType<typeof createReceiptGuard> | null = null;
  let dataDir = '';
  /** The in-repo `core.hooksPath` per thread (the fs tools' policy needs it synchronously, §8.2.6). */
  const hooks = new Map<string, string | null>();
  const hostEnv = opts.hostEnv ?? process.env;
  const home = opts.home ?? homedir();

  const need = () => {
    if (!store || !loop || !git || !sandbox || !perm || !guard) throw new GmiError('internal', 'The agent runtime is still starting.');
    return { store, loop, git, sandbox, perm, guard };
  };

  const recordOf = (threadId: string): ThreadGitRecord => {
    const { store: s } = need();
    const t = s.threads.get(threadId);
    if (!t) throw new GmiError('not_found', 'Thread not found.');
    const p = s.projects.get(t.projectId);
    if (!p) throw new GmiError('not_found', 'Project not found.');
    const r = threadGitRecord(t, p);
    if (!r) throw new GmiError('invalid_input', 'This thread has no git worktree.');
    return r;
  };

  const refreshHooks = async (threadId: string) => {
    try {
      hooks.set(threadId, await need().git.hooksPath(recordOf(threadId)));
    } catch {
      hooks.set(threadId, null);
    }
  };

  const idleThread = (threadId: string) => {
    if (need().loop.active(threadId)) throw new GmiError('conflict', 'A run is active in this thread; stop it first.');
  };

  async function gitAuthor(): Promise<{ name: string; email: string } | null> {
    // The sandbox's git identity: never the user's (no config read here); commits made in Review use the user's.
    return { name: 'GMI Desk agent', email: 'agent@gmi-desk.invalid' };
  }

  async function createThread(cmd: Extract<HarnessCommand, { op: 'thread.create' }>): Promise<unknown> {
    const { store: s, git: g } = need();
    const project = s.projects.get(cmd.projectId);
    if (!project) throw new GmiError('not_found', 'Project not found.');
    const now = new Date(clock.now()).toISOString();
    const id = randomUUID();
    const title = (cmd.init.title ?? '').trim().slice(0, 200);
    const strategy: ThreadStrategy = cmd.init.strategy;
    const row: ThreadRow = {
      id,
      projectId: project.id,
      title,
      strategy: strategy.kind,
      branch: null,
      baseRef: strategy.kind === 'worktree' ? strategy.baseRef : null,
      baseSha: null,
      worktreePath: null,
      gitDir: null,
      commonDir: null,
      gitPointer: null,
      objectDir: null,
      setupState: 'creating',
      settings: defaultThreadSettings(cmd.init.settings ?? {}),
      status: 'idle',
      statusReason: null,
      costUsd: 0,
      tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
      archived: false,
      instructionsHash: null,
      envBlock: null,
      createdAt: now,
      updatedAt: now,
    };
    s.threads.insert(row);
    try {
      const r = await g.createWorktree({ threadId: id, project, strategy, slug: slugOf(title || id.slice(0, 8)) });
      s.threads.update(id, {
        branch: r.branch,
        baseRef: r.baseRef,
        baseSha: r.baseSha,
        worktreePath: r.worktreePath,
        gitDir: r.gitDir,
        commonDir: r.commonDir,
        gitPointer: r.gitPointer,
        objectDir: r.objectDir,
        // The project's setup command runs in H3 (it needs the user's trust and a visible log); none here.
        setupState: 'ready',
      });
    } catch (error) {
      s.threads.update(id, { setupState: 'failed', statusReason: 'setup' });
      throw error;
    }
    await refreshHooks(id);
    const summary = s.projections.summary(id);
    if (summary) link.events.threads([summary]);
    return summary;
  }

  async function query(name: string, args: unknown): Promise<unknown> {
    const { store: s, git: g, perm: p } = need();
    const o = args === undefined || args === null ? {} : obj(args);
    switch (name) {
      case 'projects':
        return s.projects.list().map((p) => codeProject(p, s.threads.list({ projectId: p.id }).length));
      case 'threads': {
        const projectId = optStr(o, 'projectId');
        const archived = typeof o.archived === 'boolean' ? o.archived : undefined;
        return s.threads.summaries({ ...(projectId ? { projectId } : {}), ...(archived !== undefined ? { archived } : {}) });
      }
      case 'thread':
        return s.projections.thread(str(o, 'threadId', 128));
      case 'timeline': {
        const afterSeq = optInt(o, 'afterSeq');
        const beforeSeq = optInt(o, 'beforeSeq');
        const limit = optInt(o, 'limit');
        return s.projections.timeline(str(o, 'threadId', 128), { ...(afterSeq !== undefined ? { afterSeq } : {}), ...(beforeSeq !== undefined ? { beforeSeq } : {}), ...(limit !== undefined ? { limit } : {}) });
      }
      case 'diff': {
        const threadId = str(o, 'threadId', 128);
        const checkpointId = optStr(o, 'checkpointId');
        const ckpt = checkpointId ? s.checkpoints.get(checkpointId) : null;
        if (checkpointId && (!ckpt || ckpt.threadId !== threadId)) throw new GmiError('not_found', 'Checkpoint not found.');
        return g.diff(recordOf(threadId), ckpt ? { against: 'checkpoint', checkpoint: ckpt } : { against: 'base' });
      }
      case 'fileDiff':
        return g.fileDiff(recordOf(str(o, 'threadId', 128)), str(o, 'path'), { against: 'base' });
      case 'rules': {
        const projectId = optStr(o, 'projectId');
        const threadId = optStr(o, 'threadId');
        return p.listRules({ ...(projectId ? { projectId } : {}), ...(threadId ? { threadId } : {}) });
      }
      case 'approvals': {
        const threadId = optStr(o, 'threadId');
        return s.approvals.pending(threadId).map((a) => a.request);
      }
      case 'spill': {
        const threadId = str(o, 'threadId', 128);
        const buf = await readSpillFile(dataDir, threadId, str(o, 'toolCallId', 128), 4 * 1024 * 1024 - 64 * 1024);
        if (!buf) throw new GmiError('not_found', 'No such output.');
        return { text: buf.toString('utf8') };
      }
      case 'mcp': {
        const projectId = optStr(o, 'projectId');
        return s.mcpServers.list(projectId ? { projectId } : {}).flatMap((row) => {
          const server = storedMcp(row);
          return server ? [server] : [];
        });
      }
      default:
        throw new GmiError('invalid_input', 'Unknown query.');
    }
  }

  async function gitAction(name: string, args: unknown): Promise<unknown> {
    const { store: s, git: g } = need();
    const o = obj(args);
    const threadId = str(o, 'threadId', 128);
    idleThread(threadId);
    const r = recordOf(threadId);
    switch (name) {
      case 'discard':
        await g.discard(r, str(o, 'path'));
        return null;
      case 'restore': {
        const ckpt = s.checkpoints.get(str(o, 'checkpointId', 128));
        if (!ckpt || ckpt.threadId !== threadId) throw new GmiError('not_found', 'Checkpoint not found.');
        return g.restoreCheckpoint(r, ckpt);
      }
      case 'commit':
        return g.commit(r, str(o, 'message', 16_384));
      case 'merge': {
        const method = o.method === 'squash' ? 'squash' : 'merge';
        return g.merge(r, method);
      }
      case 'exportPatch':
        return { patch: await g.exportPatch(r) };
      default:
        throw new GmiError('invalid_input', 'Unknown git action.');
    }
  }

  async function removeThreadWorktree(threadId: string, deleteBranch: boolean): Promise<void> {
    const { store: s, git: g } = need();
    const t = s.threads.get(threadId);
    const p = t ? s.projects.get(t.projectId) : null;
    const r = t && p ? threadGitRecord(t, p) : null;
    if (r && r.strategy === 'worktree') await g.removeWorktree(r, { deleteBranch });
  }

  const runtime: RealHostRuntime = {
    parts: () => (store && loop && git && sandbox ? { store, loop, git, sandbox } : null),

    async start(init, io) {
      io.phase('starting');
      dataDir = init.dataDir;
      const paths = harnessPaths(dataDir);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      store = await openSqliteStore({ file: paths.db, worker, clock, log, phase: io.phase });
      const s = store;
      guard = createReceiptGuard(s);
      const g = createGitService({ dataDir, log, clock, procs: s.gitProcs, setupStateOf: (id) => s.threads.get(id)?.setupState ?? null, worker, env: hostEnv });
      git = g;
      sandbox = opts.sandbox ? opts.sandbox(dataDir, init.platform) : createSandboxRunner({ platform: init.platform, dataDir, log, hostEnv });
      const userData = resolve(dataDir, '..', '..');
      perm = createPermissionEngine({ store: s, clock, env: { home, userData, platform: init.platform }, mcpPolicy: (server, tool) => server === 'gmi' && GMI_READ_TOOLS.includes(tool) ? 'allow' : null });
      const ripgrep = opts.ripgrep === undefined ? findRipgrep(hostEnv.PATH) : opts.ripgrep;
      const tools = createToolRegistry();
      registerFileTools(tools, { ripgrep, approvals: link.approvals, home, platform: init.platform, hooksPath: (ctx) => hooks.get(ctx.threadId) ?? null });
      tools.register(createShellTool({ hostEnv, gitAuthor }));
      tools.register(createWebFetchTool());
      registerGmiTools(tools, link.rpc);
      const lock = createMutationLock();
      let loopRef: AgentLoop | null = null;
      const compactor = createCompactor(
        { store: s, gateway: link.gateway, clock, log: log.child('compaction') },
        {
          contextInfo: (r) => loopRef?.compactionContext(r) ?? null,
          onEvent: (e) => loopRef?.forwardStored(e),
          onCost: (threadId, contextId, usd) => loopRef?.creditCost(threadId, contextId || null, usd),
        },
      );
      loop = createAgentLoop({
        store: s,
        link,
        tools,
        perm,
        sandbox,
        git: g,
        lock,
        compactor,
        clock,
        log,
        dataDir,
        platform: init.platform,
        ripgrep: ripgrep !== null,
        compactionCostReported: true,
        modelInfo: opts.modelInfo ?? modelInfo.get,
      });
      loopRef = loop;
      tools.register(createTaskTool(() => loopRef!));
      // Money main charged for a request this host had already cancelled (review H2).
      const late = (link as { onLateUsage?: (h: LateUsageHandler | null) => void }).onLateUsage;
      late?.((scope, ev) => {
        if (ev.costUsd) loopRef?.creditCost(scope.threadId, null, ev.costUsd);
      });

      // Recovery (§5.1).
      io.phase('recovering');
      const at = new Date(clock.now()).toISOString();
      for (const id of io.skipThreads) {
        if (s.threads.get(id)) s.threads.update(id, { status: 'failed', statusReason: 'recovery', updatedAt: at });
      }
      const skip = new Set(io.skipThreads);
      for (const id of loop.threadsToRecover()) {
        if (skip.has(id)) continue;
        await io.recovering(id);
        await loop.recoverThread(id);
      }
      try {
        const records: ThreadGitRecord[] = [];
        for (const t of s.threads.list()) {
          if (t.setupState === 'ready' || t.archived) continue;
          const p = s.projects.get(t.projectId);
          const r = p ? threadGitRecord(t, p) : null;
          if (r) records.push(r);
        }
        const interrupted = s.refSnapshots.list().flatMap(({ runId }) => {
          const snap = s.refSnapshots.get(runId);
          return snap ? [{ runId, threadId: snap.threadId, refs: snap.refs }] : [];
        });
        const report = await g.recover(records, interrupted);
        for (const r of report.reconciled) if (r.outcome !== 'ready') s.threads.update(r.threadId, { setupState: 'failed' });
        for (const { runId } of interrupted) s.refSnapshots.delete(runId);
      } catch (error) {
        log.warn('git recovery failed', { code: toGmiError(error).code });
      }
      await io.recovering(null);
      void sweepSpills(dataDir, clock.now()).catch(() => undefined);

      const [version, sb] = await Promise.all([g.version().catch(() => null), sandbox.selftest()]);
      const info: HostReadyInfo = { sandbox: sb, git: { ok: version !== null, version }, ripgrep: ripgrep !== null };
      return info;
    },

    async handle(cmd, ctx) {
      const { store: s, loop: l, guard: rg, sandbox: sb } = need();
      switch (cmd.op) {
        case 'project.add':
        case 'project.update':
          return rg.run(ctx.commandId, null, () => {
            s.projects.upsert(projectRow(cmd.project, s.projects.get(cmd.project.id)));
            return null;
          });
        case 'project.remove':
          return rg.run(ctx.commandId, null, async () => {
            const threads = s.threads.list({ projectId: cmd.projectId });
            for (const t of threads) if (l.active(t.id)) throw new GmiError('conflict', 'A run is active in this project; stop it first.');
            for (const t of threads) {
              if (cmd.removeWorktrees) await removeThreadWorktree(t.id, false).catch((e: unknown) => log.warn('worktree removal failed', { code: toGmiError(e).code }));
              await deleteThreadSpills(dataDir, t.id).catch(() => undefined);
            }
            s.projects.remove(cmd.projectId);
            return null;
          });
        case 'thread.create':
          return rg.run(ctx.commandId, null, () => createThread(cmd));
        case 'thread.update':
          return rg.run(ctx.commandId, cmd.threadId, () => {
            const t = s.threads.get(cmd.threadId);
            if (!t) throw new GmiError('not_found', 'Thread not found.');
            const settings = cmd.patch.settings ? defaultThreadSettings({ ...t.settings, ...cmd.patch.settings, ...(cmd.patch.settings.budget ? { budget: { ...t.settings.budget, ...cmd.patch.settings.budget } } : {}) }) : t.settings;
            s.threads.update(cmd.threadId, { ...(cmd.patch.title !== undefined ? { title: cmd.patch.title.slice(0, 200) } : {}), settings });
            const summary = s.projections.summary(cmd.threadId);
            if (summary) link.events.threads([summary]);
            return summary;
          });
        case 'thread.archive':
          return rg.run(ctx.commandId, cmd.threadId, async () => {
            await l.interrupt(cmd.threadId);
            if (cmd.removeWorktree) await removeThreadWorktree(cmd.threadId, cmd.deleteBranch);
            s.threads.update(cmd.threadId, { archived: true });
            const summary = s.projections.summary(cmd.threadId);
            if (summary) link.events.threads([summary]);
            return null;
          });
        case 'thread.delete':
          return rg.run(ctx.commandId, cmd.threadId, async () => {
            await l.interrupt(cmd.threadId);
            const t = s.threads.get(cmd.threadId);
            if (!t) return null;
            const r = (() => {
              const p = s.projects.get(t.projectId);
              return p ? threadGitRecord(t, p) : null;
            })();
            if (r) await need().git.deleteCheckpoints(r).catch(() => undefined);
            await deleteThreadSpills(dataDir, cmd.threadId).catch(() => undefined);
            s.threads.delete(cmd.threadId);
            hooks.delete(cmd.threadId);
            return null;
          });
        case 'run.send':
          if (!l.active(cmd.threadId)) {
            const settings = s.threads.get(cmd.threadId)?.settings;
            if (settings) await modelInfo.refresh([settings.model, settings.subagentModel, settings.compactionModel, settings.sideTaskModel]);
          }
          await refreshHooks(cmd.threadId);
          return l.send(cmd.threadId, cmd.text, { commandId: ctx.commandId });
        case 'run.steer':
          l.steer(cmd.threadId, cmd.text);
          return null;
        case 'run.interrupt':
          await l.interrupt(cmd.threadId);
          return null;
        case 'run.resume':
          {
            const settings = s.threads.get(cmd.threadId)?.settings;
            if (settings) await modelInfo.refresh([settings.model, settings.subagentModel, settings.compactionModel, settings.sideTaskModel]);
          }
          await refreshHooks(cmd.threadId);
          return l.resume(cmd.threadId, { commandId: ctx.commandId });
        case 'query':
          return query(cmd.name, cmd.args);
        case 'git':
          return rg.run(ctx.commandId, null, () => gitAction(cmd.name, cmd.args));
        case 'rules.delete':
          return need().perm.deleteRule(cmd.ruleId);
        case 'mcp.upsert': {
          const server = withTrustHash(cmd.server);
          validateMcpServer(server);
          s.mcpServers.upsert({
            id: server.id,
            scope: server.scope,
            projectId: server.scope === 'project' ? server.projectId : null,
            config: server,
            trustHash: server.trustHash,
            toolHashes: server.toolHashes,
            resolvedVersion: server.resolvedVersion ?? null,
            enabled: server.enabled,
          });
          return {
            ...server,
            trustHash: server.trustHash === mcpConfigHash(server) ? server.trustHash : null,
            resolvedVersion: server.resolvedVersion ?? null,
            unpinned: unpinnedCommand(server.transport),
          };
        }
        case 'mcp.remove':
          s.mcpServers.remove(cmd.serverId);
          return null;
        case 'sandbox.selftest':
          return sb.selftest();
        default:
          throw new GmiError('invalid_input', 'Unknown command.');
      }
    },

    async shutdown(graceMs) {
      const started = clock.now();
      try {
        await loop?.shutdown(Math.max(0, Math.floor(graceMs * 0.7)));
      } catch (error) {
        log.warn('loop shutdown failed', { code: toGmiError(error).code });
      }
      await sandbox?.close().catch(() => undefined);
      try {
        store?.checkpointWal();
      } catch {
        /* best effort */
      }
      store?.close();
      store = null;
      log.debug('runtime stopped', { ms: clock.now() - started });
    },
  };
  return runtime;
}

/** The factory host.ts uses in the utilityProcess. */
export const createProductionHostRuntime: CreateHostRuntime = (deps) => createRealHostRuntime(deps);
