/**
 * Connect chat: the one place the app asks for an inference key, as a calm three-step flow.
 *
 * 1. Signed in to GMI (done, or an optional sign-in button). 2. Create a key in GMI Console (opens the API keys page).
 * 3. Come back here: while this dialog is open the main process watches the clipboard (AuthApi.startKeyDetection)
 * and reports only the last 4 characters of a key-shaped value; nothing is sent to GMI until "Use this key".
 * Then a short success moment and the dialog closes itself. "Paste it instead" keeps the manual path.
 * When GMI accepts the sign-in for chat (AuthState.inference.via === 'oauth'), it just says so: no key needed.
 *
 * Mounted once in App; opened with useUi().openConnect() (or `connect=1` in navigation params). While
 * `useUi().connectTarget === 'compute'` it shows Connect Compute instead (ConnectComputeDialog, compute.md §4.1).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, ExternalLink, Eye, EyeOff, Info, KeyRound, LogIn, MessageSquare, RotateCw, ShieldCheck } from 'lucide-react';
import type { AuthState } from '@shared/contracts/auth';
import { formatRelativeTime } from '@shared/lib/format';
import { Dino } from '@renderer/components/brand/Dino';
import { Plates } from '@renderer/components/brand/Plates';
import { cn } from '@renderer/lib/cn';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { signInWithFeedback } from '@renderer/lib/sign-in';
import { useUi } from '@renderer/lib/store';
import { keyStorageNote } from '@renderer/pages/settings/copy';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { MicroLabel, Spinner } from '../ui/misc';
import { CONNECT_COPY, connectView, detectStage, foundKeyLabel, savedKeyNote, type ConnectView, type DetectStage } from './access';
import { ConnectComputeDialog } from './ConnectComputeDialog';
import { ClickPath, EnterKbd, Fade, GridGlow, ListeningDot, Step, SuccessMark, type StepStatus } from './parts';

/**
 * The success moment stays this long before the dialog closes itself: the check draws in ~0.5 s, then about two
 * seconds to read the line under it (it says the clipboard was cleared). A pointer over the view holds it open.
 */
export const CONNECT_SUCCESS_CLOSE_MS = 2_400;

/** Marks the element that should have focus when the dialog opens (the view's next action, never the close X). */
const AUTOFOCUS = { 'data-autofocus': '' } as const;

interface Success {
  last4: string | null;
  clipboardCleared: boolean;
  /** Close by itself after CONNECT_SUCCESS_CLOSE_MS (not for the mock preview). */
  autoClose: boolean;
}

/** The one Connect dialog App mounts: Connect chat, or Connect Compute for `openConnect('compute')`. */
export function ConnectChatDialog() {
  const target = useUi((s) => s.connectTarget);
  return target === 'compute' ? <ConnectComputeDialog /> : <ConnectInferenceDialog />;
}

function ConnectInferenceDialog() {
  const open = useUi((s) => s.connectOpen);
  const setOpen = useUi((s) => s.setConnectOpen);
  const auth = useAuth();
  const close = useCallback(() => setOpen(false), [setOpen]);
  // The body says what it shows (steps, success...) so the description matches. Base UI unmounts the body when
  // the dialog has closed, so every opening starts fresh.
  const [view, setView] = useState<BodyView | null>(null);
  // Forget it once the exit animation is over, so the next opening does not start with the last view's title.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setView(null), 250);
    return () => clearTimeout(timer);
  }, [open]);
  const shown = view ?? connectView(auth.data, false);
  // Focus the view's next action on open (Base UI would pick the first tabbable element: the close X, so the
  // keyboard path Enter → Connect chat → Enter would close the dialog again).
  const bodyRef = useRef<HTMLDivElement>(null);
  const initialFocus = useCallback(() => bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? true, []);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      // Anchored near the top instead of centred: the body changes height while open (found key, paste field,
      // success), and a centred dialog would jump at both edges. This way the title and X stay put and only the
      // bottom edge moves (like the command palette's top-[14vh]).
      className="top-[max(3rem,calc(50vh_-_15rem))] translate-y-0"
      initialFocus={initialFocus}
      // Success and "sign-in works" have their own centred heading: one visible heading per view.
      title={shown === 'success' || shown === 'oauth' ? <span className="sr-only">{CONNECT_COPY.title}</span> : CONNECT_COPY.title}
      description={dialogDescription(shown)}
    >
      <div ref={bodyRef}>
        <ConnectChatBody open={open} state={auth.data} onClose={close} onView={setView} />
      </div>
    </Dialog>
  );
}

