import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AudioLines, ExternalLink, Film, FolderOpen, ImageIcon, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import type { CatalogModel } from '@shared/contracts/catalog';
import { modalityFromKind, type MediaJob } from '@shared/contracts/media';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useAppInfo, useBudget, useCatalog, useIsSignedIn } from '@renderer/lib/hooks';
import { useCommandRegistry, useUi, type PaletteCommand } from '@renderer/lib/store';
import { RequireAuth } from '@renderer/components/RequireAuth';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { Button } from '@renderer/components/ui/button';
import { DinoLoader } from '@renderer/components/brand/Dino';
import { EmptyState } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { isCreateTab, isGeneratable, modelsForTab, requestFromJob, TAB_LABELS, type CreateTab } from './form';
import { Gallery, type JobHandlers } from './Gallery';
import { GeneratePane } from './GeneratePane';
import { newNonce, useRunFlow } from './hooks';
import { ModelList } from './ModelList';
import { RunDialog } from './RunDialog';
import { useCreateUi } from './state';

/** Tab for a job's modality (history jobs of unknown modality open on the image tab). */
function tabForJob(job: MediaJob, model: CatalogModel | undefined): CreateTab {
  if (model && isCreateTab(model.kind)) return model.kind;
  const m = modalityFromKind(job.modality);
  return isCreateTab(m) ? m : 'image';
}

