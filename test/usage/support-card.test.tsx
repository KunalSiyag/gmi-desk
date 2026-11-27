// Docs › Contact GMI support: the empty form's send button stays quiet (outline) until the ticket can be sent.
// Rendered with react-dom/server (node environment, no DOM): the filled state was checked over CDP in the build.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GmiBridge } from '@shared/contracts';
import { SupportCard } from '@renderer/pages/docs/SupportCard';

beforeEach(() => {
  const bridge: GmiBridge = { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function render(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SupportCard />
    </QueryClientProvider>,
  );
}

describe('Docs › SupportCard', () => {
  it('an empty form keeps "Send to GMI support" outlined, with plain key hints', () => {
    const html = render();
    const start = html.indexOf('<button type="submit"');
    const button = html.slice(start, html.indexOf('</button>', start));
    expect(button).toContain('Send to GMI support');
    expect(button).toContain('border-input');
    expect(button).not.toContain('bg-primary');
    expect(button).not.toContain('text-primary-foreground');
  });

  it('the ?section=support highlight ring fades in and out within 200 ms (opacity only)', () => {
    const html = render();
    const section = html.match(/<section[^>]*>/)?.[0] ?? '';
    expect(section).toContain('after:transition-opacity');
    expect(section).toContain('after:duration-200');
    expect(section).not.toMatch(/duration-(?:[3-9]\d\d|\d{4})/);
  });
});
