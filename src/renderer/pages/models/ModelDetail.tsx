import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, Check, ChevronDown, ChevronUp, LogIn, MessageSquare, Sparkles, Star } from 'lucide-react';
import type { CatalogModel, ModelDetail as ModelDetailData, ModelParameter } from '@shared/contracts/catalog';
import { formatDate, formatTokens } from '@shared/lib/format';
import { formatUsd } from '@shared/lib/money';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Markdown } from '@renderer/components/Markdown';
import { Badge, DiscountBadge, discountLabel } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Kbd, microLabel, Skeleton } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { apiLabel, kindLabel } from './filter';
import { CopyButton, Fact, ModalityGlyph, modalityLabel, ModelIcon, NewBadge, PanelSection } from './parts';
import { pricingTable, type PricingRow } from './pricing';

const SOURCE_LABELS: Record<string, string> = {
  mcp: 'GMI sign-in (MCP)',
  models_api: 'Models API',
  public_media: 'Public catalog',
  public_prices: 'Price list',
  featured: 'Featured list',
  leaderboard: 'Leaderboard',
};

function PriceRow({ row, discounted }: { row: Extract<PricingRow, { type: 'price' }>; discounted: boolean }) {
  return (
    <tr className={cn(!row.nested && 'border-t border-border first:border-t-0')}>
      <td className={cn('pr-2 text-xs text-muted-foreground', row.nested ? 'py-1 pl-2' : 'py-1.5')}>
        {row.group ? <span className="sr-only">{row.group}: </span> : null}
        {row.label}
      </td>
      {discounted ? (
        <td className={cn('whitespace-nowrap pr-2 text-right text-xs tabular-nums text-muted-foreground line-through decoration-muted-foreground/50', row.nested ? 'py-1' : 'py-1.5')}>
          {row.list !== null ? formatUsd(row.list) : null}
        </td>
      ) : null}
      <td className={cn('whitespace-nowrap text-right text-xs tabular-nums text-foreground', discounted ? 'font-semibold' : 'font-medium', row.nested ? 'py-1' : 'py-1.5')}>
        {row.charged === null ? <span className="font-normal text-muted-foreground/60">—</span> : formatUsd(row.charged)}
      </td>
    </tr>
  );
}

function PricingTable({ model, signedIn }: { model: CatalogModel; signedIn: boolean }) {
  const table = pricingTable(model);
  const off = discountLabel(model.discount);

  if (!table) {
    return <p className="text-xs text-muted-foreground">GMI does not publish a price for this model.</p>;
  }
  const { rows, unitNote, discounted } = table;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto rounded-md border border-border bg-card px-2.5">
        <table className="w-full border-collapse">
          <thead className="sr-only">
            <tr>
              <th>Item</th>
              {discounted ? <th>List price</th> : null}
              <th>{discounted ? 'Your price' : 'Price'}</th>
            </tr>
          </thead>
          <tbody>
            {discounted ? (
              <tr aria-hidden>
                <td className="pb-0.5 pt-2" />
                <td className={cn(microLabel, 'whitespace-nowrap pb-0.5 pr-2 pt-2 text-right')}>List</td>
                <td className={cn(microLabel, 'whitespace-nowrap pb-0.5 pt-2 text-right', signedIn && 'text-primary-ink')}>{signedIn ? 'You pay' : 'Price'}</td>
              </tr>
            ) : null}
            {rows.map((row, i) =>
              row.type === 'heading' ? (
                <tr key={`h-${i}`} className="border-t border-border">
                  <td colSpan={discounted ? 3 : 2} className="pb-0.5 pt-1.5 text-3xs text-muted-foreground">
                    {row.label}
                  </td>
                </tr>
              ) : (
                <PriceRow key={`p-${i}`} row={row} discounted={discounted} />
              ),
            )}
          </tbody>
        </table>
      </div>
      <p className="text-3xs text-muted-foreground">
        {unitNote}
        {off ? (
          <>
            {' · '}
            <span className="font-medium text-primary-ink">{off.slice(1)} off</span>
            {signedIn ? ' for your organization' : ' (public promotion)'}
          </>
        ) : null}
        {!signedIn ? ' · sign in for your organization’s price' : ''}
      </p>
      {model.mediaPricing?.details ? <p className="text-2xs leading-relaxed text-muted-foreground">{model.mediaPricing.details}</p> : null}
    </div>
  );
}

