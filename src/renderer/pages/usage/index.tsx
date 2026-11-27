import { useEffect, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CalendarDays, RefreshCw, RotateCw, Wallet } from 'lucide-react';
import { describeError, errorCode } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useAuth, useBudget, useGmiEvent } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useCommandRegistry, useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { Dino, DinoLoader } from '@renderer/components/brand/Dino';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { PageBody, PageHeader } from '@renderer/components/PageHeader';
import { RequireAuth } from '@renderer/components/RequireAuth';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { Button } from '@renderer/components/ui/button';
import { microLabel } from '@renderer/components/ui/misc';
import { TabStrip } from '@renderer/components/ui/tabs';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { AccountOverview } from './AccountOverview';
import { BudgetPanel } from './BudgetPanel';
import { ConsoleLinks } from './ConsoleLinks';
import { GatewayCard } from './GatewayCard';
import { LocalSpend } from './LocalSpend';
import { MediaActivity } from './MediaActivity';
import { formatRange, periodFor, PERIODS, UpdatedAgo, type PeriodKey } from './parts';
import { revealInPage } from './reveal';
import { TopModels } from './TopModels';

const PERIOD_STORAGE_KEY = 'gmi.usage.period';
const BUDGET_SECTION_ID = 'usage-budget';

function periodFromDays(days: string | undefined): PeriodKey | null {
  return PERIODS.find((p) => String(p.days) === days)?.value ?? null;
}

function storedPeriod(): PeriodKey | null {
  try {
    const v = localStorage.getItem(PERIOD_STORAGE_KEY);
    return PERIODS.some((p) => p.value === v) ? (v as PeriodKey) : null;
  } catch {
    return null;
  }
}

