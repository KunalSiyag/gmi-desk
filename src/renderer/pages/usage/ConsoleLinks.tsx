import { ArrowUpRight, CreditCard, Gauge, Layers, Receipt, Workflow, type LucideIcon } from 'lucide-react';
import type { ConsolePage } from '@shared/app';
import { gmi } from '@renderer/lib/gmi';
import { Button } from '@renderer/components/ui/button';
import { Tooltip } from '@renderer/components/ui/tooltip';

const LINKS: Array<{ page: ConsolePage; label: string; icon: LucideIcon; tip?: string }> = [
  { page: 'invoices', label: 'Invoices', icon: Receipt },
  { page: 'billing', label: 'Credits & payment', icon: CreditCard },
  { page: 'subscription', label: 'Subscription', icon: Layers, tip: 'Coding Plan and Studio plans live in GMI Console' },
  { page: 'usageInference', label: 'Inference usage', icon: Gauge },
  { page: 'usageStudio', label: 'Studio usage', icon: Workflow },
];

/** Billing that only GMI Console shows (opens in the browser; signs in there if needed). */
export function ConsoleLinks() {
  return (
    <section aria-labelledby="usage-console" className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id="usage-console" className="text-[13px] font-medium">
          More in GMI Console
        </h3>
        <p className="text-2xs text-muted-foreground">Invoices, payment methods and plans (Coding Plan, Studio) are managed there.</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LINKS.map(({ page, label, icon: Icon, tip }) => {
          const button = (
            <Button key={page} variant="outline" size="sm" className="group" onClick={() => void gmi.app.openConsole(page).catch(() => undefined)}>
              <Icon className="text-muted-foreground" />
              {label}
              <ArrowUpRight className="-mr-0.5 text-muted-foreground transition-transform duration-150 ease-out group-hover:-translate-y-px group-hover:translate-x-px" />
            </Button>
          );
          return tip ? (
            <Tooltip key={page} label={tip}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
    </section>
  );
}
