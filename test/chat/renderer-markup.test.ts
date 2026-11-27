// Markup-level checks for chat components. The node test suite cannot render them (no DOM, and the components
// import @renderer/*), so these read the JSX source: each assertion pins one attribute a fix depends on.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const chatPath = (file: string) => fileURLToPath(new URL(`../../src/renderer/pages/chat/${file}`, import.meta.url));
const source = (file: string) => readFileSync(chatPath(file), 'utf8');
const componentSource = (file: string) => readFileSync(fileURLToPath(new URL(`../../src/renderer/components/${file}`, import.meta.url)), 'utf8');

/** The text of a function component, from its declaration to the next top-level declaration. */
function component(text: string, name: string): string {
  const start = text.search(new RegExp(`(function|const) ${name}\\b`));
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(export )?(function|const|interface|type) /);
  return end === -1 ? text.slice(start) : text.slice(start, start + 1 + end);
}

/** Every opening tag `<Name …>` in `text`, attributes included (`=>` inside {…} does not end a tag). */
function openingTags(text: string, name: string): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${name}[\\s>/]`, 'g');
  for (let match = re.exec(text); match; match = re.exec(text)) {
    let depth = 0;
    let i = match.index + 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(text.slice(match.index, i + 1));
  }
  return tags;
}

const classOf = (tag: string) => /className="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];

describe('sidebar chat rows', () => {
  const row = component(source('ChatSidebar.tsx'), 'ThreadRow');

  it('the time label and streaming plates that hide on hover do not cover the "…" menu trigger', () => {
    const spinner = openingTags(row, 'Plates');
    const time = openingTags(row, 'span').filter((tag) => classOf(tag).includes('group-hover/row:opacity-0'));
    expect(spinner).toHaveLength(1);
    expect(time).toHaveLength(1);
    for (const tag of [...spinner, ...time]) {
      // Hidden by opacity on hover, so they paint (and hit-test) above the trigger: clicks must pass through.
      expect(classOf(tag)).toContain('group-hover/row:opacity-0');
      expect(classOf(tag)).toContain('pointer-events-none');
    }
  });
});

describe('sidebar chat list (design kit)', () => {
  const sidebar = source('ChatSidebar.tsx');
  const row = component(sidebar, 'ThreadRow');

  it('labels date groups with the kit micro-label at full muted colour (AA on light), naming each list', () => {
    const labels = openingTags(component(sidebar, 'ChatSidebar'), 'MicroLabel');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/\bid=\{/);
    expect(sidebar).toMatch(/<ul aria-labelledby=\{/);
    expect(sidebar).not.toMatch(/muted-foreground\/\d/);
  });

  it('shows "Recent" only while the list is empty: with chats, the date groups head the list (nav keeps its name)', () => {
    const list = component(sidebar, 'ChatSidebar');
    const nav = list.slice(list.indexOf('<nav aria-label="Recent chats"'));
    expect(nav.length).toBeGreaterThan(0);
    const labels = [...nav.matchAll(/<SectionLabel\b[^>]*>Recent<\/SectionLabel>/g)];
    expect(labels).toHaveLength(1);
    // The one label sits inside the empty-list branch, next to the empty message.
    const empty = /\{list\.length === 0 \? \(([\s\S]*?)\) : null\}/.exec(nav)?.[1] ?? '';
    expect(empty).toMatch(/<SectionLabel>Recent<\/SectionLabel>/);
    expect(empty).toContain('Your chats will show up here.');
    // The skeleton and the error state still name the section.
    expect(list.slice(0, list.indexOf('<nav')).match(/>Recent<\/SectionLabel>/g)).toHaveLength(2);
  });

  it('marks the open chat with bg-accent, medium weight and the inset ActiveBar, instantly', () => {
    const li = openingTags(row, 'li')[0] ?? '';
    expect(li).toContain("'bg-accent font-medium text-foreground'");
    expect(li).not.toMatch(/transition/);
    expect(row).toMatch(/\{active \? <ActiveBar \/> : null\}/);
    expect(sidebar).toContain("from '@renderer/components/ui/active-bar'");
  });
});

describe('working signal', () => {
  it('uses the kit Plates everywhere; the chat-local copy is gone', () => {
    expect(existsSync(chatPath('Plates.tsx'))).toBe(false);
    for (const file of ['ChatSidebar.tsx', 'MessageView.tsx', 'Timeline.tsx']) {
      expect(source(file), file).toContain("import { Plates } from '@renderer/components/brand/Plates';");
    }
  });
});

describe('brand-positive states', () => {
  it('copied checks use brand ink, not the mint success colour', () => {
    expect(source('MessageView.tsx')).toContain('<Check className="text-primary-ink" />');
    expect(componentSource('Markdown.tsx')).toContain('<Check className="text-primary-ink" />');
    for (const text of [source('MessageView.tsx'), componentSource('Markdown.tsx'), componentSource('ModelPicker.tsx')]) {
      expect(text).not.toMatch(/success/);
    }
  });

  it('the model picker shows the org discount with the kit DiscountBadge and loads with Plates', () => {
    const picker = componentSource('ModelPicker.tsx');
    expect(picker).toContain('<DiscountBadge discount={m.discount} />');
    expect(picker).not.toMatch(/<Spinner\b/);
    expect(picker).toMatch(/<Plates size="sm" \/> Loading models/);
  });
});

describe('model picker trigger', () => {
  const picker = componentSource('ModelPicker.tsx');

  it('uses the kit select chevron (ChevronDown, muted), not an up/down chevron', () => {
    expect(picker).not.toMatch(/ChevronsUpDown/);
    expect(picker).toContain('<ChevronDown className="size-3.5 text-muted-foreground" />');
  });

  it('in the composer it is bare like the effort select (no dark-mode outline fill)', () => {
    const tag = openingTags(component(source('Composer.tsx'), 'Composer'), 'ModelPicker')[0] ?? '';
    expect(classOf(tag)).toEqual(expect.arrayContaining(['border-transparent', 'dark:bg-transparent', 'hover:bg-accent']));
  });
});

describe('composer toolbar selects', () => {
  const select = component(source('Composer.tsx'), 'ToolbarSelect');

  it('are the kit Select\'s ghost trigger (themed popup, its chevron and keyboard ring), opening upwards like the model picker', () => {
    const tags = openingTags(select, 'Select');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('variant="ghost"');
    expect(tags[0]).toContain('side="top"');
    expect(tags[0]).toContain('options={options}');
    // No local chevron, no native <select>/<option>, no ring of its own: the kit trigger draws them.
    expect(openingTags(select, 'ChevronDown')).toHaveLength(0);
    expect(source('Composer.tsx')).not.toMatch(/<select[\s>]|<option[\s>]|NativeSelect/);
    expect(select).not.toMatch(/focus-visible|ring-/);
  });

  it('keep their values and labels (router mode; reasoning effort with "" = default)', () => {
    const text = source('Composer.tsx');
    for (const label of ["{ value: 'cost', label: 'Cost' }", "{ value: 'balanced', label: 'Balanced' }", "{ value: 'quality', label: 'Quality' }"]) expect(text).toContain(label);
    for (const label of ["{ value: '', label: 'Default effort' }", "{ value: 'low', label: 'Low effort' }", "{ value: 'medium', label: 'Medium effort' }", "{ value: 'high', label: 'High effort' }"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("onChange={(effort) => onSettingsChange({ reasoningEffort: effort || null })}");
  });
});

describe('delete confirmation', () => {
  const dialog = component(source('ThreadDialogs.tsx'), 'DeleteThreadDialog');

  it('opens with focus on Cancel, never on the destructive Delete button', () => {
    const buttons = openingTags(dialog, 'Button');
    const destructive = buttons.filter((tag) => tag.includes('variant="destructive"'));
    const cancel = buttons.filter((tag) => tag.includes('onClick={onClose}'));
    expect(destructive).toHaveLength(1);
    expect(cancel).toHaveLength(1);
    expect(destructive[0]).not.toMatch(/\bautoFocus\b/);
    expect(cancel[0]).toMatch(/\bautoFocus\b/);
  });
});

describe('rename dialog', () => {
  const dialog = component(source('ThreadDialogs.tsx'), 'RenameThreadDialog');

  it('Save is lime only when the title really changes (outline otherwise: it would just close)', () => {
    expect(dialog).toMatch(/const changed = value\.trim\(\) !== '' && value\.trim\(\) !== thread\?\.title;/);
    const save = openingTags(dialog, 'Button').find((tag) => tag.includes('save()'));
    expect(save).toBeDefined();
    expect(save).toContain("variant={changed ? 'default' : 'outline'}");
    expect(save).toMatch(/disabled=\{busy \|\| !value\.trim\(\)\}/);
  });
});

describe('timeline "Jump to latest" pill', () => {
  const timeline = component(source('Timeline.tsx'), 'Timeline');

  it('stays mounted for its fade-out but cannot be focused or announced while hidden', () => {
    const pill = openingTags(timeline, 'Button').find((tag) => tag.includes('inert='));
    expect(pill, 'pill with inert').toBeDefined();
    expect(pill).toMatch(/inert=\{atBottom\}/);
    expect(pill).toMatch(/aria-hidden=\{atBottom \|\| undefined\}/);
  });
});

describe('composer send button', () => {
  const composer = component(source('Composer.tsx'), 'Composer');

  it('is a quiet grey key while there is nothing to send (lime only when it can act)', () => {
    const send = openingTags(composer, 'Button').find((tag) => tag.includes('aria-label="Send message"'));
    expect(send).toBeDefined();
    expect(send).toMatch(/disabled=\{!canSend\}/);
    expect(classOf(send ?? '')).toEqual(expect.arrayContaining(['disabled:bg-muted', 'disabled:text-muted-foreground']));
  });
});
