// "How will you reach it?" (§6.3): in GMI Desk (default, no public IP), SSH from this computer, or a public HTTP
// port. Public access adds an EIP (priced separately) and a firewall limited to the CIDR typed here. "Detect" is
// opt-in: one call to a public IP echo service per click, disclosed before and after.
import { useId, useState } from 'react';
import { Globe, Laptop, Radar, Terminal } from 'lucide-react';
import type { ComputeIdc } from '@shared/contracts/compute';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { Button } from '@renderer/components/ui/button';
import { Input, Label } from '@renderer/components/ui/input';
import { Spinner } from '@renderer/components/ui/misc';
import { checkCidr, cidrWarning } from '../format';
import { toastActionError } from '../hooks';
import { Note } from '../parts';
import type { AccessMode, LaunchDraft } from './state';

const CHOICES: Array<{ mode: AccessMode; icon: typeof Laptop; title: string; body: string }> = [
  { mode: 'none', icon: Laptop, title: 'In GMI Desk', body: 'No public IP. Logs, status and the computer panel inside the app.' },
  { mode: 'ssh', icon: Terminal, title: 'SSH from this computer', body: 'A public IP and a firewall that lets in TCP 22 from your address only.' },
  { mode: 'http', icon: Globe, title: 'Public HTTP port', body: 'A public IP and a firewall for the ports you list.' },
];

/** The echo service main calls (services/compute/index.ts PUBLIC_IP_SERVICE; a test keeps the two equal). */
export const DETECT_SERVICE = 'api.ipify.org';

export const DETECT_DISCLOSURE = `Detect asks ${DETECT_SERVICE} (a third party) for your address: one request, only when you click.`;

export function AccessStep({
  access,
  onChange,
  idc,
  detected: detectedProp,
}: {
  access: LaunchDraft['access'];
  onChange: (next: LaunchDraft['access']) => void;
  idc: ComputeIdc | null;
  /** Tests: the last detection result. */
  detected?: { ip: string | null; service: string } | null;
}) {
  const ids = useId();
  const [detecting, setDetecting] = useState(false);
  const [detectedState, setDetected] = useState<{ ip: string | null; service: string } | null>(null);
  const detected = detectedProp ?? detectedState;
  const publicOffered = idc?.eipAvailable !== false;
  const check = checkCidr(access.cidr);
  const warning = cidrWarning(check);

  const detect = async () => {
    setDetecting(true);
    try {
      const result = await gmi.compute.detectPublicIp();
      setDetected(result);
      if (result.ip) onChange({ ...access, cidr: result.ip });
    } catch (error) {
      toastActionError('Could not detect your IP', error);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-3" data-access={access.mode}>
      <legend className="mb-2 text-xs font-medium text-foreground">How will you reach it?</legend>
      <div role="radiogroup" aria-label="How will you reach it?" className="grid gap-2 sm:grid-cols-3">
        {CHOICES.map(({ mode, icon: Icon, title, body }) => {
          const disabled = mode !== 'none' && !publicOffered;
          const selected = access.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange({ ...access, mode })}
              className={cn(
                'flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left outline-none transition-[border-color,background-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
                // Large cards never scale: a press deepens the background instead.
                selected ? 'border-foreground/30 bg-accent' : 'border-border hover:border-foreground/20 hover:bg-accent/50 active:bg-foreground/10',
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-medium">
                <Icon aria-hidden className={cn('size-3.5', selected ? 'text-primary-ink' : 'text-muted-foreground')} />
                {title}
              </span>
              <span className="text-2xs leading-relaxed text-muted-foreground">{body}</span>
            </button>
          );
        })}
      </div>
      {!publicOffered ? <Note>GMI does not offer public IPs in {idc?.name ?? 'this data centre'}.</Note> : null}
      {access.mode !== 'none' ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border px-3.5 py-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-cidr`}>Allow connections from</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`${ids}-cidr`}
                value={access.cidr}
                onChange={(e) => onChange({ ...access, cidr: e.target.value })}
                placeholder="Your IPv4, e.g. 203.0.113.7"
                spellCheck={false}
                aria-invalid={access.cidr.trim() !== '' && Boolean(check.error)}
                className="w-56 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={() => void detect()} disabled={detecting}>
                {detecting ? <Spinner className="size-3.5" /> : <Radar />} Detect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...access, cidr: '0.0.0.0/0' })}
                className="text-muted-foreground"
              >
                All Open…
              </Button>
            </div>
            {detected ? (
              <Note>{detected.ip ? `Detected ${detected.ip} with ${detected.service}.` : `${detected.service} did not return an address. Type it instead.`}</Note>
            ) : (
              <Note>{DETECT_DISCLOSURE}</Note>
            )}
            {access.cidr.trim() && check.error ? <Note tone="danger">{check.error}</Note> : null}
            {warning ? <Note tone={check.allOpen ? 'danger' : 'warning'}>{warning}</Note> : null}
          </div>
          {access.mode === 'http' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-ports`}>HTTP ports</Label>
              <Input
                id={`${ids}-ports`}
                value={access.httpPorts}
                onChange={(e) => onChange({ ...access, httpPorts: e.target.value })}
                placeholder="8000, 8888"
                inputMode="numeric"
                className="w-56 font-mono text-xs"
              />
            </div>
          ) : null}
          <Note>The public IP bills by the hour until it is released, also while the container is stopped; the review step shows its price.</Note>
        </div>
      ) : null}
    </fieldset>
  );
}
