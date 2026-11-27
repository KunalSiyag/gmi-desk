// Docs page, signed out: the "Browse docs.gmicloud.ai" link must sit in normal flow AFTER RequireAuth's prompt.
// It used to be pulled up into the prompt with `order-last -mt-16`, and then drew over the sign-in error that
// RequireAuth shows below its button. vitest has no DOM here, so this guards the layout at the source level
// (the rendered page was checked over CDP with GMI_DESK_MOCK_AUTH=signed_out,no_key,sign_in_fails).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = await readFile(fileURLToPath(new URL('../../src/renderer/pages/docs/index.tsx', import.meta.url)), 'utf8');

describe('Docs page while signed out', () => {
  it('never pulls anything over the sign-in prompt (no negative margins, no reordering)', () => {
    expect(source).not.toMatch(/(?:^|[\s"'`{])-m[trblxy]?-(?:\d|px|\[)/m);
    expect(source).not.toMatch(/\border-(?:last|first|\d+)\b/);
  });

  it('renders the browse link after RequireAuth, in normal flow', () => {
    const promptEnd = source.indexOf('</RequireAuth>');
    const link = source.indexOf('{signedOut ? <BrowseDocsLink');
    expect(promptEnd).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(promptEnd);
  });
});
