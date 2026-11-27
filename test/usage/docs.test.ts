import { describe, expect, it } from 'vitest';
import { cleanExcerpt, cleanTitle, createDocsService, normalizeDocHits, resolveDocUrl, validateDocsQuery } from '@main/services/usage/docs';
import docsFixture from '@main/mock/fixtures/usage/docs.json';
import { fakeMcp } from './fakes';

/** Real excerpts recorded from MCP search_docs on 2026-10-31. */
const real = (title: string) => {
  const hit = docsFixture.results.find((r) => r.title === title);
  if (!hit) throw new Error(`fixture ${title} missing`);
  return hit;
};

describe('cleanExcerpt on real Mintlify excerpts', () => {
  it('drops <Frame><img srcset=…> cut by GMI mid-attribute, keeps inline code, adds no ellipsis for lost markup only', () => {
    const hit = real('API Keys');
    expect(hit.excerpt).toContain('srcset=');
    expect(hit.excerpt).toMatch(/\[truncated\]$/);
    expect(cleanExcerpt(hit.excerpt, { title: hit.title })).toBe(
      'Create and revoke API keys used by external clients and SDKs to call GMI Cloud Inference.\n\nURL: `https://console.gmicloud.ai/user-setting/api-keys`',
    );
  });

  it('removes images, srcset noise and emphasis from another truncated excerpt', () => {
    const hit = real('List an agent');
    const text = cleanExcerpt(hit.excerpt, { title: hit.title });
    expect(text).toBe(
      'Navigate to: My Agents → List an agent, or a template\'s Listing ▾ → Publish\n\nListing puts your template in the Agent Marketplace. Users click Deploy your own to copy it into their account and pay their own compute.',
    );
    expect(text).not.toMatch(/mintcdn|srcset|<|>|\*\*|\[truncated\]/);
  });

  it('keeps code fences readable without Mintlify meta and drops a heading that repeats the title', () => {
    const hit = real('Step 3. Confirm it worked');
    const text = cleanExcerpt(hit.excerpt, { title: hit.title });
    expect(text.startsWith('```bash\nclaude mcp list\n```\n\nLook for a line reporting `gmi` connected over `http`.')).toBe(true);
    expect(text).not.toContain('theme=');
    expect(text).not.toContain('Step 3');
    expect(text).toContain('\n\nWhat video models does GMI have?\n\n');
  });

  it('flattens <CardGroup>/<Card title> into labelled paragraphs', () => {
    const hit = real('Welcome to GMI Cloud');
    expect(cleanExcerpt(hit.excerpt, { title: hit.title })).toBe(
      [
        'Products',
        'Inference: Serverless and Dedicated endpoints for chat, vision, image, video, and audio models. OpenAI-compatible APIs.',
        'GPU Compute: Managed Kubernetes clusters, container instances, and bare-metal servers on H200 and B200 GPUs.',
        'GMI Studio: Visual workflow builder. Connect models with nodes to make multi-step pipelines for media and text.',
        'GMI Agentbox: Marketplace of ready-to-use AI agents. Browse, use, or publish your own.',
      ].join('\n\n'),
    );
  });

  it('labels <Note> callouts, turns tables into rows and unescapes markdown', () => {
    const note = cleanExcerpt(real('Payment settings').excerpt, { title: 'Payment settings' });
    expect(note).toContain('The Auto Pay Enable toggle.');
    expect(note).toContain('\n\nNote: When your balance nears your auto-pay threshold');

    const table = cleanExcerpt(real('Image Nodes').excerpt, { title: 'Image Nodes' });
    expect(table).toBe(
      'Image generation and editing nodes for GMI Studio workflows.\n\nNode · Model\nReve Create · `reve-create-20250915`\nReve Edit · `reve-edit-20250915`\nReve Edit Fast · `reve-edit-fast-20251030`\nReve Remix · `reve-remix-20250915`\nReve Remix Fast · `reve-remix-fast-20251030`',
    );

    const bundle = cleanExcerpt(real('2. Credit Bundle').excerpt, { title: '2. Credit Bundle' });
    expect(bundle.split('\n').slice(0, 2)).toEqual(['• Introduced a first top-up bonus:', '  ◦ First top-up ≥ $50 → +$3 credit']);
  });

  it('marks text cut by GMI with an ellipsis, even mid-link', () => {
    const text = cleanExcerpt(real('Video Nodes').excerpt, { title: 'Video Nodes' });
    expect(text.endsWith('Kling V3 Text To Video…')).toBe(true);
    expect(text).not.toContain('](');
  });

  it('joins soft-wrapped lines that continue with inline code', () => {
    // Real Agentbox API reference excerpt (search_docs "Agentbox sandbox execute command timeout").
    const raw =
      'Execute a command in a sandbox\nStarts an asynchronous shell execution in the sandbox. The request body keeps the\n`action=exec` and `parameters` shape used by the runtime contract. The effective URL is\nthe sandbox data-plane host.\nWhen `wait=true`, the server waits for a terminal result for at most\n`wait_timeout_seconds` seconds; a timeout returns `202` without cancelling the execution.';
    expect(cleanExcerpt(raw, { title: 'Execute a command in a sandbox' })).toBe(
      'Starts an asynchronous shell execution in the sandbox. The request body keeps the `action=exec` and `parameters` shape used by the runtime contract. The effective URL is the sandbox data-plane host.\nWhen `wait=true`, the server waits for a terminal result for at most `wait_timeout_seconds` seconds; a timeout returns `202` without cancelling the execution.',
    );
    // A row that starts with code after a finished sentence keeps its own line.
    expect(cleanExcerpt('Parameters:\n`command` (str): Command to run.\n`wait` (bool): Wait for it.')).toBe(
      'Parameters:\n`command` (str): Command to run.\n`wait` (bool): Wait for it.',
    );
  });

  it('keeps generic types and splits API-reference rows onto their own lines', () => {
    const text = cleanExcerpt(real('Create an API key').excerpt, { title: 'Create an API key' });
    expect(text.startsWith('Allows a user to generate an API key for their organization.\n\nREST Endpoint POST /organizations/{orgId}/api-keys\nSummary: Create an API key\n')).toBe(true);
    expect(text).toContain('type string<uuid>');
    expect(text).toContain('type enum<string>');
  });

  it('truncates to ~600 characters at a word boundary', () => {
    for (const hit of docsFixture.results) {
      const text = cleanExcerpt(hit.excerpt, { title: hit.title });
      expect(text.length).toBeLessThanOrEqual(602);
      expect(text).not.toMatch(/<\/?(img|Frame|Card|CardGroup|Note)\b/);
    }
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const cut = cleanExcerpt(long, { maxChars: 100 });
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toMatch(/word\d+…$/);
  });
});

