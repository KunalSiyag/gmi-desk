import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderGit2, GitBranch, Loader2, Plus, RefreshCw, ShieldAlert, SquarePen, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import type { ApprovalDecision, CodeThreadEvent, DiffFile, RuntimeMode, TimelineItem } from '@shared/contracts/code';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { DinoLoader } from '@renderer/components/brand/Dino';
import { PageHeader } from '@renderer/components/PageHeader';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { ActiveBar } from '@renderer/components/ui/active-bar';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { Input, Textarea } from '@renderer/components/ui/input';
import { EmptyState, MicroLabel } from '@renderer/components/ui/misc';
import { Select } from '@renderer/components/ui/select';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useCatalog, useCodeEvents } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { cn } from '@renderer/lib/cn';
import { useCodeApprovals, useCodeDiff, useCodeProjects, useCodeState, useCodeThread, useCodeThreads, useCodeTimeline } from './data';
import { diffLine, modelName, STATUS_DOT, STATUS_LABEL, timeAgo } from './format';
import { applyTimelineEvent } from './stream-apply';
import { Composer } from './components/Composer';
import { DiffDialog, RightPanel } from './components/RightPanel';
import { Timeline } from './components/Timeline';

function notify(title: string, error: unknown) {
  const info = describeError(error);
  toast.error(title, { description: info.message || info.title });
}

function NewThreadDialog({
  open,
  onOpenChange,
  projectId,
  defaultBranch,
  models,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  defaultBranch: string | null;
  models: Array<{ value: string; label: string }>;
  onCreated: (threadId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState(defaultBranch ?? 'main');
  const [model, setModel] = useState(models[0]?.value ?? '');
  const [mode, setMode] = useState<RuntimeMode>('auto-accept-edits');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle('');
      setBranch('');
      setBaseRef(defaultBranch ?? 'main');
      setModel(models[0]?.value ?? '');
      setMode('auto-accept-edits');
    }
  }, [open, defaultBranch, models]);

  const create = async () => {
    setBusy(true);
    try {
      const thread = await gmi.code.createThread(projectId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        strategy: { kind: 'worktree', baseRef, branch: branch.trim() || null },
        settings: { model, mode },
      });
      onCreated(thread.id);
      onOpenChange(false);
    } catch (error) {
      notify('Could not create the thread', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New agent thread"
      description="Each thread works on its own git worktree, so several agents can run in parallel without touching your checkout."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void create()} disabled={busy || !model}>
            {busy ? <Loader2 className="animate-spin" /> : <GitBranch />} Create thread
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix the streaming parser" autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Base branch</span>
            <Input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder="main" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Branch name (optional)</span>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="fix-stream-tail" />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Model</span>
          <Select value={model} onValueChange={setModel} options={models} placeholder="Choose a model" className="w-full" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Permission mode</span>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as RuntimeMode)}
            options={[
              { value: 'approval-required', label: 'Approval required: ask before edits and commands' },
              { value: 'auto-accept-edits', label: 'Auto-accept edits: ask before commands' },
              { value: 'auto', label: 'Auto: only destructive or network actions ask' },
              { value: 'full-access', label: 'Full access: no prompts (needs a native confirmation)' },
            ]}
            className="w-full"
          />
        </label>
      </div>
    </Dialog>
  );
}

function CommitDialog({ open, onOpenChange, threadId, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; threadId: string; onDone: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage('');
    setSuggesting(true);
    void gmi.code
      .suggestCommitMessage(threadId)
      .then((r) => setMessage(r.message))
      .catch(() => undefined)
      .finally(() => setSuggesting(false));
  }, [open, threadId]);

  const commit = async () => {
    setBusy(true);
    try {
      const { sha } = await gmi.code.commit(threadId, message.trim());
      toast.success(`Committed ${sha.slice(0, 7)}`);
      onDone();
      onOpenChange(false);
    } catch (error) {
      notify('Could not commit', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commit changes"
      description="Stages the thread's changed files in its worktree and commits them on the thread branch."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void commit()} disabled={busy || !message.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : null} Commit
          </Button>
        </>
      }
    >
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs text-muted-foreground">Message</span>
        {suggesting ? <span className="flex items-center gap-1 text-2xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Suggesting…</span> : null}
      </div>
      <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="min-h-24" />
    </Dialog>
  );
}

