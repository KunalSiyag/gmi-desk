// The chat page's pure helpers (no React / DOM): stream patching of the cached thread and formatting.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatThread, ChatThreadSummary } from '@shared/contracts/chat';
import { draftFromSettings, keepIdsFromDrafts, settingsPatchFromDraft } from '../../src/renderer/pages/chat/drafts';
import { compactTime, groupThreads, lengthNotice, routingLabel, shortModelName, threadAsMarkdown } from '../../src/renderer/pages/chat/format';
import { shouldStopOnEscape } from '../../src/renderer/pages/chat/keyboard';
import { appendAt, applyStreamEvent, patchThreadTitle } from '../../src/renderer/pages/chat/stream-patch';

const THREAD_ID = '11111111-2222-4333-8444-555555555555';

function message(over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    content: '',
    reasoning: null,
    model: null,
    routing: null,
    usage: null,
    costUsd: null,
    createdAt: '2026-10-31T10:00:00.000Z',
    status: 'complete',
    error: null,
    ...over,
  };
}

function thread(messages: ChatMessage[]): ChatThread {
  return {
    id: THREAD_ID,
    title: 'T',
    mode: 'model',
    model: 'zai-org/GLM-5.3',
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
    messageCount: messages.length,
    costUsd: 0,
    settings: { mode: 'model', model: 'zai-org/GLM-5.3', routerMode: 'balanced', maxTokens: 8192, temperature: null, reasoningEffort: null, systemPrompt: null },
    messages,
  };
}

const streaming = () => thread([message({ id: 'u', role: 'user', content: 'Hi' }), message({ id: 'a', role: 'assistant', status: 'streaming', content: 'Hel' })]);

describe('stream patching', () => {
  it('appends deltas exactly once, using the offsets', () => {
    expect(appendAt('Hel', 'lo', 3)).toEqual({ text: 'Hello', gap: false });
    expect(appendAt('Hel', 'lo', undefined)).toEqual({ text: 'Hello', gap: false });
    // Already applied (e.g. included in a refetch): skipped.
    expect(appendAt('Hello', 'lo', 3)).toEqual({ text: 'Hello', gap: false });
    // Partly applied: only the new tail is added.
    expect(appendAt('Hell', 'lo!', 3)).toEqual({ text: 'Hello!', gap: false });
    // A delta was missed: keep the text, ask for a refetch.
    expect(appendAt('Hel', 'world', 10)).toEqual({ text: 'Hel', gap: true });
  });

  it('patches content and reasoning deltas into the cached thread without refetching', () => {
    const before = streaming();
    const { thread: after, refetch } = applyStreamEvent(before, {
      threadId: THREAD_ID,
      messageId: 'a',
      type: 'delta',
      content: 'lo',
      contentOffset: 3,
      reasoning: 'Plan',
      reasoningOffset: 0,
    });
    expect(refetch).toBe(false);
    expect(after.messages[1]).toMatchObject({ content: 'Hello', reasoning: 'Plan' });
    // Immutable update: the cached object is not mutated.
    expect(before.messages[1]?.content).toBe('Hel');
    expect(after.messages[0]).toBe(before.messages[0]);
  });

  it('asks for a refetch when it cannot patch (unknown message, gap, start of a new reply)', () => {
    const t = streaming();
    expect(applyStreamEvent(t, { threadId: THREAD_ID, messageId: 'zzz', type: 'delta', content: 'x' }).refetch).toBe(true);
    expect(applyStreamEvent(t, { threadId: THREAD_ID, messageId: 'a', type: 'delta', content: 'x', contentOffset: 99 }).refetch).toBe(true);
    expect(applyStreamEvent(t, { threadId: THREAD_ID, messageId: 'new', type: 'start', model: null }).refetch).toBe(true);
    expect(applyStreamEvent(t, { threadId: THREAD_ID, messageId: 'a', type: 'start', model: null }).refetch).toBe(false);
  });

  it('ignores events for other threads', () => {
    const t = streaming();
    const result = applyStreamEvent(t, { threadId: 'other', messageId: 'a', type: 'delta', content: 'x' });
    expect(result).toEqual({ thread: t, refetch: false });
  });

  it('applies routing to the reply and swaps in the final message on done/error', () => {
    const routing = { selectedModel: 'zai-org/GLM-5.3', taskType: 'coding', mode: 'balanced', fallbackModels: [], recommendationId: null };
    const routed = applyStreamEvent(streaming(), { threadId: THREAD_ID, messageId: 'a', type: 'routing', routing });
    expect(routed.thread.messages[1]).toMatchObject({ routing, model: 'zai-org/GLM-5.3' });

    const final = message({ id: 'a', role: 'assistant', content: 'Hello!', status: 'complete', costUsd: 0.001 });
    const done = applyStreamEvent(routed.thread, { threadId: THREAD_ID, messageId: 'a', type: 'done', message: final });
    expect(done.thread.messages[1]).toEqual(final);
    // Thread totals come from the main process.
    expect(done.refetch).toBe(true);
  });
});

