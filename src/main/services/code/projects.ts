/**
 * Code projects (§12.1): the native folder picker, strict git checks, the trust dialog and the project rows the
 * harness host stores. Main owns these because only main can show a picker or a native confirmation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CodeProject } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { HarnessCommand } from '@harness/protocol';
import type { AppContext } from '../../core/context';
import type { Logger } from '../../core/logger';

const execFileAsync = promisify(execFile);

/** Files whose contents shape what the agent does; their hash is what the trust dialog approves. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.gmi-desk/instructions.md'] as const;
const MCP_FILES = ['.mcp.json', '.gmi-desk/mcp.json'] as const;
const PERMISSION_FILES = ['.gmi-desk/permissions.json'] as const;
const MAX_TRUST_FILE_BYTES = 256 * 1024;

export type CommandFn = (cmd: HarnessCommand) => Promise<unknown>;

export interface ProjectService {
  list(): Promise<CodeProject[]>;
  add(): Promise<CodeProject | null>;
  trust(projectId: string): Promise<CodeProject>;
  update(projectId: string, patch: { name?: string; setupCommand?: string | null; worktreeDir?: string }): Promise<CodeProject>;
  remove(projectId: string, opts?: { removeWorktrees?: boolean }): Promise<void>;
  /** Throws `confirmation_required` unless the project is trusted and its files still match the trusted hash. */
  requireTrusted(projectId: string): Promise<CodeProject>;
  /** The project's current trust state, recomputed from disk (never writes). */
  currentTrust(project: CodeProject): Promise<CodeProject>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

function forbiddenPath(path: string, ctx: AppContext): string | null {
  const forbidden = [
    ['the filesystem root', '/'],
    ['your home folder', process.env.HOME ?? ''],
    ['the app data folder', ctx.paths.userData],
    ['your SSH keys', join(process.env.HOME ?? '', '.ssh')],
    ['your GPG keys', join(process.env.HOME ?? '', '.gnupg')],
    ['your cloud credentials', join(process.env.HOME ?? '', '.aws')],
  ] as const;
  for (const [label, dir] of forbidden) {
    if (dir && path === resolve(dir)) return label;
  }
  return null;
}

function hashLine(path: string, content: Buffer): string {
  return `${path}\0${createHash('sha256').update(content).digest('hex')}\n`;
}

