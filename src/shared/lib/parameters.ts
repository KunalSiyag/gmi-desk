import type { ModelParameter, ParameterType } from '../contracts/catalog';

/**
 * GMI publishes generation parameters in two shapes:
 *  - MCP get_model:        { name, description, type, required, default, enum: [...], min, max }
 *  - public queue catalog: { name, display_name, description, type, required, default_value, order,
 *                            options: [{ value, display_name }], min_value, max_value, step }
 * Types seen: string text integer float number boolean enum image first_frame_image last_frame_image
 * video audio json object array.
 */

const TYPE_MAP: Record<string, ParameterType> = {
  string: 'string',
  text: 'text',
  integer: 'integer',
  int: 'integer',
  float: 'number',
  number: 'number',
  boolean: 'boolean',
  bool: 'boolean',
  enum: 'enum',
  image: 'image',
  first_frame_image: 'image',
  last_frame_image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  json: 'object',
  object: 'object',
  array: 'array',
};

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function prettyLabel(name: string): string {
  const base = name.replace(/\.\d+$/, '').replace(/[_-]+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Normalises either schema shape; returns null when the input is not a parameter list. */
export function normalizeParameters(raw: unknown): ModelParameter[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ModelParameter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const name = str(p.name);
    if (!name) continue;
    const rawType = str(p.type);
    let type: ParameterType = rawType ? (TYPE_MAP[rawType.toLowerCase()] ?? 'unknown') : 'unknown';

    let enumValues: Array<string | number> | null = null;
    let enumLabels: Record<string, string> | null = null;
    if (Array.isArray(p.enum)) {
      enumValues = p.enum.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
    } else if (Array.isArray(p.options)) {
      enumValues = [];
      enumLabels = {};
      for (const opt of p.options) {
        if (opt && typeof opt === 'object') {
          const o = opt as Record<string, unknown>;
          const value = o.value;
          if (typeof value === 'string' || typeof value === 'number') {
            enumValues.push(value);
            const label = str(o.display_name) ?? str(o.label);
            if (label) enumLabels[String(value)] = label;
          }
        } else if (typeof opt === 'string' || typeof opt === 'number') {
          enumValues.push(opt);
        }
      }
      if (Object.keys(enumLabels).length === 0) enumLabels = null;
    }
    if (enumValues) {
      // Duplicates appear in GMI's own schemas (e.g. "3072x3072" twice).
      enumValues = [...new Map(enumValues.map((v) => [String(v), v])).values()];
      if (enumValues.length === 0) enumValues = null;
      else if (type === 'unknown' || type === 'string') type = 'enum';
    }

    const def = 'default_value' in p ? p.default_value : p.default;
    out.push({
      name,
      label: str(p.display_name) ?? str(p.label) ?? prettyLabel(name),
      description: str(p.description),
      type,
      rawType,
      required: p.required === true,
      default: def === '' ? null : (def ?? null),
      enum: enumValues,
      enumLabels,
      min: num(p.min_value ?? p.min),
      max: num(p.max_value ?? p.max),
      step: num(p.step),
      order: num(p.order),
    });
  }
  return out.sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6));
}

export const MEDIA_INPUT_TYPES: readonly ParameterType[] = ['image', 'video', 'audio', 'file'];

/** Initial form values from the schema defaults (skips empty defaults). */
export function defaultParameterValues(params: ModelParameter[], skip: readonly string[] = ['prompt']): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const p of params) {
    if (skip.includes(p.name)) continue;
    if (p.default !== null && p.default !== undefined) values[p.name] = p.default;
  }
  return values;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ParameterIssue {
  name: string;
  message: string;
}

/**
 * Client-side validation. GMI's estimate endpoint does NOT validate parameters (a bad enum value is
 * accepted, priced, and the job fails later), so the app must check before estimating/submitting.
 */
export function validateParameterValues(
  params: ModelParameter[],
  values: Record<string, unknown>,
  skip: readonly string[] = ['prompt'],
): ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  for (const p of params) {
    if (skip.includes(p.name)) continue;
    const v = values[p.name];
    if (isEmpty(v)) {
      if (p.required) issues.push({ name: p.name, message: `${p.label} is required.` });
      continue;
    }
    switch (p.type) {
      case 'enum':
        if (p.enum && !p.enum.some((e) => String(e) === String(v))) issues.push({ name: p.name, message: `${p.label} must be one of: ${p.enum.join(', ')}.` });
        break;
      case 'integer': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isInteger(n)) issues.push({ name: p.name, message: `${p.label} must be a whole number.` });
        else if ((p.min !== null && n < p.min) || (p.max !== null && n > p.max)) issues.push({ name: p.name, message: `${p.label} must be between ${p.min ?? '−∞'} and ${p.max ?? '∞'}.` });
        break;
      }
      case 'number': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) issues.push({ name: p.name, message: `${p.label} must be a number.` });
        else if ((p.min !== null && n < p.min) || (p.max !== null && n > p.max)) issues.push({ name: p.name, message: `${p.label} must be between ${p.min ?? '−∞'} and ${p.max ?? '∞'}.` });
        break;
      }
      case 'boolean':
        if (typeof v !== 'boolean') issues.push({ name: p.name, message: `${p.label} must be on or off.` });
        break;
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        const list = Array.isArray(v) ? v : [v];
        if (!list.every(isHttpsUrl)) issues.push({ name: p.name, message: `${p.label} must be an https URL (upload a file to get one).` });
        else if (p.max !== null && list.length > p.max) issues.push({ name: p.name, message: `${p.label} accepts at most ${p.max}.` });
        break;
      }
      case 'object':
        if (typeof v === 'string') {
          try {
            JSON.parse(v);
          } catch {
            issues.push({ name: p.name, message: `${p.label} must be valid JSON.` });
          }
        } else if (typeof v !== 'object') issues.push({ name: p.name, message: `${p.label} must be an object.` });
        break;
      case 'array':
        if (!Array.isArray(v)) issues.push({ name: p.name, message: `${p.label} must be a list.` });
        break;
      default:
        break;
    }
  }
  return issues;
}

/** Converts form values to what GMI expects (numbers from strings, JSON strings parsed, empties dropped). */
export function coerceParameterValues(params: ModelParameter[], values: Record<string, unknown>, skip: readonly string[] = ['prompt']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const byName = new Map(params.map((p) => [p.name, p]));
  for (const [name, v] of Object.entries(values)) {
    if (skip.includes(name) || isEmpty(v)) continue;
    const p = byName.get(name);
    if (!p) {
      out[name] = v;
      continue;
    }
    if ((p.type === 'integer' || p.type === 'number') && typeof v === 'string') out[name] = Number(v);
    else if (p.type === 'enum' && p.enum) out[name] = p.enum.find((e) => String(e) === String(v)) ?? v;
    else if (p.type === 'object' && typeof v === 'string') {
      try {
        out[name] = JSON.parse(v);
      } catch {
        out[name] = v;
      }
    } else out[name] = v;
  }
  return out;
}
