import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { ModelParameter } from '@shared/contracts/catalog';
import { cn } from '@renderer/lib/cn';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Select, type SelectOption } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { isLongText, isMediaParam, isWideField } from './form';
import { MediaInput } from './MediaInput';

export function fieldId(name: string): string {
  return `create-param-${name.replace(/[^\w-]/g, '_')}`;
}

function rangeLabel(p: ModelParameter): string | null {
  if (p.type !== 'integer' && p.type !== 'number') return null;
  if (p.min !== null && p.max !== null) return `${p.min}–${p.max}`;
  if (p.min !== null) return `≥ ${p.min}`;
  if (p.max !== null) return `≤ ${p.max}`;
  return null;
}

export function FieldLabel({ htmlFor, param, aside }: { htmlFor: string; param: Pick<ModelParameter, 'label' | 'required' | 'description'>; aside?: ReactNode }) {
  return (
    <div className="flex h-4 min-w-0 items-center gap-1">
      <label htmlFor={htmlFor} className="truncate text-xs font-medium text-foreground">
        {param.label}
      </label>
      {param.required ? (
        <span className="text-xs text-destructive" aria-label="required">
          *
        </span>
      ) : null}
      {param.description ? (
        <Tooltip label={<span className="block max-h-60 overflow-hidden whitespace-pre-line">{param.description}</span>}>
          <button type="button" aria-label={`About ${param.label}`} className="rounded text-muted-foreground/60 hover:text-foreground">
            <Info className="size-3" />
          </button>
        </Tooltip>
      ) : null}
      {aside ? <span className="ml-auto shrink-0 pl-2 text-3xs tabular-nums text-muted-foreground">{aside}</span> : null}
    </div>
  );
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

const invalidRing = 'border-destructive/60 focus-visible:border-destructive focus-visible:ring-destructive/20';

/** One generated form control for a model parameter (label, control, inline message). */
export function ParamField({
  param,
  value,
  onChange,
  issue,
  className,
}: {
  param: ModelParameter;
  value: unknown;
  onChange: (value: unknown) => void;
  issue?: string | null;
  className?: string;
}) {
  const id = fieldId(param.name);
  const invalid = Boolean(issue);
  const wide = isWideField(param);
  let control: ReactNode;

  if (isMediaParam(param)) {
    return (
      <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'col-span-2', className)}>
        <FieldLabel htmlFor={id} param={param} />
        <MediaInput id={id} param={param} value={value} onChange={onChange} issue={issue} />
      </div>
    );
  }

  switch (param.type) {
    case 'enum': {
      const options = param.enum ?? [];
      const current = value === undefined || value === null ? '' : String(value);
      const known = options.some((o) => String(o) === current);
      const items: SelectOption[] = [
        // The empty choice: "Model default" for optional parameters; "Choose…" until a required one is set.
        ...(!param.required || current === '' ? [{ value: '', label: param.required ? 'Choose…' : 'Model default' }] : []),
        ...(!known && current !== '' ? [{ value: current, label: current }] : []),
        ...options.map((o) => ({ value: String(o), label: param.enumLabels?.[String(o)] ?? String(o) })),
      ];
      control = (
        <Select
          id={id}
          value={current}
          onValueChange={(v) => onChange(v === '' ? undefined : v)}
          options={items}
          aria-invalid={invalid}
          className={cn('text-xs', invalid && invalidRing)}
        />
      );
      break;
    }
    case 'integer':
    case 'number':
      control = (
        <Input
          id={id}
          type="number"
          inputMode={param.type === 'integer' ? 'numeric' : 'decimal'}
          value={textValue(value)}
          min={param.min ?? undefined}
          max={param.max ?? undefined}
          step={param.step ?? (param.type === 'integer' ? 1 : 'any')}
          placeholder={param.default !== null && param.default !== undefined ? String(param.default) : 'Model default'}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          aria-invalid={invalid || undefined}
          className={cn('text-xs tabular-nums', invalid && invalidRing)}
        />
      );
      break;
    case 'boolean': {
      const on = value === true;
      // Not a wrapping <label>: Base UI's switch forwards clicks to a hidden input, and a wrapping label would
      // forward the same click again (double toggle).
      control = (
        <div className="flex h-8 items-center gap-2 rounded-md border border-input px-2.5 text-xs text-muted-foreground dark:bg-white/[0.02]">
          <Switch id={id} checked={on} onCheckedChange={(next) => onChange(next)} aria-label={param.label} />
          <label htmlFor={id} className={cn('min-w-0 flex-1 truncate', on && 'text-foreground')}>
            {value === undefined ? 'Model default' : on ? 'On' : 'Off'}
          </label>
        </div>
      );
      break;
    }
    case 'object':
    case 'array':
      control = (
        <Textarea
          id={id}
          value={textValue(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          placeholder={param.type === 'array' ? '["…"]' : '{ "key": "value" }'}
          spellCheck={false}
          rows={3}
          aria-invalid={invalid || undefined}
          className={cn('min-h-0 font-mono text-xs', invalid && invalidRing)}
        />
      );
      break;
    default:
      control = isLongText(param) ? (
        <Textarea
          id={id}
          value={textValue(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          rows={3}
          aria-invalid={invalid || undefined}
          className={cn('min-h-0 text-xs', invalid && invalidRing)}
        />
      ) : (
        <Input
          id={id}
          value={textValue(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          placeholder={typeof param.default === 'string' && param.default ? param.default : undefined}
          aria-invalid={invalid || undefined}
          className={cn('text-xs', invalid && invalidRing)}
        />
      );
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'col-span-2', className)}>
      <FieldLabel htmlFor={id} param={param} aside={rangeLabel(param)} />
      {control}
      {issue ? <p className="text-2xs leading-tight text-destructive">{issue}</p> : null}
    </div>
  );
}
