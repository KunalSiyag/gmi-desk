import type { CodeThreadEvent, TimelineItem } from '@shared/contracts/code';

export interface TimelineState {
  items: TimelineItem[];
  lastSeq: number;
}

function appendText(item: TimelineItem, field: 'text' | 'reasoning' | 'output' | 'args', text: string): TimelineItem {
  if (field === 'args' && item.kind === 'tool') return { ...item, argsPreview: item.argsPreview + text };
  if (field === 'output' && item.kind === 'tool') {
    const output = item.output ?? { text: '', truncated: false, totalBytes: 0, spillId: null };
    return { ...item, output: { ...output, text: output.text + text, totalBytes: output.totalBytes + text.length } };
  }
  if (item.kind === 'assistant' && field === 'text') return { ...item, text: item.text + text };
  if (item.kind === 'assistant' && field === 'reasoning') return { ...item, reasoning: (item.reasoning ?? '') + text };
  return item;
}

/** Applies one durable thread event to a timeline cache. Deltas append in place; status/diff/meter are the caller's. */
export function applyTimelineEvent(state: TimelineState, event: CodeThreadEvent): TimelineState {
  if (event.type === 'item') {
    const existing = state.items.findIndex((i) => i.id === event.item.id);
    const items = existing >= 0 ? state.items.map((i, idx) => (idx === existing ? event.item : i)) : [...state.items, event.item];
    items.sort((a, b) => a.seq - b.seq);
    return { items, lastSeq: Math.max(state.lastSeq, event.seq) };
  }
  if (event.type === 'delta') {
    if (!event.itemId) return state;
    let changed = false;
    const items = state.items.map((item) => {
      if (item.id !== event.itemId) return item;
      changed = true;
      return appendText(item, event.field, event.text);
    });
    return changed ? { ...state, items } : state;
  }
  return state;
}
