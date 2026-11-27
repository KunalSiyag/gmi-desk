import { useState } from 'react';
import { Check, Files, ListChecks, Gauge } from 'lucide-react';
import type { CodeThread, DiffFile, TodoItem } from '@shared/contracts/code';
import { formatUsd } from '@shared/lib/money';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { MicroLabel } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { TabStrip } from '@renderer/components/ui/tabs';
import { cn } from '@renderer/lib/cn';
import { shortTokens, STATUS_LABEL } from '../format';

type Tab = 'review' | 'todo' | 'context';

/** Diff colours in theme tokens: additions in brand ink (the app's one accent green), deletions red, edits amber. */
const FILE_STATUS: Record<DiffFile['status'], { letter: string; tone: string }> = {
  added: { letter: 'A', tone: 'text-primary-ink' },
  deleted: { letter: 'D', tone: 'text-destructive' },
  modified: { letter: 'M', tone: 'text-warning-foreground' },
  renamed: { letter: 'R', tone: 'text-warning-foreground' },
  binary: { letter: 'B', tone: 'text-muted-foreground' },
};

/** Long paths give up their folders first: "…/workflows/ci.yml" keeps the file name readable (full path in the row title). */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <span className="flex min-w-0 flex-1 font-mono text-2xs">
      {cut > 0 ? <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, cut)}</span> : null}
      <span className="max-w-full shrink-0 truncate text-foreground/85">{path.slice(cut)}</span>
    </span>
  );
}

function DiffRow({ file, onOpen }: { file: DiffFile; onOpen: (path: string) => void }) {
  const status = FILE_STATUS[file.status] ?? FILE_STATUS.modified;
  return (
    <button
      type="button"
      onClick={() => onOpen(file.path)}
      title={file.path}
      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60', rowPressMotion)}
    >
      <span className={cn('w-3 shrink-0 text-center font-mono text-3xs font-medium', status.tone)}>{status.letter}</span>
      <PathLabel path={file.path} />
      {file.sensitive ? (
        <Badge variant="warning" size="sm">
          Sensitive
        </Badge>
      ) : null}
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-3xs tabular-nums">
        <span className="text-primary-ink">+{file.additions}</span>
        <span className="text-destructive">−{file.deletions}</span>
      </span>
    </button>
  );
}