/** Section rule: mono micro-label, quiet meta, then a 1px line to the edge. */
function SectionHeading({ id, title, meta }: { id: string; title: string; meta?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <h2 id={id} className={cn(microLabel, 'shrink-0 text-foreground/80')}>
        {title}
      </h2>
      {meta ? <span className="min-w-0 truncate text-2xs tabular-nums text-muted-foreground">{meta}</span> : null}
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

/** Failures the user has to act on (sign in again, top up) keep ErrorNotice and its action. */
const NEEDS_ACTION = new Set(['not_signed_in', 'reauth_required', 'insufficient_scope', 'payment_required', 'unauthorized']);

/** The account summary failed with nothing to show: a calm card (Dino waits), not an alarm. */
function AccountUnavailable({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const code = errorCode(error);
  if (code && NEEDS_ACTION.has(code)) return <ErrorNotice error={error} onRetry={onRetry} />;
  const view = describeError(error);
  return (
    <div role="alert" className="flex items-center gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <Dino mood="idle" size={52} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">Your GMI figures are not available right now</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {view.message || view.title} Spend from this device and your budget below still work.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RotateCw className={cn(retrying && 'animate-spin')} /> Try again
      </Button>
    </div>
  );
}

export default function UsagePage() {
  const params = useUi((s) => s.params);
  const navSeq = useUi((s) => s.navSeq);
  const navigate = useUi((s) => s.navigate);
  const client = useQueryClient();
  const auth = useAuth();
  const signedIn = auth.data?.status === 'signed_in';

  // Another organization (or a sign-out) must never show the previous account's figures.
  const account = auth.data === undefined ? null : signedIn ? (auth.data.orgId ?? '') : 'signed-out';
  const lastAccount = useRef(account);
  useEffect(() => {
    const previous = lastAccount.current;
    lastAccount.current = account;
    // '' = signed in, organization not known yet: whatever loaded meanwhile already belongs to this session.
    if (!previous || previous === account) return;
    void client.resetQueries({ queryKey: ['usage', 'summary'] });
    void client.resetQueries({ queryKey: ['usage', 'media'] });
  }, [account, client]);

  const [periodKey, setPeriodKey] = useState<PeriodKey>(() => periodFromDays(params.days) ?? storedPeriod() ?? '7d');
  const period = periodFor(periodKey);
  const days = period.days;
  const choosePeriod = (key: PeriodKey) => {
    setPeriodKey(key);
    try {
      localStorage.setItem(PERIOD_STORAGE_KEY, key);
    } catch {
      // storage may be unavailable
    }
  };
  useEffect(() => {
    const fromParams = periodFromDays(params.days);
    if (fromParams) setPeriodKey(fromParams);
  }, [params.days, navSeq]);

  const summary = useQuery({
    queryKey: qk.accountSummary(days),
    queryFn: () => gmi.usage.getAccountSummary(days),
    enabled: signedIn,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const activity = useQuery({
    queryKey: qk.mediaActivity(days),
    queryFn: () => gmi.usage.getMediaActivity(days),
    enabled: signedIn,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const local = useQuery({ queryKey: qk.localSpend(days), queryFn: () => gmi.usage.getLocalSpend(days), placeholderData: keepPreviousData });
  const budget = useBudget();
  // Every recorded spend emits usage:budget; the device totals move with it.
  useGmiEvent('usage:budget', () => void client.invalidateQueries({ queryKey: ['usage', 'local'] }));

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await gmi.usage.refresh();
      await client.invalidateQueries({ queryKey: ['usage'] });
    } catch {
      // queries surface their own errors
    } finally {
      setRefreshing(false);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // ?section=budget (from "Review budget" anywhere in the app): bring the budget card into view and focus it.
  const firstBudgetInput = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(false);
  const handledSeq = useRef<number | null>(null);
  // The page body (and the budget card in it) renders once the sign-in state is known.
  const budgetReady = budget.data !== undefined && auth.data !== undefined;
  useEffect(() => {
    if (params.section !== 'budget' || !budgetReady || handledSeq.current === navSeq) return;
    handledSeq.current = navSeq;
    revealInPage(document.getElementById(BUDGET_SECTION_ID));
    firstBudgetInput.current?.focus({ preventScroll: true });
    setHighlight(true);
    const timer = window.setTimeout(() => setHighlight(false), 2400);
    return () => window.clearTimeout(timer);
  }, [params.section, navSeq, budgetReady]);

  useEffect(
    () =>
      useCommandRegistry.getState().register('usage', [
        { id: 'usage.refresh', label: 'Refresh usage', group: 'Usage', icon: <RefreshCw />, run: () => refreshRef.current() },
        {
          id: 'usage.budget',
          label: 'Edit budget limits',
          group: 'Usage',
          icon: <Wallet />,
          keywords: ['limit', 'spend', 'cap', 'budget'],
          run: () => navigate('usage', { section: 'budget' }),
        },
        ...PERIODS.map((p) => ({
          id: `usage.period.${p.value}`,
          label: `Usage: ${p.long.toLowerCase()}`,
          group: 'Usage',
          icon: <CalendarDays />,
          run: () => choosePeriod(p.value),
        })),
      ]),
    [navigate],
  );

  const range = formatRange(summary.data?.periodStart ?? null, summary.data?.periodEnd ?? null);
  const stale = summary.isPlaceholderData || activity.isPlaceholderData;
  // Failed with nothing to show (a failed refetch keeps the previous data instead).
  const summaryFailed = Boolean(summary.error) && !summary.data;
  const activityFailed = Boolean(activity.error) && !activity.data;
  const retryAccount = () => {
    void summary.refetch();
    if (activity.error) void activity.refetch();
  };

  return (
    <>
      <TopBarActions>
        <TabStrip
          value={periodKey}
          onValueChange={choosePeriod}
          items={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
        />
        <Tooltip label="Refresh" side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh usage" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </Tooltip>
        <Button variant="outline" size="sm" onClick={() => void gmi.app.openConsole('billing').catch(() => undefined)}>
          Billing in GMI Console
          <ArrowUpRight className="text-muted-foreground" />
        </Button>
      </TopBarActions>

      {auth.data === undefined ? (
        <PageBody className="h-full">
          <DinoLoader label="Loading usage" className="flex-1 pb-16" />
        </PageBody>
      ) : (
        <PageBody className="gap-7">
          <PageHeader
            title="Usage"
            description="Your GMI balance and LLM spend, plus what this device spent and the limits GMI Desk enforces."
            actions={signedIn && summary.data ? <UpdatedAgo iso={summary.data.fetchedAt} /> : null}
          />

          <section aria-labelledby="usage-account" className="flex flex-col gap-3">
            <SectionHeading id="usage-account" title="GMI account" meta={signedIn ? (range ?? period.long) : null} />
            {signedIn ? (
              <div
                aria-busy={stale || summary.isFetching}
                // Another period's figures stay while the new ones load: dim them only if that takes a beat (150 ms
                // delay, so a quick switch never flickers), and brighten them right away.
                className={cn('flex flex-col gap-4 transition-opacity duration-200 ease-out', stale && 'opacity-60 delay-150')}
              >
                {summaryFailed ? (
                  <AccountUnavailable error={summary.error} onRetry={retryAccount} retrying={summary.isFetching} />
                ) : (
                  <>
                    {/* A failed refresh keeps the last figures on screen. */}
                    {summary.error ? <ErrorNotice error={summary.error} compact onRetry={() => void summary.refetch()} /> : null}
                    <AccountOverview summary={summary.data} periodLabel={period.long} loading={summary.isLoading} />
                  </>
                )}
                {/* With the summary down, Top models has nothing to say; media activity stays if it loaded on its own. */}
                {summaryFailed && activityFailed ? null : (
                  <div className={cn('grid gap-4', !summaryFailed && 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
                    {summaryFailed ? null : <TopModels summary={summary.data} loading={summary.isLoading} periodLabel={period.long} />}
                    <MediaActivity
                      activity={activity.data}
                      loading={activity.isLoading}
                      periodLabel={period.long}
                      error={activityFailed ? activity.error : null}
                      onRetry={() => void activity.refetch()}
                      retrying={activity.isFetching}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card">
                <RequireAuth reason="Balance, promotion credit, LLM spend and media activity come from your GMI account. Spend from this device and your budget work without it.">
                  {null}
                </RequireAuth>
              </div>
            )}
          </section>

          <section aria-labelledby="usage-device" className="flex flex-col gap-3">
            <SectionHeading id="usage-device" title="This device" meta="Spend recorded by GMI Desk and the limits it enforces" />
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {local.error ? (
                <ErrorNotice error={local.error} onRetry={() => void local.refetch()} />
              ) : (
                <LocalSpend spend={local.data} loading={local.isLoading} periodLabel={period.long} />
              )}
              {budget.error ? (
                <ErrorNotice error={budget.error} onRetry={() => void budget.refetch()} />
              ) : (
                <BudgetPanel ref={firstBudgetInput} id={BUDGET_SECTION_ID} status={budget.data} loading={budget.isLoading} highlight={highlight} />
              )}
            </div>
          </section>

          {/* GMI gateway status (H1-D); renders nothing until the gateway exists. */}
          <GatewayCard />

          <ConsoleLinks />
        </PageBody>
      )}
    </>
  );
}
