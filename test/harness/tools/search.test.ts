// H2-D: grep, glob and list (harness.md §8.1, §8.2 fixed rg argv, H-T16). The `--pre=sh` cases run the real rg
// (installed here; skipped elsewhere) against a throwaway worktree: rg's `--pre=sh` would run `sh <file>` for each
// searched file, and every file here is a script that creates a marker, so a single interpretation as an option
// shows up as the marker.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadTool } from '@harness/tools/fs';
import { createGlobTool } from '@harness/tools/glob';
import { compileGlobRule, compileIgnoreFile, createGrepTool, filesArgv, findRipgrep, grepArgv, matchRules, parseRgJson, ripgrepEnv, walkFiles } from '@harness/tools/grep';
import { createListTool, renderTree } from '@harness/tools/list';
import { call, makeEnv, type ToolEnv } from './env';

const RG = findRipgrep();
const engines: Array<[string, string | null]> = RG ? [['rg', RG], ['js', null]] : [['js', null]];

let env: ToolEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

function fixture(e: ToolEnv) {
  // rg applies .gitignore inside a git repository only (worktrees always are one).
  e.write('.git/HEAD', 'ref: refs/heads/main\n');
  e.write('.gitignore', 'dist/\n*.log\n');
  e.write('src/a.ts', 'export const Alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n');
  e.write('src/lib/b.ts', 'import { Alpha } from "../a";\nexport const delta = Alpha + 1;\n');
  e.write('src/c.js', 'module.exports = "alpha";\n');
  e.write('dist/out.ts', 'export const Alpha = "built";\n');
  e.write('debug.log', 'Alpha in a log\n');
  e.write('deploy/server.key', 'Alpha-PRIVATE-KEY\n');
  e.write('.env', 'Alpha=SECRET\n');
  e.write('README.md', '# Alpha project\n');
}