describe('chat formatting', () => {
  it('shortens model ids and labels routed replies', () => {
    expect(shortModelName('zai-org/GLM-5.3')).toBe('GLM-5.3');
    expect(shortModelName('Qwen/Qwen3-235B-A22B-Instruct-2507-FP8')).toBe('Qwen3-235B-A22B-Instruct-2507');
    expect(shortModelName(null)).toBe('Unknown model');
    expect(routingLabel({ selectedModel: 'zai-org/GLM-5.3', taskType: 'creative_writing', mode: 'balanced', fallbackModels: [], recommendationId: null })).toBe(
      'Auto → GLM-5.3 · creative writing',
    );
    expect(routingLabel(null)).toBe('Auto');
  });

  it('groups threads by local day: Today, Yesterday, Previous 7 days, Older', () => {
    const now = new Date(2026, 9, 31, 15, 0);
    const at = (d: Date): ChatThreadSummary => ({
      id: d.toISOString(),
      title: 't',
      mode: 'auto',
      model: null,
      createdAt: d.toISOString(),
      updatedAt: d.toISOString(),
      messageCount: 2,
      costUsd: 0,
    });
    const groups = groupThreads(
      [
        at(new Date(2026, 9, 31, 0, 5)),
        at(new Date(2026, 9, 30, 23, 59)),
        at(new Date(2026, 9, 30, 0, 1)),
        at(new Date(2026, 9, 25, 9, 0)),
        at(new Date(2026, 9, 1, 9, 0)),
        { ...at(new Date(2026, 9, 1)), updatedAt: 'garbage' },
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.threads.length])).toEqual([
      ['Today', 1],
      ['Yesterday', 2],
      ['Previous 7 days', 1],
      ['Older', 2],
    ]);
  });

  it('formats compact sidebar times', () => {
    const now = new Date('2026-10-31T15:00:00Z');
    expect(compactTime('2026-10-31T14:59:30Z', now)).toBe('now');
    expect(compactTime('2026-10-31T14:38:00Z', now)).toBe('22m');
    expect(compactTime('2026-10-31T12:00:00Z', now)).toBe('3h');
    expect(compactTime('2026-10-28T15:00:00Z', now)).toBe('3d');
    expect(compactTime('2026-10-01T15:00:00Z', now)).toBe('Oct 1');
    expect(compactTime('not a date', now)).toBe('');
  });

  it('exports a thread as Markdown, skipping empty replies', () => {
    const md = threadAsMarkdown({
      ...thread([
        message({ id: 'u', role: 'user', content: 'Question?' }),
        message({ id: 'a', role: 'assistant', content: 'Answer.', model: 'zai-org/GLM-5.3' }),
        message({ id: 'u2', role: 'user', content: 'More?' }),
        message({ id: 'a2', role: 'assistant', content: '', status: 'error' }),
      ]),
      title: 'My chat',
    });
    expect(md).toBe('# My chat\n\n## You\n\nQuestion?\n\n## GLM-5.3\n\nAnswer.\n\n## You\n\nMore?\n');
  });
});

