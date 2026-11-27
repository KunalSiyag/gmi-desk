// The wizard's steps (§6.1): what → where → size → options → review. Presentational: the wizard owns the draft.
import { useId } from 'react';
import { ArrowUpRight, Camera, Check, Plus, Trash2 } from 'lucide-react';
import type { ComputeCatalog, ComputeKind, ComputeSnapshot, CreateQuote } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { activeBarBefore } from '@renderer/components/ui/active-bar';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { Input, Label } from '@renderer/components/ui/input';
import { EmptyState, Skeleton } from '@renderer/components/ui/misc';
import { Select } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';
import { TabStrip } from '@renderer/components/ui/tabs';
import {
  formatDateTime,
  formatMinutes,
  isGpuOffer,
  KIND_LABEL,
  LEASE_ACTION_LABEL,
  leaseSummary,
  looksLikeJwt,
  NAME_MAX,
  offerSpecs,
  offerTitle,
  SANDBOX_TIMEOUT_PRESETS_SEC,
  validateEnvName,
} from '../format';
import { Facts, KIND_ICON, Note } from '../parts';
import { LIST_PRICE_NOTE, PriceTag } from '../PriceTag';
import { AccessStep } from './AccessStep';
import { LeaseEditor } from './LeaseEditor';
import { defaultOffer, idcsFor, offersFor, SANDBOX_DEFAULT_MIN_GIB, selectedOffer, selectedTemplate, templatesFor, type EnvDraft, type LaunchDraft } from './state';

type Patch = (patch: Partial<LaunchDraft>) => void;

/**
 * A selectable card row: accent surface + inner bar when selected (selection rule, D16). Selection and keyboard focus
 * are instant; a press deepens the background (kit rowPressMotion: full-width rows never scale). The content fills the row, so a
 * trailing `ml-auto` (price, ports) lines up against the check column instead of floating mid-row.
 */
function Choice({
  selected,
  disabled,
  onSelect,
  children,
  className,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'relative flex w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:transition-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        rowPressMotion,
        selected && cn('bg-accent transition-none hover:bg-accent', activeBarBefore),
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-3">{children}</span>
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        {selected ? <Check className="size-3.5 text-primary-ink" /> : null}
      </span>
    </button>
  );
}

