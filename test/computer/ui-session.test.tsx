// C2-D: renderer-side session lifetime (compute.md §8.1 "Close": last view + 5 min warm reattach) and the dock store
// (previews follow `computer:preview`, a closed session drops its previews' tabs).
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computerKeys, RELEASE_DEBOUNCE_MS, retainedCount, retainSession } from '@renderer/components/computer/session';
import { previewIdOf, previewTab, useComputerUi } from '@renderer/components/computer/store';
import type { PreviewInfo } from '@shared/contracts/compute';
import { installBridge, removeBridge, session, type Calls } from './ui-fixtures';

let calls: Calls;
beforeEach(() => {
  vi.useFakeTimers();
  calls = installBridge();
});
afterEach(() => {
  vi.useRealTimers();
  removeBridge();
  useComputerUi.setState({ previews: {}, tabs: {}, expanded: {}, selected: {} });
});

const closes = () => calls.invokes.filter((c) => c.ns === 'computer' && c.method === 'close');

function seeded(resourceId = 'cr_a', sessionId = 'cs_a') {
  const client = new QueryClient();
  client.setQueryData(computerKeys.session(resourceId), session({ resourceId, sessionId }));
  return client;
}

describe('warm close', () => {
  it('review: releases to main shortly after the last view lets go (main owns the 5 min warm period), and forgets the cached session', async () => {
    const client = seeded();
    const release = retainSession(client, 'cr_a');
    expect(retainedCount('cr_a')).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS - 1);
    expect(closes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toEqual([{ ns: 'computer', method: 'close', args: ['cs_a'] }]);
    expect(client.getQueryData(computerKeys.session('cr_a'))).toBeUndefined();
  });

  it('a view coming back within the debounce keeps the session (no close)', async () => {
    const client = seeded();
    retainSession(client, 'cr_a')();
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS / 2);
    const again = retainSession(client, 'cr_a');
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS * 2);
    expect(closes()).toHaveLength(0);
    again();
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);
    expect(closes()).toHaveLength(1);
  });

  it('counts several views; releasing twice is harmless', async () => {
    const client = seeded();
    const a = retainSession(client, 'cr_a');
    const b = retainSession(client, 'cr_a');
    a();
    a();
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS * 2);
    expect(closes()).toHaveLength(0);
    b();
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);
    expect(closes()).toHaveLength(1);
  });

  it('a session main already closed is not closed again', async () => {
    const client = new QueryClient();
    client.setQueryData(computerKeys.session('cr_b'), session({ resourceId: 'cr_b', sessionId: 'cs_b', state: 'closed' }));
    retainSession(client, 'cr_b')();
    await vi.advanceTimersByTimeAsync(RELEASE_DEBOUNCE_MS);
    expect(closes()).toHaveLength(0);
  });
});

describe('dock store', () => {
  const p = (patch: Partial<PreviewInfo> = {}): PreviewInfo => ({
    previewId: 'pv1',
    sessionId: 'cs_1',
    port: 3000,
    url: 'https://3000-k.example.test/',
    title: null,
    state: 'loading',
    detail: null,
    canGoBack: false,
    canGoForward: false,
    ...patch,
  });

  it('previews: upserted by event, removed when closed', () => {
    const ui = useComputerUi.getState();
    ui.upsertPreview(p());
    ui.upsertPreview(p({ state: 'ready', title: 'Vite App' }));
    expect(useComputerUi.getState().previews.pv1?.state).toBe('ready');
    ui.upsertPreview(p({ state: 'closed' }));
    expect(useComputerUi.getState().previews).toEqual({});
    ui.upsertPreview(p({ previewId: 'never-seen', state: 'closed' }));
    expect(useComputerUi.getState().previews).toEqual({});
  });

  it('review: an openPreview result never overwrites newer events (the preview stayed "loading")', () => {
    const ui = useComputerUi.getState();
    // The ready event arrived before the invoke resolved with its older `loading` snapshot.
    ui.upsertPreview(p({ state: 'ready' }));
    ui.addPreview(p());
    expect(useComputerUi.getState().previews.pv1?.state).toBe('ready');
    ui.addPreview(p({ previewId: 'pv2' }));
    expect(useComputerUi.getState().previews.pv2?.state).toBe('loading');
    ui.addPreview(p({ previewId: 'pv3', state: 'closed' }));
    expect(useComputerUi.getState().previews.pv3).toBeUndefined();
  });

  it('preview tab ids round-trip', () => {
    expect(previewIdOf(previewTab('abc'))).toBe('abc');
    expect(previewIdOf('files')).toBeNull();
  });

  it('expanded folders toggle per session', () => {
    const ui = useComputerUi.getState();
    ui.toggleExpanded('s', '/root/app');
    ui.toggleExpanded('s', '/root/data', true);
    ui.toggleExpanded('s', '/root/data', true);
    expect(useComputerUi.getState().expanded.s).toEqual(['/root/app', '/root/data']);
    ui.toggleExpanded('s', '/root/app');
    expect(useComputerUi.getState().expanded.s).toEqual(['/root/data']);
  });
});
