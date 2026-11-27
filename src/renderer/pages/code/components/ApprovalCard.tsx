import { useState } from 'react';
import { AlertTriangle, Check, ShieldQuestion, X } from 'lucide-react';
import type { ApprovalDecision, ApprovalRequest } from '@shared/contracts/code';
import { formatUsd } from '@shared/lib/money';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';

const RISK_TEXT: Record<string, string> = {
  network: 'uses the network',
  outside_worktree: 'outside the worktree',
  destructive: 'destructive',
  execution_sensitive: 'changes files that run code',
  secret_path: 'touches a secret file',
  unsandboxed: 'unsandboxed',
  costs_money: 'costs money',
  compound_command: 'compound command',
  changed_tool: 'tool changed since it was trusted',
  local_network: 'can reach this computer',
  unpinned: 'unpinned package',
};

/** What the collapsed card says once a decision is in ("Allowed once", "Denied"). */
const RESOLVED_TEXT: Record<ApprovalDecision['kind'], string> = {
  allow_once: 'Allowed once',
  allow_thread: 'Allowed for this thread',
  allow_always: 'Always allowed',
  deny: 'Denied',
  answer: 'Answered',
  cancel_run: 'Run stopped',
};

export function ApprovalCard({
  request,
  resolved,
  onDecide,
  busy,
}: {
  request: ApprovalRequest;
  resolved: ApprovalDecision | null;
  onDecide: (decision: ApprovalDecision) => void;
  busy: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const question = request.kind === 'question';
  const allows = request.allowedDecisions;
  const suggested = request.suggestedRule;
  const canAlways = allows.includes('allow_always') && suggested !== null && !suggested.tool.includes('*');
  const detail = request.detail;

  if (resolved) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        {resolved.kind === 'deny' || resolved.kind === 'cancel_run' ? (
          <X aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Check aria-hidden className="size-3.5 shrink-0 text-primary-ink" />
        )}
        <span className="min-w-0 truncate font-medium text-foreground" title={request.title}>
          {request.title}
        </span>
        <span className="shrink-0">· {RESOLVED_TEXT[resolved.kind] ?? resolved.kind}</span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning/[0.05]">
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-5 text-foreground">{request.title}</p>
          {request.risk.length > 0 ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-warning-foreground">
              <AlertTriangle aria-hidden className="size-3" />
              {request.risk.map((r) => RISK_TEXT[r] ?? r).join(' · ')}
            </p>
          ) : null}
        </div>
        {detail.costUsd !== undefined && detail.costUsd !== null ? (
          <Badge variant="warning" className="font-mono tabular-nums">
            ≈ {formatUsd(detail.costUsd)}
          </Badge>
        ) : null}
      </div>

      <div className="space-y-2 px-3.5 py-2.5">
        {question ? <p className="text-xs text-muted-foreground">{detail.question ?? 'The agent has a question.'}</p> : null}
        {detail.command ? <pre className="overflow-x-auto rounded-md bg-foreground/[0.05] px-2.5 py-2 font-mono text-xs leading-5 text-foreground/90">{detail.command}</pre> : null}
        {detail.paths?.length ? (
          <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
            {detail.paths.slice(0, 8).map((p) => (
              <li key={p} className="truncate">{p}</li>
            ))}
          </ul>
        ) : null}
        {detail.diff ? <pre className="max-h-48 overflow-auto rounded-md bg-foreground/[0.05] px-2.5 py-2 font-mono text-2xs leading-4 text-muted-foreground">{detail.diff}</pre> : null}
        {detail.url ? <p className="break-all font-mono text-xs text-muted-foreground">{detail.url}</p> : null}
        {detail.args ? <pre className="max-h-40 overflow-auto rounded-md bg-foreground/[0.05] px-2.5 py-2 font-mono text-2xs leading-4 text-muted-foreground">{detail.args}</pre> : null}
        {question && allows.includes('answer') && detail.options?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {detail.options.map((o) => (
              <Button key={o} size="xs" variant="outline" onClick={() => onDecide({ kind: 'answer', text: o })} disabled={busy}>
                {o}
              </Button>
            ))}
          </div>
        ) : null}
        {question && allows.includes('answer') ? (
          <div className="flex gap-1.5">
            <Input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Type an answer…"
              aria-label="Answer the agent"
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && answer.trim()) onDecide({ kind: 'answer', text: answer.trim() }); }}
              className="h-7 min-w-0 flex-1 px-2 text-xs"
            />
            <Button size="xs" onClick={() => onDecide({ kind: 'answer', text: answer })} disabled={busy || !answer.trim()}>
              Answer
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-warning/20 px-3 py-2">
        {allows.includes('allow_once') ? <Button size="xs" onClick={() => onDecide({ kind: 'allow_once', ...(request.risk.includes('execution_sensitive') ? { sensitiveWrites: true } : {}) })} disabled={busy}>
          Allow once
        </Button> : null}
        {allows.includes('allow_thread') && suggested ? (
          <Button size="xs" variant="secondary" onClick={() => onDecide({ kind: 'allow_thread' })} disabled={busy}>
            Allow for this thread
          </Button>
        ) : null}
        {canAlways ? (
          <Button size="xs" variant="secondary" onClick={() => onDecide({ kind: 'allow_always', rule: suggested })} disabled={busy}>
            Always allow
          </Button>
        ) : null}
        <span className="flex-1" />
        {allows.includes('deny') ? <Button size="xs" variant="ghost" onClick={() => onDecide({ kind: 'deny' })} disabled={busy}>
          <X /> Deny
        </Button> : null}
        {allows.includes('cancel_run') ? (
          <Button size="xs" variant="ghost" onClick={() => onDecide({ kind: 'cancel_run' })} disabled={busy}>
            Stop run
          </Button>
        ) : null}
      </div>
    </div>
  );
}
