import type { Logger } from './logger';

export type Disposer = () => void | Promise<void>;

/**
 * Asked before the app quits (before any disposer runs), e.g. "2 containers are still billing: delete / keep / cancel"
 * (compute.md §9.7). 'cancel' keeps the app running. A check that throws counts as 'quit' (logged): a broken
 * check must never trap the user in the app.
 */
export type QuitCheck = () => Promise<'quit' | 'cancel'>;

const quitChecks: QuitCheck[] = [];

/** Registers a quit check (run in registration order, one at a time). Returns the function that removes it. */
export function registerQuitCheck(check: QuitCheck): () => void {
  quitChecks.push(check);
  return () => {
    const i = quitChecks.indexOf(check);
    if (i !== -1) quitChecks.splice(i, 1);
  };
}

/** The registered quit checks, in order (what src/main/index.ts passes as `checks`). */
export function registeredQuitChecks(): QuitCheck[] {
  return [...quitChecks];
}

/** Runs the checks one after another; 'cancel' as soon as one cancels. */
export async function runQuitChecks(checks: QuitCheck[], log?: Logger): Promise<'quit' | 'cancel'> {
  for (const check of checks) {
    try {
      if ((await check()) === 'cancel') return 'cancel';
    } catch (error) {
      log?.warn('quit check failed; quitting anyway', error);
    }
  }
  return 'quit';
}

export interface QuitGuardOptions {
  /** Read when a quit request arrives; run before the disposers. Any 'cancel' keeps the app running. */
  checks?: () => QuitCheck[];
  /** Read when the first quit request arrives (slices register theirs during startup). */
  disposers: () => Disposer[];
  /** Upper bound for the whole shutdown; a stuck disposer must not keep the app alive. */
  timeoutMs: number;
  /** Called once the disposers settled (or timed out): `app.quit()`. */
  quit: () => void;
  /**
   * Called when a check cancelled the quit. The quit may have come from closing the last window (Linux, Windows), so
   * the app must show a window again or it keeps running with no way back in.
   */
  onCancel?: () => void;
  log?: Logger;
}

/**
 * `before-quit` handler that lets every slice finish disposing (abort downloads and streams, flush stores)
 * before the process exits. The first quit request is held back with preventDefault(); the disposers run
 * concurrently (in reverse registration order) and the real quit follows once they settle or `timeoutMs`
 * passes. Quit requests that arrive meanwhile are held back too; the final `quit()` passes straight through.
 * When `checks` are given they run first (no timeout: they may wait for the user); a 'cancel' ends the attempt and
 * the app keeps running (`onCancel`), so a later quit request asks again. A second quit request while the checks are
 * still running (Ctrl+Q again, SIGTERM at logout, a check that hangs) quits anyway: a check can never trap the user.
 */
export function createQuitGuard(opts: QuitGuardOptions): (event: { preventDefault(): void }) => void {
  let phase: 'running' | 'checking' | 'disposing' | 'done' = 'running';
  const dispose = () => {
    phase = 'disposing';
    void runDisposers(opts.disposers(), opts.timeoutMs, opts.log).finally(() => {
      phase = 'done';
      opts.quit();
    });
  };
  return (event) => {
    if (phase === 'done') return;
    event.preventDefault();
    if (phase === 'checking') {
      opts.log?.warn('quit requested again while the quit checks were running; quitting anyway');
      dispose();
      return;
    }
    if (phase !== 'running') return;
    const checks = opts.checks?.() ?? [];
    if (checks.length === 0) {
      dispose();
      return;
    }
    phase = 'checking';
    void runQuitChecks(checks, opts.log).then((outcome) => {
      // A second request may have started disposing meanwhile: the late answer changes nothing.
      if (phase !== 'checking') return;
      if (outcome === 'quit') {
        dispose();
        return;
      }
      phase = 'running';
      try {
        opts.onCancel?.();
      } catch (error) {
        opts.log?.warn('onCancel failed', error);
      }
    });
  };
}

/** Runs the disposers concurrently; resolves when all settled or after `timeoutMs`, whichever comes first. */
export async function runDisposers(disposers: Disposer[], timeoutMs: number, log?: Logger): Promise<void> {
  const all = Promise.allSettled([...disposers].reverse().map((dispose) => Promise.resolve().then(dispose))).then((results) => {
    for (const r of results) if (r.status === 'rejected') log?.warn('dispose failed', r.reason);
    return 'settled' as const;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([all, timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout') log?.warn(`shutdown: disposers still running after ${timeoutMs} ms; quitting anyway`);
}
