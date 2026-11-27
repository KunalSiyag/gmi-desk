// The Network tab (§6.3, §7.5 step 7): every EIP and firewall the key can see. Only EIPs GMI Desk created can be
// released (native confirmation in main); others get Open in console. A disassociated EIP bills until released.
import { useState } from 'react';
import { ArrowUpRight, Globe, Shield } from 'lucide-react';
import type { ComputeNetworkInventory } from '@shared/contracts/compute';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { formatAgo } from './format';
import { toastActionError } from './hooks';
import { Note, SectionHeading } from './parts';
import { PriceTag } from './PriceTag';

const EIP_STATUS: Record<ComputeNetworkInventory['eips'][number]['status'], { label: string; variant: 'primary' | 'warning' | 'outline' }> = {
  associated: { label: 'Attached', variant: 'primary' },
  disassociated: { label: 'Not attached', variant: 'warning' },
  released: { label: 'Released', variant: 'outline' },
  unknown: { label: 'Unknown', variant: 'outline' },
};

export function NetworkTab({
  inventory,
  loading,
  error,
  onRetry,
  now,
  onReleased,
  onOpenResource,
}: {
  inventory: ComputeNetworkInventory | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  onReleased: () => void;
  onOpenResource: (id: string) => void;
}) {
  const [releasing, setReleasing] = useState<string | null>(null);
  const release = async (id: string) => {
    setReleasing(id);
    try {
      await gmi.compute.releaseEip(id);
      onReleased();
    } catch (e) {
      toastActionError('Could not release the IP', e);
    } finally {
      setReleasing(null);
    }
  };
  const openConsole = () => void gmi.app.openConsole('computeHome').catch(() => undefined);

  if (error && !inventory) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (loading || !inventory)
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );

  const unattached = inventory.eips.filter((e) => e.status === 'disassociated');
  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="net-eips" className="flex flex-col gap-3">
        <SectionHeading id="net-eips" title="Public IPs" meta={`${inventory.eips.length} · fetched ${formatAgo(inventory.fetchedAt, now)}`} />
        {unattached.length ? (
          <Note tone="warning">
            {unattached.length === 1 ? 'One public IP is' : `${unattached.length} public IPs are`} not attached to anything and still bill until released.
          </Note>
        ) : null}
        {inventory.eips.length === 0 ? (
          <EmptyState icon={<Globe />} title="No public IPs" description="Containers you launch with SSH or a public port get one here." className="rounded-lg border border-border py-8" />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {inventory.eips.map((eip) => {
              const status = EIP_STATUS[eip.status];
              return (
                <li key={eip.id} data-eip={eip.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3', eip.status === 'disassociated' && 'bg-warning/[0.05]')}>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      <span className="font-mono text-xs">{eip.address ?? '—'}</span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {eip.managed ? <Badge variant="outline">GMI Desk</Badge> : <Badge variant="outline">Unmanaged</Badge>}
                    </span>
                    <span className="truncate text-2xs text-muted-foreground">
                      {eip.name} · {eip.idc}
                    </span>
                  </div>
                  <PriceTag usdPerHour={eip.listUsdPerHour} />
                  <div className="flex items-center gap-1.5">
                    {eip.attachedTo ? (
                      <Button variant="ghost" size="xs" onClick={() => onOpenResource(eip.attachedTo!)}>
                        Open container
                      </Button>
                    ) : null}
                    {eip.managed && eip.status === 'disassociated' ? (
                      <Button variant="outline" size="xs" className="text-destructive hover:text-destructive" disabled={releasing !== null} onClick={() => void release(eip.id)}>
                        {releasing === eip.id ? <Spinner className="size-3" /> : null} Release…
                      </Button>
                    ) : !eip.managed ? (
                      <Button variant="ghost" size="xs" onClick={openConsole}>
                        Open in console <ArrowUpRight className="text-muted-foreground" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="net-fw" className="flex flex-col gap-3">
        <SectionHeading id="net-fw" title="Firewalls" meta={String(inventory.firewalls.length)} />
        {inventory.firewalls.length === 0 ? (
          <EmptyState icon={<Shield />} title="No firewalls" className="rounded-lg border border-border py-8" />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {inventory.firewalls.map((fw) => (
              <li key={fw.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    {fw.name}
                    {fw.preset ? <Badge variant="outline">Preset</Badge> : null}
                    {fw.managed ? <Badge variant="outline">GMI Desk</Badge> : null}
                    {fw.status === 'error' ? <Badge variant="danger">Error</Badge> : fw.status === 'building' ? <Badge variant="default">Building</Badge> : null}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {fw.idc} · attached to {fw.attachedCount} {fw.attachedCount === 1 ? 'container' : 'containers'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Note>Change a container’s allowed address from its page (Network → Update firewall to my current IP).</Note>
      </section>
    </div>
  );
}
