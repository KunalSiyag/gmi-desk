// GMI gateway status on Usage (harness.md §4, §24 H1-D): TPM use, queue, circuit breakers, online state, cache-hit %.
// Mounted by pages/usage/index.tsx. The status comes from `code.getGatewayStatus()` and live `code:gateway` events.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleCheck, OctagonAlert, WifiOff } from 'lucide-react';
import type { GatewayModelState, GatewayStatus } from '@shared/contracts/gateway';
import { formatNumber, formatRelativeTime } from '@shared/lib/format';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { useGmiEvent } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { Badge } from '@renderer/components/ui/badge';
import { Plates } from '@renderer/components/brand/Plates';
import { MicroLabel, microLabel } from '@renderer/components/ui/misc';
import { BAR_FILL, Figure } from './parts';

/** "1.2M", "640k", "950": token counts as the rate-limit tiers are written. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${formatNumber(n / 1_000_000, n % 1_000_000 === 0 || n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${formatNumber(n / 1_000, n >= 10_000 ? 0 : 1)}k`;
  return formatNumber(n);
}

/** Share of the effective TPM used in the last minute, 0..1 (0 when no limit is known). */
export function tpmShare(status: Pick<GatewayStatus, 'tpmUsedLastMinute' | 'tpmEffective'>): number {
  if (!(status.tpmEffective > 0)) return 0;
  return Math.min(1, Math.max(0, status.tpmUsedLastMinute / status.tpmEffective));
}

/** Models worth a row: a breaker that is not closed, or requests in flight. Open first, then probing, then busiest. */
export function modelsToShow(models: GatewayModelState[]): GatewayModelState[] {
  const rank = { open: 0, half_open: 1, closed: 2 } as const;
  return models
    .filter((m) => m.breaker !== 'closed' || m.inFlight > 0)
    .sort((a, b) => rank[a.breaker] - rank[b.breaker] || b.inFlight - a.inFlight || a.model.localeCompare(b.model));
}

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** The router's scheduler key (`router:<mode>`) as people read it. */
function modelLabel(model: string): string {
  return model.startsWith('router:') ? `GMI Router · ${model.slice('router:'.length)}` : model;
}

function BreakerBadge({ state, reopenAt }: { state: GatewayModelState['breaker']; reopenAt: string | null }) {
  if (state === 'open') {
    const at = reopenAt ? new Date(reopenAt) : null;
    return (
      <Badge variant="danger">
        <OctagonAlert aria-hidden />
        Failing{at && !Number.isNaN(at.getTime()) ? ` · retry ${timeFmt.format(at)}` : ''}
      </Badge>
    );
  }
  if (state === 'half_open') {
    return (
      <Badge variant="warning">
        <AlertTriangle aria-hidden />
        Testing
      </Badge>
    );
  }
  return <Badge variant="outline">Healthy</Badge>;
}