function ChoiceList({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function WhatStep({
  draft,
  catalog,
  snapshots,
  onKind,
  patch,
}: {
  draft: LaunchDraft;
  catalog: ComputeCatalog | undefined;
  snapshots: ComputeSnapshot[] | undefined;
  onKind: (kind: ComputeKind) => void;
  patch: Patch;
}) {
  const templates = templatesFor(catalog, draft.kind);
  const ready = (snapshots ?? []).filter((s) => s.state === 'ready');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabStrip
          value={draft.kind}
          onValueChange={onKind}
          items={[
            { value: 'container', label: 'GPU container' },
            { value: 'sandbox', label: 'Sandbox' },
          ]}
        />
        <p className="text-2xs text-muted-foreground">
          {draft.kind === 'container'
            ? 'Cluster Engine: a container on a GPU (or CPU) machine. Billed by the hour until deleted.'
            : 'Agentbox: a small Linux machine for code, servers and agents. Pauses when idle.'}
        </p>
      </div>
      {!catalog ? (
        <Skeleton className="h-40" />
      ) : templates.length === 0 && ready.length === 0 ? (
        <EmptyState dino="sleep" title="No templates" description="GMI lists no templates for this kind right now." className="rounded-lg border border-border" />
      ) : (
        <ChoiceList label="Template">
          {templates.map((t) => (
            <Choice key={t.id} selected={!draft.snapshotId && draft.templateId === t.id} onSelect={() => patch({ templateId: t.id, snapshotId: null, ...(t.idc ? { idc: t.idc, offerId: null } : {}) })}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                  <span className="truncate" title={t.name}>
                    {t.name}
                  </span>
                  {t.official ? <Badge variant="outline">Official</Badge> : <Badge variant="outline">Your organization</Badge>}
                </span>
                {t.description ? <span className="truncate text-2xs text-muted-foreground">{t.description}</span> : null}
                {t.image ? <span className="truncate font-mono text-3xs text-muted-foreground">{t.image}</span> : null}
              </span>
              {t.defaultPorts.length ? (
                <span className="ml-auto hidden shrink-0 font-mono text-3xs text-muted-foreground sm:block">
                  {t.defaultPorts.map((p) => `${p.port}${p.label ? ` ${p.label}` : ''}`).join(' · ')}
                </span>
              ) : null}
            </Choice>
          ))}
          {draft.kind === 'sandbox'
            ? ready.map((s) => (
                <Choice key={s.id} selected={draft.snapshotId === s.id} onSelect={() => patch({ snapshotId: s.id, ...(s.idc ? { idc: s.idc, offerId: null } : {}) })}>
                  <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                    <Camera aria-hidden className="size-3.5 text-muted-foreground" />
                    {s.name}
                    <Badge variant="outline">Snapshot</Badge>
                  </span>
                </Choice>
              ))
            : null}
        </ChoiceList>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function WhereStep({ draft, catalog, patch }: { draft: LaunchDraft; catalog: ComputeCatalog | undefined; patch: Patch }) {
  const idcs = idcsFor(catalog, draft.kind);
  const template = selectedTemplate(catalog, draft);
  const pinned = draft.kind === 'sandbox' ? (template?.idc ?? null) : null;
  if (!catalog) return <Skeleton className="h-40" />;
  return (
    <div className="flex flex-col gap-3">
      {pinned ? <Note>This template lives in one data centre.</Note> : null}
      <ChoiceList label="Data centre">
        {idcs.map((idc) => {
          const offers = offersFor(catalog, draft.kind, idc.id);
          const from = offers.find((o) => o.listUsdPerHour !== null)?.listUsdPerHour ?? null;
          const unavailable = idc.status !== 'available';
          return (
            <Choice
              key={idc.id}
              selected={draft.idc === idc.id}
              disabled={unavailable || (pinned !== null && pinned !== idc.id) || offers.length === 0}
              onSelect={() => patch({ idc: idc.id, offerId: null })}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {idc.name}
                  {idc.country ? <span className="font-mono text-3xs text-muted-foreground">{idc.country}</span> : null}
                  {idc.status === 'maintenance' ? <Badge variant="warning">Maintenance</Badge> : idc.status === 'full' ? <Badge variant="default">Full</Badge> : null}
                </span>
                <span className="font-mono text-3xs text-muted-foreground">{idc.id}</span>
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-3">
                {offers.length ? (
                  <span className="text-2xs tabular-nums text-muted-foreground">
                    {offers.length} {offers.length === 1 ? 'size' : 'sizes'}
                  </span>
                ) : (
                  <span className="text-2xs text-muted-foreground">No sizes</span>
                )}
                {from !== null ? <PriceTag usdPerHour={from} from /> : null}
              </span>
            </Choice>
          );
        })}
      </ChoiceList>
      {draft.kind === 'sandbox' && !pinned ? <Note>Leave it unselected to use your organization’s default data centre.</Note> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function SizeStep({ draft, catalog, patch, signedOut }: { draft: LaunchDraft; catalog: ComputeCatalog | undefined; patch: Patch; signedOut: boolean }) {
  const offers = offersFor(catalog, draft.kind, draft.idc);
  const recommended = draft.kind === 'sandbox' ? defaultOffer(catalog, draft.kind, draft.idc) : null;
  if (!catalog) return <Skeleton className="h-40" />;
  return (
    <div className="flex flex-col gap-3">
      {offers.length === 0 ? (
        <EmptyState dino="sleep" title="No sizes here" description="GMI lists no sizes for this data centre right now. Try another one." className="rounded-lg border border-border" />
      ) : (
        <ChoiceList label="Size">
          {offers.map((o) => (
            <Choice key={o.id} selected={draft.offerId === o.id} disabled={o.entitled === false} onSelect={() => patch({ offerId: o.id, idc: draft.idc ?? o.idc })}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {offerTitle(o)}
                  {isGpuOffer(o) || offerTitle(o) === 'CPU' ? null : <Badge variant="outline">CPU</Badge>}
                  {o.entitled === false ? <Badge variant="default">Not enabled</Badge> : null}
                  {recommended?.id === o.id && (o.memoryGiB ?? 0) >= SANDBOX_DEFAULT_MIN_GIB ? <Badge variant="primary">Recommended</Badge> : null}
                </span>
                <span className="truncate text-2xs tabular-nums text-muted-foreground">
                  {[offerSpecs(o, { withTitle: false }), o.diskGiB ? `${o.diskGiB} GiB disk` : ''].filter(Boolean).join(' · ') || '—'}
                  {o.sku ? <span className="ml-2 font-mono text-3xs">{o.sku}</span> : null}
                </span>
              </span>
              <span className="ml-auto shrink-0">
                <PriceTag usdPerHour={o.listUsdPerHour} from={o.sku === null} />
              </span>
            </Choice>
          ))}
        </ChoiceList>
      )}
      {recommended && (recommended.memoryGiB ?? 0) >= SANDBOX_DEFAULT_MIN_GIB ? <Note>{`Sizes under ${SANDBOX_DEFAULT_MIN_GIB} GiB of memory run out on most dev and agent work; pick one only for light scripts.`}</Note> : null}
      <Note>
        {LIST_PRICE_NOTE}
        {signedOut ? ' Signed out, sizes are grouped and show the lowest price; connect a Compute key to see exactly what your organization can launch.' : ''}
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

let envSeq = 0;
const newEnv = (): EnvDraft => ({ key: `env-${++envSeq}`, name: '', value: '', secret: true });

function EnvEditor({ env, onChange }: { env: EnvDraft[]; onChange: (env: EnvDraft[]) => void }) {
  const set = (key: string, patch: Partial<EnvDraft>) => onChange(env.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Environment variables</span>
        <Button variant="ghost" size="xs" onClick={() => onChange([...env, newEnv()])}>
          <Plus /> Add
        </Button>
      </div>
      {env.length ? (
        <ul className="flex flex-col gap-2">
          {env.map((e) => {
            const nameError = e.name ? validateEnvName(e.name) : null;
            return (
              <li key={e.key} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Variable name"
                    value={e.name}
                    onChange={(ev) => set(e.key, { name: ev.target.value })}
                    placeholder="NAME"
                    spellCheck={false}
                    aria-invalid={Boolean(nameError)}
                    className="w-44 font-mono text-xs"
                  />
                  <Input
                    aria-label={`Value of ${e.name || 'variable'}`}
                    type={e.secret ? 'password' : 'text'}
                    value={e.value}
                    onChange={(ev) => set(e.key, { value: ev.target.value })}
                    placeholder="value"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 font-mono text-xs"
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                    <Switch checked={e.secret} onCheckedChange={(on) => set(e.key, { secret: on })} aria-label={`Keep ${e.name || 'value'} secret`} />
                    Secret
                  </label>
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove ${e.name || 'variable'}`} onClick={() => onChange(env.filter((x) => x.key !== e.key))}>
                    <Trash2 />
                  </Button>
                </div>
                {nameError ? <Note tone="danger">{nameError}</Note> : null}
                {looksLikeJwt(e.value) ? (
                  <Note tone="warning">This looks like an API key. GMI Desk refuses your own GMI keys here; anything else is visible to whoever can open the container.</Note>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <Note>
        Secret values stay in GMI Desk’s memory until the create and are never saved. GMI stores them with the resource, where anyone with console access to
        your organization can read them.
      </Note>
    </div>
  );
}

export function OptionsStep({ draft, catalog, patch }: { draft: LaunchDraft; catalog: ComputeCatalog | undefined; patch: Patch }) {
  const ids = useId();
  const offer = selectedOffer(catalog, draft);
  const idc = catalog?.idcs.find((i) => i.id === draft.idc) ?? null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-name`}>Name</Label>
        <Input
          id={`${ids}-name`}
          value={draft.displayName}
          maxLength={NAME_MAX}
          onChange={(e) => patch({ displayName: e.target.value, nameTouched: true })}
          className="max-w-sm"
        />
        <Note>
          {draft.kind === 'container'
            ? 'GMI sees it as gmid-<install tag>-<name>-<random>, so GMI Desk always finds its own containers again.'
            : 'Shown in GMI Desk. GMI sees only a random install id, never your computer’s or your name.'}
        </Note>
      </div>

      {draft.kind === 'container' ? (
        <AccessStep access={draft.access} onChange={(access) => patch({ access })} idc={idc} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-timeout`}>GMI’s timeout</Label>
            <Select
              id={`${ids}-timeout`}
              value={String(draft.timeoutSec)}
              onValueChange={(v) => patch({ timeoutSec: Number(v) })}
              options={SANDBOX_TIMEOUT_PRESETS_SEC.map((s) => ({ value: String(s), label: formatMinutes(s / 60) }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-ontimeout`}>When it times out, GMI</Label>
            <Select
              id={`${ids}-ontimeout`}
              value={draft.onTimeout}
              onValueChange={(v) => patch({ onTimeout: v })}
              options={[
                { value: 'pause', label: 'Pauses it' },
                { value: 'kill', label: 'Deletes it' },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-egress`}>Outbound internet</Label>
            <Select
              id={`${ids}-egress`}
              value={draft.egress.mode}
              onValueChange={(mode) => patch({ egress: { ...draft.egress, mode } })}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'allowlist', label: 'Only hosts I list' },
              ]}
            />
          </div>
          <div className="flex items-end gap-2.5 pb-1.5">
            <Switch id={`${ids}-secure`} checked={draft.secure} onCheckedChange={(secure) => patch({ secure })} />
            <Label htmlFor={`${ids}-secure`} className="font-normal text-muted-foreground">
              Port previews need a token
            </Label>
          </div>
          {draft.egress.mode === 'allowlist' ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor={`${ids}-hosts`}>Allowed hosts</Label>
              <Input
                id={`${ids}-hosts`}
                value={draft.egress.hostnames}
                onChange={(e) => patch({ egress: { ...draft.egress, hostnames: e.target.value } })}
                placeholder="registry.npmjs.org, pypi.org"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Note>An allowlist limits where data can go, not what is sent. A host that accepts uploads can receive your files.</Note>
            </div>
          ) : null}
          {!draft.secure ? (
            <Note tone="warning" className="sm:col-span-2">
              Without a token, anyone who guesses a preview URL can open it. GMI Desk asks you to confirm in a system dialog.
            </Note>
          ) : null}
        </div>
      )}

      <EnvEditor env={draft.env} onChange={(env) => patch({ env })} />

      <div className="flex flex-col gap-3">
        <span className="text-xs font-medium">Lease</span>
        <LeaseEditor kind={draft.kind} value={draft.lease} onChange={(lease) => patch({ lease })} usdPerHour={offer?.listUsdPerHour ?? null} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** The quote: cost lines, list total per hour, the most it can cost, price age, budget line, warnings. */
export function QuoteSummary({ quote, now }: { quote: CreateQuote; now: number }) {
  const stale = quote.priceAgeSec !== null && quote.priceAgeSec > 24 * 3600;
  const priceDate = quote.priceAgeSec !== null ? formatDateTime(new Date(now - quote.priceAgeSec * 1000).toISOString()) : null;
  const kind = quote.spec.kind;
  return (
    <div className="flex flex-col gap-3" data-quote={quote.quoteId}>
      <table className="w-full text-[13px]">
        <caption className="sr-only">Cost per hour</caption>
        <tbody className="divide-y divide-border">
          {quote.lines.map((line, i) => (
            <tr key={`${line.label}-${i}`}>
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                {line.label}
                {line.note ? <span className="ml-2 text-2xs text-muted-foreground">{line.note}</span> : null}
              </th>
              <td className="py-2 text-right">
                <PriceTag usdPerHour={line.usdPerHour} />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-2 pr-4 text-left font-medium">
              Total
            </th>
            <td className="py-2 text-right">
              <PriceTag usdPerHour={quote.usdPerHour} className="text-[13px] font-semibold" />
            </td>
          </tr>
        </tbody>
      </table>
      <Facts
        rows={[
          {
            label: 'At most',
            value: quote.maxUsd === null ? 'No automatic limit' : formatUsd(quote.maxUsd),
            hint: quote.maxUsd === null ? `it bills until you ${kind === 'sandbox' ? 'pause or delete' : 'delete'} it` : 'if it runs until the lease ends',
          },
          {
            label: 'Budget',
            value: quote.budget.allowed ? (quote.budget.reason ?? 'Within your budget') : (quote.budget.reason ?? 'Over your budget'),
            hint:
              quote.budget.remainingTodayUsd !== null
                ? `${formatUsd(quote.budget.remainingTodayUsd)} left today`
                : quote.budget.remainingMonthUsd !== null
                  ? `${formatUsd(quote.budget.remainingMonthUsd)} left this month`
                  : undefined,
          },
        ]}
      />
      {stale && priceDate ? <Note tone="warning">Price from {priceDate}: GMI’s price list could not be refreshed.</Note> : null}
      {quote.warnings.filter((w) => w !== quote.budget.reason).map((w) => (
        <Note key={w} tone="warning">
          {w}
        </Note>
      ))}
      <p className="text-2xs text-muted-foreground">
        {LIST_PRICE_NOTE}{' '}
        <button
          type="button"
          onClick={() => void gmi.app.openConsole('computeUsage').catch(() => undefined)}
          className="inline-flex items-center gap-0.5 font-medium text-foreground/85 underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/70"
        >
          Your usage in GMI Console <ArrowUpRight className="size-3" />
        </button>
      </p>
    </div>
  );
}

/** What will be created, in plain words (left column of the review step). */
export function ReviewFacts({ draft, catalog }: { draft: LaunchDraft; catalog: ComputeCatalog | undefined }) {
  const offer = selectedOffer(catalog, draft);
  const template = selectedTemplate(catalog, draft);
  const snapshotName = draft.snapshotId ? 'Snapshot' : null;
  const idc = catalog?.idcs.find((i) => i.id === draft.idc);
  const Icon = KIND_ICON[draft.kind];
  const access =
    draft.kind === 'sandbox'
      ? 'In GMI Desk'
      : draft.access.mode === 'none'
        ? 'In GMI Desk (no public IP)'
        : draft.access.mode === 'ssh'
          ? `SSH from ${draft.access.cidr || '…'}`
          : `HTTP ${draft.access.httpPorts || '…'} from ${draft.access.cidr || '…'}`;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {draft.displayName || '—'}
      </p>
      <Facts
        rows={[
          { label: 'Kind', value: KIND_LABEL[draft.kind] },
          { label: 'Template', value: snapshotName ?? template?.name ?? '—' },
          { label: 'Where', value: idc?.name ?? (draft.idc ?? 'Default data centre') },
          { label: 'Size', value: offer ? offerSpecs(offer) : '—', hint: offer?.sku ?? undefined },
          { label: 'Reach', value: access },
          draft.kind === 'sandbox'
            ? { label: 'GMI timeout', value: `${formatMinutes(draft.timeoutSec / 60)}, then ${draft.onTimeout === 'pause' ? 'paused' : 'deleted'}` }
            : null,
          { label: 'Lease', value: leaseSummary(draft.lease) },
          { label: 'Budget out', value: LEASE_ACTION_LABEL[draft.lease.onBudget] },
          draft.env.length ? { label: 'Environment', value: <span className="font-mono text-xs">{draft.env.map((e) => e.name).filter(Boolean).join(', ')}</span> } : null,
        ]}
      />
    </div>
  );
}

export const STEP_HINT = {
  native: 'Next, GMI Desk shows a system dialog with the price. Nothing is created or billed before you confirm there.',
} as const;