export default function CreatePage() {
  const catalog = useCatalog();
  const budget = useBudget();
  const signedIn = useIsSignedIn();
  const appInfo = useAppInfo();
  const params = useUi((s) => s.params);
  const navSeq = useUi((s) => s.navSeq);
  const setParams = useUi((s) => s.setParams);
  const register = useCommandRegistry((s) => s.register);

  const tab = useCreateUi((s) => s.tab);
  const selected = useCreateUi((s) => s.selected);
  const setTab = useCreateUi((s) => s.setTab);
  const selectModel = useCreateUi((s) => s.selectModel);
  const loadPreset = useCreateUi((s) => s.loadPreset);
  const requestFocus = useCreateUi((s) => s.requestFocus);

  const models = catalog.data?.models;
  const byId = useMemo(() => new Map((models ?? []).map((m) => [m.id, m])), [models]);
  const tabModels = useMemo(() => modelsForTab(models ?? [], tab), [models, tab]);
  const chosen = selected[tab];
  const chosenModel = chosen ? byId.get(chosen) : undefined;
  // A remembered choice that the Create page no longer offers (text-only output) falls back to the tab's first model.
  const model: CatalogModel | null = (chosenModel && isGeneratable(chosenModel) ? chosenModel : undefined) ?? tabModels[0] ?? null;

  // Deep links: ?model=<id> selects a model (and its tab); ?kind=image|video|audio|workflow switches tabs.
  const handledSeq = useRef(-1);
  useEffect(() => {
    if (handledSeq.current === navSeq) return;
    const wanted = params.model;
    if (wanted && !models) return; // wait for the catalog
    handledSeq.current = navSeq;
    if (wanted) {
      const found = byId.get(wanted);
      if (found && isCreateTab(found.kind) && isGeneratable(found)) selectModel(found.kind, found.id);
      else toast.error('That model is not available for generation', { description: wanted });
    } else if (isCreateTab(params.kind)) {
      setTab(params.kind);
    }
    if (params.focus === '1' || params.kind) requestFocus();
  }, [navSeq, params.model, params.kind, params.focus, models, byId, selectModel, setTab, requestFocus]);

  const pick = useCallback(
    (m: CatalogModel) => {
      if (!isCreateTab(m.kind)) return;
      selectModel(m.kind, m.id);
      setParams({ model: m.id });
    },
    [selectModel, setParams],
  );

  const run = useRunFlow();
  const runRef = useRef(run);
  runRef.current = run;
  // Navigating (palette, deep links) drops a cost confirmation that was left open.
  useEffect(() => runRef.current.cancel(), [navSeq]);

  const handlers: JobHandlers = useMemo(
    () => ({
      onRetake(job) {
        const request = requestFromJob(job);
        if (!request) return;
        const name = byId.get(job.modelId)?.name ?? job.modelId;
        void runRef.current.start(request, { modelName: name, nonce: newNonce() }).then((error) => {
          if (!error) return;
          const view = describeError(error);
          toast.error('Could not retake this job', { description: view.message || view.title });
        });
      },
      onUseSettings(job) {
        const m = byId.get(job.modelId);
        if (!m) {
          toast.error('That model is no longer in the catalog', { description: job.modelId });
          return;
        }
        if (!isGeneratable(m)) {
          toast.error('That model is not available for generation', { description: job.modelId });
          return;
        }
        loadPreset(tabForJob(job, m), { modelId: job.modelId, prompt: job.prompt, values: job.parameters });
        setParams({ model: job.modelId });
      },
    }),
    [byId, loadPreset, setParams],
  );

  useEffect(
    () =>
      register('create', [
        ...(['image', 'video', 'audio'] as const).map(
          (kind): PaletteCommand => ({
            id: `create.new-${kind}`,
            group: 'Create',
            label: `New ${kind}`,
            icon: kind === 'image' ? <ImageIcon /> : kind === 'video' ? <Film /> : <AudioLines />,
            keywords: ['generate', 'media', kind],
            run: () => useUi.getState().navigate('create', { kind, focus: '1' }),
          }),
        ),
        {
          id: 'create.workflows',
          group: 'Create',
          label: 'Run a GMI Studio workflow',
          icon: <Workflow />,
          keywords: ['studio', 'workflow'],
          run: () => useUi.getState().navigate('create', { kind: 'workflow', focus: '1' }),
        },
        {
          id: 'create.studio',
          group: 'Create',
          label: 'Open GMI Studio',
          icon: <ExternalLink />,
          keywords: ['studio', 'workflow', 'console'],
          run: () => gmi.app.openConsole('studio'),
        },
      ]),
    [register],
  );

  const mediaDir = appInfo.data?.mediaDir ?? null;

  let center;
  if (!signedIn) {
    center = (
      <div className="px-5 py-10">
        <RequireAuth reason="Generating images, video and audio runs on your GMI account and is billed to your organisation. Sign in to see your prices and run models. Your gallery on this device stays available.">
          {null}
        </RequireAuth>
      </div>
    );
  } else if (model) {
    center = <GeneratePane key={model.id} model={model} budget={budget.data} run={run} />;
  } else if (catalog.isLoading) {
    center = <DinoLoader label="Loading models" className="min-h-80 flex-1" />;
  } else {
    center = (
      <EmptyState
        className="py-16"
        dino="sleep"
        title={`No ${TAB_LABELS[tab].toLowerCase()} models`}
        description="GMI has not published any for this tab yet. Pick another tab."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <TopBarActions>
        {mediaDir ? (
          <Tooltip label="Open the media folder (local copies of your outputs)" side="bottom">
            <Button variant="ghost" size="sm" onClick={() => void gmi.app.showItemInFolder(mediaDir).catch(() => undefined)}>
              <FolderOpen /> Media folder
            </Button>
          </Tooltip>
        ) : null}
      </TopBarActions>

      <ModelList selectedId={model?.id ?? null} onSelect={pick} />

      <div className="@container flex min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @min-[52rem]:flex-row @min-[52rem]:overflow-hidden">
          <section
            aria-label="Generate"
            className="flex shrink-0 flex-col @min-[52rem]:w-[27rem] @min-[52rem]:overflow-y-auto @min-[52rem]:border-r @min-[52rem]:border-border @6xl:w-[30rem]"
          >
            {center}
          </section>
          <div className="min-w-0 flex-1 border-t border-border @min-[52rem]:overflow-y-auto @min-[52rem]:border-t-0">
            <Gallery handlers={handlers} />
          </div>
        </div>
      </div>

      <RunDialog ticket={run.ticket} budget={budget.data} submitting={run.submitting} error={run.dialogError} onConfirm={() => void run.confirm()} onCancel={run.cancel} />
    </div>
  );
}
