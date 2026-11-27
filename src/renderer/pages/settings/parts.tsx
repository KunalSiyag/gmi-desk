import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Info, Lock, RotateCw } from 'lucide-react';
import type { AuthState, GmiScope, LockedSecret } from '@shared/contracts/auth';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { microLabel, Spinner } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { lockedSecretNote } from './copy';

export type SettingsSectionId = 'account' | 'keys' | 'security' | 'appearance' | 'catalog' | 'chat' | 'media' | 'about';

export const SCOPE_INFO: Record<GmiScope, string> = {
  'models:read': 'Models and your prices',
  'generation:read': 'Media history',
  'generation:write': 'Generate media',
  'billing:read': 'Balance and spend',
  'profile:read': 'Organization profile',
  'support:write': 'Support requests',
};

/** Outline button in the destructive tone, for the one separated "remove / sign out" row at the end of a card. */
export const dangerButton = 'border-destructive/35 text-destructive hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive';

/** A titled group of rows (one card per section, anchored for ?section=). */
export function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`settings-${id}`} data-settings-section={id} aria-labelledby={`settings-${id}-title`} className="scroll-mt-6">
      <div className="mb-3 px-px">
        <div className="flex h-5 items-center justify-between gap-4">
          <h2 id={`settings-${id}-title`} className={cn(microLabel, 'text-foreground/80')}>
            {title}
          </h2>
          {action ? <div className="mr-1.5 flex shrink-0 items-center gap-0.5">{action}</div> : null}
        </div>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Card className="divide-y divide-border overflow-hidden">{children}</Card>
    </section>
  );
}

/** Label/description on the left, control on the right. */
export function Row({
  label,
  description,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={cn('flex min-h-14 items-center justify-between gap-6 px-4 py-3', className)}>
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="block text-[13px] font-medium leading-5">
          {label}
        </Label>
        {description ? <div className="mt-0.5 text-2xs text-muted-foreground">{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * The status line at the top of a card (account, key, app): a round chip, a title with badges, a one-line
 * subtitle and actions on the right. `tone` tints the chip: lime ink when things work, muted otherwise.
 */
export function StatusHeader({
  chip,
  tone = 'muted',
  title,
  badges,
  subtitle,
  actions,
}: {
  chip: ReactNode;
  tone?: 'brand' | 'muted' | 'danger' | 'warning';
  title: ReactNode;
  badges?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <span
        aria-hidden
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-inset [&_svg]:size-4',
          tone === 'brand' && 'bg-primary/15 text-primary-ink ring-primary-ink/25',
          tone === 'muted' && 'bg-muted text-muted-foreground ring-border',
          tone === 'danger' && 'bg-destructive/10 text-destructive ring-destructive/25',
          tone === 'warning' && 'bg-warning/12 text-warning-foreground ring-warning/30',
        )}
      >
        {chip}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold leading-5">{title}</span>
          {badges}
        </div>
        {subtitle ? <div className="mt-0.5 truncate text-2xs text-muted-foreground">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/** Quiet inline message inside a card (warnings, notes, last errors). */
export function InlineNote({ tone = 'muted', icon, children, className }: { tone?: 'muted' | 'warning' | 'danger'; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-4 py-2.5 text-2xs [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0',
        tone === 'muted' && 'bg-muted/40 text-muted-foreground',
        tone === 'warning' && 'bg-warning/[0.07] text-foreground [&_svg]:text-warning-foreground',
        tone === 'danger' && 'bg-destructive/[0.06] text-foreground [&_svg]:text-destructive',
        className,
      )}
    >
      {icon ?? (tone === 'muted' ? <Info /> : <AlertTriangle />)}
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * A saved secret the OS keychain would not decrypt: says nothing was deleted and offers "Try again", which reads
 * every locked secret again (after the user unlocked the keychain).
 */
export function KeychainLockedNote({ secret }: { secret: LockedSecret }) {
  const client = useQueryClient();
  const [stillLocked, setStillLocked] = useState(false);
  const retry = useMutation({
    mutationFn: () => gmi.auth.retrySecureStorage(),
    onSuccess: (next: AuthState) => {
      client.setQueryData(qk.auth, next);
      setStillLocked(next.lockedSecrets?.includes(secret) ?? false);
    },
  });
  // Laid out like InlineNote (warning), without its descendant svg rules that would tint the button's icon.
  return (
    <div className="flex items-start gap-2 bg-warning/[0.07] px-4 py-2.5 text-2xs text-foreground">
      <Lock aria-hidden className="mt-px size-3.5 shrink-0 text-warning-foreground" />
      <div className="min-w-0 flex-1 leading-relaxed">
        <p>{lockedSecretNote(secret)}</p>
        {retry.error ? (
          <ActionError error={retry.error} className="mt-1" />
        ) : stillLocked && !retry.isPending ? (
          <p role="status" className="mt-1 text-muted-foreground">
            Still locked. Unlock your keychain (for example by signing in to your desktop session), then try again.
          </p>
        ) : null}
      </div>
      <Button size="xs" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending} className="-my-0.5 shrink-0">
        {retry.isPending ? <Spinner className="size-3.5" /> : <RotateCw />} Try again
      </Button>
    </div>
  );
}

/** One-line error text for a failed action (the fix is next to it already). */
export function ActionError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const view = describeError(error);
  return (
    <p role="alert" className={cn('text-2xs text-destructive', className)}>
      {view.message || view.title}
    </p>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip label={copied ? 'Copied' : label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => undefined);
        }}
      >
        {copied ? <Check className="text-primary-ink" /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

/** Monospace value (ids, paths, versions). */
export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('font-mono text-2xs tabular-nums text-muted-foreground', className)}>
      {children}
    </span>
  );
}

export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/** Single-choice segmented control (radio group; arrow keys move the selection). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  label: string;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = options.findIndex((o) => o.value === value);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const next = (Math.max(0, index) + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 ring-1 ring-inset ring-border"
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (index < 0 && i === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              // Like the kit's TabStrip: the selected pill (fill, ring, shadow) switches instantly (arrow keys), only
              // the hover text colour of the others eases.
              'inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium disabled:opacity-50 [&_svg]:size-3.5',
              selected
                ? 'bg-background text-foreground shadow-xs ring-1 ring-border dark:bg-white/10 dark:ring-white/5 [&_svg]:text-primary-ink'
                : 'text-muted-foreground transition-[color] duration-150 ease-out hover:text-foreground',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The six GMI scopes with what each unlocks: granted (check), missing (warning) or requested. */
export function ScopeGrid({ scopes, mode }: { scopes: readonly string[]; mode: 'granted' | 'requested' }) {
  const granted = new Set(scopes);
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-2">
      {(Object.keys(SCOPE_INFO) as GmiScope[]).map((scope) => {
        const state = mode === 'requested' ? 'requested' : granted.has(scope) ? 'granted' : 'missing';
        return (
          <li key={scope} className="flex min-w-0 items-center gap-2 text-2xs">
            <Badge
              variant={state === 'missing' ? 'warning' : state === 'requested' ? 'outline' : 'default'}
              className={cn('font-mono text-3xs', state === 'granted' && 'text-foreground/85')}
              aria-label={`${scope}: ${state === 'granted' ? 'granted' : state === 'missing' ? 'not granted' : 'requested'}`}
            >
              {state === 'granted' ? <Check className="text-primary-ink" /> : state === 'missing' ? <AlertTriangle /> : null}
              {scope}
            </Badge>
            <span className="truncate text-muted-foreground" title={SCOPE_INFO[scope]}>
              {SCOPE_INFO[scope]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
