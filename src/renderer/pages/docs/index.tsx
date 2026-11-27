import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, LifeBuoy, Search, X } from 'lucide-react';
import { GMI_URLS } from '@shared/app';
import type { DocHit } from '@shared/contracts/usage';
import { DOCS_QUERY_LIMITS } from '@shared/contracts/usage';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useCommandRegistry, useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { Plates } from '@renderer/components/brand/Plates';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { PageBody, PageHeader } from '@renderer/components/PageHeader';
import { RequireAuth } from '@renderer/components/RequireAuth';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, Kbd, microLabel, Skeleton } from '@renderer/components/ui/misc';
import { pressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { revealInPage } from '../usage/reveal';
import { Excerpt } from './Excerpt';
import { SupportCard } from './SupportCard';
import { docBreadcrumb, highlightTerms } from './text';

const TOPICS = ['GMI Router', 'Agentbox', 'Studio', 'Rate limits', 'API keys', 'Billing', 'Video models'];
const DEBOUNCE_MS = 400;
const SUPPORT_SECTION_ID = 'docs-support';

const normalizeQuery = (raw: string) => raw.replace(/\s+/g, ' ').trim();

function openDoc(url: string) {
  void gmi.app.openExternal(url).catch(() => undefined);
}

/** "Prefer the full site? Browse docs.gmicloud.ai" (the docs website works without signing in). */
function BrowseDocsLink({ className }: { className?: string }) {
  return (
    <p className={cn('text-2xs text-muted-foreground', className)}>
      Prefer the full site?{' '}
      <button type="button" onClick={() => openDoc(GMI_URLS.docs)} className="text-primary-ink underline-offset-2 hover:underline">
        Browse docs.gmicloud.ai
      </button>
    </p>
  );
}

/** Empty and "no results" states: Dino on GMI's faint grid floor. */
function DocsFloor({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card/50">
      <div aria-hidden className="grid-floor pointer-events-none absolute inset-0" />
      <div className="relative">{children}</div>
    </div>
  );
}

function ResultItem({ hit, terms }: { hit: DocHit; terms: readonly string[] }) {
  const crumbs = docBreadcrumb(hit.url);
  return (
    <li className="group rounded-lg border border-border bg-card px-4 py-3.5 transition-colors duration-150 ease-out hover:border-foreground/15">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={cn(microLabel, 'truncate tracking-[0.14em]')} title={hit.url}>
            {crumbs.length === 0
              ? 'docs.gmicloud.ai'
              : crumbs.map((crumb, i) => (
                  <span key={i}>
                    {i > 0 ? <span className="px-1.5 opacity-50">/</span> : null}
                    {crumb}
                  </span>
                ))}
          </p>
          <h3 className="mt-1 text-sm font-medium leading-snug">
            <button
              type="button"
              data-doc-hit
              onClick={() => openDoc(hit.url)}
              className="text-left decoration-primary-ink/60 underline-offset-[3px] hover:underline focus-visible:underline"
            >
              {hit.title}
            </button>
          </h3>
        </div>
        <Tooltip label="Open in your browser">
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            onClick={() => openDoc(hit.url)}
            aria-label={`Open “${hit.title}” in your browser`}
            className="group-hover:text-foreground"
          >
            <ArrowUpRight />
          </Button>
        </Tooltip>
      </div>
      {hit.excerpt ? <Excerpt text={hit.excerpt} terms={terms} className="mt-2" /> : null}
    </li>
  );
}

function ResultSkeleton() {
  return (
    <ul className="flex flex-col gap-2" aria-busy aria-label="Searching the docs">
      {[0.4, 0.55, 0.32].map((width, i) => (
        <li key={i} className="flex flex-col rounded-lg border border-border bg-card px-4 py-3.5">
          <Skeleton className="h-2.5 w-36" />
          <Skeleton className="mt-2 h-4" style={{ width: `${width * 100}%` }} />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-4/5" />
        </li>
      ))}
    </ul>
  );
}

function DocsSearch({ initialQuery, navSeq }: { initialQuery: string; navSeq: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(normalizeQuery(initialQuery));

  // A new ?q= from elsewhere in the app replaces the search.
  useEffect(() => {
    if (!initialQuery) return;
    setInput(initialQuery);
    setQuery(normalizeQuery(initialQuery));
  }, [initialQuery, navSeq]);

  // Search as you type (debounced); Enter searches at once.
  useEffect(() => {
    const next = normalizeQuery(input);
    if (next === query) return;
    const timer = window.setTimeout(() => setQuery(next), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input, query]);

  // "/" focuses the search from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(
    () =>
      useCommandRegistry.getState().register('docs', [
        { id: 'docs.focus', label: 'Search GMI docs', group: 'Docs', icon: <Search />, shortcut: '/', run: () => inputRef.current?.focus() },
        ...TOPICS.map((topic) => ({
          id: `docs.topic.${topic}`,
          label: `Docs: ${topic}`,
          group: 'Docs',
          icon: <BookOpen />,
          run: () => {
            setInput(topic);
            setQuery(topic);
          },
        })),
      ]),
    [],
  );

  const searchable = query.length >= DOCS_QUERY_LIMITS.min;
  const results = useQuery({
    queryKey: qk.docs(query.toLowerCase()),
    // The query travels with its hits: while the next search loads, the previous hits stay on screen
    // (keepPreviousData) and keep the highlights of the words that found them.
    queryFn: async () => ({ query, hits: await gmi.docs.search(query, 8) }),
    enabled: searchable,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // ↓ from the search box walks into the results, ↑/↓ moves between them, ↑ on the first goes back.
  const listRef = useRef<HTMLUListElement>(null);
  const hitButtons = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-doc-hit]') ?? [])];
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = hitButtons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) inputRef.current?.focus();
    else buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      const first = hitButtons()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const next = normalizeQuery(input);
      setQuery(next);
      if (next === query && searchable) void results.refetch();
    } else if (event.key === 'Escape' && input) {
      event.preventDefault();
      setInput('');
      setQuery('');
    }
  };

  const pick = (topic: string) => {
    setInput(topic);
    setQuery(topic);
    inputRef.current?.focus();
  };

  const hits = searchable ? (results.data?.hits ?? []) : [];
  const busy = searchable && results.isFetching;
  const shownQuery = results.data?.query ?? query;
  const terms = useMemo(() => highlightTerms(shownQuery), [shownQuery]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="group/search relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors duration-150 ease-out group-focus-within/search:text-primary-ink"
          />
          <input
            ref={inputRef}
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={DOCS_QUERY_LIMITS.max}
            autoFocus
            placeholder="Search GMI Cloud docs, e.g. “wan video duration and resolution”"
            aria-label="Search GMI Cloud docs"
            className="h-11 w-full rounded-lg border border-input bg-card pl-10 pr-20 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-muted-foreground/70 hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            {busy ? <Plates size="sm" className="mr-0.5" /> : null}
            {input ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => {
                  setInput('');
                  setQuery('');
                  inputRef.current?.focus();
                }}
              >
                <X />
              </Button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Popular topics">
          <span aria-hidden className={cn(microLabel, 'pr-1.5')}>
            Popular
          </span>
          {TOPICS.map((topic) => {
            const active = query.toLowerCase() === topic.toLowerCase();
            return (
              <button
                key={topic}
                type="button"
                onClick={() => pick(topic)}
                aria-pressed={active}
                className={cn(
                  'h-6 rounded-md border px-2 text-xs',
                  pressMotion,
                  active
                    ? 'border-primary-ink/40 bg-primary/12 font-medium text-primary-ink'
                    : 'border-border text-muted-foreground hover:border-foreground/20 hover:bg-accent hover:text-foreground',
                )}
              >
                {topic}
              </button>
            );
          })}
        </div>
      </div>

      {!searchable ? (
        <DocsFloor>
          <EmptyState
            dino="sleep"
            title="Search GMI’s documentation"
            description={
              <>
                Exact phrases rank best, like{' '}
                <button type="button" onClick={() => pick('rate limits for video models')} className="text-primary-ink underline-offset-2 hover:underline">
                  rate limits for video models
                </button>{' '}
                or{' '}
                <button type="button" onClick={() => pick('create an inference API key')} className="text-primary-ink underline-offset-2 hover:underline">
                  create an inference API key
                </button>
                .
              </>
            }
            className="py-14"
          />
        </DocsFloor>
      ) : results.error && !results.data ? (
        <ErrorNotice error={results.error} onRetry={() => void results.refetch()} />
      ) : results.isLoading ? (
        <ResultSkeleton />
      ) : hits.length === 0 ? (
        <DocsFloor>
          <EmptyState
            dino="idle"
            title={<span className="line-clamp-2 [overflow-wrap:anywhere]">No results for “{query}”</span>}
            description="Try fewer or different words, or search the full docs site."
            action={
              <Button variant="outline" size="sm" onClick={() => openDoc(GMI_URLS.docs)}>
                Open docs.gmicloud.ai <ArrowUpRight />
              </Button>
            }
            className="py-14"
          />
        </DocsFloor>
      ) : (
        <div className={cn('flex flex-col gap-2.5 transition-opacity duration-150 ease-out', results.isPlaceholderData && 'opacity-60')} aria-busy={busy}>
          <div className="flex items-center justify-between gap-3 px-px">
            <p className={microLabel} aria-live="polite">
              <span className="text-foreground tabular-nums">{hits.length}</span> {hits.length === 1 ? 'result' : 'results'}
              <span className="sr-only"> for “{query}”</span>
            </p>
            <p className={microLabel}>from docs.gmicloud.ai</p>
          </div>
          {results.error ? <ErrorNotice error={results.error} compact onRetry={() => void results.refetch()} /> : null}
          <ul ref={listRef} onKeyDown={onListKeyDown} className="flex flex-col gap-2">
            {hits.map((hit) => (
              <ResultItem key={hit.url} hit={hit} terms={terms} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function DocsPage() {
  const params = useUi((s) => s.params);
  const navSeq = useUi((s) => s.navSeq);
  const navigate = useUi((s) => s.navigate);
  const auth = useAuth();
  const signedIn = auth.data?.status === 'signed_in';
  // Known to be signed out (not just still loading the auth state).
  const signedOut = auth.data !== undefined && !signedIn;
  const subjectRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(false);

  // ?section=support: bring the support form into view and focus its subject.
  useEffect(() => {
    if (params.section !== 'support' || !signedIn) return;
    revealInPage(document.getElementById(SUPPORT_SECTION_ID));
    subjectRef.current?.focus({ preventScroll: true });
    setHighlight(true);
    const timer = window.setTimeout(() => setHighlight(false), 2400);
    return () => window.clearTimeout(timer);
  }, [params.section, navSeq, signedIn]);

  useEffect(
    () =>
      useCommandRegistry.getState().register('docs-support', [
        {
          id: 'docs.support',
          label: 'Contact GMI support',
          group: 'Docs',
          icon: <LifeBuoy />,
          keywords: ['help', 'ticket', 'support'],
          run: () => navigate('docs', { section: 'support' }),
        },
      ]),
    [navigate],
  );

  return (
    <>
      <TopBarActions>
        <Button variant="outline" size="sm" onClick={() => openDoc(GMI_URLS.docs)}>
          docs.gmicloud.ai
          <ArrowUpRight className="text-muted-foreground" />
        </Button>
      </TopBarActions>
      <PageBody>
        <PageHeader title="Docs" description="Search GMI Cloud's documentation and reach GMI support without leaving the app." />
        <div className="flex flex-col gap-2">
          <RequireAuth reason="Docs search and support tickets go through your GMI account. You can still browse docs.gmicloud.ai in your browser.">
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <DocsSearch initialQuery={params.q ?? ''} navSeq={navSeq} />
              <div className="flex flex-col gap-3 lg:sticky lg:top-6">
                <SupportCard ref={subjectRef} id={SUPPORT_SECTION_ID} highlight={highlight} />
                <BrowseDocsLink className="px-1" />
              </div>
            </div>
          </RequireAuth>
          {/* In normal flow after the sign-in prompt, never pulled into it: a sign-in error (or anything else the
              prompt shows below its button) pushes the link down instead of being drawn over. */}
          {signedOut ? <BrowseDocsLink className="text-center" /> : null}
        </div>
      </PageBody>
    </>
  );
}
