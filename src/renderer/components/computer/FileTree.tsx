// The Files tab's tree (compute.md §8.3): a lazy tree from $HOME (one listDir per opened folder), selection, and the
// row actions (download, rename, delete with a renderer confirmation, new folder). Every path is checked here first
// (paths.ts) and again in main; the renderer never names a local path (upload and download dialogs are main's).
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, File, FileSymlink, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { DirEntry, DirListing } from '@shared/contracts/compute';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { activeBarBefore } from '@renderer/components/ui/active-bar';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { DropdownMenu } from '@renderer/components/ui/menu';
import { Skeleton, Spinner } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { formatBytes } from '@renderer/pages/compute/format';
import { toastActionError } from '@renderer/pages/compute/hooks';
import { Toolbar } from './parts';
import { displayPath, entryNameError, isWithin, joinRemote, parentOf } from './paths';
import { computerKeys } from './session';
import { useComputerUi, useStoreNow } from './store';

/** Directories first, then names (case-insensitive, numbers in order). */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    const da = a.type === 'dir' ? 0 : 1;
    const db = b.type === 'dir' ? 0 : 1;
    return da - db || collator.compare(a.name, b.name);
  });
}

const INDENT_PX = 12;

function useDir(sessionId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: computerKeys.dir(sessionId, path),
    queryFn: () => gmi.computer.listDir(sessionId, path),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

type Editing = { kind: 'rename'; path: string } | { kind: 'mkdir'; dir: string } | null;

export function FileTree({ sessionId, root, home }: { sessionId: string; root: string; home: string | null }) {
  const client = useQueryClient();
  const selected = useStoreNow(useComputerUi, (s) => s.selected[sessionId] ?? null);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<DirEntry | null>(null);
  const select = useComputerUi((s) => s.select);
  const toggle = useComputerUi((s) => s.toggleExpanded);

  // Uploads and new folders go into the selected folder (or the folder of the selected file), else the root.
  const targetDir = selected ? (selected.type === 'dir' ? selected.path : parentOf(selected.path)) : root;

  const refreshDir = (dir: string) => client.invalidateQueries({ queryKey: computerKeys.dir(sessionId, dir) });

  const upload = useMutation({
    mutationFn: () => gmi.computer.upload(sessionId, targetDir),
    onError: (error) => toastActionError('Could not upload', error),
  });
  const download = useMutation({
    mutationFn: (path: string) => gmi.computer.download(sessionId, path),
    onError: (error) => toastActionError('Could not download', error),
  });
  const remove = useMutation({
    mutationFn: (entry: DirEntry) => gmi.computer.removePath(sessionId, entry.path),
    onSuccess: (_void, entry) => {
      setDeleting(null);
      if (selected && isWithin(selected.path, entry.path)) select(sessionId, null);
      void refreshDir(parentOf(entry.path));
    },
    onError: (error) => toastActionError('Could not delete', error),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-2xs text-muted-foreground" title={targetDir}>
          {displayPath(targetDir, home)}
        </span>
        <Tooltip label="New folder">
          <Button variant="ghost" size="icon-xs" aria-label="New folder" onClick={() => setEditing({ kind: 'mkdir', dir: targetDir })}>
            <FolderPlus />
          </Button>
        </Tooltip>
        <Tooltip label={`Upload into ${displayPath(targetDir, home)}`}>
          <Button variant="ghost" size="icon-xs" aria-label="Upload files" disabled={upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? <Spinner className="size-3" /> : <Upload />}
          </Button>
        </Tooltip>
        <Tooltip label="Refresh">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh files"
            onClick={() => void client.invalidateQueries({ queryKey: computerKeys.dirAll(sessionId) })}
          >
            <RefreshCw />
          </Button>
        </Tooltip>
      </Toolbar>
      <div role="tree" aria-label="Files" className="min-h-0 flex-1 overflow-y-auto py-1">
        <DirChildren
          sessionId={sessionId}
          path={root}
          depth={0}
          editing={editing}
          setEditing={setEditing}
          onDownload={(path) => download.mutate(path)}
          onDelete={setDeleting}
          onToggle={(path, open) => toggle(sessionId, path, open)}
        />
      </div>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? ''}?`}
        description={
          deleting?.type === 'dir' ? 'The folder and everything in it are removed from the computer for good.' : 'The file is removed from the computer for good.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {remove.isPending ? <Spinner className="size-3.5 text-current" /> : <Trash2 />} Delete
            </Button>
          </>
        }
      >
        {deleting ? <p className="font-mono text-2xs break-all text-muted-foreground">{deleting.path}</p> : null}
      </Dialog>
    </div>
  );
}

interface ChildrenProps {
  sessionId: string;
  path: string;
  depth: number;
  editing: Editing;
  setEditing: (editing: Editing) => void;
  onDownload: (path: string) => void;
  onDelete: (entry: DirEntry) => void;
  onToggle: (path: string, open?: boolean) => void;
}

function DirChildren(props: ChildrenProps) {
  const { sessionId, path, depth, editing, setEditing } = props;
  const listing = useDir(sessionId, path);
  const pad = { paddingLeft: 8 + depth * INDENT_PX };
  return (
    <div role="group">
      {editing?.kind === 'mkdir' && editing.dir === path ? (
        <NameEditor
          sessionId={sessionId}
          depth={depth}
          initial=""
          placeholder="New folder"
          onCancel={() => setEditing(null)}
          onSubmit={async (name) => {
            const target = joinRemote(path, name);
            if (!target) return;
            await gmi.computer.makeDir(sessionId, target);
            setEditing(null);
          }}
          refresh={path}
        />
      ) : null}
      {listing.isPending ? (
        <div className="flex flex-col gap-1.5 py-1.5 pr-3" style={pad}>
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : listing.error ? (
        <div className="py-1 pr-2" style={pad}>
          <ErrorNotice error={listing.error} compact onRetry={() => void listing.refetch()} />
        </div>
      ) : listing.data ? (
        <DirRows {...props} listing={listing.data} />
      ) : null}
    </div>
  );
}

function DirRows({ listing, ...props }: ChildrenProps & { listing: DirListing }) {
  const entries = sortEntries(listing.entries);
  if (!entries.length) {
    return (
      <p className="py-1 text-2xs italic text-muted-foreground" style={{ paddingLeft: 8 + props.depth * INDENT_PX + 18 }}>
        Empty folder
      </p>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <EntryRow key={entry.path} entry={entry} {...props} />
      ))}
      {listing.truncated ? (
        <p className="py-1 text-2xs text-muted-foreground" style={{ paddingLeft: 8 + props.depth * INDENT_PX + 18 }}>
          Showing the first {entries.length.toLocaleString('en-US')} entries. Use the terminal for the rest.
        </p>
      ) : null}
    </>
  );
}

function EntryRow({ entry, ...props }: ChildrenProps & { entry: DirEntry }) {
  const { sessionId, depth, editing, setEditing, onDownload, onDelete, onToggle } = props;
  const isDir = entry.type === 'dir';
  const open = useStoreNow(useComputerUi, (s) => isDir && (s.expanded[sessionId]?.includes(entry.path) ?? false));
  const selected = useStoreNow(useComputerUi, (s) => s.selected[sessionId]?.path === entry.path);
  const select = useComputerUi((s) => s.select);

  if (editing?.kind === 'rename' && editing.path === entry.path) {
    return (
      <NameEditor
        sessionId={sessionId}
        depth={depth}
        initial={entry.name}
        placeholder={entry.name}
        onCancel={() => setEditing(null)}
        onSubmit={async (name) => {
          const target = joinRemote(parentOf(entry.path), name);
          if (!target) return;
          if (name !== entry.name) await gmi.computer.movePath(sessionId, entry.path, target);
          if (selected) select(sessionId, { path: target, type: isDir ? 'dir' : 'file' });
          setEditing(null);
        }}
        refresh={parentOf(entry.path)}
      />
    );
  }

  const activate = () => {
    select(sessionId, { path: entry.path, type: isDir ? 'dir' : 'file' });
    if (isDir) onToggle(entry.path);
  };
  const Icon = isDir ? (open ? FolderOpen : Folder) : entry.type === 'symlink' ? FileSymlink : File;
  const size = isDir ? null : formatBytes(entry.size);

  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={isDir ? open : undefined}
        tabIndex={0}
        data-path={entry.path}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          } else if (isDir && e.key === 'ArrowRight') onToggle(entry.path, true);
          else if (isDir && e.key === 'ArrowLeft') onToggle(entry.path, false);
          else if (e.key === 'F2') setEditing({ kind: 'rename', path: entry.path });
          else if (e.key === 'Delete') onDelete(entry);
        }}
        style={{ paddingLeft: 8 + depth * INDENT_PX }}
        className={cn(
          // Full-width row (kit rowPressMotion): a press deepens the background, never scales. Selection and keyboard
          // focus stay instant (transition-none).
          'group/row relative flex h-6 cursor-default items-center gap-1 pr-1 text-xs outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:transition-none',
          rowPressMotion,
          selected && cn('bg-accent transition-none', activeBarBefore),
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground', !isDir && 'invisible', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('min-w-0 flex-1 truncate', entry.name.startsWith('.') && 'text-muted-foreground')}>{entry.name}</span>
        {size ? <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">{size}</span> : null}
        <span className={cn('shrink-0', selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}>
          <DropdownMenu
            trigger={
              <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${entry.name}`} className="size-5" onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal />
              </Button>
            }
            items={[
              ...(isDir ? [] : [{ label: 'Download…', icon: <Download />, onSelect: () => onDownload(entry.path) }]),
              ...(isDir ? [{ label: 'New folder here', icon: <FolderPlus />, onSelect: () => (onToggle(entry.path, true), setEditing({ kind: 'mkdir', dir: entry.path })) }] : []),
              { label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: () => setEditing({ kind: 'rename', path: entry.path }) },
              'separator',
              { label: 'Delete…', icon: <Trash2 />, destructive: true, onSelect: () => onDelete(entry) },
            ]}
          />
        </span>
      </div>
      {isDir && open ? <DirChildren {...props} path={entry.path} depth={depth + 1} /> : null}
    </>
  );
}

