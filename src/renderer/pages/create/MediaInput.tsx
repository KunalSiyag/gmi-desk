import { useEffect, useRef, useState } from 'react';
import { AudioLines, Film, ImageIcon, Link2, Upload, X } from 'lucide-react';
import type { ModelParameter } from '@shared/contracts/catalog';
import { MEDIA_UPLOAD_TYPES } from '@shared/contracts/media';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Spinner } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { acceptsMany } from './form';

type UploadKind = keyof typeof MEDIA_UPLOAD_TYPES;

/** Local previews of uploaded images, by public URL (the form value only keeps the public URL). */
const localPreviews = new Map<string, string>();

function uploadKind(p: ModelParameter): UploadKind | null {
  return p.type === 'image' || p.type === 'video' || p.type === 'audio' ? p.type : null;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return typeof value === 'string' && value ? [value] : [];
}

function fileLabel(url: string): string {
  try {
    const tail = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return tail || url;
  } catch {
    return url;
  }
}

const KIND_ICON = { image: ImageIcon, video: Film, audio: AudioLines } as const;

function Thumb({ url, kind }: { url: string; kind: UploadKind | null }) {
  const [broken, setBroken] = useState(false);
  const src = localPreviews.get(url) ?? url;
  if (kind === 'image' && !broken) {
    return <img src={src} alt="" className="size-8 shrink-0 rounded border border-border bg-muted object-cover" onError={() => setBroken(true)} />;
  }
  const Icon = kind ? KIND_ICON[kind] : Link2;
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  );
}

/**
 * Image / video / audio parameter: upload a local file (GMI returns a public URL) or paste an https URL.
 * Multi-item inputs (`max` > 1) keep a list; single inputs hold one URL.
 */
export function MediaInput({
  id,
  param,
  value,
  onChange,
  issue,
}: {
  id: string;
  param: ModelParameter;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Validation message for the field (shown under the control). */
  issue?: string | null;
}) {
  const kind = uploadKind(param);
  const many = acceptsMany(param);
  const items = asList(value);
  const max = many ? (param.max ?? Infinity) : 1;
  const full = items.length >= max;
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An upload can finish after the user switched models; its URL must not land in another model's form.
  const mounted = useRef(true);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const commit = (list: string[]) => {
    if (many) onChange(list.length ? list : undefined);
    else onChange(list[0] ?? undefined);
  };

  const addUrl = () => {
    const url = draft.trim();
    if (!url) return;
    if (!/^https:\/\//i.test(url)) {
      setError('Paste an https:// link, or upload a file.');
      return;
    }
    setError(null);
    setDraft('');
    commit(many ? [...items.filter((u) => u !== url), url].slice(0, max) : [url]);
  };

  const upload = async () => {
    if (!kind) return;
    setUploading(true);
    setError(null);
    try {
      const result = await gmi.media.pickAndUpload(kind);
      if (!result || !mounted.current) return;
      if (result.previewUrl) localPreviews.set(result.publicUrl, result.previewUrl);
      // The picker is modal but the form is not: add to the value as it is now, not as it was.
      commit(many ? [...asList(latest.current), result.publicUrl].slice(0, max) : [result.publicUrl]);
    } catch (e) {
      if (!mounted.current) return;
      const view = describeError(e);
      setError(view.message || view.title);
    } finally {
      if (mounted.current) setUploading(false);
    }
  };

  const types = kind ? MEDIA_UPLOAD_TYPES[kind].map((t) => t.toUpperCase()).join(', ') : null;
  const hint = [types, many && Number.isFinite(max) ? `up to ${max}` : null, kind ? 'uploads get a public link' : 'https link'].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-1.5">
      {items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {items.map((url) => (
            <li key={url} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-1.5 py-1">
              <Thumb url={url} kind={kind} />
              <Tooltip label={<span className="break-all">{url}</span>}>
                <span className="min-w-0 flex-1 truncate text-xs">{fileLabel(url)}</span>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${fileLabel(url)} from ${param.label}`}
                onClick={() => commit(items.filter((u) => u !== url))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {!full ? (
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addUrl();
              }
            }}
            onBlur={() => {
              if (draft.trim()) addUrl();
            }}
            placeholder={kind ? `Paste ${kind === 'video' ? 'a' : 'an'} ${kind} link or upload` : 'Paste an https:// link'}
            aria-invalid={Boolean(issue || error) || undefined}
            className={cn('h-8 min-w-0 flex-1 text-xs', (issue || error) && 'border-destructive/60')}
          />
          {kind ? (
            <Button variant="outline" size="sm" onClick={() => void upload()} disabled={uploading} aria-label={`Upload ${kind} for ${param.label}`}>
              {uploading ? <Spinner className="text-current" /> : <Upload />}
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error || issue ? <p className="text-2xs text-destructive">{error ?? issue}</p> : <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
