import { describe, expect, it } from 'vitest';
import {
  acknowledge,
  applySeen,
  EMPTY_SEEN,
  isNewKey,
  normalizeSeen,
  OLD_DATE,
  recordObserved,
  type ObservedId,
  type SeenState,
} from '@main/services/catalog/seen';
import type { CatalogModel, CatalogSource } from '@shared/contracts/catalog';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const DAY = 86_400_000;
const obs = (entries: Array<[string, CatalogSource[], string | null]>) =>
  new Map<string, ObservedId>(entries.map(([id, sources, createdAt]) => [id, { sources: new Set(sources), createdAt }]));

describe('first-seen tracking', () => {
  it('seeds the first refresh with creation dates or an old date, so nothing is flagged', () => {
    const { state, newKeys } = recordObserved(
      EMPTY_SEEN,
      obs([
        ['a', ['public_media'], '2026-10-25T00:00:00.000Z'],
        ['b', ['public_media'], null],
        ['future', ['public_media'], '2027-01-01T00:00:00.000Z'],
      ]),
      ['public_media', 'featured'],
      NOW,
    );
    expect(newKeys).toEqual([]);
    expect(state.initialized).toBe(true);
    expect(state.seen).toEqual({ a: '2026-10-25T00:00:00.000Z', b: OLD_DATE, future: NOW.toISOString() });
    expect(state.sources.sort()).toEqual(['featured', 'public_media']);
    // A recent creation date still shows as New on a fresh install (it really is new).
    expect(isNewKey(state, 'a', NOW, 30)).toBe(true);
    expect(isNewKey(state, 'b', NOW, 30)).toBe(false);
  });

  it('flags ids first reported by a source that was fetched before', () => {
    const first = recordObserved(EMPTY_SEEN, obs([['a', ['public_media'], null]]), ['public_media'], NOW).state;
    const later = new Date(NOW.getTime() + DAY);
    const { state, newKeys } = recordObserved(first, obs([['a', ['public_media'], null], ['b', ['public_media'], null]]), ['public_media'], later);
    expect(newKeys).toEqual(['b']);
    expect(state.seen.b).toBe(later.toISOString());
    expect(isNewKey(state, 'b', later, 30)).toBe(true);
  });

  it('does not flag a whole source the first time it succeeds (e.g. signing in later)', () => {
    const first = recordObserved(EMPTY_SEEN, obs([['a', ['public_media'], null]]), ['public_media'], NOW).state;
    const { state, newKeys } = recordObserved(
      first,
      obs([
        ['a', ['public_media', 'mcp'], null],
        ['mcp-only', ['mcp'], null],
        ['launched', ['public_media', 'mcp'], null],
      ]),
      ['public_media', 'mcp'],
      NOW,
    );
    expect(newKeys).toEqual(['launched']);
    expect(state.seen['mcp-only']).toBe(OLD_DATE);
    expect(state.sources).toContain('mcp');
  });

  it('ignores ids only reported by stale (reused) sources', () => {
    const first = recordObserved(EMPTY_SEEN, obs([['a', ['public_media'], null]]), ['public_media', 'featured'], NOW).state;
    const { newKeys, state } = recordObserved(first, obs([['x', ['featured'], null]]), ['public_media'], NOW);
    expect(newKeys).toEqual([]);
    expect(state.seen.x).toBeUndefined();
  });

  it('expires after the window and respects acknowledgements', () => {
    const state: SeenState = { ...EMPTY_SEEN, initialized: true, seen: { a: new Date(NOW.getTime() - 10 * DAY).toISOString() } };
    expect(isNewKey(state, 'a', NOW, 30)).toBe(true);
    expect(isNewKey(state, 'a', NOW, 7)).toBe(false);
    expect(isNewKey(state, 'missing', NOW, 30)).toBe(false);
    const acked = acknowledge(state, ['A']);
    expect(isNewKey(acked, 'a', NOW, 30)).toBe(false);
    expect(acknowledge(state, [])).toBe(state);
  });

  it('fills firstSeenAt and isNew on models (case-insensitive ids)', () => {
    const state: SeenState = { ...EMPTY_SEEN, initialized: true, seen: { 'zai-org/glm-5.3': new Date(NOW.getTime() - DAY).toISOString() } };
    const [m] = applySeen([{ id: 'zai-org/GLM-5.3', firstSeenAt: '', isNew: false } as CatalogModel], state, NOW, 30);
    expect(m).toMatchObject({ isNew: true, firstSeenAt: state.seen['zai-org/glm-5.3'] });
  });

  it('normalises the stored file', () => {
    expect(normalizeSeen(null)).toEqual(EMPTY_SEEN);
    expect(
      normalizeSeen({
        seen: { 'A/B': '2026-01-01T00:00:00.000Z', bad: 'nope', n: 3 },
        acknowledged: { 'A/B': true, x: 'yes' },
        initialized: true,
        sources: ['mcp', 'bogus', 'mcp'],
        titles: { 'product photo': '2026-01-13T00:00:00.000Z', broken: 'x', n: 1 },
      }),
    ).toEqual({
      seen: { 'a/b': '2026-01-01T00:00:00.000Z' },
      acknowledged: { 'a/b': true },
      initialized: true,
      sources: ['mcp'],
      titles: { 'product photo': '2026-01-13T00:00:00.000Z' },
    });
    // Files written before titles were tracked.
    expect(normalizeSeen({ seen: {}, initialized: true }).titles).toEqual({});
  });
});