type BodyView = ConnectView | 'success';

function dialogDescription(view: BodyView): string | undefined {
  if (view === 'steps') return CONNECT_COPY.description;
  if (view === 'connected') return 'Chat and GMI Router use this key.';
  return undefined;
}

export function ConnectChatBody({
  open,
  state,
  onClose,
  onView,
}: {
  open: boolean;
  state: AuthState | undefined;
  /** Must be stable (it also closes the dialog after the success moment). */
  onClose: () => void;
  onView?: (view: BodyView) => void;
}) {
  const client = useQueryClient();
  const navigate = useUi((s) => s.navigate);
  const page = useUi((s) => s.page);
  const [replacing, setReplacing] = useState(false);
  const [success, setSuccess] = useState<Success | null>(null);
  // A pointer over the success view holds it open (it may be on its way to "Start chatting").
  const [held, setHeld] = useState(false);
  // Mock mode only: `connect=success` previews the success moment (screenshots), whenever the sign-in state
  // arrives (it is still loading when this is the first page rendered).
  const previewSuccess = useUi((s) => s.params.connect === 'success');
  const mock = state?.mock === true;
  const mockLast4 = state?.inferenceKey.last4 ?? null;
  useEffect(() => {
    if (mock && previewSuccess) setSuccess((current) => current ?? { last4: mockLast4, clipboardCleared: true, autoClose: false });
  }, [mock, previewSuccess, mockLast4]);
  const [consoleOpened, setConsoleOpened] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [useError, setUseError] = useState<unknown>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  // The first paint happens inside the opening dialog (which animates); only later state changes crossfade.
  const painted = useRef(false);
  useEffect(() => {
    painted.current = true;
  }, []);
  const animate = painted.current;

  const view: BodyView = success ? 'success' : connectView(state, replacing);
  const stage = detectStage(state, verifying);
  const watching = open && view === 'steps';
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);

  // Watch the clipboard only while the steps are on screen (the main process also stops after 10 minutes).
  useEffect(() => {
    if (!watching) return;
    void gmi.auth.startKeyDetection().catch(() => undefined);
    return () => {
      void gmi.auth.stopKeyDetection().catch(() => undefined);
    };
  }, [watching]);

  const setAuth = (next: AuthState) => client.setQueryData(qk.auth, next);

  const finish = (result: Omit<Success, 'autoClose'>) => {
    setUseError(null);
    setSuccess({ ...result, autoClose: true });
  };

  const startChatting = () => {
    onClose();
    if (page !== 'chat') navigate('chat');
  };

  // Success: a moment to register it, then out of the way, unless the pointer is over it (the timer restarts
  // when it leaves).
  useEffect(() => {
    if (!success?.autoClose || held) return;
    const timer = setTimeout(onClose, CONNECT_SUCCESS_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [success, held, onClose]);

  const acceptKey = async () => {
    if (verifying) return;
    setVerifying(true);
    setUseError(null);
    try {
      const result = await gmi.auth.useDetectedKey();
      setAuth(result.state);
      finish({ last4: result.state.inferenceKey.last4, clipboardCleared: result.clipboardCleared });
    } catch (error) {
      setUseError(error);
    } finally {
      setVerifying(false);
    }
  };

  const notThisOne = () => {
    setUseError(null);
    void gmi.auth.dismissDetectedKey().then(setAuth, () => undefined);
  };

  // Enter accepts a found key wherever focus is in the dialog (except fields and other buttons).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || stage !== 'found' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, button, a')) return;
    event.preventDefault();
    void acceptKey();
  };

  if (!state) {
    return (
      <div role="status" className="flex h-32 items-center justify-center">
        <Plates />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  return (
    <div className="pb-3" onKeyDown={onKeyDown}>
      <Fade key={view} animate={animate}>
        {view === 'success' && success ? (
          <SuccessView success={success} storage={state.secureStorage} onStart={startChatting} onHold={setHeld} />
        ) : view === 'oauth' ? (
          <OAuthView onStart={startChatting} onUseKey={() => setReplacing(true)} />
        ) : view === 'connected' ? (
          <ConnectedView state={state} onDone={onClose} onReplace={() => setReplacing(true)} />
        ) : (
          <StepsView
            state={state}
            stage={stage}
            animate={animate}
            consoleOpened={consoleOpened}
            onOpenConsole={() => {
              setConsoleOpened(true);
              void gmi.app.openConsole('apiKeys').catch(() => undefined);
            }}
            onUseKey={() => void acceptKey()}
            onNotThisOne={notThisOne}
            onWatchAgain={() => void gmi.auth.startKeyDetection().then(setAuth, () => undefined)}
            useError={useError}
            pasteOpen={pasteOpen}
            onTogglePaste={() => setPasteOpen((v) => !v)}
            onPasted={(next) => {
              setAuth(next);
              finish({ last4: next.inferenceKey.last4, clipboardCleared: false });
            }}
          />
        )}
      </Fade>
    </div>
  );
}

function StepsView({
  state,
  stage,
  animate,
  consoleOpened,
  onOpenConsole,
  onUseKey,
  onNotThisOne,
  onWatchAgain,
  useError,
  pasteOpen,
  onTogglePaste,
  onPasted,
}: {
  state: AuthState;
  stage: DetectStage;
  animate: boolean;
  consoleOpened: boolean;
  onOpenConsole: () => void;
  onUseKey: () => void;
  onNotThisOne: () => void;
  onWatchAgain: () => void;
  useError: unknown;
  pasteOpen: boolean;
  onTogglePaste: () => void;
  onPasted: (next: AuthState) => void;
}) {
  const signedIn = state.status === 'signed_in';
  const browserOpen = state.status === 'signing_in' || state.signInInProgress === true;
  const found = stage === 'found' || stage === 'verifying';
  const invalidKey = state.inferenceKey.status === 'invalid' ? state.inferenceKey : null;

  // One active step with the one primary button: signing in is optional for chat, so it never competes with step 2.
  // Lime is spent once: GMI Console's button gives it up once it has been opened, or to the paste form's submit
  // when the user takes the manual path (which turns lime only once it holds a key, like Settings).
  const step1: StepStatus = signedIn ? 'done' : 'todo';
  const step2: StepStatus = found ? 'done' : 'active';
  const step3: StepStatus = found ? 'active' : consoleOpened ? 'active' : 'todo';

  // Take focus on mount (dialog open, or back from "Use a different key") and when a found key goes away ("Not this
  // one" unmounts the focused button), so Enter opens GMI Console, unless the user is typing in a field. While a key
  // is found, FoundKey's "Use this key" has it instead (the console button is not rendered then).
  const consoleRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (found) return;
    const active = document.activeElement;
    // Later on, only take back focus that was lost (never pull it from another control the user is on).
    const free = first ? !(active instanceof HTMLElement && active.closest('input, textarea')) : !active || active === document.body;
    if (free) consoleRef.current?.focus();
  }, [found]);

  return (
    <div className="flex flex-col gap-4">
      {invalidKey ? (
        <p role="note" className="flex items-start gap-2 rounded-md bg-destructive/[0.06] px-3 py-2 text-2xs text-foreground">
          <KeyRound className="mt-px size-3.5 shrink-0 text-destructive" />
          <span>
            GMI rejected your current key
            {invalidKey.last4 ? (
              <>
                {' '}
                <span className="font-mono">••{invalidKey.last4}</span>
              </>
            ) : null}
            . Create a new one and it replaces the old one.
          </span>
        </p>
      ) : null}

      <ol aria-label="Steps" className="flex flex-col pt-1">
        <Step
          n={1}
          status={step1}
          title={signedIn ? 'Signed in to GMI' : 'Sign in to GMI (optional)'}
          aside={
            signedIn ? null : browserOpen ? (
              <span className="flex items-center gap-2 whitespace-nowrap text-2xs text-muted-foreground" role="status">
                <Plates size="sm" /> Waiting for the browser…
              </span>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void signInWithFeedback()}>
                <LogIn /> Sign in
              </Button>
            )
          }
        >
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {signedIn ? 'Models, usage and media are connected.' : 'Lets GMI Desk check that the key belongs to your organization.'}
          </p>
        </Step>

        <Step
          n={2}
          status={step2}
          title="Create a key in GMI Console"
          aside={
            found ? null : (
              <Button ref={consoleRef} {...AUTOFOCUS} size="sm" variant={consoleOpened || pasteOpen ? 'outline' : 'default'} onClick={onOpenConsole}>
                {consoleOpened ? 'Open again' : 'Open GMI Console'} <ExternalLink />
              </Button>
            )
          }
        >
          <ClickPath steps={CONNECT_COPY.consoleSteps} />
        </Step>

        <Step n={3} status={step3} title={found ? 'Confirm the key' : 'Come back here — we’ll pick it up'} last>
          <Fade key={stage === 'verifying' ? 'found' : stage} animate={animate} className="mt-2">
            {found && state.keyDetection?.candidate ? (
              <FoundKey last4={state.keyDetection.candidate.last4} verifying={stage === 'verifying'} onUse={onUseKey} onDismiss={onNotThisOne} />
            ) : stage === 'stopped' ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-input px-3 py-2.5">
                <Clock className="size-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{CONNECT_COPY.stopped}</p>
                <Button size="sm" variant="outline" onClick={onWatchAgain}>
                  <RotateCw /> Watch again
                </Button>
              </div>
            ) : (
              <div role="status" className="flex items-center gap-2.5 rounded-lg border border-dashed border-input bg-muted/30 px-3 py-2.5">
                <ListeningDot />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground/90">{CONNECT_COPY.listening}</p>
                  <p className="text-2xs text-muted-foreground">{CONNECT_COPY.listeningDetail}</p>
                </div>
              </div>
            )}
          </Fade>
          {useError ? (
            <p role="alert" className="mt-2 text-2xs text-destructive">
              {detectErrorText(useError)}
            </p>
          ) : null}
        </Step>
      </ol>

      <PasteFallback open={pasteOpen} onToggle={onTogglePaste} storage={state.secureStorage} onSaved={onPasted} />
      <Footnotes state={state} />
    </div>
  );
}

