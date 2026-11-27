import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { DinoMood } from '@renderer/components/brand/Dino';
import { EmptyState, MicroLabel } from '@renderer/components/ui/misc';
import { PageBody, PageHeader } from '@renderer/components/PageHeader';

/** Temporary placeholder used until a page is implemented. */
export function StubPage({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <PageBody>
      <PageHeader title={title} description={description} />
      {children ?? <EmptyState dino="sleep" title="Coming soon" description="This page is still being built." />}
    </PageBody>
  );
}

export interface StubPageSpec {
  title: string;
  /** The page's one-line description (under the top bar). */
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  dino?: DinoMood;
  /** What the page will offer, shown quietly under the empty state. */
  preview?: Array<{ icon: LucideIcon; title: string; description: string }>;
}

/**
 * A placeholder page component for a feature that is registered but not built yet (pages/registry.<feature>.ts).
 * Follows the "nothing yet" pattern: sleeping Dino, no lime (there is nothing to do here yet).
 */
export function makeStubPage(spec: StubPageSpec): ComponentType {
  function FeatureStubPage() {
    return (
      <StubPage title={spec.title} description={spec.description}>
        <div className="flex flex-col items-center gap-8 pb-10">
          <EmptyState dino={spec.dino ?? 'sleep'} title={spec.emptyTitle} description={spec.emptyDescription} className="pb-2" />
          {spec.preview?.length ? (
            <section aria-label="Coming next" className="flex w-full max-w-3xl flex-col gap-2.5">
              <MicroLabel as="p" className="px-px">
                Coming next
              </MicroLabel>
              <ul className="grid gap-3 sm:grid-cols-3">
                {spec.preview.map(({ icon: Icon, title, description }) => (
                  <li key={title} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3.5 py-3">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                      <Icon aria-hidden className="size-3.5 shrink-0 text-primary-ink" />
                      {title}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </StubPage>
    );
  }
  FeatureStubPage.displayName = `StubPage(${spec.title})`;
  return FeatureStubPage;
}
