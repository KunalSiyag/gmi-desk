import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ERROR_HINTS, GmiError } from '@shared/contracts/errors';
import { isTerminalJobStatus, type MediaEstimate, type MediaJob, type MediaJobList, type MediaRequest } from '@shared/contracts/media';
import { formatUsd } from '@shared/lib/money';
import { describeError, errorCode } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useGmiEvent, useIsSignedIn } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { requestKey, upsertJob } from './form';

/** Re-renders every `intervalMs` (relative times, elapsed counters). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** True once the element has come within `margin` of the viewport (stays true). */
export function useSeen(ref: RefObject<Element | null>, margin = '200px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin, seen]);
  return seen;
}

/** Writes one job into every cached gallery page and its detail entry. */
export function applyJobToCache(client: QueryClient, job: MediaJob): void {
  client.setQueriesData<MediaJobList>({ queryKey: qk.mediaJobs }, (old) => (old ? upsertJob(old, job) : old));
  client.setQueryData(qk.mediaJob(job.id), job);
}

const RELIST_WINDOW_MS = 2 * 60 * 60_000;

/** The gallery: local jobs merged with GMI's history, kept live by `media:job`. */
export function useMediaJobs(limit: number) {
  const signedIn = useIsSignedIn();
  const client = useQueryClient();
  useGmiEvent('media:job', (job) => applyJobToCache(client, job));
  return useQuery({
    queryKey: [...qk.mediaJobs, limit, signedIn],
    queryFn: () => gmi.media.listJobs({ limit }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // Jobs started elsewhere are not polled one by one; re-list while any of them is still running.
    refetchInterval: (query) =>
      query.state.data?.jobs.some(
        (j) => !j.fromThisDevice && !isTerminalJobStatus(j.status) && j.status !== 'unknown' && Date.now() - Date.parse(j.createdAt) < RELIST_WINDOW_MS,
      )
        ? 60_000
        : false,
  });
}

const ESTIMATE_FRESH_MS = 2 * 60_000;

/**
 * Debounced live price for the form (estimate_generation is free). `request` null = nothing to price.
 * `ready` is the estimate for exactly the current request, while it is fresh enough to approve as is.
 */
export function useLiveEstimate(request: MediaRequest | null) {
  const client = useQueryClient();
  const key = request ? requestKey(request) : null;
  const debounced = useDebouncedValue(key, 600);
  // Recorded spend changes what the budget allows: price again.
  useGmiEvent('usage:budget', () => void client.invalidateQueries({ queryKey: ['media', 'estimate'] }));
  const query = useQuery({
    queryKey: ['media', 'estimate', debounced],
    queryFn: () => gmi.media.estimate(JSON.parse(debounced as string) as MediaRequest),
    enabled: debounced !== null && debounced === key,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const exact = key !== null && debounced === key && !query.isPlaceholderData;
  const ready = exact && query.data && Date.now() - query.dataUpdatedAt < ESTIMATE_FRESH_MS ? query.data : null;
  return {
    data: key === null ? undefined : query.data,
    error: exact ? query.error : null,
    /** Waiting for the debounce or GMI. */
    pending: key !== null && (debounced !== key || query.isFetching),
    /** The shown figure belongs to an earlier version of the form. */
    stale: key !== null && !exact,
    ready,
    refetch: () => void query.refetch(),
  };
}

// ------------------------------------------------------------------------------------------------ run flow

export interface RunTicket {
  request: MediaRequest;
  estimate: MediaEstimate;
  modelName: string;
  /** Set for a deliberate retake: GMI would otherwise hand back the earlier identical job. */
  nonce?: string;
}

export function newNonce(): string {
  return `retake-${crypto.randomUUID()}`;
}

/**
 * estimate → (confirm) → submit. Budget blocks and missing prices stop before anything is charged; the dialog asks
 * for approval whenever the budget says so (every run by default) and re-prices if GMI's price moved meanwhile.
 */
export function useRunFlow() {
  const client = useQueryClient();
  const [ticket, setTicket] = useState<RunTicket | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const clearError = useCallback(() => setError(null), []);
  const busy = useRef(false);

  const submit = async (t: RunTicket) => {
    const job = await gmi.media.submit({ ...t.request, approvedUsd: t.estimate.chargedUsd, nonce: t.nonce });
    applyJobToCache(client, job);
    if (job.deduplicated) {
      toast.info('GMI returned your earlier identical request', {
        description: 'Nothing new was charged. Use Retake on the card for a fresh take.',
      });
    } else {
      toast.success(job.status === 'success' ? `${t.modelName} finished` : `${t.modelName} started`, {
        description: `${formatUsd(t.estimate.chargedUsd)} · it appears in the gallery`,
      });
    }
  };

  /** Resolves with the error that stopped the run (also kept in `error`), or null. */
  const start = async (request: MediaRequest, meta: { modelName: string; nonce?: string; estimate?: MediaEstimate | null }): Promise<unknown> => {
    // A ref, not state: two clicks in the same frame must not both get through.
    if (busy.current) return null;
    busy.current = true;
    setError(null);
    setPreparing(true);
    try {
      const estimate = meta.estimate ?? (await gmi.media.estimate(request));
      // A model GMI cannot price in advance is never run: there is nothing to approve or check against the budget.
      if (estimate.unpriced) throw new GmiError('not_implemented', estimate.note ?? "GMI can't price this model before it runs, so it was not run.");
      if (!estimate.budget.allowed) throw new GmiError('budget_exceeded', estimate.budget.reason ?? ERROR_HINTS.budget_exceeded);
      if (estimate.chargedUsd === null) throw new GmiError('upstream', 'GMI did not return a price for this request, so it was not run.');
      const next: RunTicket = { request, estimate, modelName: meta.modelName, nonce: meta.nonce };
      if (estimate.budget.needsConfirmation) {
        setDialogError(null);
        setTicket(next);
        return null;
      }
      await submit(next);
      return null;
    } catch (e) {
      setError(e);
      return e;
    } finally {
      busy.current = false;
      setPreparing(false);
    }
  };

  const confirm = async () => {
    if (!ticket || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setDialogError(null);
    try {
      await submit(ticket);
      setTicket(null);
    } catch (e) {
      if (errorCode(e) === 'confirmation_required') {
        // GMI's price moved since the estimate: show the new figure and ask again.
        try {
          const estimate = await gmi.media.estimate(ticket.request);
          setTicket({ ...ticket, estimate });
        } catch (repriceError) {
          e = repriceError;
        }
      }
      setDialogError(e);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return {
    ticket,
    preparing,
    submitting,
    error,
    dialogError,
    start,
    confirm,
    cancel: () => {
      if (!submitting) setTicket(null);
    },
    clearError,
  };
}

// ------------------------------------------------------------------------------------------------ job actions

function notifyError(title: string, error: unknown) {
  const view = describeError(error);
  toast.error(title, { description: view.message || view.title });
}

export function copyText(text: string, what: string, description?: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`, description ? { description } : undefined))
    .catch(() => toast.error('Could not copy to the clipboard'));
}

/** Gallery actions shared by cards and the detail view. */
export function useJobActions() {
  const client = useQueryClient();
  return {
    async saveAll(job: MediaJob) {
      try {
        // The first save also loads the outputs of a history job that was never opened.
        let latest = await gmi.media.saveOutput(job.id, 0);
        for (let i = 1; i < latest.outputs.length; i += 1) latest = await gmi.media.saveOutput(job.id, i);
        applyJobToCache(client, latest);
        toast.success('Saved to your media folder', {
          description: latest.outputs.length > 1 ? `${latest.outputs.length} files. Use Show in folder to open them.` : 'Use Show in folder to open it.',
        });
      } catch (error) {
        notifyError('Could not save the output', error);
      }
    },
    async reveal(job: MediaJob, index = 0) {
      try {
        await gmi.media.revealOutput(job.id, index);
      } catch (error) {
        notifyError('Could not show the file', error);
      }
    },
    copyUrls(job: MediaJob, index?: number) {
      const urls = index === undefined ? job.outputs.map((o) => o.url) : [job.outputs[index]?.url ?? ''];
      const text = urls.filter(Boolean).join('\n');
      if (!text) return;
      copyText(text, urls.length > 1 ? 'Links' : 'Link', 'Public link: anyone who has it can open the file.');
    },
    async open(url: string) {
      try {
        await gmi.app.openExternal(url);
      } catch (error) {
        notifyError('Could not open the link', error);
      }
    },
    async refresh(job: MediaJob) {
      try {
        applyJobToCache(client, await gmi.media.getJob(job.id));
      } catch (error) {
        notifyError('Could not check this generation', error);
      }
    },
  };
}

// ------------------------------------------------------------------------------------------------ history previews

type PreviewState = 'loading' | 'done' | 'failed';
const previewStates = new Map<string, PreviewState>();
const previewQueue: Array<() => Promise<void>> = [];
let previewActive = 0;

function pumpPreviews(): void {
  while (previewActive < 2 && previewQueue.length > 0) {
    const task = previewQueue.shift() as () => Promise<void>;
    previewActive += 1;
    void task().finally(() => {
      previewActive -= 1;
      pumpPreviews();
    });
  }
}

/**
 * Jobs from GMI's history (not started here) arrive without outputs; once a card is on screen, fetch its result
 * (get_generation is read-only and free), two at a time, once per session. GMI forgets old requests: those fail.
 */
export function useHistoryPreview(job: MediaJob, visible: boolean): PreviewState | 'idle' {
  const client = useQueryClient();
  const needed = !job.fromThisDevice && job.outputs.length === 0 && job.status === 'success';
  const [state, setState] = useState<PreviewState | 'idle'>(() => previewStates.get(job.id) ?? 'idle');
  useEffect(() => {
    if (!needed || !visible) return;
    const known = previewStates.get(job.id);
    if (known) {
      setState(known);
      return;
    }
    previewStates.set(job.id, 'loading');
    setState('loading');
    previewQueue.push(async () => {
      try {
        applyJobToCache(client, await gmi.media.getJob(job.id));
        previewStates.set(job.id, 'done');
        setState('done');
      } catch (error) {
        if (errorCode(error) === 'not_found') {
          // GMI forgot this older request: remember, so it is not asked again this session.
          previewStates.set(job.id, 'failed');
          setState('failed');
        } else {
          // Signed out, offline, rate-limited...: try again the next time the card shows up.
          previewStates.delete(job.id);
          setState('idle');
        }
      }
    });
    pumpPreviews();
  }, [needed, visible, job.id, client]);
  return needed ? state : 'idle';
}