function detectErrorText(error: unknown): string {
  const view = describeError(error);
  if (view.code === 'invalid_api_key') return `GMI didn’t accept that key${view.message ? ` (${view.message.replace(/\.$/, '')})` : ''}. Copy another one.`;
  if (view.code === 'invalid_input') return view.message || view.title;
  return view.message ? `${view.title} ${view.message}` : view.title;
}

/** The found-key card: [Not this one] [Use this key ↵]. "Use this key" takes focus so Enter accepts it. */
function FoundKey({ last4, verifying, onUse, onDismiss }: { last4: string; verifying: boolean; onUse: () => void; onDismiss: () => void }) {
  const useButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Take focus so Enter accepts, unless the user is typing in a field (e.g. pasting the key by hand).
    if (!(document.activeElement instanceof HTMLElement && document.activeElement.closest('input, textarea'))) useButton.current?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary-ink/30 bg-primary/[0.07] px-3 py-3 dark:border-primary/25 dark:bg-primary/[0.06]">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary-ink/25 bg-primary/20 text-primary-ink dark:border-primary/20 dark:bg-primary/10">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium" aria-label={foundKeyLabel(last4)}>
            Found a key ending <span className="font-mono tracking-wide">••{last4}</span>
          </p>
          <p className="text-2xs text-muted-foreground">{verifying ? 'Checking it with GMI…' : 'From your clipboard. GMI checks it when you use it.'}</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={verifying}>
          Not this one
        </Button>
        <Button
          ref={useButton}
          {...AUTOFOCUS}
          size="sm"
          onClick={onUse}
          disabled={verifying}
          aria-busy={verifying || undefined}
          // Busy, not unavailable: keep the lime while it checks.
          className={cn('min-w-[8.5rem]', verifying && 'disabled:opacity-100')}
        >
          {verifying ? <Spinner className="text-primary-foreground" /> : <ShieldCheck />}
          {verifying ? 'Checking…' : 'Use this key'}
          {verifying ? null : <EnterKbd className="ml-0.5" />}
        </Button>
      </div>
    </div>
  );
}