describe('republished workflows (GMI Studio publishes copies of a workflow under new ids)', () => {
  const wf = (entries: Array<[string, string | null]>, title = 'product photo') =>
    new Map<string, ObservedId>(entries.map(([id, createdAt]) => [id, { sources: new Set<CatalogSource>(['public_media']), createdAt, title }]));
  const JAN = '2026-01-13T00:00:00.000Z';

  it('gives a new copy of a known title its first-seen date instead of announcing it', () => {
    const first = recordObserved(EMPTY_SEEN, wf([['a', JAN]]), ['public_media'], NOW).state;
    const later = new Date(NOW.getTime() + 40 * DAY);
    const observed = wf([['a', JAN], ['b', later.toISOString()]]);
    observed.set('fresh-title', { sources: new Set(['public_media']), createdAt: later.toISOString(), title: 'love link arcade game' });
    const { state, newKeys } = recordObserved(first, observed, ['public_media'], later);
    expect(newKeys).toEqual(['fresh-title']);
    expect(state.seen.b).toBe(JAN);
    expect(state.titles).toEqual({ 'product photo': JAN, 'love link arcade game': later.toISOString() });
    expect(isNewKey(state, 'b', later, 30)).toBe(false);
  });

  it('recognises the title after the older copy is gone, and carries the acknowledgement over', () => {
    const recent = new Date(NOW.getTime() - 5 * DAY).toISOString();
    let state = recordObserved(EMPTY_SEEN, wf([['a', recent]]), ['public_media'], NOW).state;
    state = acknowledge(state, ['a']);
    const later = new Date(NOW.getTime() + DAY);
    // b replaces a while a is still listed: the badge the user cleared stays cleared.
    const withB = recordObserved(state, wf([['a', recent], ['b', null]]), ['public_media'], later);
    expect(withB.newKeys).toEqual([]);
    expect(withB.state.acknowledged.b).toBe(true);
    expect(isNewKey(withB.state, 'b', later, 30)).toBe(false);
    // c arrives after GMI stopped listing a and b: the persisted title still matches.
    const withC = recordObserved(withB.state, wf([['c', null]]), ['public_media'], later);
    expect(withC.newKeys).toEqual([]);
    expect(withC.state.seen.c).toBe(recent);
  });

  it('backfills titles for files saved before titles were tracked', () => {
    const old: SeenState = { ...EMPTY_SEEN, initialized: true, sources: ['public_media'], seen: { a: JAN }, titles: {} };
    const { newKeys, state } = recordObserved(old, wf([['a', JAN], ['b', null]]), ['public_media'], NOW);
    expect(newKeys).toEqual([]);
    expect(state.seen.b).toBe(JAN);
  });

  it('dates every copy of a title from the oldest one, and announces a title only when all its copies are new', () => {
    // Fresh install: the visible (newest) copy is not New just because it was republished recently.
    const install = recordObserved(EMPTY_SEEN, wf([['b', new Date(NOW.getTime() - DAY).toISOString()], ['a', JAN]]), ['public_media'], NOW);
    expect(install.state.seen).toEqual({ a: JAN, b: JAN });
    expect(isNewKey(install.state, 'b', NOW, 30)).toBe(false);
    // A brand-new title published twice between two refreshes is announced (once, by the catalog: duplicates are hidden).
    const later = new Date(NOW.getTime() + DAY);
    const observed = new Map([...wf([['a', JAN], ['b', null]]), ...wf([['x1', null], ['x2', null]], 'new one')]);
    const launch = recordObserved(install.state, observed, ['public_media'], later);
    expect(launch.newKeys.sort()).toEqual(['x1', 'x2']);
    expect(launch.state.seen.x1).toBe(later.toISOString());
  });
});
