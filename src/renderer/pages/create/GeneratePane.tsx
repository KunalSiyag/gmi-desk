import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, ChevronRight, Info, Play, RotateCcw } from 'lucide-react';
import type { CatalogModel } from '@shared/contracts/catalog';
import type { MediaEstimate } from '@shared/contracts/media';
import type { BudgetStatus } from '@shared/contracts/usage';
import { describeError } from '@renderer/lib/errors';
import { gmi, isMac } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Plates } from '@renderer/components/brand/Plates';
import { Badge, DiscountBadge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Textarea } from '@renderer/components/ui/input';
import { Kbd, MicroLabel, microLabel, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { pressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { fieldId, FieldLabel, ParamField } from './fields';
import {
  buildRequest,
  catalogUnpricedReason,
  estimateSummary,
  formatCents,
  formIssues,
  initialValues,
  layoutFields,
  promptPlaceholder,
  requestKey,
  sameValues,
  unitPrice,
  type CreateTab,
} from './form';
import { useLiveEstimate, type useRunFlow } from './hooks';
import { useCreateUi } from './state';

const PROMPT_ID = 'create-prompt';
/** Shortcut keys drawn on the lime Run button (black ink at low opacity, not a white wash). */
export const RUN_KBD = 'border-primary-foreground/15 bg-primary-foreground/[0.07] text-primary-foreground/75';

/** Last focus request served (module scope: survives remounts when the model changes). */
let handledFocusSeq = 0;

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelHeader({ model }: { model: CatalogModel }) {
  const navigate = useUi((s) => s.navigate);
  const price = unitPrice(model);
  const source = model.provider ?? (model.kind === 'workflow' ? 'GMI Studio workflow' : null);
  return (
    <header className="flex flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {source ? <MicroLabel>{source}</MicroLabel> : null}
          <h2 className="flex min-w-0 items-center gap-1.5 text-base font-semibold leading-tight tracking-tight">
            <span className="truncate" title={model.id}>
              {model.name}
            </span>
            {model.isNew ? <Badge variant="new">New</Badge> : null}
          </h2>
          {price ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs tabular-nums">
              <span className="font-medium">{price.charged}</span>
              <span className="text-muted-foreground">/ {price.unit}</span>
              {price.list ? <span className="text-muted-foreground line-through decoration-muted-foreground/60">{price.list}</span> : null}
              <DiscountBadge discount={model.discount} />
            </p>
          ) : null}
        </div>
        <Tooltip label="Open in Models">
          <Button variant="ghost" size="icon-xs" aria-label="Open in Models" onClick={() => navigate('models', { model: model.id })}>
            <ArrowUpRight />
          </Button>
        </Tooltip>
      </div>
      {model.description ? (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={model.description}>
          {model.description}
        </p>
      ) : null}
    </header>
  );
}

function EstimateLine({
  model,
  estimate,
  pending,
  stale,
  error,
  onRetry,
  issues,
  promptMissing,
}: {
  model: CatalogModel;
  estimate: MediaEstimate | undefined;
  pending: boolean;
  stale: boolean;
  error: unknown;
  onRetry: () => void;
  issues: number;
  promptMissing: boolean;
}) {
  const price = unitPrice(model);
  // GMI cannot price some models before they run: say so instead of showing its placeholder figure.
  const unpricedNote = estimate?.unpriced ? (estimate.note ?? catalogUnpricedReason(model)) : catalogUnpricedReason(model);
  let headline: ReactNode;
  let detail: ReactNode = null;

  if (unpricedNote && !error) {
    headline = <span className="flex h-7 items-center text-[13px] font-medium text-warning-foreground">No price before it runs</span>;
    detail = (
      <span className="block truncate" title={unpricedNote}>
        {unpricedNote}
      </span>
    );
  } else if (error) {
    const view = describeError(error);
    headline = <span className="flex h-7 items-center text-[13px] font-medium text-destructive">Could not price this</span>;
    detail = (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate" title={view.message || view.title}>
          {view.message || view.title}
        </span>
        <button type="button" onClick={onRetry} className="shrink-0 text-foreground underline-offset-2 hover:underline">
          Retry
        </button>
      </span>
    );
  } else if (estimate && (!promptMissing || pending)) {
    const summary = estimateSummary(estimate);
    headline = (
      <span className={cn('flex items-baseline gap-1.5 transition-opacity duration-150 ease-out', (pending || stale) && 'opacity-60')}>
        <span className="text-xl font-semibold leading-7 tracking-tight tabular-nums">{summary.charged}</span>
        <span className="text-2xs text-muted-foreground">estimated</span>
        {pending ? <Plates size="sm" className="self-center" /> : null}
      </span>
    );
    const parts = [summary.detail, estimate.unit ? `priced per ${estimate.unit}` : null].filter(Boolean).join(' · ');
    detail = (
      <span className={cn('flex min-w-0 items-center gap-1 tabular-nums transition-opacity duration-150 ease-out', (pending || stale) && 'opacity-60')}>
        <span className="truncate">{parts || 'No discount on this model'}</span>
        {estimate.note ? (
          <Tooltip label={estimate.note}>
            <button type="button" aria-label="About this price" className="shrink-0 text-muted-foreground hover:text-foreground">
              <Info className="size-3" />
            </button>
          </Tooltip>
        ) : null}
      </span>
    );
  } else if (pending) {
    headline = (
      <span className="flex h-7 items-center gap-1.5 text-[13px] text-muted-foreground">
        <Plates size="sm" /> Estimating…
      </span>
    );
  } else if (promptMissing) {
    headline = price ? (
      <span className="flex items-baseline gap-1.5 tabular-nums">
        <span className="text-xl font-semibold leading-7 tracking-tight">{price.charged}</span>
        <span className="text-2xs text-muted-foreground">/ {price.unit}</span>
      </span>
    ) : (
      <span className="flex h-7 items-center text-[13px] text-muted-foreground">Price on request</span>
    );
    detail = 'Write a prompt for an exact price';
  } else if (issues > 0) {
    headline = (
      <span className="flex h-7 items-center text-[13px] font-medium text-warning-foreground">
        {issues === 1 ? '1 field needs attention' : `${issues} fields need attention`}
      </span>
    );
    detail = 'Fix it to get a price';
  } else {
    headline = <span className="flex h-7 items-center text-[13px] text-muted-foreground">—</span>;
  }

  return (
    <div aria-live="polite" className="flex min-w-0 flex-col">
      {headline}
      {detail ? <span className="text-3xs text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function BudgetLine({ estimate, budget }: { estimate: MediaEstimate | undefined; budget: BudgetStatus | undefined }) {
  const navigate = useUi((s) => s.navigate);
  const review = (
    <button type="button" onClick={() => navigate('usage', { section: 'budget' })} className="shrink-0 underline-offset-2 hover:underline">
      Review budget
    </button>
  );
  if (estimate && !estimate.budget.allowed) {
    return (
      <p className="flex min-w-0 items-start gap-1.5 text-2xs text-destructive">
        <AlertTriangle className="mt-px size-3 shrink-0" />
        <span className="min-w-0 flex-1">{estimate.budget.reason ?? 'This would go over your budget.'}</span>
        {review}
      </p>
    );
  }
  if (estimate?.budget.reason) {
    return (
      <p className="flex min-w-0 items-start gap-1.5 text-2xs text-warning-foreground">
        <AlertTriangle className="mt-px size-3 shrink-0" />
        <span className="min-w-0 flex-1">{estimate.budget.reason}</span>
      </p>
    );
  }
  if (!budget) return null;
  const { remainingTodayUsd: day, remainingMonthUsd: month } = budget;
  if (day === null && month === null) {
    return (
      <p className="flex items-center gap-1 text-3xs text-muted-foreground">
        No spending limit set ·{' '}
        <button type="button" onClick={() => navigate('usage', { section: 'budget' })} className="underline-offset-2 hover:underline">
          Set one
        </button>
      </p>
    );
  }
  const parts = [day !== null ? `${formatCents(day)} left today` : null, month !== null ? `${formatCents(month)} this month` : null].filter(Boolean);
  return <p className="text-3xs tabular-nums text-muted-foreground">Budget: {parts.join(' · ')}</p>;
}

export interface GeneratePaneProps {
  model: CatalogModel;
  budget: BudgetStatus | undefined;
  run: ReturnType<typeof useRunFlow>;
}

/** Center pane: the model's header, the form generated from its schema, the live price and Run. */
export function GeneratePane({ model, budget, run }: GeneratePaneProps) {
  const detail = useQuery({ queryKey: qk.model(model.id), queryFn: () => gmi.catalog.getModel(model.id), staleTime: 5 * 60_000 });
  const layout = useMemo(() => layoutFields(detail.data?.parameters), [detail.data]);
  const { schema } = layout;

  const prompt = useCreateUi((s) => s.prompt);
  const setPrompt = useCreateUi((s) => s.setPrompt);
  const values = useCreateUi((s) => s.values);
  const setValue = useCreateUi((s) => s.setValue);
  const formModelId = useCreateUi((s) => s.formModelId);
  const initForm = useCreateUi((s) => s.initForm);
  const resetValues = useCreateUi((s) => s.resetValues);
  const touched = useCreateUi((s) => s.touched);
  const setTouched = useCreateUi((s) => s.setTouched);
  const advancedOpen = useCreateUi((s) => s.advancedOpen);
  const setAdvancedOpen = useCreateUi((s) => s.setAdvancedOpen);
  const focusSeq = useCreateUi((s) => s.focusSeq);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // A new model (or "Use these settings") starts from the schema defaults, overlaid with the preset.
  useEffect(() => {
    if (!detail.data || formModelId === model.id) return;
    const preset = useCreateUi.getState().preset;
    const mine = preset?.modelId === model.id ? preset : null;
    initForm(model.id, initialValues(schema, mine?.values), mine ? mine.prompt : null);
  }, [detail.data, formModelId, model.id, schema, initForm]);

  const ready = formModelId === model.id && detail.data !== undefined;
  // Focus requests (palette "New image", "Use these settings") wait until the form exists, and run once.
  useEffect(() => {
    if (!ready || focusSeq <= handledFocusSeq) return;
    handledFocusSeq = focusSeq;
    promptRef.current?.focus();
  }, [ready, focusSeq]);
  const issues = useMemo(() => formIssues(schema, prompt, ready ? values : {}), [schema, prompt, values, ready]);
  const request = useMemo(
    () => (ready && issues.count === 0 ? buildRequest(model.id, schema, prompt, values) : null),
    [ready, issues.count, model.id, schema, prompt, values],
  );
  const estimate = useLiveEstimate(request);
  // Editing the form clears the last run error (it was about a different request).
  const key = request ? requestKey(request) : null;
  const lastKey = useRef(key);
  const clearRunError = run.clearError;
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    clearRunError();
  }, [key, clearRunError]);
  const blocked = estimate.data !== undefined && !estimate.stale && !estimate.data.budget.allowed;
  // Nothing to approve or budget: the main process refuses these runs, so Run is off (Ctrl+Enter explains why).
  const unpriced = catalogUnpricedReason(model) !== null || (estimate.data?.unpriced === true && !estimate.stale);

  const visibleIssue = (name: string): string | null => {
    const message = issues.fields[name];
    if (!message) return null;
    return issues.missing.has(name) && !touched ? null : message;
  };
  const advancedIssues = layout.advanced.filter((p) => visibleIssue(p.name)).length;
  const showAdvanced = advancedOpen || advancedIssues > 0;
  const promptIssue = issues.prompt && (!issues.promptMissing || touched) ? issues.prompt : null;
  // Lime is spent on Run only once it can run: an empty or invalid form keeps an outline button (it still explains why).
  const runnable = (request !== null && !blocked && !unpriced) || run.preparing;

  const submit = () => {
    if (!ready) return;
    setTouched(true);
    if (!request) {
      if (issues.prompt) promptRef.current?.focus();
      else {
        const first = [...(layout.negative ? [layout.negative] : []), ...layout.primary, ...layout.advanced].find((p) => issues.fields[p.name]);
        if (first && layout.advanced.includes(first)) setAdvancedOpen(true);
        if (first) window.setTimeout(() => document.getElementById(fieldId(first.name))?.focus(), 0);
      }
      return;
    }
    void run.start(request, { modelName: model.name, estimate: estimate.ready });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  const promptLabel = schema.promptParam?.label ?? 'Prompt';
  const maxChars = schema.promptParam && (schema.promptParam.type === 'string' || schema.promptParam.type === 'text') ? schema.promptParam.max : null;
  const noSchema = ready && schema.all.length === 0;
  const changedFromDefault = ready && !sameValues(values, initialValues(schema));

  return (
    <div className="flex min-h-full flex-col" onKeyDown={onKeyDown}>
      <div className="flex flex-1 flex-col gap-4 px-5 pb-5 pt-4">
        <ModelHeader model={model} />

        {detail.error && !detail.data ? (
          <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
        ) : !ready ? (
          <FormSkeleton />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor={PROMPT_ID}
                param={{ label: promptLabel, required: true, description: schema.promptParam?.description ?? null }}
                aside={maxChars ? `${prompt.trim().length} / ${maxChars}` : null}
              />
              <Textarea
                id={PROMPT_ID}
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={promptPlaceholder(model.kind as CreateTab, schema, model.id)}
                aria-invalid={promptIssue ? true : undefined}
                className={cn(
                  'max-h-[40vh] min-h-28 resize-none text-[13px] [field-sizing:content]',
                  promptIssue && 'border-destructive/60 focus-visible:border-destructive focus-visible:ring-destructive/20',
                )}
              />
              {promptIssue ? <p className="text-2xs text-destructive">{promptIssue}</p> : null}
            </div>

            {layout.negative ? (
              <ParamField
                param={layout.negative}
                value={values[layout.negative.name]}
                onChange={(v) => setValue(layout.negative!.name, v)}
                issue={visibleIssue(layout.negative.name)}
              />
            ) : null}

            {layout.primary.length > 0 ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
                {layout.primary.map((p) => (
                  <ParamField key={p.name} param={p} value={values[p.name]} onChange={(v) => setValue(p.name, v)} issue={visibleIssue(p.name)} />
                ))}
              </div>
            ) : null}

            {layout.advanced.length > 0 ? (
              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={showAdvanced}
                    onClick={() => setAdvancedOpen(!showAdvanced)}
                    className={cn(microLabel, 'flex items-center gap-1 rounded hover:text-foreground', pressMotion)}
                  >
                    <ChevronRight className={cn('size-3.5 transition-transform duration-150 ease-out', showAdvanced && 'rotate-90')} />
                    Advanced
                    <span className="tabular-nums opacity-70">{layout.advanced.length}</span>
                    {advancedIssues > 0 ? <span className="ml-1 size-1.5 rounded-full bg-destructive" aria-label="has problems" /> : null}
                  </button>
                  <div className="h-px flex-1 bg-border" />
                </div>
                {showAdvanced ? (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
                    {layout.advanced.map((p) => (
                      <ParamField key={p.name} param={p} value={values[p.name]} onChange={(v) => setValue(p.name, v)} issue={visibleIssue(p.name)} />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {noSchema ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                {model.kind === 'workflow'
                  ? 'GMI publishes no inputs for this workflow: it runs with your prompt and the settings saved in GMI Studio. Change its inputs in Studio.'
                  : 'GMI publishes no parameters for this model: it runs with your prompt and its defaults.'}
              </p>
            ) : null}

            {changedFromDefault ? (
              <button
                type="button"
                onClick={() => resetValues(initialValues(schema))}
                className={cn('flex items-center gap-1 self-start text-2xs text-muted-foreground hover:text-foreground', pressMotion)}
              >
                <RotateCcw className="size-3" /> Reset settings to the model's defaults
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-background px-5 pb-3 pt-3">
        {run.error ? <ErrorNotice error={run.error} compact /> : null}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {ready ? (
              <EstimateLine
                model={model}
                estimate={estimate.data}
                pending={estimate.pending}
                stale={estimate.stale}
                error={estimate.error}
                onRetry={estimate.refetch}
                issues={issues.count - (issues.promptMissing ? 1 : 0)}
                promptMissing={issues.promptMissing}
              />
            ) : (
              <Skeleton className="h-8 w-32" />
            )}
          </div>
          <Button
            size="lg"
            variant={runnable ? 'default' : 'outline'}
            onClick={submit}
            disabled={!ready || run.preparing || blocked || unpriced}
            className="shrink-0 gap-2 pl-3.5 pr-2.5"
          >
            {run.preparing ? <Spinner className="text-primary-foreground" /> : <Play className="fill-current" />}
            Run
            <span aria-hidden className="flex items-center gap-0.5">
              <Kbd className={runnable ? RUN_KBD : undefined}>{isMac() ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd className={runnable ? RUN_KBD : undefined}>↵</Kbd>
            </span>
          </Button>
        </div>
        <BudgetLine estimate={estimate.stale ? undefined : estimate.data} budget={budget} />
      </div>
    </div>
  );
}
