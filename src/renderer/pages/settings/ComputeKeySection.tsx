// Settings › Compute key (compute.md §15): status, last 4, the organization's access (containers / sandboxes),
// re-verify, and remove (resources keep billing). Registered by pages/registry.compute.ts (default export), which
// renders it inside the standard titled card.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, KeyRound, Lock, Plug, RotateCw, Trash2 } from 'lucide-react';
import type { AuthState } from '@shared/contracts/auth';
import type { ComputeAccess } from '@shared/contracts/compute';
import { formatRelativeTime } from '@shared/lib/format';
import { COMPUTE_COPY, computeKeyLocked, computeKeyOf, computeKeySessionOnly, computeKeySubtitle } from '@renderer/components/connect/compute-access';
import { AccessChips, useComputeAccess } from '@renderer/components/connect/compute-parts';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Spinner } from '@renderer/components/ui/misc';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { ActionError, dangerButton, InlineNote, KeychainLockedNote, Mono, Row, shortId, StatusHeader } from './parts';

const STATUS_BADGE = {
  valid: { label: 'Valid', variant: 'primary' },
  missing: { label: 'Not set', variant: 'default' },
  invalid: { label: 'Rejected', variant: 'danger' },
  unverified: { label: 'Unverified', variant: 'warning' },
} as const;

export default function ComputeKeySection() {
  const auth = useAuth();
  const state = auth.data;
  const key = computeKeyOf(state);
  const access = useComputeAccess(key.status !== 'missing' && !computeKeyLocked(state));
  if (!state) return null;
  return <ComputeKeySectionBody state={state} access={access} />;
}

export function ComputeKeySectionBody({ state, access }: { state: AuthState; access: ComputeAccess | null }) {
  const client = useQueryClient();
  const openConnect = useUi((s) => s.openConnect);
  const setState = (next: AuthState) => client.setQueryData(qk.auth, next);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const verify = useMutation({ mutationFn: () => gmi.auth.revalidateComputeKey(), onSuccess: setState });
  const remove = useMutation({
    mutationFn: () => gmi.auth.removeComputeKey(),
    onSuccess: (next) => {
      setState(next);
      setConfirmRemove(false);
    },
  });

  const key = computeKeyOf(state);
  const locked = computeKeyLocked(state);
  const sessionOnly = computeKeySessionOnly(state);
  const hasKey = key.status !== 'missing';
  const badge = STATUS_BADGE[key.status];
  // Outline, not lime: Settings › Inference API key owns the page's one lime action (Connect chat) when it needs it.
  const tone = locked ? 'warning' : key.status === 'invalid' ? 'danger' : key.status === 'valid' ? 'brand' : 'muted';
  const connect = () => openConnect('compute');

  return (
    <>
      <StatusHeader
        tone={tone}
        chip={locked ? <Lock /> : <KeyRound />}
        title={
          hasKey ? (
            <span className="font-mono font-medium tracking-wide">
              <span className="sr-only">Key ending </span>
              <span aria-hidden>•••• •••• </span>
              {key.last4 ?? '????'}
            </span>
          ) : (
            'No Compute key yet'
          )
        }
        badges={
          <>
            {locked ? (
              <Badge variant="warning">
                <Lock /> Locked
              </Badge>
            ) : (
              <Badge variant={badge.variant}>{badge.label}</Badge>
            )}
            {sessionOnly ? <Badge variant="outline">This session only</Badge> : null}
          </>
        }
        subtitle={computeKeySubtitle(key, locked, formatRelativeTime)}
        actions={
          !hasKey ? (
            <Button size="sm" variant="outline" onClick={connect}>
              <Plug /> Connect Compute
            </Button>
          ) : !locked ? (
            <Button size="sm" variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? <Spinner /> : <RotateCw />} {verify.isPending ? 'Verifying…' : 'Re-verify'}
            </Button>
          ) : null
        }
      />

      {locked ? <KeychainLockedNote secret="compute_key" /> : null}
      {key.status === 'invalid' && key.error ? <InlineNote tone="danger">{key.error}</InlineNote> : null}
      {verify.error ? (
        <div className="px-4 py-2.5">
          <ActionError error={verify.error} />
        </div>
      ) : null}
      {sessionOnly ? (
        <InlineNote tone="warning" icon={<Lock />}>
          Kept in memory for this session only{state.secureStorage === 'unavailable' ? ' (encryption is unavailable on this computer)' : ' (no OS keyring was found)'}. Connect it
          again after you quit GMI Desk.
        </InlineNote>
      ) : null}

      {!hasKey ? (
        <InlineNote>{COMPUTE_COPY.explain}</InlineNote>
      ) : key.status === 'invalid' ? (
        <Row label="Connect a new key" description="Create one in GMI Console; GMI Desk picks it up from your clipboard.">
          <Button size="sm" variant="outline" onClick={connect}>
            <Plug /> Connect Compute
          </Button>
        </Row>
      ) : null}

      {hasKey && !locked && access ? (
        <Row label="Access" description="What GMI enables for your organization with this key.">
          <AccessChips access={access} className="items-end" />
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
          . Containers and sandboxes bill that organization.
        </InlineNote>
      ) : null}
      {hasKey && key.orgId && key.orgMatchesAccount !== false ? (
        <Row label="Billed to" description="Containers and sandboxes started with this key bill this organization.">
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

      <Row label="Compute API keys" description="Create or revoke keys in GMI Console. Use one just for GMI Desk.">
        <Button size="sm" variant="ghost" onClick={() => void gmi.app.openConsole('computeApiKeys').catch(() => undefined)}>
          Open GMI Console <ExternalLink />
        </Button>
      </Row>

      {hasKey ? (
        <Row label="Remove key" description={`Deletes the key from this computer. ${COMPUTE_COPY.keepBilling}`}>
          <Button size="sm" variant="outline" className={dangerButton} onClick={() => setConfirmRemove(true)}>
            <Trash2 /> Remove key
          </Button>
        </Row>
      ) : null}

      <Dialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the Compute key?"
        description={`GMI Desk stops managing containers and sandboxes until you add a key again. ${COMPUTE_COPY.keepBilling} The key itself stays valid in GMI Console.`}
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
    </>
  );
}