describe.each(engines)('grep (%s)', (_name, rg) => {
  const deps = () => ({ home: env.home, ripgrep: rg });

  it('finds matches grouped by file, respects .gitignore and never returns secret files', async () => {
    fixture(env);
    const r = await call(createGrepTool(deps()), { pattern: 'Alpha' }, env.ctx());
    expect(r.ok, r.content).toBe(true);
    expect(r.content).toContain('src/a.ts\n  1: export const Alpha = 1;');
    expect(r.content).toContain('src/lib/b.ts\n  1: import { Alpha } from "../a";\n  2: export const delta = Alpha + 1;');
    expect(r.content).toContain('README.md');
    expect(r.content).not.toMatch(/dist\/out|debug\.log|server\.key|PRIVATE|SECRET|\.env/);
    expect(r.effects?.readPaths?.sort()).toEqual(['README.md', 'src/a.ts', 'src/lib/b.ts']);
  });

  it('ignore_case, context, glob and path', async () => {
    fixture(env);
    const grep = createGrepTool(deps());
    const ci = await call(grep, { pattern: 'alpha', ignore_case: true, glob: '*.js' }, env.ctx());
    expect(ci.content).toBe('src/c.js\n  1: module.exports = "alpha";');
    const cx = await call(grep, { pattern: 'beta', context: 1, path: 'src' }, env.ctx());
    expect(cx.content).toBe('src/a.ts\n  1- export const Alpha = 1;\n  2: const beta = 2;\n  3- const gamma = 3;');
    const file = await call(grep, { pattern: 'delta', path: 'src/lib/b.ts' }, env.ctx());
    expect(file.content).toBe('src/lib/b.ts\n  2: export const delta = Alpha + 1;');
    expect((await call(grep, { pattern: 'zzz_nothing' }, env.ctx())).content).toBe('No matches.');
  });

  it('refuses outside and secret search paths', async () => {
    fixture(env);
    fs.writeFileSync(path.join(env.outside, 'o.txt'), 'Alpha\n');
    const grep = createGrepTool(deps());
    expect(await call(grep, { pattern: 'Alpha', path: '../outside' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
    expect(await call(grep, { pattern: 'Alpha', path: '.env' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
    expect(await call(grep, { pattern: 'Alpha', path: 'deploy/server.key' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
  });

  it('a symlinked directory pointing outside is not followed', async () => {
    fixture(env);
    fs.writeFileSync(path.join(env.outside, 'o.txt'), 'Alpha outside\n');
    fs.symlinkSync(env.outside, path.join(env.worktree, 'src', 'ext'));
    const r = await call(createGrepTool(deps()), { pattern: 'outside' }, env.ctx());
    expect(r.content).toBe('No matches.');
  });

  it('over 200 matches: truncated with a spill readable by the read tool', async () => {
    env.write('many.txt', Array.from({ length: 450 }, (_, i) => `hit ${i}`).join('\n') + '\n');
    const ctx = env.ctx();
    const r = await call(createGrepTool(deps()), { pattern: 'hit' }, ctx);
    expect(r.content).toMatch(new RegExp(`\\[showing 200 of 450 matching lines in 1 files; full results: spill:${ctx.call.id} \\(use read on it\\)\\]$`));
    expect(r.spillId).toBe(ctx.call.id);
    const back = await call(createReadTool({ home: env.home }), { path: `spill:${ctx.call.id}` }, env.ctx());
    expect(back.content).toContain('  450: hit 449');
  });

  it('an invalid regex is an execution error', async () => {
    env.write('a.txt', 'x\n');
    const r = await call(createGrepTool(deps()), { pattern: '(' }, env.ctx());
    expect(r).toMatchObject({ ok: false, errorKind: 'execution' });
  });
});

describe.each(engines)('glob and list (%s)', (_name, rg) => {
  const deps = () => ({ home: env.home, ripgrep: rg });

  it('glob: name patterns at any depth, anchored paths, braces; ignored files excluded', async () => {
    fixture(env);
    const glob = createGlobTool(deps());
    expect((await call(glob, { pattern: '*.ts' }, env.ctx())).content).toBe('src/a.ts\nsrc/lib/b.ts');
    expect((await call(glob, { pattern: 'src/*.{js,ts}' }, env.ctx())).content).toBe('src/a.ts\nsrc/c.js');
    expect((await call(glob, { pattern: '**/*.ts', path: 'src/lib' }, env.ctx())).content).toBe('src/lib/b.ts');
    expect((await call(glob, { pattern: '*.nope' }, env.ctx())).content).toBe('No files found.');
    expect(await call(glob, { pattern: '*', path: '../outside' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
  });

  it('glob: over 1,000 results are cut with a spill', async () => {
    for (let i = 0; i < 1_050; i += 1) env.write(`gen/f${String(i).padStart(4, '0')}.txt`, '');
    const ctx = env.ctx();
    const r = await call(createGlobTool(deps()), { pattern: '*.txt' }, ctx);
    expect(r.content.split('\n').length).toBe(1_001);
    expect(r.content).toMatch(/\[showing 1000 of 1050 files; full results: spill:tc_/);
    expect(fs.existsSync(path.join(env.dataDir, 'spill', ctx.threadId, `${ctx.call.id}.txt`))).toBe(true);
  });

  it('list: a tree to the requested depth with counts for deeper directories (secret files are not listed)', async () => {
    fixture(env);
    env.write('deploy/run.txt', '');
    const list = createListTool(deps());
    expect((await call(list, {}, env.ctx())).content).toBe(['./', '  deploy/', '    run.txt', '  src/', '    lib/ (1 file)', '    a.ts', '    c.js', '  README.md'].join('\n'));
    expect((await call(list, { depth: 1 }, env.ctx())).content).toBe(['./', '  deploy/ (1 file)', '  src/ (3 files)', '  README.md'].join('\n'));
    expect((await call(list, { path: 'src', depth: 3 }, env.ctx())).content).toBe(['src/', '  lib/', '    b.ts', '  a.ts', '  c.js'].join('\n'));
    expect(await call(list, { path: 'src/a.ts' }, env.ctx())).toMatchObject({ ok: false });
    expect(list.parse({ depth: 4 }).ok).toBe(false);
  });
});

describe('fixed rg argv (H-T16)', () => {
  it('builds the argv with the pattern after -e, globs after -g and the path after --', () => {
    expect(grepArgv({ pattern: '--pre=sh', searchPath: '/w', ignoreCase: true, context: 2, globs: ['--pre=sh'] })).toEqual([
      '--no-config', '--json', '-i', '-C', '2', '-g', '--pre=sh', '-e', '--pre=sh', '--', '/w',
    ]);
    expect(filesArgv('/w', ['*.ts'])).toEqual(['--no-config', '--files', '-g', '*.ts', '--', '/w']);
    expect(Object.keys(ripgrepEnv('/usr/bin/rg')).sort()).toEqual(['LANG', 'LC_ALL', 'NO_COLOR', 'PATH']);
  });

  it('with a working sandbox, rg runs in the readonly profile with that argv', async () => {
    const sb = makeEnv({ sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' } });
    try {
      sb.write('a.txt', 'x\n');
      const r = await call(createGrepTool({ home: sb.home, ripgrep: '/usr/bin/rg' }), { pattern: '--pre=sh', glob: '--pre=sh' }, sb.ctx());
      expect(r.ok).toBe(true);
      const spec = sb.sandbox.runs[0];
      expect(spec?.profile).toBe('readonly');
      expect(spec?.network).toBe('off');
      expect(spec?.command).toBeUndefined();
      const argv = spec?.argv ?? [];
      expect(argv.slice(0, 3)).toEqual(['/usr/bin/rg', '--no-config', '--json']);
      expect(argv.slice(-4)).toEqual(['-e', '--pre=sh', '--', sb.wt]);
      expect(argv[argv.indexOf('-g') + 1]).toBe('--pre=sh');
      expect(spec?.env).not.toHaveProperty('RIPGREP_CONFIG_PATH');
    } finally {
      sb.cleanup();
    }
  });

  it.skipIf(!RG)('--pre=sh as the pattern, the glob and the path never runs anything (real rg)', async () => {
    const marker = path.join(env.base, 'PWNED');
    const script = `touch ${marker}\n--pre=sh\n`;
    env.write('a.sh.txt', script);
    env.write('--pre=sh', script);
    env.write('sub/--pre=sh.txt', script);
    // A config file that would add --pre=sh, exported as RIPGREP_CONFIG_PATH in the host env.
    const cfg = path.join(env.base, 'rgrc');
    fs.writeFileSync(cfg, '--pre=sh\n');
    const prev = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = cfg;
    try {
      const deps = { home: env.home, ripgrep: RG };
      const grep = createGrepTool(deps);
      const asPattern = await call(grep, { pattern: '--pre=sh' }, env.ctx());
      expect(asPattern.ok).toBe(true);
      expect(asPattern.content).toContain('--pre=sh');
      await call(grep, { pattern: 'touch', glob: '--pre=sh' }, env.ctx());
      const asPath = await call(grep, { pattern: 'touch', path: '--pre=sh' }, env.ctx());
      expect(asPath.content).toBe(`--pre=sh\n  1: touch ${marker}`);
      await call(grep, { pattern: '--pre=sh', path: '--pre=sh', glob: '--pre=sh', ignore_case: true, context: 1 }, env.ctx());
      await call(createGlobTool(deps), { pattern: '--pre=sh' }, env.ctx());
      await call(createGlobTool(deps), { pattern: '*', path: 'sub' }, env.ctx());
      await call(createListTool(deps), { path: 'sub' }, env.ctx());
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = prev;
    }
  });
});

describe('matching helpers (JS fallback)', () => {
  it('gitignore rules: anchoring, negation, directories', () => {
    const rules = compileIgnoreFile('# c\n*.log\n!keep.log\n/build\nnode_modules/\ndocs/**/*.tmp\n');
    expect(matchRules(rules, 'a/b.log', false)).toBe(true);
    expect(matchRules(rules, 'keep.log', false)).toBe(false);
    expect(matchRules(rules, 'build', true)).toBe(true);
    expect(matchRules(rules, 'src/build', true)).toBeNull();
    expect(matchRules(rules, 'x/node_modules', true)).toBe(true);
    expect(matchRules(rules, 'node_modules', false)).toBeNull();
    expect(matchRules(rules, 'docs/a/b/c.tmp', false)).toBe(true);
    expect(matchRules(rules, 'docs/c.tmp', false)).toBe(true);
  });
  it('globs: ?, classes and braces', () => {
    const g = compileGlobRule('src/[ab]?.{ts,tsx}', true);
    expect(g?.re.test('src/a1.ts')).toBe(true);
    expect(g?.re.test('src/c1.ts')).toBe(false);
    expect(g?.re.test('src/b2.tsx')).toBe(true);
    expect(g?.re.test('src/a/1.ts')).toBe(false);
  });
  it('walkFiles skips hidden entries, .git, symlinks and nested .gitignore matches', async () => {
    env.write('a.txt', '');
    env.write('.hidden', '');
    env.write('.git/config', '');
    env.write('pkg/.gitignore', 'gen/\n');
    env.write('pkg/gen/x.txt', '');
    env.write('pkg/y.txt', '');
    fs.symlinkSync(env.outside, path.join(env.worktree, 'out'));
    const w = await walkFiles(env.worktree, { signal: new AbortController().signal });
    expect(w.files.map((f) => path.relative(env.worktree, f))).toEqual(['a.txt', 'pkg/y.txt']);
  });
  it('parseRgJson ignores non-JSON lines (stderr in a sandbox capture)', () => {
    const out = ['rg: ./x: Permission denied', '{"type":"begin","data":{"path":{"text":"/w/a"}}}', '{"type":"match","data":{"path":{"text":"/w/a"},"lines":{"text":"hi\\n"},"line_number":3}}', '{"type":"context","data":{"path":{"text":"/w/a"},"lines":{"text":"ho\\n"},"line_number":4}}', 'garbage {'].join('\n');
    expect(parseRgJson(out)).toEqual([
      { path: '/w/a', line: 3, text: 'hi\n', match: true },
      { path: '/w/a', line: 4, text: 'ho\n', match: false },
    ]);
  });
  it('renderTree', () => {
    expect(renderTree(['b.txt', 'a/x.txt', 'a/y/z.txt'], 2)).toEqual(['a/', '  y/ (1 file)', '  x.txt', 'b.txt']);
  });
});
