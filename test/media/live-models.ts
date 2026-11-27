/**
 * get_model results recorded from GMI's MCP server on 2026-11-01 (read-only tool; nothing charged), trimmed to the
 * fields the media slice reads. Used by regression tests for schemas the recorded fixtures do not cover.
 */
import { GmiError } from '@shared/contracts/errors';
import { normalizeParameters } from '@shared/lib/parameters';
import { FIXTURE_MODELS } from './fakes';

export const LIVE_MODELS = {
  'seedream-5.0-lite': {
    model_id: 'seedream-5.0-lite',
    display_name: 'seedream-5.0-lite',
    available: true,
    multimodal: {
      model_type: 'image',
      input: [
        { required: true, type: 'text' },
        { required: false, type: 'image' },
      ],
      output: [{ required: true, type: 'image' }],
      pricing: { price: 35000, pricing_type: 'per image', unit: 'image' },
    },
    parameters: [
      { default: '', description: 'Text prompt for image generation (recommended < 600 words).', name: 'prompt', required: true, type: 'string' },
      { description: 'Reference image URL or an array of URLs (jpeg/png). Up to 14 images are supported.', max: 14, name: 'image', required: false, type: 'image' },
      {
        default: '2048x2048',
        description: "Method 1: '2K', '3K'. Method 2: 'WxH' (Total pixels: 3.6M to 10.4M; Aspect Ratio: 1/16 to 16).",
        enum: ['2K', '3K', '2304x4096', '2496x3744', '2592x3456', '3072x3072', '3456x2592', '3744x2496', '4096x2304', '4704x2016', '3072x3072'],
        name: 'size',
        required: false,
        type: 'enum',
      },
      { default: 'disabled', description: 'Generate a sequence of related images automatically.', enum: ['disabled', 'auto'], name: 'sequential_image_generation', required: false, type: 'enum' },
      { default: 1, description: 'Total(reference+generated) ≤ 15.', max: 15, min: 1, name: 'max_images', required: false, type: 'integer' },
      { default: 'jpeg', description: 'Specifies the file format of the generated image.', enum: ['jpeg', 'png'], name: 'output_format', required: false, type: 'enum' },
      { default: false, description: 'Whether to include an watermark saying AI Generated in the bottom right corner.', name: 'watermark', required: false, type: 'boolean' },
    ],
  },
  'heygen-avatar-4': {
    model_id: 'heygen-avatar-4',
    display_name: 'heygen-avatar-4',
    available: true,
    multimodal: {
      model_type: 'video',
      input: [{ required: true, type: 'text' }],
      output: [{ required: true, type: 'video' }],
      pricing: { price: 66700, pricing_type: 'video length based pricing', unit: 'second' },
    },
    parameters: [
      { default: '', description: 'HeyGen built-in avatar ID. Required if not using talking_photo_id.', name: 'avatar_id', required: false, type: 'string' },
      { default: '', description: 'Uploaded photo ID for talking photo mode. Required if not using avatar_id.', name: 'talking_photo_id', required: false, type: 'string' },
      { default: 'normal', description: 'Avatar layout style.', enum: ['normal', 'circle', 'closeUp'], name: 'avatar_style', required: false, type: 'enum' },
      { default: '', description: 'Text for the avatar to speak (max 5000 characters).', name: 'input_text', required: true, type: 'string' },
      { default: '', description: 'Voice ID from HeyGen voice library.', name: 'voice_id', required: true, type: 'string' },
      { default: 1, description: 'Speaking speed. Range: 0.5–1.5.', max: 1.5, min: 0.5, name: 'speed', required: false, type: 'float' },
      { default: 30, description: 'Estimated video length for price calculation.', max: 300, min: 1, name: 'duration', required: false, type: 'integer' },
    ],
  },
  'Gemini-batch-inference': {
    model_id: 'Gemini-batch-inference',
    display_name: 'Gemini-batch-inference',
    available: true,
    multimodal: {
      model_type: 'image',
      input: [{ required: true, type: 'text' }],
      output: [{ required: true, type: 'text' }],
      pricing: { price: 0, pricing_type: 'per-request', unit: 'request' },
    },
    parameters: [
      {
        default: 'gemini-3-flash-preview',
        description: 'The Vertex AI Gemini 3 model to use for batch prediction.',
        enum: ['gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-3-pro-image-preview'],
        name: 'model',
        required: true,
        type: 'enum',
      },
      {
        default: '',
        description: 'JSONL formatted input data. Each line should be a JSON object: {"request": {"contents": [...]}}. Can be raw JSONL string or base64 encoded.',
        name: 'input_data',
        required: true,
        type: 'string',
      },
    ],
  },
  'wan2.7-image': {
    model_id: 'wan2.7-image',
    display_name: 'wan2.7-image',
    available: true,
    multimodal: {
      model_type: 'image',
      input: [
        { required: true, type: 'text' },
        { required: false, type: 'image' },
      ],
      output: [{ required: true, type: 'image' }],
      pricing: { price: 30000, pricing_type: 'per image', unit: 'image' },
    },
    parameters: [
      {
        default: '',
        description:
          'The user-entered prompt. Supports Chinese and English. The length cannot exceed 5,000 characters. Each Chinese character, letter, number, or symbol counts as one character. Any excess is automatically truncated.',
        name: 'text',
        required: true,
        type: 'string',
      },
      { description: 'Image resolution: The width and height must both be in the range of [240, 8000] pixels.', max: 9, name: 'image', required: false, type: 'image' },
      { default: '2K', description: 'Output resolution.', enum: ['1K', '2K'], name: 'size', required: false, type: 'enum' },
      { default: 1, description: 'How many images to output. Default is 1, up to 4 allowed', max: 4, name: 'n', required: false, type: 'integer' },
    ],
  },
  'gpt-image-2-generate': {
    model_id: 'gpt-image-2-generate',
    display_name: 'gpt-image-2-generate',
    available: true,
    multimodal: {
      model_type: 'image',
      input: [{ required: true, type: 'text' }],
      output: [{ required: true, type: 'image' }],
      pricing: { price: 60000, pricing_type: 'per-image pricing', unit: 'image' },
    },
    parameters: [
      { default: '', description: 'Text description of the image to generate.', name: 'prompt', required: true, type: 'string' },
      { default: '1024x1024', description: 'Output resolution and aspect ratio.', name: 'size', required: false, type: 'string' },
      { default: 'medium', description: 'Image quality level — affects detail and cost.', enum: ['low', 'medium', 'high', 'auto'], name: 'quality', required: false, type: 'enum' },
      { default: 1, description: 'Number of images to generate (1–10).', max: 10, min: 1, name: 'n', required: false, type: 'integer' },
      { default: 'png', description: 'File format of the generated image.', enum: ['png', 'jpeg'], name: 'output_format', required: false, type: 'enum' },
    ],
  },
  'kling-lip-sync': {
    model_id: 'kling-lip-sync',
    display_name: 'kling-lip-sync',
    available: true,
    multimodal: {
      model_type: 'video',
      input: [{ required: false, type: 'text' }],
      output: [{ required: true, type: 'video' }],
      pricing: { price: 70000, pricing_type: 'per request', unit: 'request' },
    },
    parameters: [
      {
        default: '',
        description:
          'Session ID returned by a prior kling-identify-face request (found in outcome.data.session_id of that request). Identifies the analyzed source video and its detected faces.',
        name: 'session_id',
        required: true,
        type: 'string',
      },
      { description: 'Array describing which detected face(s) to lip-sync and the audio to drive each one.', name: 'face_choose', required: true, type: 'json' },
    ],
  },
} as const satisfies Record<string, { model_id: string; parameters: readonly unknown[]; [field: string]: unknown }>;

export type LiveModelId = keyof typeof LIVE_MODELS;

/** get_model handler serving these live schemas, then the recorded fixtures; unknown ids answer not_found. */
export function liveGetModel() {
  return (args: Record<string, unknown>): unknown => {
    const id = String(args.model_id);
    const model = (LIVE_MODELS as Record<string, unknown>)[id] ?? FIXTURE_MODELS[id];
    if (!model) throw new GmiError('not_found', `unknown model ${id}`);
    return model;
  };
}

/** The live parameter list of a model, normalised the way the app reads it. */
export function liveParameters(id: LiveModelId) {
  return normalizeParameters(LIVE_MODELS[id].parameters);
}
