// The Launch tab (§6.1, §6.2, §7.1): the wizard over a draft kept for the session (switching tabs keeps it), the
// live quote on the review step, the inline daily budget, and create (main asks natively, then creates once).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, KeyRound, Rocket, Wallet } from 'lucide-react';
import { create } from 'zustand';
import type { ComputeCatalog, ComputeCreateSpec, ComputeKind, ComputeResource, ComputeSnapshot, CreateQuote } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { Dino } from '@renderer/components/brand/Dino';
import { Plates } from '@renderer/components/brand/Plates';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Spinner } from '@renderer/components/ui/misc';
import type { ComputeKeyView } from '../format';
import { isCancelled, useComputeCatalog, useStoreNow } from '../hooks';
import { Note, Panel } from '../parts';
import { BudgetInline } from './BudgetInline';
import {
  autofill,
  buildSpec,
  initialDraft,
  LAUNCH_STEPS,
  needsDailyBudget,
  selectedOffer,
  STEP_LABEL,
  stepError,
  withKind,
  type LaunchDraft,
  type LaunchStep,
} from './state';
import { OptionsStep, QuoteSummary, ReviewFacts, SizeStep, STEP_HINT, WhatStep, WhereStep } from './steps';

/** The draft lives for the session (in memory only: secret env values never reach storage). */
export const useLaunchDraft = create<{ draft: LaunchDraft; set: (draft: LaunchDraft) => void; reset: (kind?: ComputeKind) => void }>((set) => ({
  draft: initialDraft('container'),
  set: (draft) => set({ draft }),
  reset: (kind = 'container') => set({ draft: initialDraft(kind) }),
}));

/** Happy Dino only on the first successful create of a session (§8.6). */
let celebrated = false;