export default function CodePage() {
  const client = useQueryClient();
  const state = useCodeState();
  const projects = useCodeProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.data?.find((p) => p.id === projectId) ?? projects.data?.[0];
  const threads = useCodeThreads(project?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const threadId = selectedId ?? threads.data?.[0]?.id ?? null;
  const thread = useCodeThread(threadId);
  const timeline = useCodeTimeline(threadId);
  const approvals = useCodeApprovals();
  const diff = useCodeDiff(threadId);
  const catalog = useCatalog();
  const [pinSignal, setPinSignal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [newThread, setNewThread] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [openFile, setOpenFile] = useState<DiffFile | null>(null);

  const models = useMemo(
    () =>
      (catalog.data?.models ?? [])
        .filter((m) => m.kind === 'llm')
        .slice(0, 200)
        .map((m) => ({ value: m.id, label: `${m.name}${m.provider ? ` · ${m.provider}` : ''}` })),
    [catalog.data],
  );

  const onThreadEvent = useCallback(
    (event: CodeThreadEvent) => {
      if (event.threadId === threadId && (event.type === 'item' || event.type === 'delta')) {
        client.setQueryData(qk.codeTimeline(threadId), (current: { items: TimelineItem[]; hasMore: boolean; lastSeq: number } | undefined) => {
          if (!current) return current;
          const next = applyTimelineEvent({ items: current.items, lastSeq: current.lastSeq }, event);
          return { ...current, items: next.items, lastSeq: next.lastSeq };
        });
        if (event.type === 'item') void client.invalidateQueries({ queryKey: qk.codeThread(threadId) });
        return;
      }
      void client.invalidateQueries({ queryKey: qk.codeThreads, refetchType: 'active' });
      if (event.threadId === threadId) {
        void client.invalidateQueries({ queryKey: qk.codeThread(threadId), refetchType: 'active' });
        if (event.type === 'diff') void client.invalidateQueries({ queryKey: qk.codeDiff(threadId), refetchType: 'active' });
      }
    },
    [client, threadId],
  );
  useCodeEvents(onThreadEvent);

  const pending = useMemo(() => new Map((approvals.data ?? []).map((a) => [a.requestId, a])), [approvals.data]);
  const threadApprovals = useMemo(() => new Map((approvals.data ?? []).filter((a) => a.threadId === threadId).map((a) => [a.requestId, a])), [approvals.data, threadId]);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: qk.codeState });
    void client.invalidateQueries({ queryKey: qk.codeProjects });
    void client.invalidateQueries({ queryKey: qk.codeThreads });
    if (threadId) {
      void client.invalidateQueries({ queryKey: qk.codeThread(threadId) });
      void client.invalidateQueries({ queryKey: qk.codeTimeline(threadId) });
      void client.invalidateQueries({ queryKey: qk.codeDiff(threadId) });
    }
  };

  const decide = async (requestId: string, decision: ApprovalDecision) => {
    setDeciding(requestId);
    try {
      await gmi.code.respondApproval(requestId, decision);
      await client.invalidateQueries({ queryKey: qk.codeApprovals });
      if (threadId) await client.invalidateQueries({ queryKey: qk.codeTimeline(threadId) });
    } catch (error) {
      notify('Could not answer the approval', error);
    } finally {
      setDeciding(null);
    }
  };

  const send = async (text: string) => {
    if (!threadId) return;
    setBusy(true);
    try {
      const result = await gmi.code.send(threadId, text);
      if (result.budgetWarning) toast.warning('Budget', { description: result.budgetWarning });
      setPinSignal((n) => n + 1);
      await client.invalidateQueries({ queryKey: qk.codeTimeline(threadId) });
      await client.invalidateQueries({ queryKey: qk.codeThread(threadId) });
    } catch (error) {
      notify('Could not send', error);
    } finally {
      setBusy(false);
    }
  };

  const steer = async (text: string) => {
    if (!threadId) return;
    try {
      await gmi.code.steer(threadId, text);
      toast.success('Queued as steering');
    } catch (error) {
      notify('Could not steer the run', error);
    }
  };

  const stop = async () => {
    if (!threadId) return;
    try {
      await gmi.code.interrupt(threadId);
    } catch (error) {
      notify('Could not stop the run', error);
    }
  };

  const changeMode = async (mode: RuntimeMode) => {
    if (!threadId) return;
    try {
      await gmi.code.updateThread(threadId, { settings: { mode } });
      await client.invalidateQueries({ queryKey: qk.codeThread(threadId) });
    } catch (error) {
      notify('Could not change the mode', error);
    }
  };

  const changeModel = async (model: string) => {
    if (!threadId) return;
    try {
      await gmi.code.updateThread(threadId, { settings: { model } });
      await client.invalidateQueries({ queryKey: qk.codeThread(threadId) });
    } catch (error) {
      notify('Could not change the model', error);
    }
  };

  const addProject = async () => {
    try {
      const added = await gmi.code.addProject();
      if (!added) return;
      setProjectId(added.id);
      await client.invalidateQueries({ queryKey: qk.codeProjects });
      await client.invalidateQueries({ queryKey: qk.codeThreads });
    } catch (error) {
      notify('Could not add the project', error);
    }
  };

  const trust = async () => {
    if (!project) return;
    try {
      await gmi.code.trustProject(project.id);
      await client.invalidateQueries({ queryKey: qk.codeProjects });
      toast.success('Project trusted');
    } catch (error) {
      notify('Could not trust the project', error);
    }
  };

  const openDiff = async (path: string) => {
    if (!threadId) return;
    try {
      setOpenFile(await gmi.code.getFileDiff(threadId, path));
    } catch (error) {
      notify('Could not load the diff', error);
    }
  };

  const loaded = state.data && projects.data && threads.data;
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        {state.error || projects.error ? <ErrorNotice error={state.error ?? projects.error} onRetry={refresh} className="max-w-md" /> : <DinoLoader label="Loading Code" />}
      </div>
    );
  }

  const selected = thread.data;
  const items = timeline.data?.items ?? [];
  const diffFiles = diff.data ?? [];
  const running = selected && (selected.status === 'running' || selected.status === 'queued' || selected.status === 'compacting' || selected.status === 'awaiting_approval');

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[15.5rem] shrink-0 flex-col border-r border-border/70 bg-card/20">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
          <Select
            variant="ghost"
            value={project?.id ?? ''}
            onValueChange={(id) => {
              setProjectId(id);
              setSelectedId(null);
            }}
            options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            placeholder="No project"
            className="min-w-0 flex-1"
            aria-label="Project"
          />
          {/* A quiet new-thread control beside the project it belongs to (T3 Code); "Add project" lives in the top bar.
              The lime fill stays free for the one action the open thread needs (an approval, the composer's send). */}
          <Tooltip label="New thread" side="bottom">
            <Button size="icon-xs" variant="ghost" disabled={!project || project.trust.state !== 'trusted'} onClick={() => setNewThread(true)} aria-label="New thread">
              <SquarePen />
            </Button>
          </Tooltip>
        </div>
        <div className="flex items-center justify-between pb-1 pl-3.5 pr-2.5 pt-2.5">
          <MicroLabel>Threads</MicroLabel>
          <Tooltip label="Refresh" side="bottom">
            <Button size="icon-xs" variant="ghost" onClick={refresh} aria-label="Refresh threads">
              <RefreshCw />
            </Button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
          {threads.data?.length === 0 ? <p className="px-2 py-3 text-2xs text-muted-foreground">No threads yet.</p> : null}
          {threads.data?.map((t) => {
            const current = t.id === threadId;
            return (
              // A full-width row: a press deepens its background instead of scaling it (kit rowPressMotion).
              <button
                key={t.id}
                type="button"
                aria-current={current || undefined}
                title={t.title}
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  'relative w-full rounded-md px-2 py-2 text-left',
                  rowPressMotion,
                  // The selected row switches instantly (thread switching is high-frequency): no background ease.
                  current ? 'bg-accent text-foreground transition-none' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                {current ? <ActiveBar /> : null}
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[t.status])} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.title}</span>
                  <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">{timeAgo(t.updatedAt)}</span>
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3 text-2xs text-muted-foreground">
                  <span className="shrink-0">{STATUS_LABEL[t.status]}</span>
                  {t.pendingApprovals > 0 ? (
                    <Badge variant="warning" size="sm" className="tabular-nums">
                      {t.pendingApprovals} {t.pendingApprovals === 1 ? 'approval' : 'approvals'}
                    </Badge>
                  ) : null}
                  {t.diff ? <span className="truncate tabular-nums">{diffLine(t.diff)}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border/70 px-4 py-2">
          <div className="min-w-0 flex-1">
            <PageHeader
              title="Code"
              description={
                project ? (
                  <span className="flex items-center gap-2">
                    <FolderGit2 className="size-3.5" /> {project.name}
                    {selected ? (
                      <>
                        <span aria-hidden>·</span>
                        <GitBranch className="size-3.5" /> {selected.branch ?? 'root'}
                      </>
                    ) : null}
                    {selected ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className={cn('size-1.5 rounded-full', STATUS_DOT[selected.status])} />
                        {STATUS_LABEL[selected.status]}
                      </>
                    ) : null}
                  </span>
                ) : (
                  'Agent threads on your repositories'
                )
              }
              actions={
                <>
                  {pending.size > 0 ? (
                    <Badge variant="warning" className="tabular-nums">
                      <ShieldAlert /> {pending.size} approval{pending.size === 1 ? '' : 's'}
                    </Badge>
                  ) : null}
                  {state.data.mock ? <Badge variant="outline" className="font-mono text-3xs uppercase tracking-[0.12em]">Demo</Badge> : null}
                  {state.data.hostState !== 'ready' && !state.data.mock ? (
                    <Badge variant="warning" className="font-mono text-3xs uppercase tracking-[0.12em]">
                      {state.data.hostState}
                    </Badge>
                  ) : null}
                </>
              }
            />
            <TopBarActions>
              <Button size="sm" variant="outline" onClick={() => void addProject()}>
                <FolderGit2 /> Add project
              </Button>
            </TopBarActions>
          </div>
        </div>

        {!project ? (
          <EmptyState
            dino="sleep"
            title="No project yet"
            description="Add a git repository and GMI Desk gives each agent thread its own worktree."
            action={
              <Button size="sm" onClick={() => void addProject()}>
                <FolderGit2 /> Add a project
              </Button>
            }
            className="flex-1"
          />
        ) : project.trust.state !== 'trusted' ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-xl border border-warning/30 bg-warning/[0.05] p-5">
              <ShieldAlert className="size-5 text-warning-foreground" />
              <h2 className="mt-2 text-sm font-medium">{project.trust.state === 'changed' ? 'Project configuration changed' : 'Review this project first'}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {project.trust.state === 'changed'
                  ? 'AGENTS.md, CLAUDE.md, MCP servers or permission files changed since you trusted this project. Review them before agents run again.'
                  : 'Before an agent runs here, review its instruction files, MCP servers and permission rules. Nothing runs until you trust the project.'}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" onClick={() => void trust()}>
                  Review and trust
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void addProject()}>
                  Use another project
                </Button>
              </div>
            </div>
          </div>
        ) : !selected || !threadId ? (
          <EmptyState
            dino="idle"
            icon={<Terminal />}
            title="Start an agent thread"
            description="A thread gets a git worktree on its own branch, runs tools in the sandbox, and asks for approval only when it needs you."
            action={
              <Button size="sm" onClick={() => setNewThread(true)}>
                <Plus /> New thread
              </Button>
            }
            className="flex-1"
          />
        ) : (
          <>
            <Timeline
              key={threadId}
              thread={selected}
              items={items}
              approvals={threadApprovals}
              deciding={deciding}
              pinSignal={pinSignal}
              onDecide={(requestId, decision) => void decide(requestId, decision)}
            />
            <Composer
              thread={selected}
              models={models}
              busy={busy}
              onSend={send}
              onSteer={steer}
              onStop={() => void stop()}
              onMode={(m) => void changeMode(m)}
              onModel={(m) => void changeModel(m)}
            />
          </>
        )}
      </div>

      {threadId && selected ? (
        <RightPanel
          thread={selected}
          diff={diffFiles}
          busy={running || busy}
          onOpenFile={(path) => void openDiff(path)}
          onCommit={() => setCommitOpen(true)}
          onExport={() => {
            void gmi.code
              .exportPatch(threadId)
              .then((path) => path && toast.success('Patch saved', { description: path }))
              .catch((error: unknown) => notify('Could not export the patch', error));
          }}
          onMerge={() => {
            void gmi.code
              .mergeToBase(threadId, 'squash')
              .then(({ sha }) => toast.success(`Merged as ${sha.slice(0, 7)}`))
              .catch((error: unknown) => notify('Could not merge', error));
          }}
        />
      ) : null}

      {project ? (
        <NewThreadDialog
          open={newThread}
          onOpenChange={setNewThread}
          projectId={project.id}
          defaultBranch={project.defaultBranch}
          models={models}
          onCreated={(id) => {
            setSelectedId(id);
            void client.invalidateQueries({ queryKey: qk.codeThreads });
            void client.invalidateQueries({ queryKey: qk.codeTimeline(id) });
          }}
        />
      ) : null}
      {threadId ? <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} threadId={threadId} onDone={() => void client.invalidateQueries({ queryKey: qk.codeDiff(threadId) })} /> : null}
      <DiffDialog file={openFile} onClose={() => setOpenFile(null)} />
    </div>
  );
}
