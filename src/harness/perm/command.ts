/**
 * Shell command classification (harness.md §9.3). Used only for permission matching, never as the security
 * boundary: the sandbox (§8.3) is the boundary, and allowlisted read-only commands run in the `readonly` profile, so
 * read-only is a property of the mounts even if a flag rule here is missed.
 *
 * - A small POSIX shell lexer. Anything it cannot reduce to one plain argv (operators, substitutions, expansions,
 *   globs, redirections, here-docs, comments, assignments, `eval`/`sudo`/`exec`/`source`) is `compound`: never matched
 *   by an allow rule and never on the read-only allowlist.
 * - The destructive class (§9.3) asks in every mode and is denied in unattended runs. It is detected on every segment
 *   of a compound command, and again on a quote-stripped copy, so `echo "$(rm -rf /)"` is still caught.
 * - The read-only allowlist with its flag rules (§9.2, SC-3: `rg --pre`, `git -c`, `--output`, `find -fprint` …).
 */
import type { CommandClassification } from '../types';
import { isSecretFileName } from './hard';

// ─── Lexer ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ShellToken =
  | { kind: 'word'; value: string; /** Contains an unquoted or double-quoted expansion, glob, brace or tilde. */ dynamic: boolean }
  | { kind: 'op'; value: string };

export interface LexResult {
  tokens: ShellToken[];
  /** Unterminated quote, control character … : the command is treated as compound. */
  error: string | null;
}

const OPERATORS = ['<<<', '<<-', '&&', '||', '|&', ';;', '>>', '<<', '<(', '>(', '>&', '<&', '&>', '>|', '$(', '${', ';', '&', '|', '>', '<', '(', ')', '`', '\n', '{', '}'];
const GLOB = /[*?[\]]/;
const MAX_COMMAND_CHARS = 65_536;

/** Tokenises a shell command into words and operators. Never throws. */
export function lexShell(input: string): LexResult {
  const tokens: ShellToken[] = [];
  if (input.length > MAX_COMMAND_CHARS) return { tokens, error: 'too long' };
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x08\x0b-\x1f\x7f]/.test(input)) return { tokens, error: 'control character' };
  let i = 0;
  let word = '';
  let inWord = false;
  let dynamic = false;
  let error: string | null = null;
  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', value: word, dynamic });
    word = '';
    inWord = false;
    dynamic = false;
  };
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t') {
      flush();
      i += 1;
      continue;
    }
    if (c === '\\') {
      if (input[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      if (i + 1 < input.length) {
        word += input[i + 1];
        inWord = true;
        i += 2;
        continue;
      }
      error = 'trailing backslash';
      i += 1;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) {
        error = 'unterminated quote';
        word += input.slice(i + 1);
        inWord = true;
        break;
      }
      word += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < input.length) {
        const d = input[j] as string;
        if (d === '\\' && j + 1 < input.length && '"\\$`\n'.includes(input[j + 1] ?? 'x')) {
          word += input[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '$' || d === '`') {
          // Substitution or expansion inside double quotes: dynamic, and `$(`/backticks are commands of their own.
          dynamic = true;
          if (d === '`' || input[j + 1] === '(') tokens.push({ kind: 'op', value: d === '`' ? '`' : '$(' });
        }
        word += d;
        j += 1;
      }
      if (!closed) error = 'unterminated quote';
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      flush();
      tokens.push({ kind: 'op', value: '#' });
      break; // the rest is a comment
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    // `{` and `}` are operators only at a word start (brace groups); inside a word they mark brace expansion.
    if (op && !((op === '{' || op === '}') && inWord)) {
      flush();
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    if (c === '$') dynamic = true;
    if (GLOB.test(c) || c === '{' || c === '}') dynamic = true;
    if (c === '~' && !inWord) dynamic = true;
    word += c;
    inWord = true;
    i += 1;
  }
  flush();
  return { tokens, error };
}

/** Splits tokens at operators into word lists (segments). */
function segmentsOf(tokens: ShellToken[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'op') {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(t.value);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Segments with the operator that follows each (for pipelines and redirections). */
function segmentsWithOps(tokens: ShellToken[]): Array<{ words: string[]; next: string | null }> {
  const out: Array<{ words: string[]; next: string | null }> = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'op') {
      out.push({ words: cur, next: t.value });
      cur = [];
    } else cur.push(t.value);
  }
  out.push({ words: cur, next: null });
  return out;
}

// ─── Destructive class (§9.3) ─────────────────────────────────────────────────────────────────────────────────

/** Wrappers stripped before looking at the real command (`sudo rm -rf /`). */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'env', 'xargs', 'busybox', 'stdbuf', 'timeout', 'setsid', 'unbuffer']);
const SHELLS = /^(?:.*\/)?(?:ba|z|da|k|fi|c|tc|mk)?sh$|^(?:.*\/)?(?:python[0-9.]*|perl|ruby|node|bun|deno|php)$/;
const DEVICE = /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|md|dm-|mapper\/)/;

