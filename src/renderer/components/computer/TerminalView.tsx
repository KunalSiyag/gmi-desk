// The Terminal tab (compute.md §8.2, §8.7): xterm.js + fit addon, themed from the page's tokens (re-themed whenever
// <html>'s theme class changes), flow control through TerminalController, links behind a confirmation, the title as
// plain text, and the terminal's banners (attached elsewhere, reconnecting, cold resume; banners.tsx).
//
// xterm is loaded on first use (its own chunk): the app starts without it, and markup tests never touch it.
import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import type { ComputerSessionInfo } from '@shared/contracts/compute';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Spinner } from '@renderer/components/ui/misc';
import { describeError } from '@renderer/lib/errors';
import { gmi, isMac, onGmiEvent } from '@renderer/lib/gmi';
import { isCancelled, toastActionError } from '@renderer/pages/compute/hooks';
import { TerminalBanners } from './banners';
import { checkLink, cleanTitle, findLinks, type LinkVerdict } from './links';
import { TerminalController } from './terminal-controller';
import { readTerminalTokens, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, terminalTheme } from './terminal-theme';

/** The dock toggle (⌘/Ctrl+J) passes through the terminal; see `terminalKeyRoute`. */
export const DOCK_TOGGLE_KEY = 'j';

/**
 * Where a key pressed inside the terminal goes:
 * - `app`: the app handles it and xterm ignores it (the dock toggle, Ctrl/⌘+1…9 page switches);
 * - `copy` / `paste`: Ctrl+Shift+C / Ctrl+Shift+V off macOS (⌘C / ⌘V work natively on macOS);
 * - `shell`: the shell gets it. Off macOS, Ctrl+letter combos are shell keys (Ctrl+K kills a line, Ctrl+B moves
 *   back, Ctrl+N is next history), so they stop here instead of reaching the app's global shortcuts.
 * - `default`: neither (plain typing, macOS ⌘ shortcuts): xterm and the app behave as usual.
 */
export function terminalKeyRoute(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  mac: boolean,
): 'app' | 'copy' | 'paste' | 'shell' | 'default' {
  const key = e.key.toLowerCase();
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey && (key === DOCK_TOGGLE_KEY || /^[1-9]$/.test(key))) return 'app';
  if (mac) return 'default';
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'c') return 'copy';
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'v') return 'paste';
  if (e.ctrlKey && !e.metaKey) return 'shell';
  return 'default';
}

/** Terminal states in which main accepts input (it queues it while (re)connecting). */
const TYPEABLE_TERMINAL_STATES: ReadonlySet<string> = new Set(['attached', 'connecting', 'reconnecting']);

/**
 * Whether typing can reach the shell: main refuses input while the sandbox is paused and when the shell is not
 * connected or open somewhere else, so the view does not take keystrokes it would only turn into errors.
 */
export function terminalCanType(session: Pick<ComputerSessionInfo, 'state' | 'terminal'>, blocked: boolean): boolean {
  if (blocked) return false;
  if (session.state !== 'ready' && session.state !== 'reconnecting' && session.state !== 'connecting') return false;
  return TYPEABLE_TERMINAL_STATES.has(session.terminal.state);
}

/** How long a view that main reports behind waits for a chunk before it attaches again for a replay. */
export const BEHIND_REATTACH_MS = 500;

