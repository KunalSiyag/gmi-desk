/**
 * Connect Compute (compute.md §4.1): the one place the app asks for a Compute key (`ce_resource`), as the same calm
 * flow as Connect chat (D14/D15).
 *
 * 1. Create a Compute key in GMI Console (opens the Compute API keys page). 2. Come back here: while this dialog is
 * open the main process watches the clipboard (AuthApi.startKeyDetection('compute')) and reports only the last 4
 * characters of a key-shaped value; nothing is sent to GMI until "Use this key". An inference key is recognised and
 * can go to chat instead. With a weak keyring, main asks natively whether to store the key or keep it for this
 * session. Then a success moment that shows what the organization can use (containers / sandboxes).
 *
 * Rendered by ConnectChatDialog (mounted once in App) while `useUi().connectTarget === 'compute'`; opened with
 * useUi().openConnect('compute') (or `connect=compute` in navigation params; `connect=compute-success` previews the
 * success moment in mock mode).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, ExternalLink, Eye, EyeOff, Info, KeyRound, Lock, MessageSquare, RotateCw, Server, ShieldCheck } from 'lucide-react';
import type { AuthState } from '@shared/contracts/auth';
import type { ComputeAccess } from '@shared/contracts/compute';
import { formatRelativeTime } from '@shared/lib/format';
import { Plates } from '@renderer/components/brand/Plates';
import { cn } from '@renderer/lib/cn';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { MicroLabel, Spinner } from '../ui/misc';
import { detectStage, type DetectStage } from './access';
import {
  COMPUTE_COPY,
  computeConnectView,
  computeKeyLocked,
  computeKeyOf,
  computeKeySessionOnly,
  computeKeySubtitle,
  computeStorageNote,
  isInferenceKeyError,
  savedComputeKeyNote,
  type ComputeConnectView,
} from './compute-access';
import { AccessChips, useComputeAccess } from './compute-parts';
import { ClickPath, EnterKbd, Fade, ListeningDot, Step, SuccessMark, type StepStatus } from './parts';

/** Marks the element that should have focus when the dialog opens (the view's next action, never the close X). */
const AUTOFOCUS = { 'data-autofocus': '' } as const;

export interface ComputeSuccess {
  /** `compute`: the Compute key was saved; `chat`: an inference key found here went to chat instead. */
  kind: 'compute' | 'chat';
  last4: string | null;
  clipboardCleared: boolean;
}

export type ComputeBodyView = ComputeConnectView | 'success';

export function ConnectComputeDialog() {
  const open = useUi((s) => s.connectOpen);
  const setOpen = useUi((s) => s.setConnectOpen);
  const auth = useAuth();
  const close = useCallback(() => setOpen(false), [setOpen]);
  const [view, setView] = useState<ComputeBodyView | null>(null);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setView(null), 250);
    return () => clearTimeout(timer);
  }, [open]);
  const shown = view ?? computeConnectView(auth.data, false);
  const key = computeKeyOf(auth.data);
  const access = useComputeAccess(open && key.status !== 'missing' && !computeKeyLocked(auth.data));
  const bodyRef = useRef<HTMLDivElement>(null);
  const initialFocus = useCallback(() => bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? true, []);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      // Anchored near the top (like Connect chat): the body changes height while open.
      className="top-[max(3rem,calc(50vh_-_15rem))] translate-y-0"
      initialFocus={initialFocus}
      title={shown === 'success' ? <span className="sr-only">{COMPUTE_COPY.title}</span> : COMPUTE_COPY.title}
      description={shown === 'steps' ? COMPUTE_COPY.description : shown === 'connected' ? 'Containers and sandboxes use this key.' : undefined}
    >
      <div ref={bodyRef}>
        <ConnectComputeBody open={open} state={auth.data} access={access} onClose={close} onView={setView} />
      </div>
    </Dialog>
  );
}

