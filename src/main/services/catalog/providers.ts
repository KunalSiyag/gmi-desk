/**
 * Provider names. GMI reports the provider three ways: as the id prefix ("deepseek-ai/…"),
 * as a routing key ("vertex", "byteplus-seedream", "minimax-audio") or as "GMI Cloud" (the host,
 * useless for display). This maps all of them to the brand users know.
 */
import type { ModelKind } from '@shared/contracts/catalog';

/** Id prefix (before "/") → provider. Keys are lower-case. */
const BY_PREFIX: Record<string, string> = {
  'deepseek-ai': 'DeepSeek',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot AI',
  'zai-org': 'Z.ai',
  qwen: 'Qwen',
  minimaxai: 'MiniMax',
  openai: 'OpenAI',
  google: 'Google',
  'x-ai': 'xAI',
  xai: 'xAI',
  anthropic: 'Anthropic',
  'meta-llama': 'Meta',
  nvidia: 'NVIDIA',
  bytedance: 'ByteDance',
  xiaomimimo: 'Xiaomi',
  mistralai: 'Mistral',
  tencent: 'Tencent',
  'stepfun-ai': 'StepFun',
  inclusionai: 'inclusionAI',
  kwaipilot: 'Kwaipilot',
  thinkingmachines: 'Thinking Machines',
  gmi: 'GMI Cloud',
};

/** Provider field values (routing keys and brand spellings) → provider. Keys are lower-case. */
const ALIASES: Record<string, string> = {
  vertex: 'Google',
  'vertex-interactions': 'Google',
  'vertex-batch': 'Google',
  veo3: 'Google',
  google: 'Google',
  gemini: 'Google',
  'gpt-image': 'OpenAI',
  openai: 'OpenAI',
  aliyun: 'Alibaba',
  'aliyun-wan-image': 'Alibaba',
  alibaba: 'Alibaba',
  byteplus: 'ByteDance',
  'byteplus-seedream': 'ByteDance',
  'byteplus-seededit': 'ByteDance',
  bytedance: 'ByteDance',
  kling: 'Kling',
  minimax: 'MiniMax',
  'minimax-audio': 'MiniMax',
  bria: 'Bria',
  luma: 'Luma',
  'luma-uni': 'Luma',
  pixverse: 'PixVerse',
  vidu: 'Vidu',
  inworld: 'Inworld',
  resemble: 'Resemble AI',
  hunyuan: 'Tencent',
  tencent: 'Tencent',
  skyreels: 'SkyReels',
  reve: 'Reve',
  'reve ai': 'Reve',
  'bfl-flux': 'Black Forest Labs',
  bfl: 'Black Forest Labs',
  heygen: 'HeyGen',
  'gmi-workflow': 'GMI Studio',
  ltx: 'Lightricks',
  elevenlabs: 'ElevenLabs',
  zhipu: 'Z.ai',
  zai: 'Z.ai',
  'z.ai': 'Z.ai',
  'moonshot ai': 'Moonshot AI',
  moonshot: 'Moonshot AI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  anthropic: 'Anthropic',
  nvidia: 'NVIDIA',
  meta: 'Meta',
  xai: 'xAI',
  'x-ai': 'xAI',
  stepfun: 'StepFun',
  xiaomi: 'Xiaomi',
};

/** Hints that say nothing about the model's maker. */
const IGNORED_HINTS = new Set(['gmi cloud', 'gmi', 'custom', 'system', 'unknown', 'n/a']);

