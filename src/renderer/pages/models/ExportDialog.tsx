import { useMutation } from '@tanstack/react-query';
import { Copy, FolderOpen, RotateCw } from 'lucide-react';
import type { OpenCodeExport } from '@shared/contracts/catalog';
import { gmi } from '@renderer/lib/gmi';
import { Dino } from '@renderer/components/brand/Dino';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Markdown } from '@renderer/components/Markdown';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { MicroLabel, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { copyText, CopyButton } from './parts';

/** Runs the export (writes the file in the main process) and keeps the last result for the dialog. */
export function useOpenCodeExport() {
  return useMutation<OpenCodeExport, unknown, void>({ mutationFn: () => gmi.catalog.exportOpenCode() });
}

export function ExportDialog({
  open,
  onOpenChange,
  state,
  signedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ReturnType<typeof useOpenCodeExport>;
  signedIn: boolean;
}) {
  const result = state.data;
  const reveal = () => {
    if (result) void gmi.app.showItemInFolder(result.configPath).catch(() => undefined);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="w-[min(36rem,calc(100vw-2rem))]"
      title="Export for OpenCode / T3 Code"
      description={
        result
          ? `${result.modelCount} GMI chat models written as an OpenCode provider config, with ${signedIn ? 'your prices' : 'GMI’s public list prices'}.`
          : 'Writes the live GMI chat-model list as an OpenCode provider config.'
      }
      footer={
        result ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => state.mutate()} disabled={state.isPending}>
              {state.isPending ? <Spinner /> : <RotateCw />} Export again
            </Button>
            <Button variant="outline" size="sm" onClick={reveal}>
              <FolderOpen /> Reveal file
            </Button>
            <Button size="sm" onClick={() => void copyText(result.configPath, 'Path copied')}>
              <Copy /> Copy path
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        )
      }
    >
      {state.isPending && !result ? (
        <div className="flex flex-col gap-2 py-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-28" />
        </div>
      ) : state.error ? (
        <ErrorNotice error={state.error} onRetry={() => state.mutate()} className="my-2" />
      ) : result ? (
        <div className="flex flex-col gap-3 pb-1">
          {/* The success moment: Dino hops once next to the file that was written. */}
          <div className="flex min-w-0 items-end gap-3">
            <Dino mood="happy" size={44} className="-mb-0.5" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <MicroLabel>Config file</MicroLabel>
              <div className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-border bg-muted/40 pl-2.5">
                <span className="min-w-0 flex-1 select-text truncate font-mono text-2xs" title={result.configPath}>
                  {result.configPath}
                </span>
                <CopyButton text={result.configPath} label="Copy path" />
              </div>
            </div>
          </div>
          <Markdown className="text-xs leading-relaxed [&_pre]:text-3xs">{result.instructions}</Markdown>
        </div>
      ) : null}
    </Dialog>
  );
}
