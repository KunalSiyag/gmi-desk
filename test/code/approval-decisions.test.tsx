import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalRequest } from '@shared/contracts/code';
import { ApprovalCard } from '@renderer/pages/code/components/ApprovalCard';

// A local copy of test/harness/fakes.ts' sampleApproval: that module imports `@harness/*`, which the renderer test
// project (tsconfig.test-web.json) does not map, so importing it from a .tsx test broke `npm run typecheck`.
function sampleApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'apr_1',
    threadId: 'thr_1',
    runId: 'run_1',
    toolCallId: 'tc_1',
    kind: 'command',
    tool: 'bash',
    title: 'Run npm test',
    detail: { command: 'npm test', cwd: '/work' },
    risk: [],
    suggestedRule: { tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'project' },
    allowedDecisions: ['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run'],
    createdAt: '2026-11-03T14:21:00.000Z',
    expiresAt: null,
    ...over,
  };
}

describe('approval cards reflect main-authorized actions', () => {
  it('shows answers, deny and stop for questions; never permission grants', () => {
    const request = sampleApproval({ kind: 'question', allowedDecisions: ['answer', 'deny', 'cancel_run'], suggestedRule: null, detail: { question: 'Which file?', options: ['A', 'B'] } });
    const html = renderToStaticMarkup(<ApprovalCard request={request} resolved={null} busy={false} onDecide={() => {}} />);
    expect(html).toContain('Answer the agent');
    expect(html).toContain('Stop run');
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('Always allow');
  });
  it('never invents allow once or standing grants', () => {
    const request = sampleApproval({ allowedDecisions: ['deny'], suggestedRule: null });
    const html = renderToStaticMarkup(<ApprovalCard request={request} resolved={null} busy={false} onDecide={() => {}} />);
    expect(html).not.toContain('Allow once');
    expect(html).not.toContain('Allow for this thread');
    expect(html).not.toContain('Stop run');
  });
});