function ParameterRow({ p }: { p: ModelParameter }) {
  const values = p.enum ?? [];
  const shown = values.slice(0, 8);
  const range =
    p.min !== null || p.max !== null
      ? p.type === 'image' || p.type === 'video' || p.type === 'audio' || p.type === 'file'
        ? `up to ${p.max ?? '∞'}`
        : `${p.min ?? '−∞'}–${p.max ?? '∞'}`
      : null;
  const def = p.default === null || p.default === undefined ? null : typeof p.default === 'object' ? JSON.stringify(p.default) : String(p.default);
  return (
    <li className="flex flex-col gap-1 border-t border-border py-2 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-2xs text-foreground">{p.name}</span>
        <Badge variant="outline" className="px-1 font-normal">
          {p.rawType ?? p.type}
        </Badge>
        {p.required ? (
          <Badge variant="primary" className="px-1">
            required
          </Badge>
        ) : null}
      </div>
      {p.description ? <p className="line-clamp-2 text-2xs leading-snug text-muted-foreground">{p.description}</p> : null}
      {def !== null || range ? (
        <p className="text-3xs tabular-nums text-muted-foreground">
          {def !== null ? (
            <>
              Default <span className="font-mono text-foreground/80">{def.length > 40 ? `${def.slice(0, 39)}…` : def}</span>
            </>
          ) : null}
          {def !== null && range ? ' · ' : null}
          {range ? `Range ${range}` : null}
        </p>
      ) : null}
      {shown.length ? (
        <div className="flex flex-wrap gap-1">
          {shown.map((v) => (
            <span key={String(v)} className="rounded border border-border bg-muted/50 px-1 font-mono text-3xs text-foreground/80">
              {p.enumLabels?.[String(v)] ?? String(v)}
            </span>
          ))}
          {values.length > shown.length ? <span className="text-3xs text-muted-foreground">+{values.length - shown.length} more</span> : null}
        </div>
      ) : null}
    </li>
  );
}

function Parameters({ detail, loading, error, onRetry }: { detail: ModelDetailData | undefined; loading: boolean; error: unknown; onRetry: () => void }) {
  if (loading && !detail) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  }
  if (error && !detail) return <ErrorNotice error={error} onRetry={onRetry} compact />;
  const params = detail?.parameters ?? null;
  if (!params || params.length === 0) return <p className="text-xs text-muted-foreground">GMI publishes no parameters for this model.</p>;
  return (
    <ul className="flex flex-col rounded-md border border-border bg-card px-2.5 py-2">
      {params.map((p) => (
        <ParameterRow key={p.name} p={p} />
      ))}
    </ul>
  );
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.25rem] items-center gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-[2px] bg-muted dark:bg-white/[0.07]">
        <span className="block h-full rounded-[2px] bg-brand-olive dark:bg-primary" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      <span className="text-right text-2xs font-medium tabular-nums">{value.toFixed(1)}</span>
    </div>
  );
}

function LongDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 700;
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn('relative', long && !expanded && 'max-h-56 overflow-hidden')}>
        {/* Headings sized for the narrow panel. `!`: .gmi-markdown is unlayered CSS and beats plain utilities (see
            Markdown.tsx); font-size-only values, so the block keeps its own line heights. */}
        <Markdown className="text-xs leading-relaxed [&_h1]:text-[13px]! [&_h2]:text-[13px]! [&_h3]:text-[12px]!">{text}</Markdown>
        {long && !expanded ? <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-sidebar to-transparent" /> : null}
      </div>
      {long ? (
        <Button variant="link" size="xs" className="self-start text-2xs" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronUp /> : <ChevronDown />}
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}

function Modalities({ model }: { model: CatalogModel }) {
  const chip = (type: string, required: boolean) => (
    <span key={type} className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-px text-2xs">
      <ModalityGlyph type={type} className="size-3 text-muted-foreground" />
      {modalityLabel(type)}
      {required ? <span className="text-3xs text-muted-foreground">req.</span> : null}
    </span>
  );
  if (model.inputs.length === 0 && model.outputs.length === 0) return null;
  return (
    <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5">
      <dt className={cn(microLabel, 'pt-[3px]')}>Inputs</dt>
      <dd className="flex flex-wrap gap-1">{model.inputs.length ? model.inputs.map((m) => chip(m.type, m.required && model.kind !== 'llm')) : '—'}</dd>
      <dt className={cn(microLabel, 'pt-[3px]')}>Outputs</dt>
      <dd className="flex flex-wrap gap-1">{model.outputs.length ? model.outputs.map((m) => chip(m.type, false)) : '—'}</dd>
    </dl>
  );
}

export interface ModelDetailProps {
  model: CatalogModel | null;
  signedIn: boolean;
  loading: boolean;
  onAcknowledge: (id: string) => void;
  onSignIn: () => void;
}

export function ModelDetailPanel({ model, signedIn, loading, onAcknowledge, onSignIn }: ModelDetailProps) {
  const navigate = useUi((s) => s.navigate);
  const detail = useQuery({
    queryKey: qk.model(model?.id ?? ''),
    queryFn: () => gmi.catalog.getModel(model?.id ?? ''),
    enabled: Boolean(model),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (!model) {
    if (loading) {
      return (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-8" />
          <Skeleton className="h-24" />
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
        <p className={microLabel}>No model selected</p>
        <p className="max-w-56 text-xs text-muted-foreground">Pick a model to see its prices, parameters and benchmarks.</p>
      </div>
    );
  }

  const m: CatalogModel = detail.data && detail.data.id === model.id ? { ...model, ...detail.data, isNew: model.isNew, firstSeenAt: model.firstSeenAt } : model;
  const isLlm = m.kind === 'llm';
  const off = discountLabel(m.discount);
  const longDescription = detail.data?.longDescription ?? null;
  const showDescription = m.description && (!longDescription || !longDescription.includes(m.description.slice(0, 60)));
  const lb = m.leaderboard;
  const created = m.createdAt ? formatDate(m.createdAt) : null;
  const firstSeen = m.firstSeenAt && !m.firstSeenAt.startsWith('2000-') ? formatDate(m.firstSeenAt) : null;

  const enterHint = (
    <Kbd className="ml-auto border-black/15 bg-black/[0.08] text-primary-foreground" aria-hidden>
      ↵
    </Kbd>
  );
  const primary = isLlm ? (
    <Button className="flex-1" disabled={!m.available} onClick={() => navigate('chat', { new: '1', model: m.id })} title="Enter in the list">
      <MessageSquare /> Chat with this model
      {enterHint}
    </Button>
  ) : (
    <Button className="flex-1" disabled={!m.available} onClick={() => navigate('create', { model: m.id })} title="Enter in the list">
      <Sparkles /> Create with this model
      {enterHint}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <ModelIcon model={m} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[15px] font-semibold leading-snug tracking-[-0.01em]">{m.name}</h2>
            <p className={cn(microLabel, 'mt-1 truncate')} title={`${m.provider ?? 'Unknown provider'} · ${kindLabel(m.kind)}`}>
              {m.provider ?? 'Unknown provider'} · {kindLabel(m.kind)}
            </p>
          </div>
        </div>
        {m.isNew || m.featured || off || m.openSource || !m.available || m.api === 'responses' ? (
          <div className="flex flex-wrap items-center gap-1">
            {m.isNew ? <NewBadge /> : null}
            {m.featured ? (
              <Badge variant="outline" className="text-foreground/85">
                <Star className="fill-current text-primary-ink" /> Featured
              </Badge>
            ) : null}
            {off ? (
              <DiscountBadge discount={m.discount}>
                <BadgePercent /> {off.slice(1)} off
              </DiscountBadge>
            ) : null}
            {m.openSource ? <Badge variant="outline">Open weights</Badge> : null}
            {m.api === 'responses' ? (
              <Tooltip label="Called through GMI's Responses API, not Chat Completions">
                <Badge variant="outline">Responses API</Badge>
              </Tooltip>
            ) : null}
            {!m.available ? <Badge variant="warning">Unavailable</Badge> : null}
            {m.isNew ? (
              <Button variant="ghost" size="xs" className="ml-auto h-5 px-1.5 text-3xs" onClick={() => onAcknowledge(m.id)}>
                <Check /> Mark seen
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-border bg-muted/40 pl-2 pr-0.5">
          <span className="min-w-0 flex-1 select-text truncate font-mono text-2xs text-foreground/90" title={m.id}>
            {m.id}
          </span>
          <CopyButton text={m.id} label="Copy model id" />
        </div>
        {m.available ? (
          <div className="flex">{primary}</div>
        ) : (
          <Tooltip label="GMI lists this model but it is not available to your organization right now">
            <span className="flex">{primary}</span>
          </Tooltip>
        )}
        {showDescription ? <p className="text-xs leading-relaxed text-muted-foreground">{m.description}</p> : null}
      </header>

      <PanelSection title="Pricing">
        <PricingTable model={m} signedIn={signedIn} />
        {!signedIn ? (
          <Button variant="outline" size="sm" className="self-start" onClick={onSignIn}>
            <LogIn /> Sign in for your prices
          </Button>
        ) : null}
      </PanelSection>

      <PanelSection title="Details">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {isLlm ? <Fact label="Context">{m.contextLength ? `${formatTokens(m.contextLength)} tokens` : '—'}</Fact> : null}
          {isLlm ? <Fact label="Quantization">{m.quantization ? m.quantization.toUpperCase() : '—'}</Fact> : null}
          <Fact label="API">{apiLabel(m.api)}</Fact>
          <Fact label="Kind">{kindLabel(m.kind)}</Fact>
          {created ? <Fact label="Added by GMI">{created}</Fact> : null}
          {firstSeen && firstSeen !== created ? <Fact label="First seen here">{firstSeen}</Fact> : null}
          {m.openSource !== null && m.openSource !== undefined ? <Fact label="Weights">{m.openSource ? 'Open' : 'Proprietary'}</Fact> : null}
        </dl>
        <Modalities model={m} />
        {m.tags.length ? (
          <div className="flex flex-wrap gap-1">
            {m.tags.map((t) => (
              <span key={t} className="rounded bg-muted px-1.5 py-px text-3xs text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </PanelSection>

      {lb && (lb.overall !== null || lb.coding !== null) ? (
        <PanelSection title="Benchmarks" meta="GMI leaderboard">
          <div className="flex flex-col gap-1.5">
            <ScoreBar label="Overall" value={lb.overall} />
            <ScoreBar label="Coding" value={lb.coding} />
            <ScoreBar label="Agentic" value={lb.agentic} />
            <ScoreBar label="Reasoning" value={lb.reasoning} />
          </div>
        </PanelSection>
      ) : null}

      {!isLlm ? (
        <PanelSection title="Parameters" meta={detail.data?.parameters ? `${detail.data.parameters.length}` : undefined}>
          <Parameters detail={detail.data} loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()} />
        </PanelSection>
      ) : null}

      {longDescription ? (
        <PanelSection title="About">
          <LongDescription text={longDescription} />
        </PanelSection>
      ) : null}

      <p className="border-t border-border pt-3 text-3xs leading-relaxed text-muted-foreground">
        <span className={cn(microLabel, 'mr-1.5')}>Sources</span>
        {/* Each name keeps its trailing "·", so a wrapped line never starts with one. */}
        {m.sources.length === 0
          ? '—'
          : m.sources.map((s, i) => (
              <Fragment key={s}>
                {i > 0 ? ' ' : null}
                <span className="whitespace-nowrap">
                  {SOURCE_LABELS[s] ?? s}
                  {i < m.sources.length - 1 ? ' ·' : null}
                </span>
              </Fragment>
            ))}
      </p>
    </div>
  );
}
