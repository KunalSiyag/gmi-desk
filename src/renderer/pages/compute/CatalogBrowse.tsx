// Signed-out browsing (§5, G1): what GMI offers, from its key-less public feeds. Sizes are grouped with the lowest
// list price ("from $X/h"); no raw SKU is shown (§5.2 rule 3). Connect Compute is the one lime action here.
import { ArrowRight, Box, KeyRound, Server } from 'lucide-react';
import type { ComputeCatalog, ComputeKind } from '@shared/contracts/compute';
import { cn } from '@renderer/lib/cn';
import { useUi } from '@renderer/lib/store';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { MicroLabel, Skeleton } from '@renderer/components/ui/misc';
import { COMPUTE_COPY } from '@renderer/components/connect/compute-access';
import { cheapestByModel, formatAgo, type ComputeKeyView } from './format';
import { Note, Panel, SectionHeading } from './parts';
import { LIST_PRICE_NOTE, PriceTag } from './PriceTag';

const KIND_BLURB: Record<ComputeKind, { title: string; body: string; icon: typeof Server }> = {
  container: { title: 'GPU containers', body: 'Cluster Engine: GPU machines by the hour, deleted when their lease ends.', icon: Server },
  sandbox: { title: 'Sandboxes', body: 'Agentbox: small Linux machines for code, servers and agents. Pause when idle.', icon: Box },
};

function KindColumn({ catalog, kind, onLaunch }: { catalog: ComputeCatalog; kind: ComputeKind; onLaunch: (kind: ComputeKind) => void }) {
  const rows = cheapestByModel(catalog.offers, kind).slice(0, 8);
  const { title, body, icon: Icon } = KIND_BLURB[kind];
  return (
    // Side by side (lg), both cards share the parent's two rows (subgrid): the headers take the taller one's height,
    // so the price rows line up across the cards even when one blurb wraps.
    <Panel className="flex flex-col lg:row-span-2 lg:grid lg:grid-rows-subgrid" data-browse={kind}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <Icon aria-hidden className="size-4 text-muted-foreground" /> {title}
          </p>
          <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{body}</p>
        </div>
        <Button variant="ghost" size="xs" onClick={() => onLaunch(kind)}>
          Explore <ArrowRight />
        </Button>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.title} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px]">{row.title}</span>
              <span className="hidden truncate text-3xs tabular-nums text-muted-foreground sm:block">
                {row.idcs.length} {row.idcs.length === 1 ? 'region' : 'regions'}
              </span>
              {/* A fixed, right-aligned price column so the region counts line up down the list. */}
              <PriceTag usdPerHour={row.fromUsdPerHour} from className="min-w-[6.75rem] justify-end" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-xs text-muted-foreground">GMI lists none right now.</p>
      )}
    </Panel>
  );
}

export function ConnectComputeHero({ keyView }: { keyView: ComputeKeyView }) {
  const openConnect = useUi((s) => s.openConnect);
  const title = keyView === 'invalid' ? 'Your Compute key stopped working' : keyView === 'locked' ? 'Your Compute key is locked' : 'Launch GPUs and sandboxes from here';
  const body =
    keyView === 'invalid'
      ? 'GMI rejected the saved key (revoked or expired). Anything already running keeps running and billing until you delete it.'
      : keyView === 'locked'
        ? 'The OS keychain did not unlock it. Unlock your keyring and reopen GMI Desk, or connect the key again.'
        : COMPUTE_COPY.explain;
  return (
    <Panel className="flex flex-wrap items-center gap-4 px-5 py-4" data-connect-hero={keyView}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold tracking-tight">{title}</p>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
      <Button onClick={() => openConnect('compute')}>
        <KeyRound /> {keyView === 'invalid' ? 'Replace Compute key' : 'Connect Compute'}
      </Button>
    </Panel>
  );
}

export function CatalogBrowse({
  catalog,
  loading,
  error,
  onRetry,
  now,
  onLaunch,
}: {
  catalog: ComputeCatalog | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  onLaunch: (kind: ComputeKind) => void;
}) {
  if (error && !catalog) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (loading || !catalog)
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  const official = catalog.templates.filter((t) => t.official);
  const stale = Object.values(catalog.sources).some((s) => s.state === 'stale' || s.state === 'error');
  return (
    <section aria-labelledby="compute-browse" className="flex flex-col gap-4">
      <SectionHeading id="compute-browse" title="What GMI offers" meta={`public list prices · updated ${formatAgo(catalog.fetchedAt, now) ?? ''}`} />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-y-0">
        <KindColumn catalog={catalog} kind="container" onLaunch={onLaunch} />
        <KindColumn catalog={catalog} kind="sandbox" onLaunch={onLaunch} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {official.length ? (
          <div className="flex flex-col gap-2">
            <MicroLabel as="p">Official templates</MicroLabel>
            <ul className="flex flex-wrap gap-1.5">
              {official.map((t) => (
                <li key={t.id}>
                  <Badge variant="outline" className="py-0.5 text-xs">
                    {t.name}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {catalog.idcs.length ? (
          <div className="flex flex-col gap-2">
            <MicroLabel as="p">Data centres</MicroLabel>
            <ul className="flex flex-wrap gap-1.5">
              {catalog.idcs.map((i) => (
                <li key={i.id}>
                  <Badge variant={i.status === 'maintenance' ? 'warning' : 'outline'} className={cn('py-0.5 text-xs', i.status !== 'available' && 'opacity-70')}>
                    {i.name}
                    {i.status === 'full' ? ' · full' : i.status === 'maintenance' ? ' · maintenance' : ''}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <Note>
        {LIST_PRICE_NOTE}
        {stale ? ' Some of GMI’s feeds did not answer; showing the last good data.' : ''}
      </Note>
    </section>
  );
}
