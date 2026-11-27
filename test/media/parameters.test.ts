import { describe, expect, it } from 'vitest';
import { prepareMediaSchema, reconcileEnumDefault, reconcileNumericEnum } from '@shared/contracts/media';
import { coerceParameterValues, defaultParameterValues, normalizeParameters, validateParameterValues } from '@shared/lib/parameters';
import { FIXTURE_MODELS } from './fakes';
import { liveParameters } from './live-models';

const schemaOf = (id: string) => {
  const params = normalizeParameters(FIXTURE_MODELS[id]?.parameters);
  return prepareMediaSchema(params);
};

describe('parameter flow with recorded GMI schemas', () => {
  it('uses the prompt parameter as the main text and keeps the rest as fields (wan3.0-video)', () => {
    const s = schemaOf('wan3.0-video');
    expect(s.promptName).toBe('prompt');
    expect(s.promptParam).toMatchObject({ name: 'prompt', required: true, max: 5000 });
    expect(s.fields.map((f) => f.name)).toEqual([
      'negative_prompt',
      'first_frame',
      'last_frame',
      'reference_image',
      'reference_video',
      'audio_url',
      'resolution',
      'ratio',
      'duration',
      'prompt_extend',
      'watermark',
      'seed',
    ]);
    expect(s.fields.find((f) => f.name === 'first_frame')).toMatchObject({ type: 'image', rawType: 'first_frame_image' });
    expect(s.fields.find((f) => f.name === 'reference_video')).toMatchObject({ type: 'video', max: 5 });
  });

  it('falls back to the first required text field when the model has no prompt (text-to-speech)', () => {
    const s = schemaOf('minimax-tts-speech-2.8-hd');
    expect(s.promptName).toBe('text');
    expect(s.promptParam?.label).toBe('Text');
    expect(s.fields.some((f) => f.name === 'text')).toBe(false);
  });

  it('keeps prompt as the main text for music while lyrics stays a required field', () => {
    const s = schemaOf('minimax-music-3.0');
    expect(s.promptName).toBe('prompt');
    expect(s.fields.find((f) => f.name === 'lyrics')).toMatchObject({ required: true, type: 'string' });
  });

  it('handles workflows without a published schema', () => {
    const s = prepareMediaSchema(normalizeParameters(FIXTURE_MODELS['80ce8515-e387-4050-883c-7a34e127fba8']?.parameters));
    expect(s).toMatchObject({ promptName: 'prompt', promptParam: null, fields: [], all: [] });
  });

  it('reconciles numeric enums published as strings so the model default validates', () => {
    const raw = normalizeParameters(FIXTURE_MODELS['hy-image-v3.5-preview']?.parameters)!;
    const pixels = raw.find((p) => p.name === 'generate_max_pixels')!;
    // As published, GMI's own default fails a text comparison.
    expect(validateParameterValues([pixels], { generate_max_pixels: pixels.default })).toHaveLength(1);

    const fixed = reconcileNumericEnum(pixels);
    expect(fixed.enum).toEqual([1048576, 2359296, 4194304]);
    expect(validateParameterValues([fixed], { generate_max_pixels: 4194304 })).toEqual([]);
    expect(coerceParameterValues([fixed], { generate_max_pixels: '2359296' })).toEqual({ generate_max_pixels: 2359296 });

    const music = prepareMediaSchema(normalizeParameters(FIXTURE_MODELS['minimax-music-3.0']?.parameters));
    expect(music.all.find((p) => p.name === 'sample_rate')?.enum).toEqual([16000, 24000, 32000, 44100]);
    // String enums with string defaults are left alone (Kling's duration is "5", not 5).
    const kling = prepareMediaSchema(normalizeParameters(FIXTURE_MODELS['kling-3.0-turbo-t2v']?.parameters));
    expect(kling.all.find((p) => p.name === 'duration')?.enum?.[0]).toBe('3');
  });

  it("adds a default GMI left out of its own enum, so the model's default validates on both sides (seedream-5.0-lite)", () => {
    const raw = liveParameters('seedream-5.0-lite')!;
    const size = raw.find((p) => p.name === 'size')!;
    // As published: default 2048x2048, not among the options.
    expect(validateParameterValues([size], { size: '2048x2048' })).toHaveLength(1);

    const fixed = reconcileEnumDefault(size);
    expect(fixed.enum?.[0]).toBe('2048x2048');
    expect(fixed.enum).toHaveLength((size.enum?.length ?? 0) + 1);
    expect(validateParameterValues([fixed], { size: '2048x2048' })).toEqual([]);
    const s = prepareMediaSchema(raw);
    expect(validateParameterValues(s.all, defaultParameterValues(s.fields, [s.promptName]), ['prompt'])).toEqual([]);

    // Already listed, empty, or not a scalar: unchanged.
    const listed = { ...size, default: '2K' };
    expect(reconcileEnumDefault(listed)).toBe(listed);
    const empty = { ...size, default: '' };
    expect(reconcileEnumDefault(empty)).toBe(empty);
    const flag = { ...size, default: true };
    expect(reconcileEnumDefault(flag)).toBe(flag);
    const numeric = reconcileEnumDefault({ ...size, enum: [16000, 24000], default: 44100 });
    expect(numeric.enum).toEqual([44100, 16000, 24000]);
  });

  it('collects defaults, validates edits and coerces form strings (seedream-5.0-pro)', () => {
    const s = schemaOf('seedream-5.0-pro');
    const defaults = defaultParameterValues(s.fields, [s.promptName]);
    expect(defaults).toEqual({ size: '2048x2048', sequential_image_generation: 'disabled', max_images: 1, output_format: 'jpeg', watermark: false });
    expect(validateParameterValues(s.all, defaults, ['prompt'])).toEqual([]);

    const edited = { ...defaults, size: '4K', max_images: '20', image: ['https://example.com/a.png', 'http://insecure.example/b.png'] };
    const issues = validateParameterValues(s.all, edited, ['prompt']);
    expect(issues.map((i) => i.name).sort()).toEqual(['image', 'max_images', 'size']);

    const good = { ...defaults, size: '3K', max_images: '3', image: ['https://example.com/a.png'] };
    expect(validateParameterValues(s.all, good, ['prompt'])).toEqual([]);
    expect(coerceParameterValues(s.all, good, ['prompt'])).toMatchObject({ size: '3K', max_images: 3, image: ['https://example.com/a.png'] });
  });

  it('enforces required media inputs and case-sensitive enums (happyhorse / wan)', () => {
    const hh = schemaOf('happyhorse-1.1-i2v');
    expect(validateParameterValues(hh.all, {}, ['prompt']).map((i) => i.message)).toEqual(['First frame is required.']);
    const wan = schemaOf('wan3.0-video');
    const issues = validateParameterValues(wan.all, { resolution: '720p' }, ['prompt']);
    expect(issues[0]?.message).toContain('480P, 720P, 1080P');
  });
});
