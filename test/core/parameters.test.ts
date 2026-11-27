import { describe, expect, it } from 'vitest';
import { coerceParameterValues, defaultParameterValues, normalizeParameters, validateParameterValues } from '@shared/lib/parameters';

const MCP_SHAPE = [
  { default: '', description: 'Text prompt', name: 'prompt', required: true, type: 'string' },
  { description: 'Reference image URLs', max: 14, name: 'image', required: false, type: 'image' },
  { default: '2048x2048', enum: ['2K', '3K', '3072x3072', '3072x3072'], name: 'size', required: false, type: 'enum' },
  { default: 1, max: 15, min: 1, name: 'max_images', required: false, type: 'integer' },
  { default: false, name: 'watermark', required: false, type: 'boolean' },
];

const PUBLIC_SHAPE = [
  { name: 'image_size', display_name: 'Output Resolution', type: 'enum', required: false, default_value: '1K', options: [{ value: '1K', display_name: '1K (≈1024px)' }, { value: '2K', display_name: '2K' }], order: 3 },
  { name: 'speed', display_name: 'Speaking Speed', type: 'float', required: false, default_value: 1, min_value: 0.5, max_value: 1.5, step: 0.1, order: 6 },
  { name: 'first_frame', display_name: 'First Frame Image', type: 'first_frame_image', required: true, default_value: null, order: 2 },
  { name: 'synthesis_context', display_name: 'Conversation Context', type: 'json', required: false, default_value: null, order: 14 },
];

describe('normalizeParameters', () => {
  it('normalises the MCP get_model shape', () => {
    const p = normalizeParameters(MCP_SHAPE)!;
    expect(p.map((x) => [x.name, x.type])).toEqual([
      ['prompt', 'string'],
      ['image', 'image'],
      ['size', 'enum'],
      ['max_images', 'integer'],
      ['watermark', 'boolean'],
    ]);
    expect(p[0]!.default).toBeNull();
    expect(p[2]!.enum).toEqual(['2K', '3K', '3072x3072']);
    expect(p[3]).toMatchObject({ min: 1, max: 15, default: 1, label: 'Max images' });
  });

  it('normalises the public catalog shape and sorts by order', () => {
    const p = normalizeParameters(PUBLIC_SHAPE)!;
    expect(p.map((x) => x.name)).toEqual(['first_frame', 'image_size', 'speed', 'synthesis_context']);
    expect(p[0]).toMatchObject({ type: 'image', rawType: 'first_frame_image', required: true, label: 'First Frame Image' });
    expect(p[1]).toMatchObject({ type: 'enum', enum: ['1K', '2K'], enumLabels: { '1K': '1K (≈1024px)', '2K': '2K' } });
    expect(p[2]).toMatchObject({ type: 'number', min: 0.5, max: 1.5, step: 0.1 });
    expect(p[3]!.type).toBe('object');
  });

  it('returns null for non-lists', () => {
    expect(normalizeParameters(null)).toBeNull();
    expect(normalizeParameters({})).toBeNull();
  });
});

describe('validate / defaults / coerce', () => {
  const params = normalizeParameters([...MCP_SHAPE, ...PUBLIC_SHAPE])!;

  it('collects defaults except the prompt', () => {
    expect(defaultParameterValues(params)).toEqual({ size: '2048x2048', max_images: 1, watermark: false, image_size: '1K', speed: 1 });
  });

  it('flags bad enum values, ranges, urls and missing required inputs', () => {
    const issues = validateParameterValues(params, { size: '720p', max_images: 20, image: ['http://insecure.test/a.png'], speed: 'fast', synthesis_context: '{bad' });
    const names = issues.map((i) => i.name).sort();
    expect(names).toEqual(['first_frame', 'image', 'max_images', 'size', 'speed', 'synthesis_context']);
  });

  it('accepts valid values and coerces strings', () => {
    const values = { size: '3K', max_images: '2', first_frame: 'https://x.test/f.png', speed: '1.2', synthesis_context: '{"a":1}', watermark: true };
    expect(validateParameterValues(params, values)).toEqual([]);
    expect(coerceParameterValues(params, values)).toEqual({ size: '3K', max_images: 2, first_frame: 'https://x.test/f.png', speed: 1.2, synthesis_context: { a: 1 }, watermark: true });
  });
});