/** The card's body for a known status (pure: rendered by tests with renderToStaticMarkup). */
export function GatewayStatusView({ status, now = new Date() }: { status: GatewayStatus; now?: Date }) {
  const share = tpmShare(status);
  const pct = Math.round(share * 100);
  const reduced = status.tpmEffective > 0 && status.tpmEffective < status.tpmLimit;
  const rows = modelsToShow(status.models);
  const failing = status.models.filter((m) => m.breaker === 'open').length;
  const barFill = share >= 1 ? 'bg-destructive' : share > 0.8 ? 'bg-warning' : BAR_FILL;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
        <Figure
          label="Rate limit · last minute"
          value={
            <span>
              {formatTokens(status.tpmUsedLastMinute)}
              <span className="text-base font-medium text-muted-foreground"> / {formatTokens(status.tpmEffective)}</span>
            </span>
          }
          hint={reduced ? `Slowed after a 429 · tier ${formatTokens(status.tpmLimit)}` : `Tokens per minute · tier ${formatTokens(status.tpmLimit)}`}
        >
          <div
            role="meter"
            aria-label="Tokens used in the last minute"
            aria-valuemin={0}
            aria-valuemax={status.tpmEffective}
            aria-valuenow={status.tpmUsedLastMinute}
            aria-valuetext={`${formatNumber(status.tpmUsedLastMinute)} of ${formatNumber(status.tpmEffective)} tokens per minute`}
            className="absolute inset-x-4 bottom-0 h-0.5 overflow-hidden bg-muted dark:bg-white/[0.06]"
          >
            {pct > 0 ? <div className={cn('h-full', barFill)} style={{ width: `${Math.max(pct, 2)}%` }} /> : null}
          </div>
        </Figure>
        <Figure
          label="Queue"
          value={formatNumber(status.queued)}
          tone={status.queued === 0 ? 'muted' : 'default'}
          hint={`${formatNumber(status.inFlight)} in flight`}
        />
        <Figure
          label="Cache hits · 24h"
          value={status.cacheHitRatio24h === null ? '—' : `${Math.round(status.cacheHitRatio24h * 100)}%`}
          tone={status.cacheHitRatio24h === null ? 'muted' : 'default'}
          hint={status.cacheHitRatio24h === null ? 'No measured requests yet' : 'Of prompt tokens, read from cache'}
        />
        <Figure
          label="Last rate limit"
          value={status.last429At ? formatRelativeTime(status.last429At, now) : 'None'}
          tone={status.last429At ? 'default' : 'muted'}
          hint={status.last429At ? 'GMI said 429; requests waited' : 'No 429 since GMI Desk started'}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {rows.length === 0 ? (
          <>
            <MicroLabel>Models</MicroLabel>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck aria-hidden className="size-3.5 shrink-0 text-primary-ink" />
              No model is failing and nothing is in flight.
            </p>
          </>
        ) : (
          <table className="w-full table-fixed text-xs">
            <caption className="sr-only">Models with requests in flight or a tripped circuit breaker</caption>
            <thead>
              <tr className={cn('text-left', microLabel)}>
                <th scope="col" className="pb-1.5 font-medium">
                  Model
                </th>
                <th scope="col" className="w-[5.5rem] pb-1.5 text-right font-medium">
                  In flight
                </th>
                <th scope="col" className="w-[9.5rem] pb-1.5 text-right font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.model} className="border-t border-border/60">
                  <td className="truncate py-1.5 pr-2 font-mono text-[11px]" title={m.model}>
                    {modelLabel(m.model)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {m.inFlight > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Plates size="sm" />
                        {formatNumber(m.inFlight)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    <BreakerBadge state={m.breaker} reopenAt={m.reopenAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {failing > 0 ? (
          <p className="text-2xs text-muted-foreground">
            Chat fails fast on a failing model; <span className="text-foreground">Retry</span> on that reply tries it anyway.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Online / offline chip for the section heading (words + icon, never colour alone). */
export function GatewayOnlineBadge({ online }: { online: boolean }) {
  return online ? (
    <Badge variant="primary">
      <span aria-hidden className="size-1.5 bg-primary-ink" />
      Online
    </Badge>
  ) : (
    <Badge variant="warning">
      <WifiOff aria-hidden />
      Offline · requests wait
    </Badge>
  );
}

/** The section: heading with the online chip, then the status. */
export function GatewaySection({ status, now }: { status: GatewayStatus; now?: Date }) {
  return (
    <section aria-labelledby="usage-gateway" className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <h2 id="usage-gateway" className={cn(microLabel, 'shrink-0 text-foreground/80')}>
          GMI gateway
        </h2>
        <span className="min-w-0 truncate text-2xs text-muted-foreground">Every model request from this device goes through it</span>
        <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
        <GatewayOnlineBadge online={status.online} />
      </div>
      <GatewayStatusView status={status} now={now} />
    </section>
  );
}

/**
 * Usage's gateway card: the last status from main, kept live by `code:gateway`. Renders nothing while no status is
 * known (before `code.getGatewayStatus` is served and before any status event since the page opened).
 */
export function GatewayCard() {
  const client = useQueryClient();
  useGmiEvent('code:gateway', (status) => client.setQueryData<GatewayStatus>(qk.gatewayStatus, status));
  const query = useQuery({
    queryKey: qk.gatewayStatus,
    queryFn: () => gmi.code.getGatewayStatus(),
    // Until the Code slice serves it (not_implemented), only live events fill this in: no retries, no refetch loop.
    retry: false,
    staleTime: 30_000,
  });
  return query.data ? <GatewaySection status={query.data} /> : null;
}