export function RightPanel({
  thread,
  diff,
  onOpenFile,
  onCommit,
  onExport,
  onMerge,
  busy,
}: {
  thread: CodeThread;
  diff: DiffFile[];
  onOpenFile: (path: string) => void;
  onCommit: () => void;
  onExport: () => void;
  onMerge: () => void;
  busy: boolean;
}) {
  const [tab, setTab] = useState<Tab>('review');
  const meter = thread.meter;
  const used = meter.ceilingTokens > 0 ? Math.min(1, meter.usedTokens / meter.ceilingTokens) : 0;
  const files = diff.length;

  const todo = thread.todo;
  const done = todo.filter((t) => t.status === 'done').length;

  return (
    <aside className="flex w-[19rem] shrink-0 flex-col border-l border-border/70 bg-card/20">
      {/* The kit's segmented tabs: they switch instantly (keyboard arrows work), counts in mono. py-2 + the 28 px strip
          puts this border on the same line as the thread rail's and the timeline header's. */}
      <div className="flex items-center border-b border-border/60 px-2 py-2">
        <TabStrip
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'review', label: <><Files className="size-3.5" /> Review</>, count: files > 0 ? files : undefined },
            { value: 'todo', label: <><ListChecks className="size-3.5" /> Todo</>, count: todo.length > 0 ? todo.length : undefined },
            { value: 'context', label: <><Gauge className="size-3.5" /> Context</> },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === 'review' ? (
          <div className="space-y-0.5">
            {files === 0 ? <p className="px-2 py-6 text-center text-2xs text-muted-foreground">No changes against the base branch yet.</p> : null}
            {diff.map((f) => (
              <DiffRow key={f.path} file={f} onOpen={onOpenFile} />
            ))}
            {thread.checkpoints.length > 0 ? (
              <div className="pt-4">
                <MicroLabel as="p" className="px-2 pb-1">
                  Checkpoints
                </MicroLabel>
                {thread.checkpoints.map((c) => (
                  <p key={c.id} className="px-2 py-1 text-2xs tabular-nums text-muted-foreground">
                    Turn {c.turn} · {c.filesChanged} file{c.filesChanged === 1 ? '' : 's'}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === 'todo' ? (
          <div className="space-y-1">
            {todo.length === 0 ? <p className="px-2 py-6 text-center text-2xs text-muted-foreground">The agent has not planned any steps yet.</p> : null}
            {todo.map((item: TodoItem) => (
              <div key={item.id} className="flex items-start gap-2 px-2 py-1">
                <span
                  aria-hidden
                  className={cn(
                    'mt-px flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                    item.status === 'done' ? 'border-primary-ink bg-primary/15 text-primary-ink' : item.status === 'in_progress' ? 'border-primary-ink text-primary-ink' : 'border-input',
                  )}
                >
                  {item.status === 'done' ? <Check className="size-2.5" /> : item.status === 'in_progress' ? <span className="size-1 rounded-full bg-current" /> : null}
                </span>
                <span className={cn('text-xs leading-4', item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground/85')}>{item.text}</span>
              </div>
            ))}
            {todo.length > 0 ? (
              <p className="px-2 pt-2 text-3xs tabular-nums text-muted-foreground">
                {done}/{todo.length} done
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === 'context' ? (
          <div className="space-y-4 px-2 py-2 text-xs">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">Context window</span>
                <span className="tabular-nums text-foreground/85">
                  {shortTokens(meter.usedTokens)} / {shortTokens(meter.ceilingTokens)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <div className={cn('h-full rounded-full', used > 0.85 ? 'bg-destructive' : used > 0.65 ? 'bg-warning' : 'bg-primary')} style={{ width: `${Math.round(used * 100)}%` }} />
              </div>
              {meter.tierBoundaryTokens ? <p className="mt-1 text-3xs tabular-nums text-muted-foreground">Long-context tier at {shortTokens(meter.tierBoundaryTokens)}</p> : null}
            </div>
            <dl className="grid grid-cols-2 gap-y-1.5">
              <dt className="text-muted-foreground">Window</dt><dd className="text-right tabular-nums">{shortTokens(meter.windowTokens)}</dd>
              <dt className="text-muted-foreground">Reserve</dt><dd className="text-right tabular-nums">{shortTokens(meter.reserveTokens)}</dd>
              <dt className="text-muted-foreground">Messages</dt><dd className="text-right tabular-nums">{meter.messageCount}</dd>
              <dt className="text-muted-foreground">Compactions</dt><dd className="text-right tabular-nums">{meter.compactions}</dd>
              <dt className="text-muted-foreground">Cache hit</dt><dd className="text-right tabular-nums">{meter.cachedRatio === null ? '—' : `${Math.round(meter.cachedRatio * 100)}%`}</dd>
              <dt className="text-muted-foreground">Next step</dt><dd className="text-right tabular-nums">{formatUsd(meter.nextStepUsd)}</dd>
            </dl>
            {meter.estimated ? <p className="text-3xs text-warning-foreground">Estimated: no measured usage since the last change.</p> : null}
            <dl className="grid grid-cols-2 gap-y-1.5 border-t border-border/60 pt-3">
              <dt className="text-muted-foreground">Spent</dt><dd className="text-right tabular-nums">{formatUsd(thread.costUsd)}</dd>
              <dt className="text-muted-foreground">Input</dt><dd className="text-right tabular-nums">{shortTokens(thread.tokens.input)}</dd>
              <dt className="text-muted-foreground">Cached</dt><dd className="text-right tabular-nums">{shortTokens(thread.tokens.cached)}</dd>
              <dt className="text-muted-foreground">Output</dt><dd className="text-right tabular-nums">{shortTokens(thread.tokens.output)}</dd>
              <dt className="text-muted-foreground">State</dt><dd className="text-right">{STATUS_LABEL[thread.status]}</dd>
            </dl>
          </div>
        ) : null}
      </div>

      {tab === 'review' && files > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 p-2">
          <Button size="xs" variant="secondary" disabled={busy} onClick={onCommit}>
            Commit
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onExport}>
            Export patch
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onMerge}>
            Merge to base
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * One file's diff in the kit's centred modal (fade/scale in, Escape and the backdrop close it, focus is trapped).
 * `file` null = closed; the last file stays rendered while the dialog fades out.
 */
export function DiffDialog({ file, onClose }: { file: DiffFile | null; onClose: () => void }) {
  const [shown, setShown] = useState(file);
  if (file && file !== shown) setShown(file);
  const view = file ?? shown;
  return (
    <Dialog
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={<span className="block truncate font-mono text-xs font-medium" title={view?.path}>{view?.path}</span>}
      className="w-[min(48rem,calc(100vw-2rem))] max-h-[80vh]"
    >
      {!view ? null : view.tooLarge ? (
        <p className="py-2 text-xs text-muted-foreground">This file is too large to preview.</p>
      ) : view.hunks?.length ? (
        <pre className="-mx-5 -mb-4 overflow-x-auto border-t border-border font-mono text-2xs leading-5">
          {view.hunks.map((h) => (
            <div key={h.header}>
              <div className="bg-muted/60 px-3 text-muted-foreground dark:bg-white/[0.03]">{h.header}</div>
              {h.lines.map((l, i) => (
                <div
                  key={`${h.header}-${i}`}
                  className={cn('pr-3', l.type === 'add' ? 'bg-primary/12 text-foreground' : l.type === 'del' ? 'bg-destructive/10 text-foreground' : 'text-muted-foreground')}
                >
                  <span className="inline-block w-10 select-none pr-2 text-right tabular-nums text-muted-foreground/70">{l.oldNo ?? ''}</span>
                  <span className="inline-block w-10 select-none pr-2 text-right tabular-nums text-muted-foreground/70">{l.newNo ?? ''}</span>
                  <span className={cn('select-none', l.type === 'add' ? 'text-primary-ink' : l.type === 'del' ? 'text-destructive' : '')}>
                    {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                  </span>{' '}
                  {l.text}
                </div>
              ))}
            </div>
          ))}
        </pre>
      ) : (
        <p className="py-2 text-xs text-muted-foreground">No textual hunks.</p>
      )}
    </Dialog>
  );
}
