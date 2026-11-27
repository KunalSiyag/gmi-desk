import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Object keys whose values are never logged (JWT-shaped values are redacted anywhere by `redact`). */
export const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|api[_-]?key|apikey|cookie|code_verifier|refresh|url_?path|connect_?url|access_token|traffic|private_?key|ssh_?key|env_?vars)/i;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Strips bearer tokens, JWTs and key-looking query params from free text. */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
    .replace(/([?&](?:api_key|apikey|key|token|access_token|code)=)[^&\s"']+/gi, '$1[redacted]');
}

/**
 * A copy of `value` that is safe to log or write to a trace file: secret-named keys → '[redacted]', bearer tokens,
 * JWTs and key-looking query params redacted in strings, arrays capped at 50 items, depth capped at 6.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), ...(value.cause ? { cause: sanitize(value.cause, depth + 1) } : {}) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : sanitize(v, depth + 1);
  }
  return out;
}

export function createLogger(opts: { file?: string | null; level?: LogLevel; scope?: string; console?: boolean } = {}): Logger {
  const minLevel = LEVELS[opts.level ?? 'info'];
  const file = opts.file ?? null;
  const toConsole = opts.console ?? true;
  let queue: Promise<void> = Promise.resolve();
  let dirReady = false;

  const writeLine = (line: string) => {
    if (!file) return;
    queue = queue
      .then(async () => {
        if (!dirReady) {
          await mkdir(dirname(file), { recursive: true });
          dirReady = true;
        }
        try {
          const s = await stat(file);
          if (s.size > MAX_LOG_BYTES) await rename(file, `${file}.1`);
        } catch {
          // file does not exist yet
        }
        await appendFile(file, `${line}\n`, 'utf8');
      })
      .catch(() => undefined);
  };

  const make = (scope: string | undefined): Logger => {
    const log = (level: LogLevel, message: string, meta?: unknown) => {
      if (LEVELS[level] < minLevel) return;
      const metaText = meta === undefined ? '' : ` ${JSON.stringify(sanitize(meta))}`;
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${redact(message)}${metaText}`;
      if (toConsole) {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(line);
      }
      writeLine(line);
    };
    return {
      debug: (m, meta) => log('debug', m, meta),
      info: (m, meta) => log('info', m, meta),
      warn: (m, meta) => log('warn', m, meta),
      error: (m, meta) => log('error', m, meta),
      child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope),
    };
  };

  return make(opts.scope);
}

/** Logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