/** `blocked`: the session is paused, closed or unreachable (SessionBanner says so; attach errors are expected then). */
export function TerminalView({ session, blocked = false }: { session: ComputerSessionInfo; blocked?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [title, setTitle] = useState('');
  const [link, setLink] = useState<LinkVerdict | null>(null);
  const [attachError, setAttachError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const sessionId = session.sessionId;
  const terminalState = session.terminal.state;
  const sessionState = session.state;
  const sessionLastSeq = session.terminal.lastSeq;
  const canType = terminalCanType(session, blocked);
  const canTypeRef = useRef(canType);
  canTypeRef.current = canType;
  const stdinRef = useRef<((enabled: boolean) => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    setLoaded(false);
    setLoadError(null);
    setAttachError(null);
    setTitle('');

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      // xterm measures the cell size once on open: wait for Geist Mono, or the grid is off until the next resize.
      await document.fonts?.load(`${TERMINAL_FONT_SIZE}px "Geist Mono Variable"`).catch(() => undefined);
      if (disposed) return;

      const { dark, tokens } = readTerminalTokens();
      const term = new Terminal({
        allowProposedApi: false,
        scrollback: 5000,
        convertEol: false,
        // windowOptions stay at xterm's defaults (all off): no XTWINOPS resizing, moving or reporting (T7).
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: 1.25,
        cursorBlink: true,
        cursorStyle: 'block',
        disableStdin: true,
        macOptionIsMeta: true,
        theme: terminalTheme(dark, tokens),
        // OSC 8 hyperlinks: the same confirmation as detected links; xterm only offers http(s) to it.
        linkHandler: { activate: (_event, text) => setLink(checkLink(text)), allowNonHttpProtocols: false },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      cleanups.push(() => term.dispose());

      const mac = isMac();
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const route = terminalKeyRoute(event, mac);
        if (route === 'app') return false;
        if (route === 'copy') {
          const text = term.getSelection();
          if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
          event.preventDefault();
          return false;
        }
        // The browser's paste event reaches xterm's textarea, which sends it (bracketed paste kept).
        if (route === 'paste') return false;
        return true;
      });
      const stopShellKeys = (event: KeyboardEvent) => {
        if (terminalKeyRoute(event, mac) === 'shell') event.stopPropagation();
      };
      host.addEventListener('keydown', stopShellKeys);
      cleanups.push(() => host.removeEventListener('keydown', stopShellKeys));

      const links = term.registerLinkProvider({
        provideLinks(y, callback) {
          const line = term.buffer.active.getLine(y - 1);
          if (!line) return callback(undefined);
          const found = findLinks(line.translateToString(true));
          callback(
            found.length
              ? found.map((f) => ({
                  range: { start: { x: f.start + 1, y }, end: { x: f.end, y } },
                  text: f.url,
                  activate: (_event: MouseEvent, text: string) => setLink(checkLink(text)),
                }))
              : undefined,
          );
        },
      });
      cleanups.push(() => links.dispose());
      const titles = term.onTitleChange((next) => setTitle(cleanTitle(next)));
      cleanups.push(() => titles.dispose());

      const fitNow = () => {
        try {
          fit.fit();
        } catch {
          // not laid out yet (hidden): the next resize fits
        }
      };
      fitNow();

      const controller = new TerminalController({
        sessionId,
        term,
        port: gmi.computer,
        onAttached: (attached) => {
          term.options.disableStdin = !(attached && canTypeRef.current);
          if (attached) setAttachError(null);
        },
        onError: (error, op) => {
          if (op === 'attach') setAttachError(error);
          else if (op === 'input' && !isCancelled(error)) {
            // One toast per session, replaced on repeats (a burst of keys never stacks toasts).
            const view = describeError(error);
            toast.error(`Could not send that to the terminal: ${view.title}`, { id: `terminal-input-${sessionId}`, description: view.message || undefined });
          }
        },
      });
      controller.setInputAllowed(canTypeRef.current);
      stdinRef.current = (enabled) => {
        controller.setInputAllowed(enabled);
        term.options.disableStdin = !(controller.attached && enabled);
      };
      cleanups.push(() => {
        stdinRef.current = null;
      });
      controllerRef.current = controller;
      cleanups.push(() => {
        controller.dispose();
        if (controllerRef.current === controller) controllerRef.current = null;
      });
      const data = term.onData((d) => controller.input(d));
      cleanups.push(() => data.dispose());

      cleanups.push(onGmiEvent('computer:terminal', (chunk) => controller.onChunk(chunk)));

      let frame = 0;
      const observer = new ResizeObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          fitNow();
          controller.resize();
        });
      });
      observer.observe(host);
      cleanups.push(() => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      });

      const onVisibility = () => void controller.setVisible(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', onVisibility);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

      // Theme switches (settings, the OS) flip the `dark` class on <html>: re-read the tokens.
      const themeObserver = new MutationObserver(() => {
        const next = readTerminalTokens();
        term.options.theme = terminalTheme(next.dark, next.tokens);
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      cleanups.push(() => themeObserver.disconnect());

      setLoaded(true);
      void controller.start(document.visibilityState === 'visible');
      term.focus();
    })().catch((error: unknown) => {
      if (!disposed) setLoadError(error);
    });

    return () => {
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }, [sessionId]);

  // Input only while main accepts it (paused, attached elsewhere, not connected: the keys go nowhere).
  useEffect(() => {
    stdinRef.current?.(canType);
  }, [canType, loaded]);

  // The shell came (back) after the first attach failed (taken over, reconnected), or the session became usable
  // again after Reconnect (the attach refused while `unavailable` left the view without a shell): attach again.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || controller.attached || controller.attaching || blocked || document.visibilityState !== 'visible') return;
    if (terminalState === 'attached' || sessionState === 'ready' || sessionState === 'connecting') void controller.attach();
  }, [terminalState, sessionState, blocked, loaded]);

  // Main says this view missed output (a stale-ack gap while it was visible): wait briefly for a chunk, then replay.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !controller.isBehind(sessionLastSeq)) return undefined;
    const timer = setTimeout(() => {
      if (controllerRef.current === controller && controller.isBehind(sessionLastSeq)) void controller.attach();
    }, BEHIND_REATTACH_MS);
    return () => clearTimeout(timer);
  }, [sessionLastSeq, loaded]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TerminalBanners session={session} blocked={blocked} />
      {attachError && !blocked && terminalState !== 'attached_elsewhere' ? (
        <div className="shrink-0 border-b border-border p-2">
          <ErrorNotice error={attachError} compact onRetry={() => void controllerRef.current?.attach()} retryLabel="Reattach" />
        </div>
      ) : null}
      {loadError ? (
        <div className="shrink-0 p-2">
          <ErrorNotice error={loadError} compact />
        </div>
      ) : null}
      {title ? (
        <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border px-3 text-muted-foreground" title={title}>
          <SquareTerminal className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-mono text-3xs">{title}</span>
        </div>
      ) : null}
      {/* xterm's own scrollbar and padding live inside; the host only provides the page's background. */}
      <div className="relative min-h-0 flex-1 bg-background">
        <div ref={hostRef} data-terminal-host="" className="absolute inset-0 py-1.5 pl-2.5" />
        {!loaded && !loadError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        ) : null}
      </div>
      <LinkDialog verdict={link} onClose={() => setLink(null)} />
    </div>
  );
}

