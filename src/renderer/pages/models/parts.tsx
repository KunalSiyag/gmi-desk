import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { AudioLines, Box, Check, Copy, Film, Image as ImageIcon, Star, Type, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { CatalogModel, ModalitySpec } from '@shared/contracts/catalog';
import { formatUsd } from '@shared/lib/money';
import { cn } from '@renderer/lib/cn';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { MicroLabel, microLabel } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { chargedLlm, chargedMedia } from './filter';

/** The "New" badge: GMI's one solid lime chip (the kit's `new` variant carries the edge it needs on white). */
export function NewBadge({ className }: { className?: string }) {
  return (
    <Badge variant="new" className={className}>
      New
    </Badge>
  );
}

/**
 * Featured on GMI: a small filled star in GMI's secondary lime (olive ink on light), quieter than the lime accents
 * around it because a sorted list can show a dozen in a row. Spreads props so it can be a tooltip trigger.
 */
export function FeaturedStar({ className, ...props }: ComponentProps<typeof Star>) {
  return <Star aria-label="Featured" {...props} className={cn('size-3 shrink-0 fill-current text-primary-ink dark:text-brand-olive', className)} />;
}

/** Re-renders every `intervalMs` so relative times ("5m ago") stay current. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error('Could not copy to the clipboard');
  }
}

/** Copy button that flips to a check mark for a moment. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <Tooltip label={done ? 'Copied' : label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        className={className}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setDone(true),
            () => toast.error('Could not copy to the clipboard'),
          );
        }}
      >
        {done ? <Check className="text-primary-ink" /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

function initialOf(model: CatalogModel): string {
  const source = model.provider ?? model.name;
  const ch = source.replace(/[^\p{L}\p{N}]/gu, '').charAt(0);
  return (ch || '?').toUpperCase();
}

/** Provider logo (GMI-hosted https image) or the provider's initial. */
export function ModelIcon({ model, size = 'md', className }: { model: CatalogModel; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = model.iconUrl && model.iconUrl.startsWith('https://') && !failed ? model.iconUrl : null;
  const box = size === 'lg' ? 'size-9 rounded-lg text-sm' : size === 'sm' ? 'size-5 rounded text-3xs' : 'size-7 rounded-md text-xs';
  if (url) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center overflow-hidden border border-border bg-white', box, className)}>
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-contain p-[3px]"
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center border border-border bg-muted font-mono font-medium text-muted-foreground', box, className)}
    >
      {initialOf(model)}
    </span>
  );
}

const MODALITY: Record<string, { icon: LucideIcon; label: string }> = {
  text: { icon: Type, label: 'Text' },
  image: { icon: ImageIcon, label: 'Image' },
  video: { icon: Film, label: 'Video' },
  audio: { icon: AudioLines, label: 'Audio' },
  '3d': { icon: Box, label: '3D' },
};

/** "first_frame_image" → image; unknown types keep their own name. */
export function modalityKey(type: string): string {
  const t = type.toLowerCase();
  if (t.endsWith('image')) return 'image';
  if (t.endsWith('video')) return 'video';
  if (t.endsWith('audio')) return 'audio';
  return t;
}

export function modalityLabel(type: string): string {
  const key = modalityKey(type);
  const known = MODALITY[key]?.label;
  if (type === 'first_frame_image') return 'First frame';
  if (type === 'last_frame_image') return 'Last frame';
  return known ?? type.replace(/[_-]+/g, ' ');
}

export function ModalityGlyph({ type, className }: { type: string; className?: string }) {
  const Icon = MODALITY[modalityKey(type)]?.icon ?? Box;
  return <Icon aria-hidden className={cn('size-3 shrink-0', className)} />;
}

function uniqueKeys(list: ModalitySpec[]): string[] {
  return [...new Set(list.map((m) => modalityKey(m.type)))];
}

/** Inputs → outputs as small icons, e.g. [T][img] → [video]. */
export function ModalityIcons({ inputs, outputs, className }: { inputs: ModalitySpec[]; outputs: ModalitySpec[]; className?: string }) {
  const ins = uniqueKeys(inputs);
  const outs = uniqueKeys(outputs);
  if (ins.length === 0 && outs.length === 0) return <span className="text-muted-foreground/60">—</span>;
  const describe = (keys: string[]) => keys.map((k) => MODALITY[k]?.label ?? k).join(', ') || '—';
  return (
    <Tooltip label={`In: ${describe(ins)} · Out: ${describe(outs)}`}>
      <span className={cn('inline-flex items-center gap-[3px] text-muted-foreground', className)}>
        {ins.slice(0, 2).map((k) => (
          <ModalityGlyph key={`i-${k}`} type={k} />
        ))}
        {ins.length > 2 ? <span className="text-3xs leading-none tabular-nums">+{ins.length - 2}</span> : null}
        <span aria-hidden className="text-3xs leading-none text-muted-foreground/60">
          →
        </span>
        {outs.slice(0, 2).map((k) => (
          <ModalityGlyph key={`o-${k}`} type={k} className="text-foreground/80" />
        ))}
      </span>
    </Tooltip>
  );
}

/** "second" → "sec", "song (up to 5 minutes)" → "song", "1K characters" → "1K chars". */
export function shortUnit(unit: string | null | undefined): string {
  if (!unit) return 'unit';
  const u = unit.replace(/\(.*\)/, '').trim().toLowerCase();
  const map: Record<string, string> = {
    second: 'sec',
    seconds: 'sec',
    request: 'request',
    image: 'image',
    '1k characters': '1K chars',
    character: 'char',
    characters: 'char',
    generation: 'run',
  };
  return map[u] ?? (u.length > 12 ? `${u.slice(0, 11)}…` : u || 'unit');
}

/** Two-line price for list rows: charged price, then the struck list price (or the unit). */
export function PriceCell({ model }: { model: CatalogModel }) {
  const discounted = (model.discount ?? 0) > 0;
  if (model.kind === 'llm') {
    const p = model.llmPricing;
    if (!p || (p.inputPerMTok === null && p.outputPerMTok === null)) return <PriceUnknown />;
    const { input, output } = chargedLlm(model);
    return (
      <span className="flex flex-col items-end leading-tight">
        <span className="whitespace-nowrap text-xs tabular-nums text-foreground">
          {formatUsd(input)}
          <span className="text-muted-foreground"> / </span>
          {formatUsd(output)}
        </span>
        <span className="whitespace-nowrap text-3xs tabular-nums text-muted-foreground">
          {discounted ? (
            <s className="decoration-muted-foreground/60">
              {formatUsd(p.inputPerMTok)} / {formatUsd(p.outputPerMTok)}
            </s>
          ) : (
            'in / out · 1M'
          )}
        </span>
      </span>
    );
  }
  const m = model.mediaPricing;
  if (!m || m.usdPerUnit === null) return <PriceUnknown />;
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className="whitespace-nowrap text-xs tabular-nums text-foreground">{formatUsd(chargedMedia(model))}</span>
      <span className="whitespace-nowrap text-3xs tabular-nums text-muted-foreground">
        {discounted ? (
          <>
            <s className="decoration-muted-foreground/60">{formatUsd(m.usdPerUnit)}</s>{' '}
          </>
        ) : null}
        / {shortUnit(m.unit)}
      </span>
    </span>
  );
}

function PriceUnknown() {
  return (
    <Tooltip label="GMI does not publish a price for this model">
      <span className="text-xs text-muted-foreground/60">—</span>
    </Tooltip>
  );
}

/** Small "label: value" pair for the detail panel. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <MicroLabel as="dt">{label}</MicroLabel>
      <dd className="truncate text-xs tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

/** Panel section with a quiet heading. */
export function PanelSection({ title, meta, children, className }: { title: ReactNode; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={microLabel}>{title}</h3>
        {meta ? <span className="truncate text-3xs tabular-nums text-muted-foreground">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