/** "Paste it instead": the manual path (same validate + store, and the same outline-until-filled submit, as Settings). */
function PasteFallback({
  open,
  onToggle,
  storage,
  onSaved,
}: {
  open: boolean;
  onToggle: () => void;
  storage: AuthState['secureStorage'];
  onSaved: (next: AuthState) => void;
}) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  const ready = value.trim() !== '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await gmi.auth.setInferenceKey(value);
      setValue('');
      onSaved(next);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex items-center gap-1.5 self-start rounded-sm text-2xs font-medium text-muted-foreground underline-offset-[3px] transition-colors duration-150 ease-out hover:text-foreground hover:underline"
      >
        <KeyRound className="size-3" /> Paste it instead
      </button>
      {open ? (
        <Fade>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  ref={inputRef}
                  type={reveal ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    if (error) setError(null);
                  }}
                  aria-label="GMI API key"
                  placeholder="Paste your GMI API key"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  className="h-8 pr-8 font-mono text-xs"
                />
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={reveal ? 'Hide key' : 'Show key'}
                  onClick={() => setReveal((r) => !r)}
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                >
                  {reveal ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <Button
                type="submit"
                size="md"
                variant={ready || saving ? 'default' : 'outline'}
                disabled={!ready || saving}
                aria-busy={saving || undefined}
                className={cn(saving && 'disabled:opacity-100')}
              >
                {saving ? <Spinner className="text-primary-foreground" /> : <ShieldCheck />} {saving ? 'Verifying…' : 'Save & verify'}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-2xs text-destructive">
                {describeError(error).message || describeError(error).title}
              </p>
            ) : (
              <p className="text-2xs text-muted-foreground">{keyStorageNote(storage)}</p>
            )}
          </form>
        </Fade>
      ) : null}
    </div>
  );
}