async function trustFileLines(rootPath: string): Promise<Array<{ path: string; exists: boolean; line: string }>> {
  const out: Array<{ path: string; exists: boolean; line: string }> = [];
  for (const rel of [...INSTRUCTION_FILES, ...MCP_FILES, ...PERMISSION_FILES]) {
    try {
      const content = await readFile(join(rootPath, rel));
      if (content.length > MAX_TRUST_FILE_BYTES) {
        out.push({ path: rel, exists: true, line: `${rel} (larger than 256 KiB, not hashed)` });
        continue;
      }
      out.push({ path: rel, exists: true, line: hashLine(rel, content) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') out.push({ path: rel, exists: true, line: `${rel} (unreadable)` });
    }
  }
  return out;
}

/** SHA-256 over the trust files (an empty list hashes too: trusting "nothing" is still a decision). */
export async function projectConfigHash(rootPath: string): Promise<string> {
  const lines = await trustFileLines(rootPath);
  return createHash('sha256').update(lines.map((f) => f.line).join('')).digest('hex');
}

export function createProjectService(ctx: AppContext, command: CommandFn, log?: Logger): ProjectService {
  const list = async (): Promise<CodeProject[]> => {
    const rows = (await command({ op: 'query', name: 'projects', args: {} })) as CodeProject[];
    return Promise.all(rows.map((p) => currentTrust(p)));
  };

  const currentTrust = async (project: CodeProject): Promise<CodeProject> => {
    const hash = await projectConfigHash(project.rootPath).catch(() => null);
    const state: CodeProject['trust']['state'] =
      project.trust.state === 'untrusted' ? 'untrusted' : project.trust.configHash !== null && project.trust.configHash === hash ? 'trusted' : 'changed';
    return { ...project, trust: { ...project.trust, state } };
  };

  const find = async (projectId: string): Promise<CodeProject> => {
    const project = (await list()).find((p) => p.id === projectId);
    if (!project) throw new GmiError('not_found', 'Project not found.');
    return project;
  };

  const add = async (): Promise<CodeProject | null> => {
    const picked = await ctx.platform.pickDirectory({ title: 'Add a git repository' });
    if (!picked) return null;
    const path = await realpath(picked).catch(() => null);
    if (!path) throw new GmiError('invalid_input', 'That folder no longer exists.');
    const blocked = forbiddenPath(path, ctx);
    if (blocked) throw new GmiError('invalid_input', `Refusing to add ${blocked}.`);
    if (path.startsWith(ctx.paths.userData + '/') || path.startsWith(ctx.paths.secure + '/')) {
      throw new GmiError('invalid_input', 'Refusing to add a folder inside the app data directory.');
    }

    let top: string;
    try {
      top = await git(path, 'rev-parse', '--show-toplevel');
      if (!top || (await git(path, 'rev-parse', '--is-bare-repository')) === 'true') throw new Error('not a work tree');
    } catch {
      throw new GmiError('invalid_input', 'That folder is not inside a git repository with a working tree.');
    }
    const rootPath = await realpath(top).catch(() => resolve(top));
    const existing = (await list()).find((p) => p.rootPath === rootPath);
    if (existing) throw new GmiError('conflict', 'That repository is already in Code.');

    let defaultBranch: string | null = null;
    try {
      defaultBranch = (await git(rootPath, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '');
    } catch {
      try {
        const head = await git(rootPath, 'rev-parse', '--abbrev-ref', 'HEAD');
        defaultBranch = head === 'HEAD' ? null : head;
      } catch {
        defaultBranch = null;
      }
    }

    const id = randomUUID();
    const project: CodeProject = {
      id,
      name: basename(rootPath),
      rootPath,
      defaultBranch,
      trust: { state: 'untrusted', configHash: null, trustedAt: null },
      worktreeDir: join(ctx.paths.userData, 'worktrees', id.slice(0, 8)),
      setupCommand: null,
      addedAt: new Date().toISOString(),
      threadCount: 0,
    };
    await mkdir(project.worktreeDir, { recursive: true }).catch((error: unknown) => log?.warn('could not create the worktree directory', error));
    await command({ op: 'project.add', project });
    return project;
  };

  const trust = async (projectId: string): Promise<CodeProject> => {
    const project = await find(projectId);
    const files = await trustFileLines(project.rootPath);
    const found = files.filter((f) => f.exists);
    const lines = found.length > 0 ? found.map((f) => `• ${f.path}`) : ['No instruction, MCP or permission files found.'];
    const setup = project.setupCommand?.trim();
    const message = [
      `GMI Desk will follow these files in ${project.name}:`,
      ...lines,
      ...(setup ? ['', `Setup command: ${setup}`] : []),
      '',
      'Only trust repositories whose files you have read or that you wrote yourself.',
    ].join('\n');
    if (!(await ctx.platform.confirm({ title: `Trust ${project.name}?`, message, confirmLabel: 'Trust project', cancelLabel: 'Cancel' }))) throw new GmiError('cancelled', 'Project not trusted.');
    const configHash = await projectConfigHash(project.rootPath);
    const trusted: CodeProject = {
      ...project,
      trust: { state: 'trusted', configHash, trustedAt: new Date().toISOString() },
    };
    await command({ op: 'project.update', project: trusted });
    return trusted;
  };

  const update = async (projectId: string, patch: { name?: string; setupCommand?: string | null; worktreeDir?: string }): Promise<CodeProject> => {
    const project = await find(projectId);
    const name = patch.name === undefined ? project.name : patch.name.trim();
    if (!name || name.length > 200) throw new GmiError('invalid_input', 'A project name must be 1–200 characters.');
    const worktreeDir = patch.worktreeDir === undefined ? project.worktreeDir : patch.worktreeDir;
    if (!worktreeDir.startsWith('/')) throw new GmiError('invalid_input', 'The worktree folder must be an absolute path.');
    const setupCommand = patch.setupCommand === undefined ? project.setupCommand : patch.setupCommand?.trim() || null;
    if (setupCommand && setupCommand.length > 8_192) throw new GmiError('invalid_input', 'The setup command is too long.');
    const next: CodeProject = { ...project, name, worktreeDir, setupCommand };
    await command({ op: 'project.update', project: next });
    return next;
  };

  const remove = async (projectId: string, opts?: { removeWorktrees?: boolean }): Promise<void> => {
    const project = await find(projectId);
    const removeWorktrees = opts?.removeWorktrees ?? false;
    if (removeWorktrees) {
      const message = [
        `Remove ${project.name} and its ${project.threadCount} thread${project.threadCount === 1 ? '' : 's'}?`,
        'Agent worktrees and branches are deleted. Commits merged into the base branch are kept.',
      ].join('\n');
      if (!(await ctx.platform.confirm({ title: 'Remove project?', message, confirmLabel: 'Remove project', cancelLabel: 'Cancel' }))) throw new GmiError('cancelled', 'Project kept.');
    }
    await command({ op: 'project.remove', projectId: project.id, removeWorktrees });
  };

  const requireTrusted = async (projectId: string): Promise<CodeProject> => {
    const project = await find(projectId);
    if (project.trust.state !== 'trusted') {
      throw new GmiError(
        'confirmation_required',
        project.trust.state === 'changed'
          ? 'The project’s instruction or permission files changed. Trust the project again before continuing.'
          : 'Trust the project before starting an agent thread.',
      );
    }
    return project;
  };

  return { list, add, trust, update, remove, requireTrusted, currentTrust };
}
