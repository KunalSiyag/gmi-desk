import { Fragment, memo } from 'react';
import { cn } from '@renderer/lib/cn';
import { splitHighlights } from './text';

type Block = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string };

/** The main process cleans excerpts to paragraphs, `inline code` and ``` fences; split them back into blocks. */
function parse(excerpt: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)\n```/g;
  let last = 0;
  for (const m of excerpt.matchAll(fence)) {
    const before = excerpt.slice(last, m.index);
    for (const para of before.split(/\n{2,}/)) if (para.trim()) blocks.push({ kind: 'text', text: para.trim() });
    blocks.push({ kind: 'code', lang: m[1] ?? '', code: m[2] ?? '' });
    last = (m.index ?? 0) + m[0].length;
  }
  for (const para of excerpt.slice(last).split(/\n{2,}/)) if (para.trim()) blocks.push({ kind: 'text', text: para.trim() });
  return blocks;
}

/** The search's words, marked in brand ink on a faint lime tint (olive on light surfaces). */
function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {splitHighlights(text, terms).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-[3px] bg-primary/15 px-px font-medium text-primary-ink dark:bg-primary/12">
            {part.text}
          </mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function InlineCode({ text, terms }: { text: string; terms: readonly string[] }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.92em] text-foreground">
            <Highlighted text={part.slice(1, -1)} terms={terms} />
          </code>
        ) : (
          <Highlighted key={i} text={part} terms={terms} />
        ),
      )}
    </>
  );
}

const NO_TERMS: readonly string[] = [];

/**
 * Renders a cleaned docs excerpt as plain text (never HTML): paragraphs, line breaks, inline code, code blocks.
 * `terms` (from highlightTerms) are marked in the prose and inline code, not inside code blocks.
 */
export const Excerpt = memo(function Excerpt({ text, terms = NO_TERMS, className }: { text: string; terms?: readonly string[]; className?: string }) {
  const blocks = parse(text);
  if (blocks.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground', className)}>
      {blocks.map((b, i) =>
        b.kind === 'code' ? (
          <pre
            key={i}
            className="overflow-x-auto rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-2xs leading-relaxed text-foreground/90 dark:bg-background/60"
            aria-label={b.lang ? `${b.lang} code` : 'Code'}
          >
            <code>{b.code}</code>
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words">
            <InlineCode text={b.text} terms={terms} />
          </p>
        ),
      )}
    </div>
  );
});