export function ConnectComputeBody({
  open,
  state,
  access,
  onClose,
  onView,
}: {
  open: boolean;
  state: AuthState | undefined;
  /** The organization's access (ComputeState.access); null while unknown. */
  access: ComputeAccess | null;
  onClose: () => void;
  onView?: (view: ComputeBodyView) => void;
}) {
  const client = useQueryClient();
  const navigate = useUi((s) => s.navigate);
  const page = useUi((s) => s.page);
  const [replacing, setReplacing] = useState(false);
  const [success, setSuccess] = useState<ComputeSuccess | null>(null);
  // Mock mode only: `connect=compute-success` previews the success moment (screenshots).
  const previewSuccess = useUi((s) => s.params.connect === 'compute-success');
  const mock = state?.mock === true;
  const mockLast4 = state?.computeKey?.last4 ?? 'c0mp';
  useEffect(() => {
    if (mock && previewSuccess) setSuccess((current) => current ?? { kind: 'compute', last4: mockLast4, clipboardCleared: true });
  }, [mock, previewSuccess, mockLast4]);
  const [consoleOpened, setConsoleOpened] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [useError, setUseError] = useState<unknown>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const painted = useRef(false);
  useEffect(() => {
    painted.current = true;
  }, []);
  const animate = painted.current;

  const view: ComputeBodyView = success ? 'success' : computeConnectView(state, replacing);
  const stage = detectStage(state, verifying);
  const watching = open && view === 'steps';
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);

  // Watch the clipboard for a Compute key only while the steps are on screen (main also stops after 10 minutes).
  useEffect(() => {
    if (!watching) return;
    void gmi.auth.startKeyDetection('compute').catch(() => undefined);
    return () => {
      void gmi.auth.stopKeyDetection().catch(() => undefined);
    };
  }, [watching]);

  const setAuth = (next: AuthState) => client.setQueryData(qk.auth, next);

  const acceptKey = async () => {
    if (verifying) return;
    setVerifying(true);
    setUseError(null);
    try {
      const result = await gmi.auth.useDetectedKey();
      setAuth(result.state);
      setSuccess({ kind: 'compute', last4: result.state.computeKey?.last4 ?? null, clipboardCleared: result.clipboardCleared });
    } catch (error) {
      setUseError(error);
    } finally {
      setVerifying(false);
    }
  };

  /** The found key is an inference key: move it over to chat (same detection, other target), then use it. */
  const useFoundForChat = async () => {
    if (verifying) return;
    setVerifying(true);
    try {
      await gmi.auth.startKeyDetection('inference');
      const result = await gmi.auth.useDetectedKey();
      setAuth(result.state);
      setUseError(null);
      setSuccess({ kind: 'chat', last4: result.state.inferenceKey.last4, clipboardCleared: result.clipboardCleared });
    } catch (error) {
      setUseError(error);
      void gmi.auth.startKeyDetection('compute').catch(() => undefined);
    } finally {
      setVerifying(false);
    }
  };

  const notThisOne = () => {
    setUseError(null);
    void gmi.auth.dismissDetectedKey().then(setAuth, () => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || stage !== 'found' || isInferenceKeyError(useError) || event.defaultPrevented || event.nativeEvent.isComposing) return;
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

  const done = () => {
    onClose();
  };
  const openCompute = () => {
    onClose();
    if (page !== 'compute') navigate('compute');
  };
  const startChatting = () => {
    onClose();
    if (page !== 'chat') navigate('chat');
  };

  return (
    <div className="pb-3" onKeyDown={onKeyDown}>
      <Fade key={view} animate={animate}>
        {view === 'success' && success ? (
          <ComputeSuccessView
            success={success}
            state={state}
            access={access}
            onOpenCompute={openCompute}
            onStartChatting={startChatting}
            onDone={done}
          />
        ) : view === 'connected' ? (
          <ComputeConnectedView state={state} access={access} onDone={done} onReplace={() => setReplacing(true)} />
        ) : (
          <ComputeStepsView
            state={state}
            stage={stage}
            animate={animate}
            consoleOpened={consoleOpened}
            onOpenConsole={() => {
              setConsoleOpened(true);
              void gmi.app.openConsole('computeApiKeys').catch(() => undefined);
            }}
            onUseKey={() => void acceptKey()}
            onUseForChat={() => void useFoundForChat()}
            onNotThisOne={notThisOne}
            onWatchAgain={() => void gmi.auth.startKeyDetection('compute').then(setAuth, () => undefined)}
            useError={useError}
            pasteOpen={pasteOpen}
            onTogglePaste={() => setPasteOpen((v) => !v)}
            onPasted={(next, kind) => {
              setAuth(next);
              setUseError(null);
              setSuccess(
                kind === 'chat'
                  ? { kind, last4: next.inferenceKey.last4, clipboardCleared: false }
                  : { kind, last4: next.computeKey?.last4 ?? null, clipboardCleared: false },
              );
            }}
          />
        )}
      </Fade>
    </div>
  );
}

