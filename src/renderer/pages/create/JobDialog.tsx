import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, ExternalLink, FolderOpen, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { MediaJob } from '@shared/contracts/media';
import { formatBytes, formatRelativeTime } from '@shared/lib/format';
import { formatDiscount, formatUsd } from '@shared/lib/money';
import { errorCode } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { microLabel } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { outputSrc, requestFromJob } from './form';
import type { JobHandlers } from './Gallery';
import { copyText, useJobActions, useNow } from './hooks';
import { JobMedia, JobStatusBadge, OutputView } from './JobMedia';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function paramText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Full view of one generation: every output, the exact prompt and settings, cost, and actions. */
export function JobDialog({ job, modelName, handlers, onClose }: { job: MediaJob | null; modelName: string; handlers: JobHandlers; onClose: () => void }) {
  const id = job?.id ?? '';
  // Opening a job refreshes it from GMI when it is unfinished or its outputs were never loaded.
  const detail = useQuery({
    queryKey: qk.mediaJob(id),
    queryFn: () => gmi.media.getJob(id),
    enabled: job !== null,
    placeholderData: job ?? undefined,
    staleTime: 0,
    retry: false,
  });
  const current = detail.data ?? job;
  const [index, setIndex] = useState(0);
  const actions = useJobActions();
  const now = useNow(15_000);
  useEffect(() => setIndex(0), [id]);

  const output = current?.outputs[index] ?? current?.outputs[0] ?? null;
  const params = current ? Object.entries(current.parameters) : [];
  const discount = formatDiscount(current?.discount);
  const remoteUrl = output && /^https:\/\//i.test(output.url) ? output.url : null;
  const saved = !!current && current.outputs.length > 0 && current.outputs.every((o) => o.localPath);
  const expired = errorCode(detail.error) === 'not_found';

  return (
    <Dialog
      open={job !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={modelName}
      description={
        current ? (
          <span className="flex items-center gap-1.5">
            <span>{formatRelativeTime(current.createdAt, now)}</span>
            {current.estimateUsd !== null ? <span className="tabular-nums">· {formatUsd(current.estimateUsd)}</span> : null}
            {!current.fromThisDevice ? <span>· from your GMI history</span> : null}
          </span>
        ) : null
      }
      className="w-[min(58rem,calc(100vw-2rem))]"
      footer={
        current ? (
          <>
            <div className="mr-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => void actions.saveAll(current)} disabled={current.status !== 'success' || saved}>
                <Download /> {saved ? 'Saved' : 'Save locally'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void actions.reveal(current, index)} disabled={current.status !== 'success'}>
                <FolderOpen /> Show in folder
              </Button>
              <Button variant="ghost" size="sm" onClick={() => actions.copyUrls(current, current.outputs.length ? index : undefined)} disabled={!output}>
                <Copy /> Copy link
              </Button>
              {remoteUrl ? (
                <Tooltip label="Open GMI's public link in your browser">
                  <Button variant="ghost" size="icon-sm" aria-label="Open link in browser" onClick={() => void actions.open(remoteUrl)}>
                    <ExternalLink />
                  </Button>
                </Tooltip>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                handlers.onUseSettings(current);
                onClose();
              }}
              disabled={!current.modelId || current.modelId === 'unknown'}
            >
              <SlidersHorizontal /> Use these settings
            </Button>
            <Button
              size="sm"
              onClick={() => {
                handlers.onRetake(current);
                onClose();
              }}
              disabled={!requestFromJob(current)}
            >
              <RotateCcw /> Retake
            </Button>
          </>
        ) : null
      }
    >
      {current ? (
        <div className="grid gap-4 pb-1 md:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="h-[min(56vh,30rem)] overflow-hidden rounded-lg border border-border bg-muted/60 dark:bg-white/[0.025]">
              {output && current.status === 'success' ? (
                <OutputView key={`${current.id}-${index}`} output={output} job={current} fit="contain" />
              ) : (
                <JobMedia job={current} now={now} preview={detail.isFetching ? 'loading' : expired ? 'failed' : 'idle'} onOpen={() => undefined} />
              )}
            </div>
            {current.outputs.length > 1 ? (
              <div className="-m-1 flex gap-1.5 overflow-x-auto p-1" role="tablist" aria-label="Outputs">
                {current.outputs.map((o, i) => {
                  const src = outputSrc(o);
                  return (
                    <button
                      key={o.url}
                      type="button"
                      role="tab"
                      aria-selected={i === index}
                      aria-label={`Output ${i + 1}`}
                      onClick={() => setIndex(i)}
                      className={cn(
                        'size-12 shrink-0 overflow-hidden rounded-md border bg-muted font-mono text-3xs tabular-nums text-muted-foreground transition-opacity duration-150 ease-out',
                        i === index ? 'border-primary-ink ring-2 ring-primary-ink/25' : 'border-border opacity-70 hover:opacity-100',
                      )}
                    >
                      {o.kind === 'image' && src ? <img src={src} alt="" className="size-full object-cover" /> : i + 1}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <aside className="flex min-w-0 flex-col gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <JobStatusBadge job={current} />
              {detail.isFetching ? <span className="text-3xs text-muted-foreground">Checking with GMI…</span> : null}
            </div>
            {current.prompt ? (
              <div className="flex flex-col gap-1">
                <span className={microLabel}>Prompt</span>
                <p className="max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">{current.prompt}</p>
              </div>
            ) : null}
            {current.error ? <p className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-2.5 py-2 text-destructive">{current.error}</p> : null}
            {detail.error && !expired ? <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} compact /> : null}
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
              <Row label="Model">
                <span className="break-all font-mono text-3xs">{current.modelId}</span>
              </Row>
              <Row label="Created">{new Date(current.createdAt).toLocaleString()}</Row>
              {current.estimateUsd !== null ? (
                <Row label="Cost">
                  <span className="tabular-nums">{formatUsd(current.estimateUsd)}</span>
                  {discount && current.listUsd ? (
                    <>
                      <span className="text-muted-foreground"> · list {formatUsd(current.listUsd)}</span>
                      <span className="text-primary-ink"> · {discount}</span>
                    </>
                  ) : null}
                </Row>
              ) : null}
              {output?.bytes ? <Row label="Local copy">{formatBytes(output.bytes)}</Row> : null}
              <Row label="Request">
                <button
                  type="button"
                  onClick={() => copyText(current.id, 'Request id')}
                  className="break-all text-left font-mono text-3xs text-muted-foreground hover:text-foreground"
                  title="Copy request id (quote it to GMI support)"
                >
                  {current.id}
                </button>
              </Row>
            </dl>
            {params.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className={microLabel}>Settings</span>
                <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-3xs">
                  {params.map(([name, value]) => (
                    <Row key={name} label={name}>
                      <span className="line-clamp-2 break-all" title={paramText(value)}>
                        {paramText(value)}
                      </span>
                    </Row>
                  ))}
                </dl>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </Dialog>
  );
}
