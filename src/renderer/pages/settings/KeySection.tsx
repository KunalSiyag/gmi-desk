import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Eye, EyeOff, KeyRound, Lock, Plug, RotateCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { AuthState, InferenceKeyInfo } from '@shared/contracts/auth';
import { formatRelativeTime } from '@shared/lib/format';
import { chatAccess, chatViaSignIn } from '@renderer/components/connect/access';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Spinner } from '@renderer/components/ui/misc';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { keyStorageNote, oauthProbeLabel } from './copy';
import { ActionError, dangerButton, InlineNote, KeychainLockedNote, Mono, Row, Section, shortId, StatusHeader } from './parts';

const STATUS_BADGE: Record<InferenceKeyInfo['status'], { label: string; variant: 'primary' | 'default' | 'danger' | 'warning' }> = {
  valid: { label: 'Valid', variant: 'primary' },
  missing: { label: 'Not set', variant: 'default' },
  invalid: { label: 'Rejected', variant: 'danger' },
  unverified: { label: 'Unverified', variant: 'warning' },
};

export function KeySection({ state, focusInput }: { state: AuthState; focusInput: number }) {
  const key = state.inferenceKey;
  const client = useQueryClient();
  const openConnect = useUi((s) => s.openConnect);
  const setState = (next: AuthState) => client.setQueryData(qk.auth, next);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: (raw: string) => gmi.auth.setInferenceKey(raw),
    onSuccess: (next) => {
      setState(next);
      setValue('');
      setReveal(false);
      setJustSaved(true);
    },
  });
  const verify = useMutation({ mutationFn: () => gmi.auth.revalidateInferenceKey(), onSuccess: setState });
  const probe = useMutation({ mutationFn: () => gmi.auth.probeOAuthInference(), onSuccess: setState });
  const remove = useMutation({
    mutationFn: () => gmi.auth.removeInferenceKey(),
    onSuccess: (next) => {
      setState(next);
      setConfirmRemove(false);
      setJustSaved(false);
    },
  });

  useEffect(() => {
    if (focusInput > 0) inputRef.current?.focus();
  }, [focusInput]);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 4000);
    return () => clearTimeout(t);
  }, [justSaved]);

  const fromEnv = key.source === 'env';
  const hasKey = key.status !== 'missing';
  // Saved, but the OS keychain would not decrypt it right now (nothing was deleted).
  const locked = state.lockedSecrets?.includes('inference_key') ?? false;
  const badge = STATUS_BADGE[key.status];
  // Chat cannot authenticate: the guided flow is the main action, the paste form stays below it.
  const needsConnect = chatAccess(state) !== 'ready' && !locked && !fromEnv;
  const viaSignIn = chatViaSignIn(state);
  const probeState = state.inference?.oauthProbe ?? 'unknown';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || save.isPending) return;
    save.mutate(value);
  };

  const tone = locked ? 'warning' : key.status === 'invalid' ? 'danger' : key.status === 'valid' || viaSignIn ? 'brand' : 'muted';
  const checkedAt = state.inference?.oauthProbeAt ?? null;
  const probing = probe.isPending || probeState === 'checking';
  const ready = value.trim().length > 0;

  return (
    <Section
      id="keys"
      title="Inference API key"
      description={
        viaSignIn
          ? 'Chat and GMI Router use your GMI sign-in right now. A key you add here takes over.'
          : 'Chat and GMI Router need one inference key. GMI’s sign-in doesn’t cover chat yet.'
      }
      action={
        <Button size="sm" variant="ghost" onClick={() => void gmi.app.openConsole('apiKeys')}>
          Create a key in GMI Console <ExternalLink />
        </Button>
      }
    >
      <StatusHeader
        tone={tone}
        chip={locked ? <Lock /> : viaSignIn ? <ShieldCheck /> : <KeyRound />}
        title={
          hasKey ? (
            <span className="font-mono font-medium tracking-wide">
              <span className="sr-only">Key ending </span>
              <span aria-hidden>•••• •••• </span>
              {key.last4 ?? '????'}
            </span>
          ) : viaSignIn ? (
            'Using your GMI sign-in'
          ) : (
            'No key yet'
          )
        }
        badges={
          <>
            {locked ? (
              <Badge variant="warning">
                <Lock /> Locked
              </Badge>
            ) : viaSignIn ? (
              <Badge variant="primary">No key needed</Badge>
            ) : (
              <Badge variant={badge.variant}>{badge.label}</Badge>
            )}
            {fromEnv ? <Badge variant="outline" className="font-mono">GMI_API_KEY</Badge> : null}
            {justSaved ? (
              <span role="status" className="flex items-center gap-1 text-2xs text-primary-ink">
                <Check className="size-3" /> Saved and verified
              </span>
            ) : null}
          </>
        }
        subtitle={
          locked
            ? 'Saved on this computer, but the OS keychain did not unlock it'
            : hasKey
              ? key.validatedAt
                ? `${key.status === 'invalid' ? 'Checked' : 'Verified'} ${formatRelativeTime(key.validatedAt)}${key.scope ? ` · ${key.scope === 'ie_model' ? 'Inference' : 'Compute'} scope (${key.scope})` : ''}`
                : 'Not verified with GMI yet'
              : viaSignIn
                ? 'GMI accepts your sign-in for chat.'
                : 'Create one in GMI Console and GMI Desk picks it up from your clipboard.'
        }
        actions={
          needsConnect && !hasKey ? (
            <Button size="sm" onClick={openConnect}>
              <Plug /> Connect chat
            </Button>
          ) : hasKey && !locked ? (
            <Button size="sm" variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? <Spinner /> : <RotateCw />} {verify.isPending ? 'Verifying…' : 'Re-verify'}
            </Button>
          ) : null
        }
      />

      {locked ? <KeychainLockedNote secret="inference_key" /> : null}
      {key.status === 'invalid' && key.error ? <InlineNote tone="danger">{key.error}</InlineNote> : null}
      {verify.error ? (
        <div className="px-4 py-2.5">
          <ActionError error={verify.error} />
        </div>
      ) : null}
      {needsConnect && hasKey ? (
        <Row label="Connect a new key" description="Create one in GMI Console; GMI Desk picks it up from your clipboard.">
          <Button size="sm" onClick={openConnect}>
            <Plug /> Connect chat
          </Button>
        </Row>
      ) : null}
      {hasKey && key.orgMatchesAccount === false ? (
        <InlineNote tone="warning">
          This key belongs to organization <span className="font-mono">{key.orgId ? shortId(key.orgId) : 'unknown'}</span>, not the one you signed in with
          {state.orgId ? (
            <>
              {' '}
              (<span className="font-mono">{shortId(state.orgId)}</span>)
            </>
          ) : null}
          . Chat will bill that organization.
        </InlineNote>
      ) : null}
      {hasKey && key.orgId && key.orgMatchesAccount !== false ? (
        <Row label="Billed to" description="Chat with this key is billed to this organization.">
          <Mono title={key.orgId} className="text-foreground/80">
            {shortId(key.orgId)}
          </Mono>
          {key.orgMatchesAccount ? (
            <Badge variant="primary">
              <Check /> Matches your sign-in
            </Badge>
          ) : null}
        </Row>
      ) : null}

      {fromEnv ? (
        <InlineNote>
          Using <span className="font-mono">GMI_API_KEY</span> from the environment. Unset it to manage the key here.
        </InlineNote>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2 px-4 py-3.5">
          <label htmlFor="inference-key" className="text-[13px] font-medium leading-5">
            {hasKey ? 'Replace key' : needsConnect ? 'Or paste a key' : viaSignIn ? 'Add a key (optional)' : 'Add key'}
          </label>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                ref={inputRef}
                id="inference-key"
                type={reveal ? 'text' : 'password'}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (save.error) save.reset();
                }}
                placeholder="Paste your GMI inference API key"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={save.error ? true : undefined}
                aria-describedby="inference-key-note"
                className="pr-8 font-mono text-xs"
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
            {/* Lime only once there is something to save: the empty form stays quiet next to "Connect chat". */}
            <Button type="submit" variant={ready || save.isPending ? 'default' : 'outline'} disabled={!ready || save.isPending}>
              {save.isPending ? <Spinner className="text-primary-foreground" /> : <ShieldCheck />}
              {save.isPending ? 'Verifying…' : 'Save & verify'}
            </Button>
          </div>
          {save.error ? (
            <ActionError error={save.error} />
          ) : (
            <p id="inference-key-note" className="text-2xs text-muted-foreground">
              {keyStorageNote(state.secureStorage)}
            </p>
          )}
        </form>
      )}

      {state.status === 'signed_in' ? (
        <Row
          label="Chat with your GMI sign-in"
          description={
            <>
              Used automatically, without a key, once GMI allows it.{' '}
              {checkedAt && !probing ? `Last checked ${formatRelativeTime(checkedAt)}.` : 'Checked after sign-in and daily.'}
            </>
          }
        >
          <Badge
            variant={probeState === 'supported' ? 'primary' : probeState === 'error' ? 'warning' : 'default'}
            title={checkedAt ? `Checked ${formatRelativeTime(checkedAt)}` : undefined}
            aria-live="polite"
          >
            {probeState === 'supported' ? <Check /> : null}
            {oauthProbeLabel(probeState)}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => probe.mutate()} disabled={probing}>
            {probing ? <Spinner /> : <RotateCw />} Check now
          </Button>
        </Row>
      ) : null}
      {probe.error ? (
        <div className="px-4 py-2.5">
          <ActionError error={probe.error} />
        </div>
      ) : null}

      {hasKey && !fromEnv ? (
        <Row label="Remove key" description="Deletes the key from this computer. It stays valid in GMI Console.">
          <Button size="sm" variant="outline" className={dangerButton} onClick={() => setConfirmRemove(true)}>
            <Trash2 /> Remove key
          </Button>
        </Row>
      ) : null}

      <Dialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the inference key?"
        description="Chat and GMI Router stop working until you add a key again. The key itself stays valid in GMI Console."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? <Spinner className="text-white" /> : <Trash2 />} Remove key
            </Button>
          </>
        }
      >
        {remove.error ? <ActionError error={remove.error} /> : null}
      </Dialog>
    </Section>
  );
}
