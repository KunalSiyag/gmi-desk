import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Boxes, Gauge, KeyRound, Lock, LogIn, MessageSquare, Plug, Sparkles, type LucideIcon } from 'lucide-react';
import { APP_NAME } from '@shared/app';
import type { AuthState } from '@shared/contracts/auth';
import { Dino, type DinoMood } from '@renderer/components/brand/Dino';
import { GmiLogo } from '@renderer/components/brand/GmiLogo';
import { Plates } from '@renderer/components/brand/Plates';
import { chatAccess } from '@renderer/components/connect/access';
import { DINO_GLOW, EnterKbd, Fade, StepMarker } from '@renderer/components/connect/parts';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Kbd, MicroLabel, microLabel } from '@renderer/components/ui/misc';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';

const FEATURES: Array<{ icon: LucideIcon; label: string; title: string; body: string }> = [
  { icon: Boxes, label: 'Models', title: 'Live model catalog', body: 'Every GMI model, priced with your discount.' },
  { icon: MessageSquare, label: 'Chat', title: 'Chat + GMI Router', body: 'Stream any model, or let Auto pick one.' },
  { icon: Sparkles, label: 'Create', title: 'Images, video & audio', body: 'See the cost, approve, then generate.' },
  { icon: Gauge, label: 'Usage', title: 'Usage & budgets', body: 'Balance, spend and local spending limits.' },
];

/** Same size as the boot splash's Dino (styles/dino.css .gmi-boot-dino), so the hand-over is one Dino, not two. */
const HERO_DINO = 116;

/**
 * GMI's grid floor behind the hero: the boot splash's grid (40 px cells, centred in the window, so the hand-over
 * lines up to the pixel), faded out around the top half.
 */
const GRID_FLOOR = 'grid-floor [--grid-cell:40px] [--grid-fade:radial-gradient(ellipse_46%_44%_at_50%_34%,#000_20%,transparent_100%)]';

