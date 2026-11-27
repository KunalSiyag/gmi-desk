import { describe, expect, it } from 'vitest';
import { iconMatchesProvider, prettyProvider, providerForIcon } from '@main/services/catalog/providers';
import {
  classifyApi,
  cleanModelName,
  isInternalText,
  isJunkId,
  isJunkName,
  mapKind,
  normalizeModalities,
  normalizeTags,
  normalizeUnit,
} from '@main/services/catalog/text';

describe('cleanModelName', () => {
  it('strips org prefixes, provider prefixes and proxy markers', () => {
    expect(cleanModelName('moonshotai/Kimi: K2.6')).toBe('Kimi K2.6');
    expect(cleanModelName('ZAI: GLM-5.3 Flash')).toBe('GLM-5.3 Flash');
    expect(cleanModelName('StepFun: Step-3.7-Flash')).toBe('Step-3.7-Flash');
    expect(cleanModelName('Proxy: zai-org/GLM-4.7')).toBe('GLM-4.7');
    expect(cleanModelName('Qwen/Qwen3-235B-A22B-Instruct-2507-FP8')).toBe('Qwen3-235B-A22B-Instruct-2507-FP8');
    expect(cleanModelName('  Qwen3 Next 80B A3B Instruct  ')).toBe('Qwen3 Next 80B A3B Instruct');
  });

  it('rejects unusable names', () => {
    expect(cleanModelName('80ce8515-e387-4050-883c-7a34e127fba8')).toBeNull();
    expect(cleanModelName('XXXX')).toBeNull();
    expect(cleanModelName('123')).toBeNull();
    expect(cleanModelName('')).toBeNull();
    expect(cleanModelName(42)).toBeNull();
    expect(cleanModelName('646d8d2d5c78a1')).toBeNull();
  });

  it('cleans workflow titles without touching slashes', () => {
    expect(cleanModelName('Published Workflow - My Cat To Merch', { workflow: true })).toBe('My Cat To Merch');
    expect(cleanModelName('Published Workflows - Hostwheel Car', { workflow: true })).toBe('Hostwheel Car');
    expect(cleanModelName('Text/Image to Video', { workflow: true })).toBe('Text/Image to Video');
    const long = cleanModelName('Generate a cinematic Creator Dome campaign image set from character + product references.', { workflow: true });
    expect(long?.endsWith('…')).toBe(true);
    expect(long!.length).toBeLessThanOrEqual(64);
  });
});

describe('junk detection', () => {
  it('flags test, probe, capture, ssrf, proxy and dedicated-endpoint ids', () => {
    for (const id of ['vtx-bypass-test-1009', 'testmodel0423', 'GMI-MAAS-Testing', 'gmi/gmi-router-test', 'zero-cost-probe-1', 'capture-img-1', 'ssrf-file', 'proxy:foo', '646d8d2d5c78/DeepSeek-V4-Pro', '']) {
      expect(isJunkId(id), id).toBe(true);
    }
    for (const id of ['deepseek-ai/DeepSeek-V4-Pro', 'chatgpt-4o-latest', 'seedance-2-5-260628', 'zai-org/GLM-4.7-FP8']) {
      expect(isJunkId(id), id).toBe(false);
    }
  });

  it('checks names and internal markers separately', () => {
    expect(isJunkName('Image Capture')).toBe(true);
    expect(isJunkName('VTX Bypass Test')).toBe(true);
    expect(isJunkName('Kling 3.0 Turbo')).toBe(false);
    expect(isInternalText('[EA - INTERNAL TESTING ONLY]')).toBe(true);
    expect(isInternalText(null, 'EA internal testing - not charged (set real pricing before launch)')).toBe(true);
    // Descriptions may legitimately mention testing.
    expect(isInternalText('Great for testing ideas quickly')).toBe(false);
  });
});