/** "Open this link?" with the whole URL (T7): https only, through main's openExternal. */
export function LinkDialog({ verdict, onClose }: { verdict: LinkVerdict | null; onClose: () => void }) {
  const open = async () => {
    if (!verdict?.ok) return;
    try {
      await gmi.app.openExternal(verdict.url);
      onClose();
    } catch (error) {
      toastActionError('Could not open the link', error);
    }
  };
  const copy = async () => {
    if (!verdict) return;
    try {
      await navigator.clipboard.writeText(verdict.url);
      toast.success('Link copied');
      onClose();
    } catch (error) {
      toastActionError('Could not copy the link', error);
    }
  };
  return (
    <Dialog
      open={verdict !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={verdict?.ok ? 'Open this link in your browser?' : 'This link is not opened'}
      description={
        verdict?.ok ? (
          <>
            It comes from the computer’s output. Check where it goes: <span className="font-medium text-foreground">{verdict.host}</span>
          </>
        ) : (
          verdict?.reason
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => void copy()}>
            <Copy /> Copy link
          </Button>
          {verdict?.ok ? (
            <Button onClick={() => void open()}>
              <ExternalLink /> Open
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </>
      }
    >
      {verdict ? (
        <p data-link-url="" className="rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-2xs leading-relaxed break-all text-foreground">
          {verdict.url}
        </p>
      ) : null}
    </Dialog>
  );
}