export default function WelcomePage() {
  const auth = useAuth();
  const client = useQueryClient();
  const navigate = useUi((s) => s.navigate);
  const dismiss = useUi((s) => s.dismissWelcome);
  const openConnect = useUi((s) => s.openConnect);
  const connectOpen = useUi((s) => s.connectOpen);
  // `welcome?step=connect` shows the after-sign-in offer directly (screenshots).
  const stepParam = useUi((s) => s.params.step);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  /** Signed in just now and chat still needs a key: offer the Connect chat step before entering the app. */
  const [offerConnect, setOfferConnect] = useState(stepParam === 'connect');
  const dinoRef = useRef<HTMLSpanElement>(null);
  const intro = useBootHandoff(dinoRef);

  const state = auth.data;
  /** The browser sign-in is open (started here or anywhere else in the app). */
  const browserOpen = state?.status === 'signing_in' || state?.signInInProgress === true;
  const waiting = starting || browserOpen;
  // Mock mode is always "signed in"; keep the first-run screen meaningful there (sign-in is simulated).
  const alreadySignedIn = state?.status === 'signed_in' && !state.signInInProgress && !state.mock;
  const chatReady = chatAccess(state) === 'ready';
  const showOffer = (offerConnect || alreadySignedIn) && state?.status === 'signed_in' && !chatReady && !waiting;
  // Dino works while the browser is open and hops once when the sign-in lands.
  const mood: DinoMood = waiting ? 'loading' : showOffer || alreadySignedIn ? 'happy' : 'idle';

  const enterApp = useCallback(
    (page: 'models' | 'chat' = 'models') => {
      dismiss();
      navigate(page);
    },
    [dismiss, navigate],
  );

  /** Signed in: straight into the app when chat already works, otherwise offer to connect it first. */
  const afterSignIn = useCallback(
    (next: AuthState) => {
      if (chatAccess(next) === 'ready') enterApp('models');
      else setOfferConnect(true);
    },
    [enterApp],
  );

  const signIn = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const next: AuthState = await gmi.auth.signIn();
      client.setQueryData(qk.auth, next);
      if (next.status === 'signed_in') afterSignIn(next);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }, [client, afterSignIn]);

  const cancel = useCallback(() => {
    void gmi.auth
      .cancelSignIn()
      .then((next) => client.setQueryData(qk.auth, next))
      .catch(() => undefined);
  }, [client]);

  // A sign-in started elsewhere (command palette) that finishes while this screen shows: continue too.
  const sawBrowserOpen = useRef(false);
  useEffect(() => {
    if (browserOpen) {
      sawBrowserOpen.current = true;
      return;
    }
    const finished = sawBrowserOpen.current && state?.status === 'signed_in';
    sawBrowserOpen.current = false;
    if (finished && !starting && state) afterSignIn(state);
  }, [browserOpen, state, starting, afterSignIn]);

  // Chat works now (connected from the offer, or GMI turned out to accept the sign-in): straight to a chat once
  // the dialog has closed.
  useEffect(() => {
    if (offerConnect && chatReady && !connectOpen && state?.status === 'signed_in') enterApp('chat');
  }, [offerConnect, chatReady, connectOpen, state?.status, enterApp]);

  // Keyboard first: Enter signs in (or continues), Esc cancels a pending sign-in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('button, a'))) return;
      if (event.key === 'Enter' && !waiting) {
        event.preventDefault();
        if (showOffer) openConnect();
        else if (alreadySignedIn) enterApp('models');
        else void signIn();
      } else if (event.key === 'Escape' && waiting) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [waiting, alreadySignedIn, showOffer, openConnect, signIn, cancel, enterApp]);

  /** Props for the rest of the page during the boot hand-over (see reveal()). */
  const rv = (step: number, className?: string, rise = true) => {
    const r = reveal(intro.phase, step, rise);
    return { className: cn(className, r.className), style: r.style };
  };

  const dinoStyle: CSSProperties | undefined =
    intro.phase === 'hold' && intro.offset
      ? { transform: `translate(${intro.offset.x}px, ${intro.offset.y}px)` }
      : intro.phase === 'play'
        ? { transform: 'translate(0px, 0px)', transition: 'transform 600ms var(--ease-in-out) 90ms' }
        : undefined;

  return (
    <div className="relative flex h-full flex-col overflow-y-auto overflow-x-hidden bg-background">
      <div aria-hidden className={cn('pointer-events-none absolute inset-0', GRID_FLOOR)} />

      {/* GMI Cloud's logo + the product word, top left (the sidebar's header is hidden on Welcome). */}
      <div {...rv(6, 'absolute left-5 top-5 z-10 flex items-center gap-2', false)}>
        <GmiLogo className="h-[15px] w-auto text-foreground" label="GMI" />
        <span className="text-sm font-semibold tracking-tight text-primary-ink">{APP_NAME.split(' ').slice(1).join(' ')}</span>
      </div>

      {state?.mock ? (
        <MicroLabel dot title="Demo mode: sample data, nothing is sent to GMI" {...rv(6, 'absolute right-4 top-4 z-10 rounded border border-border bg-card px-2 py-1 leading-none', false)}>
          Demo data
        </MicroLabel>
      ) : null}

      {/* A plain div: App already wraps every page in the one <main> landmark. */}
      <div className="relative m-auto flex w-full max-w-[48rem] flex-col items-center px-6 pb-8 pt-10">
        <span ref={dinoRef} className="relative flex" style={dinoStyle}>
          {/* A soft brand light behind Dino (the boot splash has the same one), travelling with him. */}
          <span aria-hidden className={cn('pointer-events-none absolute left-1/2 top-1/2 size-[30rem] -translate-x-1/2 -translate-y-1/2', DINO_GLOW)} />
          <Dino mood={mood} size={HERO_DINO} className="relative" />
        </span>

        <div {...rv(0, 'mt-6')}>
          <MicroLabel dot>Welcome to {APP_NAME}</MicroLabel>
        </div>
        <h1 {...rv(1, 'mt-3 text-center text-[30px] font-semibold leading-[1.15] tracking-[-0.025em]')}>GMI Cloud, on your desktop</h1>
        <p {...rv(2, 'mt-2.5 max-w-[34rem] text-balance text-center text-[13.5px] leading-relaxed text-muted-foreground')}>
          Live models with your prices, chat, media generation and usage — in one window.
        </p>

        <div {...rv(3, 'mt-8 flex w-full max-w-[22rem] flex-col gap-2')}>
          {showOffer ? (
            <ConnectOffer onConnect={openConnect} onLater={() => enterApp('models')} />
          ) : alreadySignedIn ? (
            <Button size="lg" className="h-10 w-full text-sm" onClick={() => enterApp('models')}>
              Continue to {APP_NAME} <ArrowRight />
            </Button>
          ) : waiting ? (
            <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5">
              <Plates />
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-[13px] font-medium">Waiting for the browser…</p>
                <p className="truncate text-2xs text-muted-foreground">Approve access on gmicloud.ai.</p>
              </div>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel <Kbd className="ml-0.5">Esc</Kbd>
              </Button>
            </div>
          ) : (
            <Button size="lg" className="relative h-10 w-full text-sm" onClick={() => void signIn()}>
              <LogIn /> Sign in with GMI
              <EnterKbd className="absolute right-3" />
            </Button>
          )}

          {waiting ? (
            <button
              type="button"
              onClick={() => void gmi.auth.signIn().catch(() => undefined)}
              className="self-center rounded-sm text-2xs text-muted-foreground underline-offset-[3px] transition-colors duration-150 ease-out hover:text-foreground hover:underline"
            >
              Browser didn’t open? Open the sign-in page again
            </button>
          ) : alreadySignedIn || showOffer ? null : (
            <Button variant="ghost" className="group w-full" onClick={() => enterApp('models')}>
              Browse models first
              <ArrowRight className="transition-transform duration-150 ease-out group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0" />
            </Button>
          )}

          {error && !waiting ? <ErrorNotice error={error} compact className="mt-1" /> : null}
        </div>

        <ul aria-label="What’s inside" {...rv(4, 'mt-12 grid w-full grid-cols-4 overflow-hidden rounded-lg border border-border bg-card')}>
          {FEATURES.map(({ icon: Icon, label, title, body }, i) => (
            <li key={title} className={cn('flex min-w-0 flex-col gap-4 px-4 pb-4 pt-3.5', i > 0 && 'border-l border-border')}>
              <div className="flex items-center justify-between gap-2">
                <Icon aria-hidden className="size-4 shrink-0 text-primary-ink" strokeWidth={1.75} />
                <span aria-hidden className={cn(microLabel, 'truncate')}>
                  {label}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium leading-snug">{title}</p>
                <p className="mt-1 text-2xs leading-snug text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ul>

        <p {...rv(5, 'mt-5 max-w-[44rem] text-balance text-center text-2xs leading-relaxed text-muted-foreground')}>
          <KeyRound aria-hidden className="mr-1.5 inline size-3.5 -translate-y-px align-middle" />
          <span>
            {showOffer
              ? 'GMI’s sign-in doesn’t cover chat yet, so chat needs one API key from GMI Console. Once it does, GMI Desk switches over by itself.'
              : 'Chat also needs an API key from GMI Console. After you sign in, GMI Desk walks you through it (about 30 seconds).'}
          </span>
        </p>
      </div>

      <footer {...rv(6, 'relative flex items-center justify-center gap-1.5 px-6 pb-5 text-3xs text-muted-foreground', false)}>
        <Lock aria-hidden className="size-3 shrink-0" />
        Sign-in opens gmicloud.ai in your browser. {APP_NAME} never sees your password.
      </footer>
    </div>
  );
}

/** After sign-in: chat is one step away. Calm, one primary action, an easy "Later". */
function ConnectOffer({ onConnect, onLater }: { onConnect: () => void; onLater: () => void }) {
  return (
    <Fade className="flex flex-col gap-2">
      <div role="status" className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
        <StepMarker n={1} status="done" />
        <p className="min-w-0 flex-1 text-left text-[13px] font-medium">Signed in to GMI</p>
        <span className={cn(microLabel, 'shrink-0')}>Step 1 of 2</span>
      </div>
      <Button size="lg" className="relative h-10 w-full text-sm" onClick={onConnect}>
        <Plug /> Connect chat <span className="font-normal text-primary-foreground/70">· about 30 seconds</span>
        <EnterKbd className="absolute right-3" />
      </Button>
      <Button variant="ghost" className="group w-full" onClick={onLater}>
        Later
        <ArrowRight className="transition-transform duration-150 ease-out group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0" />
      </Button>
    </Fade>
  );
}

// ── Boot splash → Welcome ──────────────────────────────────────────────────────────────────────────────────────
//
// On first run Welcome mounts while the boot splash (index.html, lib/boot-splash.ts) still covers the window. Then
// Welcome's Dino starts exactly where the splash's Dino is (same size), and once the splash fades out he glides up
// to his place (on-screen movement: ease-in-out) while the rest rises in, staggered. One Dino throughout, never two.
// Without a splash (Welcome opened later) or with reduced motion, everything is simply there.

type IntroPhase = 'none' | 'hold' | 'play';

function bootSplash(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('gmi-boot');
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Where an element sits by layout (offsets, so the splash's own entrance transform does not skew it). */
function layoutCentre(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  const base = root.getBoundingClientRect();
  return { x: base.left + x + el.offsetWidth / 2, y: base.top + y + el.offsetHeight / 2 };
}

function useBootHandoff(dinoRef: RefObject<HTMLElement | null>): { phase: IntroPhase; offset: { x: number; y: number } | null } {
  const [phase, setPhase] = useState<IntroPhase>(() => (bootSplash() && !prefersReducedMotion() ? 'hold' : 'none'));
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const measured = useRef(false);

  // Before the first paint: put Dino where the splash's Dino is.
  useLayoutEffect(() => {
    if (phase !== 'hold' || measured.current) return;
    measured.current = true;
    const splash = bootSplash();
    const from = splash?.querySelector<HTMLElement>('.gmi-boot-dino');
    const to = dinoRef.current;
    if (!splash || !from || !to) {
      setPhase('none');
      return;
    }
    const a = layoutCentre(from, splash);
    const b = to.getBoundingClientRect();
    setOffset({ x: Math.round(a.x - (b.left + b.width / 2)), y: Math.round(a.y - (b.top + b.height / 2)) });
  }, [phase, dinoRef]);

  // When the splash starts fading out (data-done), let go. Two frames, so the held position is styled first.
  useEffect(() => {
    if (phase !== 'hold') return;
    const splash = bootSplash();
    let frame = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setPhase('play'));
      });
    };
    if (!splash || splash.hasAttribute('data-done')) {
      release();
      return () => cancelAnimationFrame(frame);
    }
    const observer = new MutationObserver(() => {
      if (splash.hasAttribute('data-done') || !splash.isConnected) release();
    });
    observer.observe(splash, { attributes: true, attributeFilter: ['data-done'] });
    // Safety net: never keep the page hidden if the splash goes away some other way.
    const fallback = window.setTimeout(release, 2500);
    return () => {
      observer.disconnect();
      window.clearTimeout(fallback);
      cancelAnimationFrame(frame);
    };
  }, [phase]);

  return { phase, offset };
}

/**
 * The rest of the page during the hand-over: hidden while held, then rising 8 px into place one after another (or
 * only fading, for edge-pinned things whose rise would overflow the page and flash a scrollbar).
 */
function reveal(phase: IntroPhase, step: number, rise = true): { className?: string; style?: CSSProperties } {
  if (phase === 'none') return {};
  if (phase === 'hold') return { className: rise ? 'opacity-0 translate-y-2' : 'opacity-0' };
  return {
    className: rise ? 'opacity-100 translate-y-0 transition-[opacity,translate] duration-500 ease-out' : 'opacity-100 transition-opacity duration-500 ease-out',
    style: { transitionDelay: `${260 + step * 50}ms` },
  };
}