describe('cleanExcerpt edge cases', () => {
  it('handles HTML comments, entities, <br>, <code>, autolinks and media elements', () => {
    const raw =
      '<!-- hidden -->Use <code>max_tokens</code> &amp; <b>stream</b><br/>See <https://docs.gmicloud.ai/x>.\n\n<video src="a.mp4"><source src="b.mp4" /></video>\n![diagram](https://x.test/a.png)\nDone &lt;ok&gt;';
    expect(cleanExcerpt(raw)).toBe('Use `max_tokens` & stream\nSee https://docs.gmicloud.ai/x.\n\nDone <ok>');
  });

  it('never strips placeholders inside inline code and keeps unclosed fences', () => {
    expect(cleanExcerpt('Send `Authorization: Bearer <your-api-key>` with every call.')).toBe(
      'Send `Authorization: Bearer <your-api-key>` with every call.',
    );
    expect(cleanExcerpt('Run:\n```python\nimport os\nprint(os.environ)\n [truncated]')).toBe('Run:\n\n```python\nimport os\nprint(os.environ)\n```\n\n…');
  });

  it('returns an empty string for non-text and image-only excerpts', () => {
    expect(cleanExcerpt(undefined)).toBe('');
    expect(cleanExcerpt(42)).toBe('');
    expect(cleanExcerpt('<Frame>\n  <img src="https://mintcdn.com/a.png" />\n</Frame>')).toBe('');
  });
});