/** Why a key at all, Coding Plan users, and a quiet way to ask GMI again whether the sign-in covers chat. */
function Footnotes({ state }: { state: AuthState }) {
  const probe = state.inference?.oauthProbe ?? 'unknown';
  const checking = probe === 'checking';
  const signedIn = state.status === 'signed_in';
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 text-2xs leading-relaxed text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-[3px] size-3 shrink-0" />
        <span>
          {CONNECT_COPY.why}
          {signedIn ? (
            <>
              {' '}
              <button
                type="button"
                disabled={checking}
                onClick={() => void gmi.auth.probeOAuthInference().catch(() => undefined)}
                className="rounded-sm font-medium text-foreground/85 underline decoration-foreground/25 underline-offset-[3px] transition-[color,text-decoration-color] duration-150 ease-out hover:text-foreground hover:decoration-foreground/70 disabled:no-underline disabled:opacity-60"
                title={state.inference?.oauthProbeAt ? `Last checked ${formatRelativeTime(state.inference.oauthProbeAt)}` : undefined}
              >
                {checking ? 'Checking…' : 'Check again'}
              </button>
            </>
          ) : null}
        </span>
      </p>
      <p className="flex items-start gap-1.5">
        <KeyRound className="mt-[3px] size-3 shrink-0" />
        <span>{CONNECT_COPY.codingPlan}</span>
      </p>
    </div>
  );
}