export function ComputeStepsView({
  state,
  stage,
  animate,
  consoleOpened,
  onOpenConsole,
  onUseKey,
  onUseForChat,
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
  onUseForChat: () => void;
  onNotThisOne: () => void;
  onWatchAgain: () => void;
  useError: unknown;
  pasteOpen: boolean;
  onTogglePaste: () => void;
  onPasted: (next: AuthState, kind: 'compute' | 'chat') => void;
}) {
  const found = stage === 'found' || stage === 'verifying';
  const inferenceFound = found && isInferenceKeyError(useError);
  const key = computeKeyOf(state);
  const invalidKey = key.status === 'invalid' ? key : null;
  const candidate = state.keyDetection?.candidate ?? null;

  const step1: StepStatus = found ? 'done' : 'active';
  const step2: StepStatus = found || consoleOpened ? 'active' : 'todo';

  const consoleRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (found) return;
    const active = document.activeElement;
    const free = first ? !(active instanceof HTMLElement && active.closest('input, textarea')) : !active || active === document.body;
    if (free) consoleRef.current?.focus();
  }, [found]);

  return (
    <div className="flex flex-col gap-4">
      {invalidKey ? (
        <p role="note" className="flex items-start gap-2 rounded-md bg-destructive/[0.06] px-3 py-2 text-2xs text-foreground">
          <KeyRound className="mt-px size-3.5 shrink-0 text-destructive" />
          <span>
            GMI rejected your current Compute key
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

      <p className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
        <Server className="mt-[3px] size-3 shrink-0" />
        <span>{COMPUTE_COPY.explain}</span>
      </p>

      <ol aria-label="Steps" className="flex flex-col">
        <Step
          n={1}
          status={step1}
          title="Create a Compute key in GMI Console"
          aside={
            found ? null : (
              <Button ref={consoleRef} {...AUTOFOCUS} size="sm" variant={consoleOpened || pasteOpen ? 'outline' : 'default'} onClick={onOpenConsole}>
                {consoleOpened ? 'Open again' : 'Open GMI Console'} <ExternalLink />
              </Button>
            )
          }
        >
          <ClickPath steps={COMPUTE_COPY.consoleSteps} />
          <p className="mt-0.5 text-2xs text-muted-foreground">{COMPUTE_COPY.dedicated}</p>
        </Step>

        <Step n={2} status={step2} title={found ? 'Confirm the key' : 'Come back here — we’ll pick it up'} last>
          <Fade key={inferenceFound ? 'inference' : stage === 'verifying' ? 'found' : stage} animate={animate} className="mt-2">
            {found && candidate && inferenceFound ? (
              <InferenceKeyCard last4={candidate.last4} busy={stage === 'verifying'} onUseForChat={onUseForChat} onDismiss={onNotThisOne} />
            ) : found && candidate ? (
              <FoundComputeKey last4={candidate.last4} verifying={stage === 'verifying'} onUse={onUseKey} onDismiss={onNotThisOne} />
            ) : stage === 'stopped' ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-input px-3 py-2.5">
                <Clock className="size-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{COMPUTE_COPY.stopped}</p>
                <Button size="sm" variant="outline" onClick={onWatchAgain}>
                  <RotateCw /> Watch again
                </Button>
              </div>
            ) : (
              <div role="status" className="flex items-center gap-2.5 rounded-lg border border-dashed border-input bg-muted/30 px-3 py-2.5">
                <ListeningDot />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground/90">{COMPUTE_COPY.listening}</p>
                  <p className="text-2xs text-muted-foreground">{COMPUTE_COPY.listeningDetail}</p>
                </div>
              </div>
            )}
          </Fade>
          {useError && !inferenceFound ? (
            <p role="alert" className="mt-2 text-2xs text-destructive">
              {computeErrorText(useError)}
            </p>
          ) : null}
        </Step>
      </ol>

      {state.secureStorage !== 'os' ? (
        <p role="note" className="flex items-start gap-2 rounded-md bg-warning/[0.07] px-3 py-2 text-2xs leading-relaxed text-foreground">
          <Lock className="mt-px size-3.5 shrink-0 text-warning-foreground" />
          <span>{computeStorageNote(state.secureStorage)}</span>
        </p>
      ) : null}

      <ComputePasteFallback open={pasteOpen} onToggle={onTogglePaste} storage={state.secureStorage} onSaved={onPasted} />

      <div className="flex flex-col gap-1 border-t border-border pt-3 text-2xs leading-relaxed text-muted-foreground">
        <p className="flex items-start gap-1.5">
          <Info className="mt-[3px] size-3 shrink-0" />
          <span>Your chat key and GMI sign-in don’t cover containers and sandboxes: Compute uses its own key.</span>
        </p>
      </div>
    </div>
  );
}