describe('normalizeDocHits', () => {
  it('cleans titles and excerpts, resolves relative links, drops non-https and duplicates', () => {
    const hits = normalizeDocHits({
      results: [
        { title: '## **Rate limits**', url: '/inference-engine/api-reference/rate-limit', excerpt: 'TPM and RPH.' },
        { title: 'Dup', url: 'https://docs.gmicloud.ai/inference-engine/api-reference/rate-limit', excerpt: 'other' },
        { title: 'Insecure', url: 'http://docs.gmicloud.ai/x', excerpt: 'x' },
        { title: 'Script', url: 'javascript:alert(1)', excerpt: 'x' },
        { title: 'Same page, same text', url: 'https://docs.gmicloud.ai/index#products', excerpt: 'Products' },
        { title: 'Same page, same text 2', url: 'https://docs.gmicloud.ai/index', excerpt: 'Products' },
        { url: 'https://docs.gmicloud.ai/agentbox-marketplace/list-an-agent', excerpt: '' },
        'junk',
      ],
    });
    expect(hits).toEqual([
      { title: 'Rate limits', url: 'https://docs.gmicloud.ai/inference-engine/api-reference/rate-limit', excerpt: 'TPM and RPH.' },
      { title: 'Same page, same text', url: 'https://docs.gmicloud.ai/index#products', excerpt: 'Products' },
      { title: 'List an agent', url: 'https://docs.gmicloud.ai/agentbox-marketplace/list-an-agent', excerpt: '' },
    ]);
    expect(() => normalizeDocHits({ nope: 1 })).toThrow();
  });

  it('accepts only https urls', () => {
    expect(resolveDocUrl('https://docs.gmicloud.ai/a#b')).toBe('https://docs.gmicloud.ai/a#b');
    expect(resolveDocUrl('/a/b')).toBe('https://docs.gmicloud.ai/a/b');
    expect(resolveDocUrl('file:///etc/passwd')).toBeNull();
    expect(resolveDocUrl('https://user:pw@docs.gmicloud.ai/')).toBeNull();
    expect(cleanTitle('  Step 2: Obtain `API` Credentials ')).toBe('Step 2: Obtain API Credentials');
  });
});

describe('docs search service', () => {
  it('trims and validates the query (2..300 chars) before calling GMI', async () => {
    const { mcp, calls } = fakeMcp({ search_docs: () => ({ results: [] }) });
    const docs = createDocsService(mcp, () => new Date()).api;
    for (const bad of ['', ' a ', 'x'.repeat(301), 42]) {
      await expect(docs.search(bad as string)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(calls).toHaveLength(0);
    expect(validateDocsQuery('  rate \n limits  ')).toBe('rate limits');
  });

  it('defaults to 8 results, clamps the limit to 1..10 and caches repeated searches', async () => {
    const { mcp, calls } = fakeMcp({ search_docs: () => ({ results: docsFixture.results }) });
    const docs = createDocsService(mcp, () => new Date()).api;
    const hits = await docs.search('  GMI Router ');
    expect(calls[0]?.args).toEqual({ query: 'GMI Router', limit: 8 });
    expect(hits).toHaveLength(8);
    await docs.search('gmi router');
    expect(calls).toHaveLength(1);
    await docs.search('agentbox', 50);
    await docs.search('agentbox', 0);
    expect(calls.slice(1).map((c) => c.args.limit)).toEqual([10, 1]);
  });

  it('passes GMI errors through (sign-in required)', async () => {
    const { mcp } = fakeMcp();
    mcp.callTool = async () => {
      throw Object.assign(new Error('Sign in first'), { name: 'GmiError', code: 'not_signed_in' });
    };
    await expect(createDocsService(mcp, () => new Date()).api.search('billing')).rejects.toMatchObject({ code: 'not_signed_in' });
  });
});
