import { AlertTriangle, Info } from 'lucide-react';
import type { AccountSummary } from '@shared/contracts/usage';
import { formatNumber, formatTokens } from '@shared/lib/format';
import { formatUsd } from '@shared/lib/money';
import { Figure } from './parts';

/**
 * Figure strip from get_account_summary: the balance as the hero, then promotion credit and LLM spend, tokens,
 * requests. Absent figures show "—" with the reason, never 0. Cells sit on a 1px border grid that stays whole at
 * every width (balance spans two columns: 2 → 3 → 6 columns).
 */
export function AccountOverview({ summary, periodLabel, loading }: { summary: AccountSummary | undefined; periodLabel: string; loading: boolean }) {
  const s = summary;
  const unmeasured = s ? s.usageNote !== null : false;
  const notMeasured = unmeasured ? 'Not measured' : 'Not reported';
  const perRequest =
    s && s.llmTokenCostUsd !== null && s.llmRequests ? `≈ ${formatUsd(s.llmTokenCostUsd / s.llmRequests)} per request` : s?.llmRequests === 0 ? 'No requests' : null;
  const negative = !!s && !s.balanceUnlimited && s.balanceUsd !== null && s.balanceUsd < 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 xl:grid-cols-6">
        <Figure
          hero
          className="col-span-2"
          label="Balance"
          loading={loading}
          tone={negative ? 'danger' : s?.balanceUsd === null && !s.balanceUnlimited ? 'muted' : 'default'}
          value={s ? (s.balanceUnlimited ? 'Unlimited' : formatUsd(s.balanceUsd)) : '—'}
          hint={
            !s
              ? null
              : s.balanceUnlimited
                ? 'No spending cap on this account'
                : s.balanceUsd === null
                  ? 'Not reported'
                  : negative
                    ? 'Below zero: GMI keeps charging'
                    : 'Updates can lag behind spend'
          }
        >
          {/* GMI's grid floor, strongest in the bottom-right corner behind the balance. */}
          <span
            aria-hidden
            className="grid-floor pointer-events-none absolute inset-0 [--grid-cell:18px] [--grid-fade:radial-gradient(ellipse_90%_120%_at_100%_100%,black_15%,transparent_75%)]"
          />
        </Figure>
        <Figure
          label="Promotion credit"
          loading={loading}
          tone={s?.promotionCreditUsd === null ? 'muted' : 'default'}
          value={s ? formatUsd(s.promotionCreditUsd) : '—'}
          hint={s ? (s.promotionCreditUsd === null ? 'Unknown right now' : 'Kept apart from balance') : null}
        />
        <Figure
          label="LLM spend"
          loading={loading}
          tone={s?.llmTokenCostUsd === null ? 'muted' : 'default'}
          value={s ? formatUsd(s.llmTokenCostUsd) : '—'}
          hint={s ? (s.llmTokenCostUsd === null ? notMeasured : periodLabel) : null}
        />
        <Figure
          label="LLM tokens"
          loading={loading}
          tone={s?.llmTokens === null ? 'muted' : 'default'}
          value={s ? formatTokens(s.llmTokens) : '—'}
          hint={s ? (s.llmTokens === null ? notMeasured : `${formatNumber(s.llmTokens)} tokens`) : null}
        />
        <Figure
          label="LLM requests"
          loading={loading}
          tone={s?.llmRequests === null ? 'muted' : 'default'}
          value={s ? formatNumber(s.llmRequests) : '—'}
          hint={s ? (s.llmRequests === null ? notMeasured : perRequest) : null}
        />
      </div>
      <div className="flex flex-col gap-1 text-2xs text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Info aria-hidden className="size-3 shrink-0" />
          LLM tokens only. Image, video and audio spend is billed separately.
        </p>
        {s?.usageNote ? (
          <p className="flex items-start gap-1.5 text-foreground">
            <AlertTriangle aria-hidden className="mt-px size-3 shrink-0 text-warning-foreground" />
            <span>
              <span className="font-medium">Usage not measured: </span>
              {s.usageNote}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
