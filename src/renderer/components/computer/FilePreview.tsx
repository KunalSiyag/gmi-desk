// The selected file (compute.md §8.3): a text preview up to 2 MiB, editable and saved when it is text of at most
// 1 MiB (a plain mono textarea in v1), binary files offered for download. Saves with ⌘/Ctrl+S.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileWarning, Save, X } from 'lucide-react';
import { FILE_PREVIEW_MAX_BYTES, FILE_WRITE_MAX_BYTES, type FileContent } from '@shared/contracts/compute';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Skeleton, Spinner } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { gmi, isMac } from '@renderer/lib/gmi';
import { formatBytes } from '@renderer/pages/compute/format';
import { toastActionError } from '@renderer/pages/compute/hooks';
import { Toolbar } from './parts';
import { baseName } from './paths';
import { computerKeys } from './session';

const encoder = new TextEncoder();

/** What the preview can do with a file. */
export function fileMode(file: Pick<FileContent, 'text' | 'binary' | 'truncated' | 'size'>): 'edit' | 'read' | 'binary' {
  if (file.binary || file.text === null) return 'binary';
  if (file.truncated || file.size > FILE_WRITE_MAX_BYTES) return 'read';
  return 'edit';
}

/** Why a draft cannot be saved, or null. */
export function saveProblem(text: string): string | null {
  return encoder.encode(text).byteLength > FILE_WRITE_MAX_BYTES ? `Files over ${formatBytes(FILE_WRITE_MAX_BYTES)} are saved from the terminal.` : null;
}

export function FilePreview({ sessionId, path, onClose }: { sessionId: string; path: string; onClose: () => void }) {
  const client = useQueryClient();
  const file = useQuery({
    queryKey: computerKeys.file(sessionId, path),
    queryFn: () => gmi.computer.readFile(sessionId, path, { maxBytes: FILE_PREVIEW_MAX_BYTES }),
    staleTime: 0,
    // A refetch while editing would replace the draft's base; the file reloads on open and after a save.
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [path, file.data]);

  const save = useMutation({
    mutationFn: (text: string) => gmi.computer.writeFile(sessionId, path, text),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: computerKeys.file(sessionId, path) });
    },
    onError: (error) => toastActionError('Could not save', error),
  });
  const download = useMutation({
    mutationFn: () => gmi.computer.download(sessionId, path),
    onError: (error) => toastActionError('Could not download', error),
  });

  const data = file.data;
  const mode = data ? fileMode(data) : null;
  const dirty = draft !== null && data?.text !== draft;
  const problem = dirty ? saveProblem(draft) : null;
  const canSave = mode === 'edit' && dirty && !problem && !save.isPending;
  const doSave = () => {
    if (canSave && draft !== null) save.mutate(draft);
  };

  return (
    <section aria-label={`File ${baseName(path)}`} className="flex min-h-0 flex-1 flex-col border-t border-border">
      <Toolbar>
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-2xs text-foreground" title={path}>
          {baseName(path)}
          {dirty ? <span className="text-muted-foreground"> · edited</span> : null}
        </span>
        {data ? <span className="shrink-0 px-1 font-mono text-3xs tabular-nums text-muted-foreground">{formatBytes(data.size)}</span> : null}
        {mode === 'edit' ? (
          <Tooltip label={problem ?? `Save (${isMac() ? '⌘' : 'Ctrl+'}S)`}>
            <Button variant={dirty ? 'outline' : 'ghost'} size="xs" disabled={!canSave} onClick={doSave}>
              {save.isPending ? <Spinner className="size-3" /> : <Save />} Save
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip label="Download…">
          <Button variant="ghost" size="icon-xs" aria-label="Download file" disabled={download.isPending} onClick={() => download.mutate()}>
            <Download />
          </Button>
        </Tooltip>
        <Tooltip label="Close">
          <Button variant="ghost" size="icon-xs" aria-label="Close file" onClick={onClose}>
            <X />
          </Button>
        </Tooltip>
      </Toolbar>
      {file.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : file.error ? (
        <div className="p-2">
          <ErrorNotice error={file.error} compact onRetry={() => void file.refetch()} />
        </div>
      ) : data && mode === 'binary' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <FileWarning className="size-4 text-muted-foreground" />
          <p className="text-xs font-medium">{data.text === null && !data.binary ? 'Too large to preview' : 'Binary file'}</p>
          <p className="text-2xs text-muted-foreground">Download it to open it on this computer.</p>
        </div>
      ) : data ? (
        <>
          {mode === 'read' ? (
            <p className="shrink-0 border-b border-border bg-muted/50 px-3 py-1 text-3xs text-muted-foreground dark:bg-white/[0.02]">
              {data.truncated ? `Showing the first ${formatBytes(FILE_PREVIEW_MAX_BYTES)}, read-only.` : `Read-only: files over ${formatBytes(FILE_WRITE_MAX_BYTES)} are edited in the terminal.`}
            </p>
          ) : null}
          <textarea
            aria-label={`Contents of ${baseName(path)}`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            readOnly={mode !== 'edit'}
            value={draft ?? data.text ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((isMac() ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                doSave();
              }
            }}
            className={cn(
              'min-h-0 flex-1 resize-none bg-background px-3 py-2 font-mono text-2xs leading-relaxed text-foreground outline-none',
              'focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]',
            )}
          />
          {problem ? <p className="shrink-0 border-t border-border px-3 py-1 text-3xs text-destructive">{problem}</p> : null}
        </>
      ) : null}
    </section>
  );
}
