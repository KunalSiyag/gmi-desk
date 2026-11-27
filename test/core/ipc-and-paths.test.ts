import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, consoleUrl } from '@shared/app';
import { GmiError, type IpcResult } from '@shared/contracts/errors';
import { invokeChannel } from '@shared/contracts';
import { silentLogger } from '@main/core/logger';
import { fromMediaUrl, isInsideDir, safeFileName, toMediaUrl } from '@main/core/media-paths';
import { parseShotSpecs } from '@main/dev/screenshots';
import { methodNames, registerApi, type IpcMainLike } from '@main/ipc/registry';

function fakeIpc() {
  const handlers = new Map<string, (event: { senderFrame?: { url: string } | null }, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
  };
  return { ipc, handlers };
}

describe('registerApi', () => {
  it('exposes methods and serialises results and GmiErrors', async () => {
    const { ipc, handlers } = fakeIpc();
    const impl = {
      async getSnapshot() {
        return { models: [] };
      },
      async refresh() {
        throw new GmiError('not_signed_in', 'Sign in first');
      },
      async getModel() {
        throw new Error('boom');
      },
    };
    const unregister = registerApi(ipc, 'catalog', impl as never, { log: silentLogger, isTrustedSender: (e) => e.senderFrame?.url === 'app://ok' });
    expect([...handlers.keys()].sort()).toEqual([invokeChannel('catalog', 'getModel'), invokeChannel('catalog', 'getSnapshot'), invokeChannel('catalog', 'refresh')].sort());
    const ok = { senderFrame: { url: 'app://ok' } };
    expect(await handlers.get(invokeChannel('catalog', 'getSnapshot'))!(ok)).toEqual({ ok: true, data: { models: [] } });
    const err = (await handlers.get(invokeChannel('catalog', 'refresh'))!(ok)) as IpcResult<unknown>;
    expect(err).toMatchObject({ ok: false, error: { code: 'not_signed_in', message: 'Sign in first' } });
    const internal = (await handlers.get(invokeChannel('catalog', 'getModel'))!(ok)) as IpcResult<unknown>;
    expect(internal).toMatchObject({ ok: false, error: { code: 'internal', message: 'boom' } });
    const untrusted = (await handlers.get(invokeChannel('catalog', 'getSnapshot'))!({ senderFrame: { url: 'https://evil.test' } })) as IpcResult<unknown>;
    expect(untrusted).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    unregister();
    expect(handlers.size).toBe(0);
  });

  it('finds prototype methods but skips invalid names', () => {
    class Impl {
      async a() {}
      async b() {}
    }
    expect(methodNames(new Impl()).sort()).toEqual(['a', 'b']);
    expect(methodNames({ _private: () => 1, ok: () => 1, value: 3 })).toEqual(['ok']);
  });
});

describe('media paths', () => {
  const root = '/data/media';
  it('round-trips files inside the media dir', () => {
    const url = toMediaUrl(root, join(root, 'jobs', 'a b.png'));
    expect(url).toBe('gmi-media://local/jobs/a%20b.png');
    expect(fromMediaUrl(root, url!)).toBe(join(root, 'jobs', 'a b.png'));
  });

  it('rejects traversal and foreign schemes', () => {
    expect(toMediaUrl(root, '/etc/passwd')).toBeNull();
    expect(fromMediaUrl(root, 'gmi-media://local/..%2F..%2Fetc%2Fpasswd')).toBeNull();
    // WHATWG URL parsing collapses dot segments, so this can never escape the media dir.
    expect(isInsideDir(root, fromMediaUrl(root, 'gmi-media://local/../secret') ?? root)).toBe(true);
    expect(fromMediaUrl(root, 'file:///etc/passwd')).toBeNull();
    expect(fromMediaUrl(root, 'gmi-media://other/x.png')).toBeNull();
    expect(isInsideDir(root, '/data/media-evil/x')).toBe(false);
    expect(safeFileName('../../x y?.png')).toBe('x_y_.png');
  });
});

describe('external URLs', () => {
  it('allows https only, without credentials', () => {
    expect(isAllowedExternalUrl('https://docs.gmicloud.ai/x')).toBe(true);
    expect(isAllowedExternalUrl('https://en.wikipedia.org/wiki/GPU')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('https://user:pw@example.com')).toBe(false);
    expect(consoleUrl('apiKeys')).toBe('https://console.gmicloud.ai/auth/sign-in?callbackUrl=%2Fuser-setting%2Fie%2Fapi-keys');
  });
});

describe('parseShotSpecs', () => {
  it('parses pages, params, theme and wait', () => {
    const specs = parseShotSpecs('models,models?model=zai-org/GLM-5.3#light~2500,bogus,chat');
    expect(specs.map((s) => s.name)).toEqual(['models', 'models-light', 'chat']);
    expect(specs[1]).toMatchObject({ nav: { page: 'models', params: { model: 'zai-org/GLM-5.3' } }, theme: 'light', waitMs: 2500 });
  });

  it('accepts the wait and theme suffixes in either order', () => {
    const [a, b] = parseShotSpecs('chat?thread=x~900#light,usage#light~1200');
    expect(a).toMatchObject({ nav: { page: 'chat', params: { thread: 'x' } }, theme: 'light', waitMs: 900 });
    expect(b).toMatchObject({ nav: { page: 'usage' }, theme: 'light', waitMs: 1200 });
  });
});
