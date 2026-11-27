import { forwardRef, useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, LifeBuoy, Lock, Send } from 'lucide-react';
import { SUPPORT_LIMITS } from '@shared/contracts/usage';
import { formatNumber } from '@shared/lib/format';
import { gmi } from '@renderer/lib/gmi';
import { cn } from '@renderer/lib/cn';
import { Dino } from '@renderer/components/brand/Dino';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input, Label, Textarea } from '@renderer/components/ui/input';
import { modKey } from '@renderer/components/shell/Sidebar';
import { Kbd, MicroLabel, Spinner } from '@renderer/components/ui/misc';

/** Same normalisation the main process applies before checking lengths. */
const cleanSubject = (s: string) => s.replace(/\s+/g, ' ').trim();
const cleanDescription = (s: string) => s.replace(/\r\n?/g, '\n').trim();

function Counter({ length, max, id }: { length: number; max: number; id: string }) {
  return (
    <span
      id={id}
      className={cn(
        'font-mono text-3xs tabular-nums',
        length > max ? 'font-medium text-destructive' : length > max * 0.9 ? 'text-warning-foreground' : 'text-muted-foreground',
      )}
    >
      {formatNumber(length)}/{formatNumber(max)}
    </span>
  );
}

/**
 * Files a ticket with GMI support. Every send creates a NEW ticket: the user confirms first,
 * the request is sent once, and nothing is retried automatically.
 */
export const SupportCard = forwardRef<HTMLInputElement, { id?: string; highlight?: boolean }>(function SupportCard({ id, highlight }, subjectRef) {
  const ids = useId();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);

  const send = useMutation({
    mutationFn: () => gmi.support.createRequest({ subject: cleanSubject(subject), description: cleanDescription(description) }),
    retry: false,
    onSettled: () => setConfirming(false),
  });

  const s = cleanSubject(subject);
  const d = cleanDescription(description);
  const L = SUPPORT_LIMITS;
  const subjectError =
    s.length < L.subjectMin ? `Add a subject (at least ${L.subjectMin} characters).` : s.length > L.subjectMax ? `Keep the subject to ${L.subjectMax} characters.` : null;
  const descriptionError =
    d.length < L.descriptionMin
      ? `Describe the problem (at least ${L.descriptionMin} characters).`
      : d.length > L.descriptionMax
        ? `Keep the description to ${formatNumber(L.descriptionMax)} characters.`
        : null;
  const valid = !subjectError && !descriptionError;
  // Lime only once the ticket can be sent: an empty or half-filled form keeps a quiet outline button.
  const ready = valid || send.isPending;
  const kbdOnLime = ready ? 'border-primary-foreground/15 bg-primary-foreground/10 text-primary-foreground' : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (valid && !send.isPending) setConfirming(true);
  };

  const reset = () => {
    send.reset();
    setSubject('');
    setDescription('');
    setTouched(false);
    setCopied(false);
  };

  const copyId = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable
    }
  };

  return (
    <section
      id={id}
      aria-labelledby={`${ids}-title`}
      data-highlight={highlight ? '' : undefined}
      className={cn(
        'relative rounded-lg border border-border bg-card',
        // ?section=support: a lime ring that fades in and out (opacity only) around the card.
        'after:pointer-events-none after:absolute after:-inset-[3px] after:rounded-[calc(var(--radius)+3px)] after:ring-2 after:ring-ring/50',
        'after:opacity-0 after:transition-opacity after:duration-200 after:ease-out data-[highlight]:after:opacity-100',
      )}
    >
      <header className="flex h-10 items-center gap-2 border-b border-border px-4">
        <LifeBuoy className="size-3.5 text-muted-foreground" />
        <h2 id={`${ids}-title`} className="text-[13px] font-medium">
          Contact GMI support
        </h2>
      </header>

      {send.isSuccess ? (
        <div className="flex flex-col items-center gap-3 px-4 pb-4 pt-5 text-center" role="status">
          <Dino mood="happy" size={56} />
          <div>
            <p className="text-[13px] font-medium">Filed with GMI support</p>
            <p className="mt-1 text-xs text-muted-foreground">{send.data.message}</p>
          </div>
          {send.data.submissionId ? (
            <div className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-left dark:bg-background/60">
              <div className="min-w-0">
                <MicroLabel as="p">Submission ID</MicroLabel>
                <p className="mt-0.5 truncate font-mono text-xs" title={send.data.submissionId}>
                  {send.data.submissionId}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? 'Copied' : 'Copy submission ID'}
                onClick={() => void copyId(send.data.submissionId ?? '')}
              >
                {copied ? <Check className="text-primary-ink" /> : <Copy />}
              </Button>
            </div>
          ) : null}
          <Button variant="outline" size="sm" className="w-full" onClick={reset}>
            New request
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5 px-4 pb-4 pt-3.5" noValidate>
          <p className="text-2xs text-muted-foreground">Opens a ticket for your organization with GMI support.</p>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor={`${ids}-subject`}>Subject</Label>
              <Counter id={`${ids}-subject-count`} length={s.length} max={L.subjectMax} />
            </div>
            <Input
              ref={subjectRef}
              id={`${ids}-subject`}
              value={subject}
              maxLength={L.subjectMax + 50}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Video job stuck in processing"
              aria-invalid={(touched && Boolean(subjectError)) || undefined}
              aria-describedby={`${ids}-subject-count ${ids}-subject-error`}
              className="aria-[invalid]:border-destructive/60"
            />
            {touched && subjectError ? (
              <p id={`${ids}-subject-error`} className="text-2xs text-destructive">
                {subjectError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor={`${ids}-description`}>Description</Label>
              <Counter id={`${ids}-description-count`} length={d.length} max={L.descriptionMax} />
            </div>
            <Textarea
              id={`${ids}-description`}
              value={description}
              rows={7}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter sends (after the confirmation), like the chat composer.
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="What happened, which model or request ID, and what you expected."
              aria-invalid={(touched && Boolean(descriptionError)) || undefined}
              aria-describedby={`${ids}-description-count ${ids}-description-error`}
              className="resize-y aria-[invalid]:border-destructive/60"
            />
            {touched && descriptionError ? (
              <p id={`${ids}-description-error`} className="text-2xs text-destructive">
                {descriptionError}
              </p>
            ) : null}
          </div>
          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Lock aria-hidden className="size-3 shrink-0" /> Never include API keys or passwords.
          </p>
          {send.error ? <ErrorNotice error={send.error} compact /> : null}
          <Button type="submit" variant={ready ? 'default' : 'outline'} className="w-full" disabled={send.isPending || (touched && !valid)}>
            <Send /> Send to GMI support
            <span aria-hidden className="ml-auto flex items-center gap-0.5">
              <Kbd className={kbdOnLime}>{modKey()}</Kbd>
              <Kbd className={kbdOnLime}>Enter</Kbd>
            </span>
          </Button>
        </form>
      )}

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!send.isPending) setConfirming(open);
        }}
        title="Send this to GMI support?"
        description="This files a new ticket for your organization with GMI support."
        hideClose={send.isPending}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={send.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending} autoFocus>
              {send.isPending ? <Spinner className="text-primary-foreground" /> : <Send />}
              {send.isPending ? 'Sending…' : 'Send ticket'}
            </Button>
          </>
        }
      >
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 dark:bg-background/60">
          <p className="break-words text-[13px] font-medium">{s}</p>
          <p className="mt-1 line-clamp-6 whitespace-pre-wrap break-words text-xs text-muted-foreground">{d}</p>
        </div>
      </Dialog>
    </section>
  );
});