function baseName(word: string): string {
  const i = word.lastIndexOf('/');
  return i >= 0 ? word.slice(i + 1) : word;
}

/** Drops leading wrappers, their options and `NAME=value` assignments. */
export function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    const b = baseName(w);
    if (WRAPPERS.has(b)) {
      i += 1;
      // Options of the wrapper (and `timeout 10`, `nice -n 5`): skip flags and short numeric values.
      while (i < words.length && /^-|^[0-9.]+[smhd]?$|^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i += 1;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function shortFlags(words: string[]): string {
  return words
    .filter((w) => /^-[A-Za-z]/.test(w) && !w.startsWith('--'))
    .map((w) => w.slice(1))
    .join('');
}

function isDangerousRmTarget(t: string): boolean {
  const v = t.replace(/\/+$/, '') || '/';
  if (['/', '/*', '~', '~/*', '$HOME', '${HOME}', '$HOME/*', '..', '../*', '../..', '*', '.', './*', '/.', '.*'].includes(v)) return true;
  if (v.startsWith('~') || v.startsWith('$HOME') || v.startsWith('${HOME}')) return v.split('/').filter(Boolean).length <= 2;
  if (v.startsWith('/')) return v.split('/').filter(Boolean).length <= 2; // /usr, /home/me, /etc/x …
  if (/^(\.\.\/)+\.\.?$|^(\.\.\/)+\*?$/.test(v)) return true;
  return false;
}

function destructiveSegment(raw: string[]): boolean {
  const words = unwrap(raw);
  if (words.length === 0) return false;
  const cmd = baseName(words[0] ?? '');
  const rest = words.slice(1);
  const flags = shortFlags(rest);
  const longs = rest.filter((w) => w.startsWith('--'));
  const positionals = rest.filter((w) => !w.startsWith('-'));
  switch (cmd) {
    case 'rm': {
      const recursive = /[rR]/.test(flags) || longs.includes('--recursive');
      if (longs.includes('--no-preserve-root')) return true;
      return recursive && positionals.some(isDangerousRmTarget);
    }
    case 'git': {
      let i = 0;
      while (i < rest.length && (rest[i] ?? '').startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(rest[i] ?? '') ? 2 : 1;
      const sub = rest[i];
      const args = rest.slice(i + 1);
      const sflags = shortFlags(args);
      if (sub === 'push') {
        return (
          /f/.test(sflags) ||
          args.some((a) => /^--(force|force-with-lease|force-if-includes|mirror|delete|prune)(=|$)/.test(a)) ||
          /d/.test(sflags) ||
          args.some((a) => !a.startsWith('-') && (a.startsWith('+') || a.startsWith(':') || a.includes(':+')))
        );
      }
      if (sub === 'reset') {
        if (!args.includes('--hard') && !args.includes('--merge') && !args.includes('--keep')) return false;
        const targets = args.filter((a) => !a.startsWith('-') && a !== '--');
        return targets.some((t) => !/^(HEAD|@)([~^][0-9]*)*$/.test(t));
      }
      // Ignored files are not checkpointed (§7.7), so a forced clean that includes them cannot be undone.
      if (sub === 'clean') return (/f/.test(sflags) || args.includes('--force')) && /[xX]/.test(sflags);
      return false;
    }
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const recursive = /R/.test(flags) || longs.includes('--recursive');
      return recursive && positionals.some((p) => p.startsWith('/') || p.startsWith('~') || p.startsWith('$HOME') || p === '..' || p.startsWith('../'));
    }
    case 'dd':
      return true;
    case 'wipefs':
    case 'mke2fs':
    case 'fdisk':
    case 'sfdisk':
    case 'parted':
      return true;
    case 'kill':
    case 'pkill':
    case 'killall':
      return rest.includes('-1') || (cmd === 'killall' && rest.length > 0 && positionals.length === 0) || (rest.includes('--') && rest[rest.indexOf('--') + 1] === '-1');
    default:
      if (/^mkfs(\..+)?$/.test(cmd)) return true;
      if (rest.some((a) => /^of=/.test(a) && DEVICE.test(a.slice(3)))) return true;
      return false;
  }
}

const RAW_DESTRUCTIVE: RegExp[] = [
  /:\s*\(\s*\)\s*\{/, // fork bomb :(){ :|:& };:
  /\b([A-Za-z_]\w*)\s*\(\s*\)\s*\{[^}]*\b\1\s*\|\s*\1\b/, // named fork bomb
  /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:ba|z|da|k)?sh\b/,
  /\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*<\(\s*(?:curl|wget)\b/,
  /\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/,
  />\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk)/,
];

function destructiveTokens(tokens: ShellToken[]): boolean {
  const segs = segmentsWithOps(tokens);
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i] as { words: string[]; next: string | null };
    if (destructiveSegment(s.words)) return true;
    // curl … | sh
    const head = unwrap(s.words);
    if ((s.next === '|' || s.next === '|&') && head.length && /^(?:curl|wget|fetch)$/.test(baseName(head[0] ?? ''))) {
      const nxt = unwrap(segs[i + 1]?.words ?? []);
      if (nxt.length && SHELLS.test(nxt[0] ?? '')) return true;
    }
    // > /dev/sda
    if ((s.next === '>' || s.next === '>>' || s.next === '>|' || s.next === '&>') && DEVICE.test(segs[i + 1]?.words[0] ?? '')) return true;
  }
  return false;
}