function Stepper({ current, draft, catalog, onStep }: { current: LaunchStep; draft: LaunchDraft; catalog: ComputeCatalog | undefined; onStep: (s: LaunchStep) => void }) {
  const currentIndex = LAUNCH_STEPS.indexOf(current);
  return (
    <ol aria-label="Launch steps" className="flex flex-wrap items-center gap-1">
      {LAUNCH_STEPS.map((step, i) => {
        // A step is reachable when every step before it is valid.
        const reachable = LAUNCH_STEPS.slice(0, i).every((s) => !stepError(draft, s, catalog));
        const done = i < currentIndex && !stepError(draft, step, catalog);
        return (
          <li key={step} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden className="h-px w-4 bg-border" /> : null}
            <button
              type="button"
              aria-current={step === current ? 'step' : undefined}
              disabled={!reachable}
              onClick={() => onStep(step)}
              className={cn(
                // Small pressable: dips to 0.97 while held; the current-step slab switches instantly (no background ease).
                'flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-[color,scale] duration-160 ease-out focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-97 disabled:opacity-40',
                step === current ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className={cn('font-mono text-3xs tabular-nums', done ? 'text-primary-ink' : 'text-muted-foreground')}>{i + 1}</span>
              {STEP_LABEL[step]}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export interface ReviewProps {
  draft: LaunchDraft;
  catalog: ComputeCatalog | undefined;
  keyView: ComputeKeyView;
  dailyBudgetSet: boolean;
  quote: CreateQuote | undefined;
  quoting: boolean;
  quoteError: unknown;
  onRequote: () => void;
  creating: boolean;
  createError: unknown;
  onCreate: () => void;
  now: number;
}

/** The review step (presentational, so tests can render every state). */
export function ReviewStep(p: ReviewProps) {
  const openConnect = useUi((s) => s.openConnect);
  const navigate = useUi((s) => s.navigate);
  const offer = selectedOffer(p.catalog, p.draft);
  const budgetMissing = needsDailyBudget(p.draft, offer) && !p.dailyBudgetSet;
  const canCreate = p.keyView === 'ready' && !budgetMissing && Boolean(p.quote) && p.quote!.budget.allowed && !p.creating;
  const priceBlocked = p.keyView === 'ready' && !p.quote && p.quoteError instanceof GmiError && p.quoteError.code === 'invalid_input';
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-review="">
      <Panel className="px-4 py-4">
        <ReviewFacts draft={p.draft} catalog={p.catalog} />
      </Panel>
      <div className="flex flex-col gap-4">
        {p.keyView !== 'ready' ? (
          <Panel className="flex flex-col items-start gap-3 px-4 py-4" data-needs-key="">
            <p className="text-[13px] font-medium">Connect Compute to launch</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Prices here are GMI’s public list prices. With a Compute key, GMI Desk shows exactly what your organization can launch, prices it, and asks you
              in a system dialog before anything bills.
            </p>
            <Button onClick={() => openConnect('compute')}>
              <KeyRound /> {p.keyView === 'invalid' ? 'Replace Compute key' : 'Connect Compute'}
            </Button>
          </Panel>
        ) : budgetMissing ? (
          <BudgetInline
            primary
            reason={
              p.draft.kind === 'container'
                ? 'Containers keep billing until they are deleted. GMI Desk needs a daily limit before your first one, so it can warn you and stop what it is allowed to.'
                : 'GPU sandboxes bill by the second. GMI Desk needs a daily limit before your first one.'
            }
          />
        ) : null}
        <Panel className="px-4 py-4" aria-busy={p.quoting || undefined}>
          {p.quote ? (
            <QuoteSummary quote={p.quote} now={p.now} />
          ) : p.quoting ? (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Plates size="sm" /> Pricing with GMI…
            </p>
          ) : p.quoteError ? (
            <ErrorNotice error={p.quoteError} onRetry={priceBlocked ? undefined : p.onRequote} compact />
          ) : (
            <p className="text-xs text-muted-foreground">
              {p.keyView === 'ready' ? (budgetMissing ? 'Set a daily budget to see the full quote.' : 'Pricing…') : 'A live quote needs a Compute key.'}
            </p>
          )}
        </Panel>
        {p.createError && !isCancelled(p.createError) ? <ErrorNotice error={p.createError} /> : null}
        {p.keyView === 'ready' ? (
          <div className="flex flex-col items-start gap-2">
            <Button variant={canCreate ? 'default' : 'outline'} disabled={!canCreate} onClick={p.onCreate} data-create="">
              {p.creating ? <Spinner className="size-3.5 text-current" /> : <Rocket />}
              Create
            </Button>
            {p.quote && !p.quote.budget.allowed ? (
              <Button variant="ghost" size="sm" onClick={() => navigate('usage', { section: 'budget' })}>
                <Wallet /> Review budget
              </Button>
            ) : (
              <Note>{STEP_HINT.native}</Note>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** After a create: what happens next (happy Dino the first time in a session). */
export function LaunchSuccess({ resource, celebrate, onOpen, onAnother }: { resource: ComputeResource; celebrate: boolean; onOpen: () => void; onAnother: () => void }) {
  return (
    <Panel className="flex flex-col items-center gap-2 px-6 py-10 text-center" data-launch-success="">
      {celebrate ? <Dino mood="happy" size={76} className="mb-2" /> : null}
      <p role="status" className="text-sm font-semibold tracking-tight">
        Starting {resource.displayName}
      </p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        GMI is setting it up. GMI Desk watches it, counts its cost toward your budget and applies its lease.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={onOpen}>Open {resource.kind === 'sandbox' ? 'sandbox' : 'container'}</Button>
        <Button variant="ghost" onClick={onAnother}>
          Launch another
        </Button>
      </div>
    </Panel>
  );
}

export function LaunchWizard({
  step: stepParam,
  kind: kindParam,
  snapshot: snapshotParam,
  idc: idcParam,
  catalog: baseCatalog,
  snapshots,
  keyView,
  dailyBudgetSet,
  now,
  onStep,
  onOpenResource,
}: {
  step: LaunchStep;
  kind: ComputeKind | null;
  snapshot: string | null;
  idc: string | null;
  catalog: ComputeCatalog | undefined;
  snapshots: ComputeSnapshot[] | undefined;
  keyView: ComputeKeyView;
  dailyBudgetSet: boolean;
  now: number;
  onStep: (step: LaunchStep) => void;
  onOpenResource: (id: string) => void;
}) {
  const client = useQueryClient();
  const draft = useStoreNow(useLaunchDraft, (s) => s.draft);
  const setDraft = useLaunchDraft((s) => s.set);
  const resetDraft = useLaunchDraft((s) => s.reset);
  const [created, setCreated] = useState<{ resource: ComputeResource; celebrate: boolean } | null>(null);
  const patch = (p: Partial<LaunchDraft>) => setDraft({ ...useLaunchDraft.getState().draft, ...p });

  // Deep links (?kind=, ?snapshot=, ?idc=) seed the draft once per value.
  useEffect(() => {
    let next = useLaunchDraft.getState().draft;
    if (kindParam) next = withKind(next, kindParam);
    if (snapshotParam) next = { ...withKind(next, 'sandbox'), snapshotId: snapshotParam, templateId: null };
    if (idcParam && next.idc !== idcParam) next = { ...next, idc: idcParam, offerId: null };
    if (next !== useLaunchDraft.getState().draft) setDraft(next);
  }, [kindParam, snapshotParam, idcParam, setDraft]);

  // A deep link to a later step fills the earlier ones with defaults; then the first invalid step wins.
  // The public catalog picks only the template and the data centre: sizes come from the effective catalog below (two
  // catalogs picking sizes in turn would never settle).
  const upToIdc: LaunchStep = LAUNCH_STEPS.indexOf(stepParam) > LAUNCH_STEPS.indexOf('size') ? 'size' : stepParam;
  const base = useMemo(() => autofill(draft, baseCatalog, upToIdc, { preselectSandboxSize: false }), [draft, baseCatalog, upToIdc]);
  // With a key, the chosen data centre's own products (real SKUs) replace the public aggregated sizes.
  const idcForCatalog = keyView === 'ready' ? base.idc : null;
  const idcCatalog = useComputeCatalog(idcForCatalog, idcForCatalog !== null);
  const catalog = idcForCatalog && idcCatalog.data ? idcCatalog.data : baseCatalog;
  const filled = useMemo(() => autofill(base, catalog, stepParam), [base, catalog, stepParam]);
  useEffect(() => {
    if (filled !== draft) setDraft(filled);
  }, [filled, draft, setDraft]);
  const blocking = LAUNCH_STEPS.slice(0, LAUNCH_STEPS.indexOf(stepParam)).find((s) => stepError(filled, s, catalog));
  const step: LaunchStep = catalog && blocking ? blocking : stepParam;

  const spec = useMemo(() => (step === 'review' ? buildSpec(filled, catalog) : null), [step, filled, catalog]);
  const specKey = spec ? JSON.stringify(spec) : null;
  const offer = selectedOffer(catalog, filled);
  const budgetMissing = needsDailyBudget(filled, offer) && !dailyBudgetSet;

  // A new quote clears an earlier create error (e.g. "the price was refreshed").
  const quote = useMutation({ mutationFn: (s: ComputeCreateSpec) => gmi.compute.quoteCreate(s), onMutate: (): void => resetCreate.current() });
  const resetCreate = useRef<() => void>(() => undefined);
  const lastQuoted = useRef<string | null>(null);
  const requote = () => {
    if (!spec) return;
    lastQuoted.current = specKey;
    quote.mutate(spec);
  };
  useEffect(() => {
    if (keyView !== 'ready' || !spec || budgetMissing || specKey === lastQuoted.current) return;
    lastQuoted.current = specKey;
    quote.mutate(spec);
    // Re-quote only when the spec, the key or the budget requirement changes (not on every render).
  }, [keyView, specKey, budgetMissing]);
  const currentQuote = quote.data && lastQuoted.current === specKey ? quote.data : undefined;

  const createMutation = useMutation({
    mutationFn: async () => {
      const q = currentQuote;
      // Quotes live 5 minutes; an old one is priced again first (the user then sees the new price and clicks again).
      if (!q || Date.parse(q.expiresAt) <= Date.now() + 5_000) {
        if (spec) quote.mutate(spec);
        throw new GmiError('invalid_input', 'The price was refreshed. Check it and create again.');
      }
      return gmi.compute.create(q.quoteId);
    },
    onSuccess: (resource) => {
      const celebrate = !celebrated;
      celebrated = true;
      setCreated({ resource, celebrate });
      resetDraft(filled.kind);
      lastQuoted.current = null;
      void client.invalidateQueries({ queryKey: ['compute'] });
      void client.invalidateQueries({ queryKey: qk.budget });
    },
  });

  resetCreate.current = createMutation.reset;

  if (created)
    return (
      <LaunchSuccess
        resource={created.resource}
        celebrate={created.celebrate}
        onOpen={() => onOpenResource(created.resource.id)}
        onAnother={() => {
          setCreated(null);
          onStep('template');
        }}
      />
    );

  const index = LAUNCH_STEPS.indexOf(step);
  const error = stepError(filled, step, catalog);
  const go = (s: LaunchStep) => onStep(s);
  const signedOut = keyView !== 'ready' || catalog?.scope !== 'account';

  return (
    <div className="flex flex-col gap-5" data-step={step}>
      <Stepper current={step} draft={filled} catalog={catalog} onStep={go} />
      <div>
        {step === 'template' ? (
          <WhatStep draft={filled} catalog={catalog} snapshots={snapshots} onKind={(kind) => setDraft(withKind(filled, kind))} patch={patch} />
        ) : step === 'idc' ? (
          <WhereStep draft={filled} catalog={catalog} patch={patch} />
        ) : step === 'size' ? (
          <SizeStep draft={filled} catalog={catalog} patch={patch} signedOut={signedOut} />
        ) : step === 'options' ? (
          <OptionsStep draft={filled} catalog={catalog} patch={patch} />
        ) : (
          <ReviewStep
            draft={filled}
            catalog={catalog}
            keyView={keyView}
            dailyBudgetSet={dailyBudgetSet}
            quote={currentQuote}
            quoting={quote.isPending}
            quoteError={lastQuoted.current === specKey ? quote.error : null}
            onRequote={requote}
            creating={createMutation.isPending}
            createError={createMutation.error}
            onCreate={() => createMutation.mutate()}
            now={now}
          />
        )}
      </div>
      {step !== 'review' ? (
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <Button variant="ghost" onClick={() => go(LAUNCH_STEPS[index - 1]!)} disabled={index === 0}>
            <ArrowLeft /> Back
          </Button>
          <div className="flex items-center gap-3">
            {error && catalog ? <span className="text-2xs text-muted-foreground">{error}</span> : null}
            <Button variant={error ? 'outline' : 'default'} disabled={Boolean(error)} onClick={() => go(LAUNCH_STEPS[index + 1]!)}>
              {index === LAUNCH_STEPS.length - 2 ? 'Review' : 'Continue'} <ArrowRight />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex border-t border-border pt-4">
          <Button variant="ghost" onClick={() => go('options')}>
            <ArrowLeft /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