describe('cached thread titles (renames from the sidebar)', () => {
  const summary = (title: string): ChatThreadSummary => ({
    id: THREAD_ID,
    title,
    mode: 'model',
    model: 'zai-org/GLM-5.3',
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
    messageCount: 2,
    costUsd: 0,
  });

  it('takes the title from the matching summary, leaving everything else alone', () => {
    const cached = streaming();
    const patched = patchThreadTitle(cached, [summary('Renamed inline')]);
    expect(patched.title).toBe('Renamed inline');
    expect(patched.messages).toBe(cached.messages);
    expect(patched.settings).toBe(cached.settings);
    expect(cached.title).toBe('T');
  });

  it('returns the same object when the title already matches or the thread is not listed', () => {
    const cached = streaming();
    expect(patchThreadTitle(cached, [summary('T')])).toBe(cached);
    expect(patchThreadTitle(cached, [{ ...summary('Other'), id: 'someone-else' }])).toBe(cached);
    expect(patchThreadTitle(cached, [])).toBe(cached);
  });
});

describe('"cut off" notice for replies that hit an output limit', () => {
  const cut = (over: Partial<ChatMessage>) => message({ id: 'a', role: 'assistant', content: 'Long…', finishReason: 'length', ...over });
  const routing = { selectedModel: 'deepseek-ai/DeepSeek-V4-Flash', taskType: 'qa', mode: 'balanced', fallbackModels: [], recommendationId: null };

  it('names the limit the reply was sent with, not the current setting', () => {
    expect(lengthNotice(cut({ maxTokens: 2048 }))).toBe(
      'The reply hit the 2,048-token limit and was cut off. Raise “Max tokens” in the chat settings to allow longer answers.',
    );
  });

  it('routed replies: the routed model stopped at its own limit (the router takes no max tokens)', () => {
    expect(lengthNotice(cut({ routing, model: routing.selectedModel, maxTokens: null }))).toBe(
      'The routed model (DeepSeek-V4-Flash) stopped at its own output limit. Pick DeepSeek-V4-Flash directly and raise “Max tokens” for longer answers.',
    );
    // Saved before limits were recorded, but routed all the same.
    expect(lengthNotice(cut({ routing }))).toContain('The routed model (DeepSeek-V4-Flash)');
    // Router reply whose routing never arrived.
    expect(lengthNotice(cut({ maxTokens: null }))).toBe(
      'The model GMI Router picked stopped at its own output limit. Pick a model directly and raise “Max tokens” for longer answers.',
    );
  });

  it('older direct replies (limit not recorded) name no number', () => {
    const text = lengthNotice(cut({}));
    expect(text).toBe('The reply hit the output limit and was cut off. Raise “Max tokens” in the chat settings to allow longer answers.');
    expect(text).not.toMatch(/\d/);
  });

  it('says nothing for replies that were not cut off', () => {
    expect(lengthNotice(cut({ finishReason: 'stop', maxTokens: 2048 }))).toBeNull();
    expect(lengthNotice(cut({ finishReason: null }))).toBeNull();
  });
});