function computeErrorText(error: unknown): string {
  const view = describeError(error);
  if (view.code === 'invalid_compute_key') return `GMI didn’t accept that key${view.message ? ` (${view.message.replace(/\.$/, '')})` : ''}. Copy another one.`;
  if (view.code === 'invalid_input') return view.message || view.title;
  return view.message ? `${view.title} ${view.message}` : view.title;
}

function FoundComputeKey({ last4, verifying, onUse, onDismiss }: { last4: string; verifying: boolean; onUse: () => void; onDismiss: () => void }) {
  const useButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!(document.activeElement instanceof HTMLElement && document.activeElement.closest('input, textarea'))) useButton.current?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary-ink/30 bg-primary/[0.07] px-3 py-3 dark:border-primary/25 dark:bg-primary/[0.06]">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary-ink/25 bg-primary/20 text-primary-ink dark:border-primary/20 dark:bg-primary/10">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium" aria-label={`Found a key ending ••${last4}`}>
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

/** The found key is an inference key: say so, and offer it to chat. */
function InferenceKeyCard({ last4, busy, onUseForChat, onDismiss }: { last4: string; busy: boolean; onUseForChat: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-warning/25 bg-warning/12 text-warning-foreground">
          <MessageSquare className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">{COMPUTE_COPY.inferenceTitle}</p>
          <p className="text-2xs text-muted-foreground">
            Key <span className="font-mono">••{last4}</span>. {COMPUTE_COPY.inferenceBody}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>
          Not this one
        </Button>
        <Button size="sm" variant="outline" onClick={onUseForChat} disabled={busy} aria-busy={busy || undefined}>
          {busy ? <Spinner /> : <MessageSquare />} Use it for chat instead
        </Button>
      </div>
    </div>
  );
}

/** "Paste it instead": the manual path (same validate + store; an inference key can go to chat instead). */
function ComputePasteFallback({
  open,
  onToggle,
  storage,
  onSaved,
}: {
  open: boolean;
  onToggle: () => void;
  storage: AuthState['secureStorage'];
  onSaved: (next: AuthState, kind: 'compute' | 'chat') => void;
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
  const inference = isInferenceKeyError(error);

  const save = async (kind: 'compute' | 'chat') => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = kind === 'chat' ? await gmi.auth.setInferenceKey(value) : await gmi.auth.setComputeKey(value);
      setValue('');
      onSaved(next, kind);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save('compute');
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
          <form onSubmit={submit} className="flex flex-col gap-1.5">
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
                  aria-label="GMI Compute API key"
                  placeholder="Paste your GMI Compute API key"
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
                variant={(ready && !inference) || saving ? 'default' : 'outline'}
                disabled={!ready || saving}
                aria-busy={saving || undefined}
                className={cn(saving && 'disabled:opacity-100')}
              >
                {saving ? <Spinner className="text-primary-foreground" /> : <ShieldCheck />} {saving ? 'Verifying…' : 'Save & verify'}
              </Button>
            </div>
            {inference ? (
              <div role="alert" className="flex items-center gap-2 text-2xs">
                <span className="min-w-0 flex-1 text-foreground">{COMPUTE_COPY.inferenceTitle}. Compute needs a Compute key.</span>
                <Button size="xs" variant="outline" onClick={() => void save('chat')} disabled={saving}>
                  <MessageSquare /> Use it for chat instead
                </Button>
              </div>
            ) : error ? (
              <p role="alert" className="text-2xs text-destructive">
                {computeErrorText(error)}
              </p>
            ) : (
              <p className="text-2xs text-muted-foreground">{computeStorageNote(storage)}</p>
            )}
          </form>
        </Fade>
      ) : null}
    </div>
  );
}