/** Inline name field for rename and new folder: Enter saves, Escape cancels, the rule broken is shown under it. */
function NameEditor({
  sessionId,
  depth,
  initial,
  placeholder,
  onSubmit,
  onCancel,
  refresh,
}: {
  sessionId: string;
  depth: number;
  initial: string;
  placeholder: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
  /** Folder to re-list after a successful change. */
  refresh: string;
}) {
  const client = useQueryClient();
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const problem = entryNameError(name);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, like a file manager.
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = async () => {
    setTouched(true);
    if (problem || pending) return;
    setPending(true);
    try {
      await onSubmit(name);
      void client.invalidateQueries({ queryKey: computerKeys.dir(sessionId, refresh) });
    } catch (error) {
      toastActionError(initial ? 'Could not rename' : 'Could not create the folder', error);
    } finally {
      setPending(false);
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="py-0.5 pr-2" style={{ paddingLeft: 8 + depth * INDENT_PX + 16 }}>
      <Input
        ref={ref}
        aria-label={initial ? `New name for ${initial}` : 'Folder name'}
        aria-invalid={touched && problem ? true : undefined}
        aria-describedby={touched && problem ? `${id}-err` : undefined}
        value={name}
        placeholder={placeholder}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!pending && (name === initial || !name.trim())) onCancel();
        }}
        className="h-6 px-1.5 text-xs"
      />
      {touched && problem ? (
        <p id={`${id}-err`} className="mt-0.5 text-3xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
