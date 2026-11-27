// The Settings section list. Features add sections through their page registration (pages/registry.<feature>.ts),
// so they never edit the Settings page or this list.
import type { ComponentType } from 'react';
import { Boxes, Image, Info, KeyRound, MessageSquare, Palette, ShieldCheck, UserRound, type LucideIcon } from 'lucide-react';
import { CODE_SETTINGS_SECTIONS } from '../registry.code';
import { COMPUTE_SETTINGS_SECTIONS } from '../registry.compute';

export interface SettingsSectionDef {
  /** Anchor (`settings-<id>`) and `?section=<id>` deep link. */
  id: string;
  /** Label in the section nav. */
  label: string;
  icon: LucideIcon;
  /** Position: built-in sections use 10, 20 … 90 (About is last). */
  order: number;
  /** Rendered by the Settings page inside a titled card. Null: a built-in section the page renders itself. */
  Component: ComponentType | null;
  /** Card title (default: label) and description, for sections with a Component. */
  title?: string;
  description?: string;
}

export const BUILTIN_SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'account', label: 'Account', icon: UserRound, order: 10, Component: null },
  { id: 'keys', label: 'API key', icon: KeyRound, order: 20, Component: null },
  { id: 'security', label: 'Security', icon: ShieldCheck, order: 30, Component: null },
  { id: 'appearance', label: 'Appearance', icon: Palette, order: 40, Component: null },
  { id: 'catalog', label: 'Model catalog', icon: Boxes, order: 50, Component: null },
  { id: 'chat', label: 'Chat', icon: MessageSquare, order: 60, Component: null },
  { id: 'media', label: 'Media', icon: Image, order: 70, Component: null },
  { id: 'about', label: 'About', icon: Info, order: 90, Component: null },
];

/** Every section, in display order (ids are unique: a feature section never replaces a built-in one). */
export function buildSettingsSections(extra: readonly SettingsSectionDef[]): SettingsSectionDef[] {
  const seen = new Set<string>();
  const out: SettingsSectionDef[] = [];
  for (const def of [...BUILTIN_SETTINGS_SECTIONS, ...extra]) {
    if (seen.has(def.id)) continue;
    seen.add(def.id);
    out.push(def);
  }
  return out.sort((a, b) => a.order - b.order);
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = buildSettingsSections([...COMPUTE_SETTINGS_SECTIONS, ...CODE_SETTINGS_SECTIONS]);