/** The destructive class of §9.3, on every segment (compound commands included). */
export function isDestructive(command: string): boolean {
  if (RAW_DESTRUCTIVE.some((re) => re.test(command))) return true;
  if (destructiveTokens(lexShell(command).tokens)) return true;
  // Quote-stripped pass: substitutions inside quotes (`echo "$(rm -rf /)"`) become visible segments. A false positive
  // only asks.
  return destructiveTokens(lexShell(command.replace(/["']/g, ' ')).tokens);
}

// ─── Read-only allowlist and flag rules (§9.2) ───────────────────────────────────────────────────────────────

const GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame']);
/** Git global options allowed before the subcommand (anything else, notably `-c`, `--config-env`, `--exec-path`, `-p`, `-C`, `--git-dir`, is refused). */
const GIT_SAFE_GLOBALS = new Set(['--no-pager', '--no-optional-locks', '-P', '--literal-pathspecs', '--no-replace-objects']);
const GIT_BAD_ARGS = /^(?:--output(?:=.*)?|-o|--ext-diff|--textconv|--exec-path(?:=.*)?|--config-env(?:=.*)?|--paginate|--open-files-in-pager(?:=.*)?|-O.*|--upload-pack(?:=.*)?|--receive-pack(?:=.*)?|--exec(?:=.*)?|--run(?:=.*)?|--contents(?:=.*)?|-S.*|--show-signature)$/;
const GIT_BRANCH_LIST_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--show-current', '--no-color', '--color=never', '--no-column', '--sort', '--points-at']);
/** rg options that run programs or read compressed input through external tools (SC-3). */
const RG_BAD = /^(?:--pre(?:=.*)?|--pre-glob(?:=.*)?|--search-zip|--hostname-bin(?:=.*)?)$/;
const FIND_BAD = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    if (!GIT_SAFE_GLOBALS.has(args[i] ?? '')) return false;
    i += 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'branch') {
    for (let j = 0; j < rest.length; j += 1) {
      const a = rest[j] as string;
      if (a.startsWith('--sort=') || a.startsWith('--contains=') || a.startsWith('--merged=') || a.startsWith('--no-merged=') || a.startsWith('--points-at=')) continue;
      if (!GIT_BRANCH_LIST_FLAGS.has(a)) return false;
      // Options that take a commit argument: the next word is a value, not a branch name.
      if (['--contains', '--no-contains', '--merged', '--no-merged', '--sort', '--points-at'].includes(a)) {
        const v = rest[j + 1];
        if (v === undefined || v.startsWith('-')) continue;
        j += 1;
      }
    }
    return true;
  }
  if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
  for (const a of rest) {
    if (a === '--') break;
    if (GIT_BAD_ARGS.test(a)) return false;
  }
  return true;
}

function rgReadOnly(args: string[]): boolean {
  for (const a of args) {
    if (a === '--') break;
    if (RG_BAD.test(a)) return false;
    if (/^-[A-Za-z]+$/.test(a) && a.includes('z')) return false; // -z / combined short flags with z
  }
  return true;
}

/**
 * True when an argv word names a secret file by its last path component (`cat a/b/.env`, `--file=x/id_rsa`), case-
 * insensitively. Such a command never runs read-only without asking (review H2: the masks are best effort).
 */
export function mentionsSecretFile(argv: readonly string[]): boolean {
  for (const word of argv) {
    for (const part of word.split('=')) {
      const base = part.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      if (base && isSecretFileName(base)) return true;
    }
  }
  return false;
}

/** True when the argv is on the read-only allowlist with every flag rule satisfied (§9.2). */
export function readOnlyAllowed(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const [cmd = '', ...args] = argv;
  if (cmd.includes('/')) return false; // only PATH lookups of the plain names
  if (mentionsSecretFile(args)) return false;
  switch (cmd) {
    case 'git':
      return gitReadOnly(args);
    case 'ls':
    case 'pwd':
    case 'cat':
    case 'head':
    case 'wc':
    case 'which':
    case 'grep':
      return true;
    case 'tail':
      return !args.some((a) => a === '-f' || a === '-F' || a.startsWith('--follow') || a === '--retry' || (/^-[A-Za-z]+$/.test(a) && /[fF]/.test(a)));
    case 'node':
      return args.length === 1 && (args[0] === '-v' || args[0] === '--version');
    case 'python3':
      return args.length === 1 && (args[0] === '-V' || args[0] === '--version');
    case 'npm':
      return args[0] === 'ls' && args.slice(1).every((a) => a.startsWith('-') ? /^--(?:all|depth=\d+|json|long|parseable|production|omit=\w+|no-color)$|^-a$|^-l$/.test(a) : true);
    case 'rg':
      return rgReadOnly(args);
    case 'find':
      return !args.some((a) => FIND_BAD.has(a));
    case 'tree':
      return !args.some((a) => a === '-o' || a.startsWith('--output') || (/^-[A-Za-z]+$/.test(a) && a.includes('o')));
    default:
      return false;
  }
}

// ─── Classification ──────────────────────────────────────────────────────────────────────────────────────────

/** Commands that make even a single plain argv compound (§9.3). */
const COMPOUND_COMMANDS = new Set(['eval', 'sudo', 'doas', 'su', 'exec', 'source', '.', 'xargs', 'env', 'command', 'builtin', 'trap', 'alias', 'nohup', 'setsid', 'time', 'timeout', 'watch']);
/** Commands whose second word names the action (`npm run build`, `cargo test`). */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'deno', 'uv', 'poetry', 'pipenv', 'hatch', 'make', 'just', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', './gradlew', 'git', 'docker', 'kubectl', 'python', 'python3', 'pip', 'pip3', 'node', 'composer', 'mix', 'rake', 'bundle', 'swift', 'zig', 'gh']);
const RUN_SUBCOMMANDS = new Set(['run', 'exec', 'x', 'dlx', 'test', '-m']);

/**
 * "Always allow" suggestion: a command prefix (`npm test`, `npm run build`, `pytest -q`), never `*` (§9.3). Null for
 * compound and destructive commands.
 */
export function suggestPattern(argv: string[]): string | null {
  if (argv.length === 0) return null;
  const words = argv.map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : null));
  const w0 = words[0];
  if (!w0) return null;
  const take: string[] = [w0];
  const first = baseName(argv[0] ?? '');
  const second = words[1];
  if (second && !second.includes('/') && second.length <= 64) {
    if (RUNNERS.has(first) || RUNNERS.has(argv[0] ?? '') || /^-[A-Za-z]$/.test(second)) {
      take.push(second);
      const third = words[2];
      if (third && RUN_SUBCOMMANDS.has(second) && !third.startsWith('-') && !third.includes('/') && third.length <= 64) take.push(third);
    }
  }
  return take.join(' ');
}

