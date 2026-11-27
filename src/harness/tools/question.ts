/**
 * The `question` tool (harness.md §8.1, §6.1): the run goes `awaiting_user`; the user's answer comes back as the tool
 * result. The question travels as an approval request of kind `question` (§13.1: `detail.question/options`, decision
 * `answer`), decided in main like any approval; the request is persisted (`approvals`) so recovery sees it.
 *
 * Text from the model is cleaned before it reaches a dialog (H-T17: control, bidi and zero-width characters
 * stripped, lengths capped); main sanitises again.
 */
import type { ApprovalDecision, ApprovalRequest } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import { newId, type ApprovalClient, type ParsedArgs, type ToolDefinition, type ToolResult } from '../types';
import { objectArgs } from './fs';
import { errorResult, okResult } from './output';

export interface QuestionArgs {
  question: string;
  options?: string[];
}

export const QUESTION_LIMITS = { maxQuestion: 2_000, maxOptions: 8, maxOption: 200 } as const;

// C0/C1 controls except \n and \t, bidi overrides/isolates, zero-width characters, BOM.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

export function cleanText(s: string, max: number, singleLine: boolean): string {
  let t = s.replace(UNSAFE, '');
  if (singleLine) t = t.replace(/[\r\n\t]+/g, ' ');
  t = t.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface QuestionDeps {
  /** Main's approval broker (MainLink.approvals). */
  approvals: ApprovalClient;
}

export function createQuestionTool(deps: QuestionDeps): ToolDefinition<QuestionArgs> {
  return {
    name: 'question',
    description:
      'Ask the user a question and wait for the answer. Use it only when you cannot proceed without a decision or information from the user; optionally offer up to 8 short answer options.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, self-contained.' },
        options: { type: 'array', items: { type: 'string' }, maxItems: QUESTION_LIMITS.maxOptions, description: 'Suggested answers.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    class: 'user',
    parse(raw): ParsedArgs<QuestionArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      if (typeof o.question !== 'string') return { ok: false, error: 'question must be a string.' };
      const question = cleanText(o.question, QUESTION_LIMITS.maxQuestion, false);
      if (!question) return { ok: false, error: 'question must not be empty.' };
      const args: QuestionArgs = { question };
      if (o.options !== undefined && o.options !== null) {
        if (!Array.isArray(o.options) || o.options.some((x) => typeof x !== 'string')) return { ok: false, error: 'options must be an array of strings.' };
        if (o.options.length > QUESTION_LIMITS.maxOptions) return { ok: false, error: `At most ${QUESTION_LIMITS.maxOptions} options.` };
        const options = (o.options as string[]).map((x) => cleanText(x, QUESTION_LIMITS.maxOption, true)).filter(Boolean);
        if (options.length) args.options = [...new Set(options)];
      }
      return { ok: true, args };
    },
    readOnly: () => false,
    mutates: () => false,
    title: () => 'Question for you',
    subject: (a) => ({ tool: 'question', kind: 'question', title: 'Question for you', args: { question: a.question, ...(a.options ? { options: a.options } : {}) }, risk: [] }),
    async run(a, ctx): Promise<ToolResult> {
      // Review H2: through the loop when it offers askUser (awaiting_user, wall clock paused, denied at once in
      // unattended runs); asking main directly kept the thread `running` and let the time cap kill the question.
      if (ctx.askUser) {
        let answer;
        try {
          answer = await ctx.askUser({ question: a.question, ...(a.options ? { options: a.options } : {}) });
        } catch (err) {
          if (ctx.signal.aborted || (err instanceof GmiError && err.code === 'cancelled')) return errorResult('cancelled', 'Cancelled: the question was withdrawn.');
          return errorResult('execution', 'The question could not be shown to the user.');
        }
        return decisionResult(answer);
      }
      const now = new Date(ctx.clock.now()).toISOString();
      const request: ApprovalRequest = {
        requestId: newId('apr', ctx.clock.now()),
        threadId: ctx.threadId,
        runId: ctx.runId,
        toolCallId: ctx.call.id,
        kind: 'question',
        tool: 'question',
        title: 'Question for you',
        detail: { question: a.question, ...(a.options ? { options: a.options } : {}) },
        risk: [],
        suggestedRule: null,
        allowedDecisions: ['answer', 'deny', 'cancel_run'],
        createdAt: now,
        expiresAt: null,
      };
      ctx.store.approvals.insert({ requestId: request.requestId, threadId: ctx.threadId, runId: ctx.runId, toolCallId: ctx.call.id, kind: 'question', request, decision: null, decidedAt: null });
      let decision;
      try {
        decision = await deps.approvals.request(request, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted || (err instanceof GmiError && err.code === 'cancelled')) return errorResult('cancelled', 'Cancelled: the question was withdrawn.');
        return errorResult('execution', 'The question could not be shown to the user.');
      }
      ctx.store.approvals.decide(request.requestId, decision, new Date(ctx.clock.now()).toISOString());
      return decisionResult(decision);
    },
  };
}

function decisionResult(decision: ApprovalDecision): ToolResult {
  switch (decision.kind) {
    case 'answer':
      return okResult(`The user answered:\n${decision.text}`);
    case 'deny':
      return errorResult('denied', decision.feedback ? `The user declined to answer: ${decision.feedback}` : 'The user declined to answer. Continue with your best judgement or stop.');
    case 'cancel_run':
      return errorResult('cancelled', 'The user stopped the run.');
    default:
      return errorResult('denied', 'The user did not answer.');
  }
}