function SuccessView({
  success,
  storage,
  onStart,
  onHold,
}: {
  success: Success;
  storage: AuthState['secureStorage'];
  onStart: () => void;
  /** The pointer moved over (true) or left (false) the view: pauses the auto-close. */
  onHold: (held: boolean) => void;
}) {
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    startRef.current?.focus();
  }, []);
  return (
    // pointermove fires only when the pointer really moves over the view (not when the view appears under a resting
    // pointer), so a resting mouse still auto-closes.
    <div
      role="status"
      // The header row above holds only the close button (the title is sr-only here): no extra top padding.
      className="flex flex-col items-center px-2 pb-4 text-center"
      onPointerMove={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
    >
      <SuccessMark />
      <MicroLabel dot className="mt-4">
        Connected
      </MicroLabel>
      <p className="mt-2 text-lg font-semibold leading-tight tracking-tight">{CONNECT_COPY.ready}</p>
      <p className="mt-1.5 max-w-[22rem] text-xs leading-relaxed text-muted-foreground">{savedKeyNote(success.last4, success.clipboardCleared, storage)}</p>
      <Button ref={startRef} {...AUTOFOCUS} size="lg" className="mt-5 min-w-40" onClick={onStart}>
        <MessageSquare /> Start chatting
      </Button>
    </div>
  );
}

function OAuthView({ onStart, onUseKey }: { onStart: () => void; onUseKey: () => void }) {
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    startRef.current?.focus();
  }, []);
  return (
    <div className="flex flex-col items-center px-2 pb-3 text-center">
      <span aria-hidden className="relative flex items-center justify-center">
        <GridGlow className="-inset-x-28 -bottom-8 -top-2" />
        <Dino mood="happy" size={84} className="relative" />
      </span>
      <MicroLabel dot className="mt-4">
        Connected
      </MicroLabel>
      <p className="mt-2 text-lg font-semibold leading-tight tracking-tight">{CONNECT_COPY.oauthTitle}</p>
      <p className="mt-1.5 max-w-[26rem] text-xs leading-relaxed text-muted-foreground">{CONNECT_COPY.oauthBody}</p>
      <Button ref={startRef} {...AUTOFOCUS} size="lg" className="mt-5 min-w-40" onClick={onStart}>
        <MessageSquare /> Start chatting
      </Button>
      <button
        type="button"
        onClick={onUseKey}
        className="mt-3 rounded-sm text-2xs text-muted-foreground underline-offset-[3px] transition-colors duration-150 ease-out hover:text-foreground hover:underline"
      >
        Prefer a separate key? Add one instead
      </button>
    </div>
  );
}

function ConnectedView({ state, onDone, onReplace }: { state: AuthState; onDone: () => void; onReplace: () => void }) {
  const key = state.inferenceKey;
  const fromEnv = key.source === 'env';
  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium tracking-wide">•••• {key.last4 ?? '????'}</span>
            <Badge variant={key.status === 'valid' ? 'primary' : 'warning'}>{key.status === 'valid' ? 'Valid' : 'Unverified'}</Badge>
            {fromEnv ? <Badge variant="outline">GMI_API_KEY</Badge> : null}
          </div>
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">
            {key.validatedAt ? `Verified ${formatRelativeTime(key.validatedAt)}` : 'Not verified with GMI yet'}
          </p>
        </div>
      </div>
      <div className={cn('flex items-center gap-2', fromEnv ? 'justify-end' : 'justify-between')}>
        {fromEnv ? null : (
          <Button variant="ghost" size="sm" onClick={onReplace}>
            <RotateCw /> Use a different key
          </Button>
        )}
        <Button {...AUTOFOCUS} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