describe('kinds, APIs, units', () => {
  it('maps GMI model types', () => {
    expect(mapKind('language')).toBe('llm');
    expect(mapKind('LLM')).toBe('llm');
    expect(mapKind('workflow')).toBe('workflow');
    expect(mapKind('video')).toBe('video');
    expect(mapKind('3d')).toBe('other');
    expect(mapKind('omni')).toBe('other');
    expect(mapKind('')).toBeNull();
    expect(mapKind(undefined)).toBeNull();
  });

  it('classifies the API a model is called through', () => {
    expect(classifyApi('openai/gpt-5.3-codex', 'llm')).toBe('responses');
    expect(classifyApi('openai/gpt-5.4-pro', 'llm')).toBe('responses');
    expect(classifyApi('bytedance/seed-2.0-mini', 'llm')).toBe('responses');
    expect(classifyApi('openai/gpt-5.4', 'llm')).toBe('chat');
    expect(classifyApi('seedance-2-5-260628', 'video')).toBe('queue');
    expect(classifyApi('80ce8515-e387-4050-883c-7a34e127fba8', 'workflow')).toBe('queue');
  });

  it('cleans pricing units', () => {
    expect(normalizeUnit('1k character', 'per one thousand character')).toBe('1K characters');
    expect(normalizeUnit('character', 'per 1000 character')).toBe('1K characters');
    expect(normalizeUnit('character', 'per_unit')).toBe('character');
    expect(normalizeUnit('video', 'per second')).toBe('second');
    expect(normalizeUnit('', 'video length based pricing per second')).toBe('second');
    expect(normalizeUnit('song (up to 5 minutes)', 'per request')).toBe('song (up to 5 minutes)');
    expect(normalizeUnit(null, '')).toBeNull();
  });

  it('reads per-1K-character prices published under a per-character label', () => {
    // Inworld TTS 2: 15000 micro-USD per "character" is $0.015 per 1K characters (GMI's estimate: 15 micro-USD a character).
    expect(normalizeUnit('character', 'per_unit', 15_000)).toBe('1K characters');
    expect(normalizeUnit('characters', 'per_unit', '25000')).toBe('1K characters');
    // Below $0.001 a character it really is a per-character price.
    expect(normalizeUnit('character', 'per_unit', 15)).toBe('character');
    expect(normalizeUnit('character', 'per_unit', null)).toBe('character');
    expect(normalizeUnit('request', 'per_unit', 15_000)).toBe('request');
  });

  it('normalises modalities and tags', () => {
    expect(
      normalizeModalities([
        { type: 'Text', required: true },
        { type: 'image', required: false },
        { type: 'image', required: true },
        { nope: 1 },
      ]),
    ).toEqual([
      { type: 'text', required: true },
      { type: 'image', required: true },
    ]);
    expect(normalizeTags(['#fifa', 'Video', 'video', 3], ['LLM'])).toEqual(['fifa', 'Video', 'LLM']);
  });
});

describe('providers', () => {
  it('prefers the id prefix, then known hints, then id patterns', () => {
    expect(prettyProvider('deepseek-ai/DeepSeek-V4-Pro', ['GMI Cloud'])).toBe('DeepSeek');
    expect(prettyProvider('moonshotai/kimi-k3', [])).toBe('Moonshot AI');
    expect(prettyProvider('zai-org/GLM-5.3', ['Zhipu'])).toBe('Z.ai');
    expect(prettyProvider('XiaomiMiMo/MiMo-V2.5', [])).toBe('Xiaomi');
    expect(prettyProvider('x-ai/grok-4.5', [])).toBe('xAI');
    expect(prettyProvider('seedream-5.0-pro', ['byteplus-seedream'])).toBe('ByteDance');
    expect(prettyProvider('gemini-3-pro-image', ['vertex'])).toBe('Google');
    expect(prettyProvider('gpt-image-2-generate', ['gpt-image'])).toBe('OpenAI');
    expect(prettyProvider('minimax-music-3.0', ['minimax-audio'])).toBe('MiniMax');
    expect(prettyProvider('Flux2-Klein', [''])).toBe('Black Forest Labs');
    expect(prettyProvider('LTX-2', [])).toBe('Lightricks');
    expect(prettyProvider('Wan-AI_Wan2.2-T2V-A14B', [])).toBe('Alibaba');
    expect(prettyProvider('80ce8515-e387-4050-883c-7a34e127fba8', [''], 'workflow')).toBe('GMI Studio');
    expect(prettyProvider('mystery-model', ['acme labs'])).toBe('Acme labs');
    expect(prettyProvider('mystery-model', [])).toBeNull();
  });

  it('matches logos to providers by file name', () => {
    const kimi = 'https://storage.googleapis.com/gmi-artifact-metadata/shared_icons/kimi.webp';
    expect(providerForIcon(kimi)).toBe('Moonshot AI');
    expect(iconMatchesProvider(kimi, 'Z.ai')).toBe(false);
    expect(iconMatchesProvider(kimi, 'Moonshot AI')).toBe(true);
    expect(iconMatchesProvider(kimi, 'Some New Lab')).toBe(true);
    expect(providerForIcon('https://example.com/creator_ui.png')).toBeNull();
  });
});
