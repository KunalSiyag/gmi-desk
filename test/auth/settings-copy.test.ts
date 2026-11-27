// Settings copy that depends on state (src/renderer/pages/settings/copy.ts is pure, so it runs here).
import { describe, expect, it } from 'vitest';
import { CHAT_DEFAULTS_COPY, keyStorageClause, keyStorageNote, lockedSecretNote } from '../../src/renderer/pages/settings/copy';

describe('Settings copy', () => {
  it('says where a saved key really goes, matching the Security section (os / basic_text / unavailable)', () => {
    expect(keyStorageNote('os')).toMatch(/stored in your OS keychain/);
    expect(keyStorageNote('basic_text')).toMatch(/weak encryption/);
    expect(keyStorageNote('basic_text')).not.toMatch(/keychain/);
    expect(keyStorageNote('unavailable')).toMatch(/memory only/);
    expect(keyStorageNote('unavailable')).toMatch(/paste it again after you quit/);
    expect(keyStorageNote('unavailable')).not.toMatch(/keychain/);
    expect(keyStorageClause('os')).toMatch(/OS keychain/);
    expect(keyStorageClause('basic_text')).not.toMatch(/keychain/);
    expect(keyStorageClause('unavailable')).toMatch(/memory only/);
  });

  it('presents the Chat settings as defaults for new chats, not something sent with every request', () => {
    for (const text of [CHAT_DEFAULTS_COPY.maxTokens, CHAT_DEFAULTS_COPY.routerMode]) expect(text).toMatch(/^Default for new chats/);
    expect(CHAT_DEFAULTS_COPY.model).toMatch(/New chats start with this model/);
    expect(CHAT_DEFAULTS_COPY.maxTokens).not.toMatch(/every request/i);
  });

  it('explains a locked secret: nothing deleted, what to do', () => {
    expect(lockedSecretNote('sign_in')).toMatch(/saved GMI sign-in\. Nothing was deleted.*or sign in again/);
    expect(lockedSecretNote('inference_key')).toMatch(/saved API key\. Nothing was deleted.*or paste the key again/);
  });
});