describe('Chat settings popover drafts', () => {
  const saved = { systemPrompt: null, temperature: null, maxTokens: 8192 };

  it('turns every edited field into one patch (what Esc, an outside click, Enter or blur saves)', () => {
    const draft = { systemPrompt: '  Answer in French.  ', temperature: '0.3', maxTokens: '32000' };
    expect(settingsPatchFromDraft(draft, saved)).toEqual({
      patch: { systemPrompt: 'Answer in French.', temperature: 0.3, maxTokens: 32000 },
      draft: { systemPrompt: '  Answer in French.  ', temperature: '0.3', maxTokens: '32000' },
    });
  });

  it('is null when nothing changed, including after a save (no double save on blur + close)', () => {
    expect(settingsPatchFromDraft(draftFromSettings(saved), saved).patch).toBeNull();
    const current = { systemPrompt: 'Be terse.', temperature: 0.7, maxTokens: 4096 };
    expect(settingsPatchFromDraft({ systemPrompt: 'Be terse. ', temperature: '0.70', maxTokens: '4096' }, current).patch).toBeNull();
  });

  it('clears the system prompt and temperature with empty fields', () => {
    const current = { systemPrompt: 'Be terse.', temperature: 0.7, maxTokens: 4096 };
    expect(settingsPatchFromDraft({ systemPrompt: '   ', temperature: '', maxTokens: '4096' }, current).patch).toEqual({ systemPrompt: null, temperature: null });
  });

  it('clamps numbers to what the main process accepts and reverts invalid ones', () => {
    const clamped = settingsPatchFromDraft({ systemPrompt: '', temperature: '5', maxTokens: '3' }, saved);
    expect(clamped.patch).toEqual({ temperature: 2, maxTokens: 16 });
    expect(clamped.draft).toMatchObject({ temperature: '2', maxTokens: '16' });
    expect(settingsPatchFromDraft({ systemPrompt: '', temperature: '', maxTokens: '9999999' }, saved).patch).toEqual({ maxTokens: 262_144 });
    expect(settingsPatchFromDraft({ systemPrompt: '', temperature: '', maxTokens: '1000.6' }, saved).patch).toEqual({ maxTokens: 1001 });

    const invalid = settingsPatchFromDraft({ systemPrompt: '', temperature: 'warm', maxTokens: '' }, { ...saved, temperature: 0.4 });
    expect(invalid.patch).toBeNull();
    expect(invalid.draft).toMatchObject({ temperature: '0.4', maxTokens: '8192' });
  });
});

describe('unsent composer text survives a new chat', () => {
  it('keeps chats with non-blank drafts, by well-formed id only', () => {
    const other = '22222222-3333-4444-8555-666666666666';
    expect(keepIdsFromDrafts({ [THREAD_ID]: 'My long draft', [other]: '   ', '../../etc': 'x', '': 'y' })).toEqual([THREAD_ID]);
    expect(keepIdsFromDrafts({})).toEqual([]);
  });
});

describe('Esc stops a streaming reply from anywhere on the chat page', () => {
  const element = (overlay: string | null) => ({ closest: (selector: string) => (overlay && selector.includes(overlay) ? {} : null) });
  const esc = (over: Partial<Parameters<typeof shouldStopOnEscape>[0]> = {}) => ({ key: 'Escape', defaultPrevented: false, target: element(null), ...over });

  it('stops for a plain Esc wherever focus is (e.g. on the page after Send turned into Stop)', () => {
    expect(shouldStopOnEscape(esc())).toBe(true);
    expect(shouldStopOnEscape(esc({ target: null }))).toBe(true);
    expect(shouldStopOnEscape(esc({ target: {} }))).toBe(true);
  });

  it('leaves Esc to dialogs, menus, popovers and an open popup trigger', () => {
    for (const overlay of ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]', '[data-popup-open]']) {
      expect(shouldStopOnEscape(esc({ target: element(overlay) }))).toBe(false);
    }
  });

  it('ignores handled, composing, modified and other keys', () => {
    expect(shouldStopOnEscape(esc({ defaultPrevented: true }))).toBe(false);
    expect(shouldStopOnEscape(esc({ isComposing: true }))).toBe(false);
    expect(shouldStopOnEscape(esc({ ctrlKey: true }))).toBe(false);
    expect(shouldStopOnEscape(esc({ metaKey: true }))).toBe(false);
    expect(shouldStopOnEscape(esc({ altKey: true }))).toBe(false);
    expect(shouldStopOnEscape(esc({ key: 'Enter' }))).toBe(false);
  });
});