/** Lexes `pattern` (a command prefix) into words; null if it is not a plain argv. */
export function patternArgv(pattern: string): string[] | null {
  const { tokens, error } = lexShell(pattern);
  if (error || tokens.length === 0 || tokens.some((t) => t.kind === 'op' || t.dynamic)) return null;
  return tokens.map((t) => t.value);
}

/** Word-wise prefix match: `npm test` matches `npm test -- --watch`, not `npm testx` or `npm`. */
export function prefixMatches(prefix: string[], argv: string[]): boolean {
  if (prefix.length === 0 || prefix.length > argv.length) return false;
  return prefix.every((w, i) => argv[i] === w);
}

/** The argvs of every segment of a command (compound ones included), for deny rules. */
export function commandSegments(command: string): string[][] {
  const lexed = lexShell(command);
  const stripped = lexShell(command.replace(/["']/g, ' '));
  return [...segmentsOf(lexed.tokens), ...segmentsOf(stripped.tokens)].map(unwrap).filter((s) => s.length > 0);
}

export function classifyCommand(command: string): CommandClassification {
  const { tokens, error } = lexShell(command);
  const destructive = isDestructive(command);
  const words = tokens.filter((t): t is Extract<ShellToken, { kind: 'word' }> => t.kind === 'word');
  const compound =
    error !== null ||
    words.length === 0 ||
    tokens.some((t) => t.kind === 'op') ||
    words.some((w) => w.dynamic) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]?.value ?? '') ||
    COMPOUND_COMMANDS.has(baseName(words[0]?.value ?? ''));
  const argv = compound ? null : words.map((w) => w.value);
  return {
    argv,
    compound,
    destructive,
    readOnly: argv !== null && !destructive && readOnlyAllowed(argv),
    suggestedPattern: argv !== null && !destructive ? suggestPattern(argv) : null,
  };
}