/** Prefix-less ids ("seedance-2-0-260128", "Flux2-Klein") → provider. */
const BY_ID_PATTERN: Array<[RegExp, string]> = [
  [/^(gemini|veo|imagen|nano-banana)/i, 'Google'],
  [/^(gpt-image|sora|dall-?e)/i, 'OpenAI'],
  [/^qwen/i, 'Qwen'],
  [/^(wan[\d.-]|wan-ai|sfwan|happyhorse|z-image)/i, 'Alibaba'],
  [/^glm/i, 'Z.ai'],
  [/^flux/i, 'Black Forest Labs'],
  [/^ltx/i, 'Lightricks'],
  [/^(hunyuan|hy-|hy\d)/i, 'Tencent'],
  [/^krea/i, 'Krea'],
  [/^step-/i, 'StepFun'],
  [/^gmi-/i, 'GMI Cloud'],
  [/^kling/i, 'Kling'],
  [/^(seedance|seedream|seededit|seed-)/i, 'ByteDance'],
  [/^(minimax|hailuo)/i, 'MiniMax'],
  [/^pixverse/i, 'PixVerse'],
  [/^vidu/i, 'Vidu'],
  [/^bria/i, 'Bria'],
  [/^luma/i, 'Luma'],
  [/^inworld/i, 'Inworld'],
  [/^chatterbox/i, 'Resemble AI'],
  [/^heygen/i, 'HeyGen'],
  [/^reve/i, 'Reve'],
  [/^skyreels/i, 'SkyReels'],
  [/^elevenlabs/i, 'ElevenLabs'],
];

/** Words a provider's logo file name contains ("…/shared_icons/kimi.webp" is Moonshot AI). */
const ICON_WORDS: Record<string, string[]> = {
  DeepSeek: ['deepseek'],
  'Moonshot AI': ['kimi', 'moonshot'],
  'Z.ai': ['zai', 'z-ai', 'glm', 'zhipu'],
  Qwen: ['qwen'],
  MiniMax: ['minimax'],
  OpenAI: ['openai', 'gpt'],
  Google: ['google', 'gemini', 'gemma'],
  xAI: ['xai', 'grok'],
  Anthropic: ['anthropic', 'claude'],
  Meta: ['meta', 'llama'],
  NVIDIA: ['nvidia', 'nemotron'],
  Tencent: ['tencent', 'hunyuan'],
  Xiaomi: ['xiaomi', 'mimo'],
  StepFun: ['stepfun', 'step'],
};

function iconFileName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The provider a logo URL belongs to, judging by its file name ("kimi.webp" → Moonshot AI). */
export function providerForIcon(url: string): string | null {
  const file = iconFileName(url);
  if (!file) return null;
  for (const [provider, words] of Object.entries(ICON_WORDS)) if (words.some((w) => file.includes(w))) return provider;
  return null;
}

/**
 * GMI's featured feed reuses logos across models (GLM-5.3 carries the Kimi logo). For providers we know,
 * keep an icon only when its file name mentions the provider; unknown providers keep theirs.
 */
export function iconMatchesProvider(url: string, provider: string | null): boolean {
  const words = provider ? ICON_WORDS[provider] : undefined;
  if (!words) return true;
  const file = iconFileName(url);
  return file !== null && words.some((w) => file.includes(w));
}

/**
 * Display provider for a model. The id prefix wins ("deepseek-ai/…" is DeepSeek whatever the
 * feed says), then known provider hints, then id patterns, then the raw hint.
 */
export function prettyProvider(id: string, hints: Array<string | null | undefined>, kind?: ModelKind | null): string | null {
  const slash = id.indexOf('/');
  if (slash > 0) {
    const prefix = id.slice(0, slash).toLowerCase();
    const known = BY_PREFIX[prefix];
    if (known) return known;
  }
  const usable = hints
    .map((h) => (typeof h === 'string' ? h.trim() : ''))
    .filter((h) => h && !IGNORED_HINTS.has(h.toLowerCase()));
  for (const h of usable) {
    const alias = ALIASES[h.toLowerCase()];
    if (alias) return alias;
  }
  const tail = slash > 0 ? id.slice(slash + 1) : id;
  for (const [pattern, name] of BY_ID_PATTERN) if (pattern.test(tail)) return name;
  if (kind === 'workflow') return 'GMI Studio';
  const raw = usable[0];
  if (raw) return raw.length <= 2 ? raw.toUpperCase() : raw.charAt(0).toUpperCase() + raw.slice(1);
  if (slash > 0) return id.slice(0, slash);
  return null;
}
