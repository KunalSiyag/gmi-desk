// Shared by Connect Compute and Settings › Compute key: the organization's access to containers and sandboxes
// (ComputeState.access, answered by the compute slice's entitlement probe, compute.md §4.1 step 5).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, X } from 'lucide-react';
import type { ComputeAccess, ComputeEntitlement, ComputeState } from '@shared/contracts/compute';
import { Plates } from '@renderer/components/brand/Plates';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { useGmiEvent } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { Badge } from '../ui/badge';
import { entitlementLabel, entitlementRows } from './compute-access';

/**
 * The organization's compute access while a Compute key is saved (`enabled`), live through `compute:state`. Null
 * while unknown: no key, still loading, or the compute slice cannot answer yet.
 */
export function useComputeAccess(enabled: boolean): ComputeAccess | null {
  const client = useQueryClient();
  useGmiEvent('compute:state', (state) => client.setQueryData<ComputeState>(qk.computeState, state));
  const query = useQuery({ queryKey: qk.computeState, queryFn: () => gmi.compute.getState(), enabled, retry: false, staleTime: 15_000 });
  return enabled ? (query.data?.access ?? null) : null;
}

function EntitlementBadge({ value }: { value: ComputeEntitlement }) {
  const label = entitlementLabel(value);
  if (value === 'entitled')
    return (
      <Badge variant="primary">
        <Check /> {label}
      </Badge>
    );
  if (value === 'checking')
    return (
      <Badge variant="default" aria-live="polite">
        <Plates size="sm" /> {label}
      </Badge>
    );
  if (value === 'not_entitled')
    return (
      <Badge variant="default">
        <X /> {label}
      </Badge>
    );
  return <Badge variant={value === 'error' ? 'warning' : 'outline'}>{label}</Badge>;
}

/** "Containers ✓ · Sandboxes ✗ (Contact GMI support to enable)". Nothing while access is unknown. */
export function AccessChips({ access, className }: { access: ComputeAccess | null; className?: string }) {
  const rows = entitlementRows(access);
  if (!rows) return null;
  const missing = rows.some((row) => row.value === 'not_entitled');
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <ul aria-label="Compute access" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="font-medium text-foreground/85">{row.label}</span>
            <EntitlementBadge value={row.value} />
          </li>
        ))}
      </ul>
      {missing ? (
        <p className="text-2xs text-muted-foreground">
          Not enabled for your organization yet.{' '}
          <button
            type="button"
            onClick={() => void gmi.app.openConsole('computeHome').catch(() => undefined)}
            className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground/85 underline decoration-foreground/25 underline-offset-[3px] transition-[color,text-decoration-color] duration-150 ease-out hover:text-foreground hover:decoration-foreground/70"
          >
            Contact GMI support to enable <ExternalLink className="size-3" />
          </button>
        </p>
      ) : null}
    </div>
  );
}