/** The key card: last 4, status, when it was verified, and where it is kept. */
function ComputeKeyCard({ state }: { state: AuthState }) {
  const key = computeKeyOf(state);
  const locked = computeKeyLocked(state);
  const sessionOnly = computeKeySessionOnly(state);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
        {locked ? <Lock className="size-4" /> : <KeyRound className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium tracking-wide">•••• {key.last4 ?? '????'}</span>
          {locked ? (
            <Badge variant="warning">
              <Lock /> Locked
            </Badge>
          ) : (
            <Badge variant={key.status === 'valid' ? 'primary' : 'warning'}>{key.status === 'valid' ? 'Valid' : 'Unverified'}</Badge>
          )}
          {sessionOnly ? <Badge variant="outline">This session only</Badge> : null}
        </div>
        <p className="mt-0.5 truncate text-2xs text-muted-foreground">{computeKeySubtitle(key, locked, formatRelativeTime)}</p>
      </div>
    </div>
  );
}

export function ComputeConnectedView({ state, access, onDone, onReplace }: { state: AuthState; access: ComputeAccess | null; onDone: () => void; onReplace: () => void }) {
  const client = useQueryClient();
  const locked = computeKeyLocked(state);
  const [retrying, setRetrying] = useState(false);
  const key = computeKeyOf(state);
  return (
    <div className="flex flex-col gap-4 pt-1">
      <ComputeKeyCard state={state} />
      {locked ? (
        <p role="note" className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
          <Lock className="mt-px size-3.5 shrink-0 text-warning-foreground" />
          <span>Your OS keychain is locked, so GMI Desk can’t read the saved key. Nothing was deleted: unlock it and try again.</span>
        </p>
      ) : (
        <AccessChips access={access} />
      )}
      {key.orgMatchesAccount === false ? (
        <p role="note" className="text-2xs text-foreground">
          This key belongs to another organization than your sign-in. Containers and sandboxes bill that organization.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onReplace}>
          <RotateCw /> Use a different key
        </Button>
        <div className="flex items-center gap-1.5">
          {locked ? (
            <Button
              variant="outline"
              size="sm"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                void gmi.auth
                  .retrySecureStorage()
                  .then((next) => client.setQueryData(qk.auth, next), () => undefined)
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? <Spinner /> : <RotateCw />} Try again
            </Button>
          ) : null}
          <Button {...AUTOFOCUS} onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ComputeSuccessView({
  success,
  state,
  access,
  onOpenCompute,
  onStartChatting,
  onDone,
}: {
  success: ComputeSuccess;
  state: AuthState;
  access: ComputeAccess | null;
  onOpenCompute: () => void;
  onStartChatting: () => void;
  onDone: () => void;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);
  const chat = success.kind === 'chat';
  const note = chat
    ? `Key ••${success.last4 ?? '????'} is now your chat key. Compute still needs its own key.`
    : savedComputeKeyNote(success.last4, success.clipboardCleared, state.secureStorage, computeKeySessionOnly(state));
  return (
    <div role="status" className="flex flex-col items-center px-2 pb-4 text-center">
      <SuccessMark />
      <MicroLabel dot className="mt-4">
        Connected
      </MicroLabel>
      <p className="mt-2 text-lg font-semibold leading-tight tracking-tight">{chat ? COMPUTE_COPY.chatReady : COMPUTE_COPY.ready}</p>
      <p className="mt-1.5 max-w-[24rem] text-xs leading-relaxed text-muted-foreground">{note}</p>
      {chat ? null : <AccessChips access={access} className="mt-4 items-center" />}
      <div className="mt-5 flex items-center gap-2">
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
        {chat ? (
          <Button ref={primaryRef} {...AUTOFOCUS} size="lg" className="min-w-40" onClick={onStartChatting}>
            <MessageSquare /> Start chatting
          </Button>
        ) : (
          <Button ref={primaryRef} {...AUTOFOCUS} size="lg" className="min-w-40" onClick={onOpenCompute}>
            <Server /> Open Compute
          </Button>
        )}
      </div>
    </div>
  );
}
