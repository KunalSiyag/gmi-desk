// The Compute page's registration (compute.md §15). Owned by C1-0.
//
// Later slices plug in without editing this file (they do not own it):
// - C1-E: `pages/compute/index.tsx` with a default-exported page component replaces the stub below.
// - C1-A: `pages/settings/ComputeKeySection.tsx` with a default-exported component adds Settings › Compute key.
// Both are picked up at build time (Vite `import.meta.glob`, eager): while a file does not exist, nothing changes.
import type { ComponentType } from 'react';
import { Activity, KeyRound, Rocket, Server, SquareTerminal } from 'lucide-react';
import type { PageMeta } from './registry';
import type { SettingsSectionDef } from './settings/sections';
import { makeStubPage } from './StubPage';

export const COMPUTE_PAGE_META: PageMeta = {
  id: 'compute',
  title: 'Compute',
  icon: Server,
  shortcut: '7',
  keywords: ['containers', 'sandbox', 'agentbox', 'cluster engine', 'gpu', 'computer', 'terminal'],
};

/** Shown until C1-E's page exists. */
export const ComputeStubPage: ComponentType = makeStubPage({
  title: 'Compute',
  description: 'GPU containers and Agentbox sandboxes on GMI Cloud, with their cost in view.',
  emptyTitle: 'No computers yet',
  emptyDescription: 'Launching containers and sandboxes from GMI Desk is being built. Nothing here creates or bills anything yet.',
  preview: [
    { icon: Rocket, title: 'Launch', description: 'Pick a template and a size, see the price per hour, approve, and it starts.' },
    { icon: SquareTerminal, title: 'Computer panel', description: 'Terminal, files and port previews side by side with chat.' },
    { icon: Activity, title: 'Cost guard', description: 'Leases, idle pause and your budgets, so nothing keeps billing by accident.' },
  ],
});

/** A module found by the glob: only its default export is used. */
export type FeatureModule = { default?: unknown };

/** The default export of the single module in `modules` when it is a component; otherwise `fallback`. */
export function pickFeatureComponent(modules: Record<string, FeatureModule>, fallback: ComponentType): ComponentType {
  const found = Object.values(modules);
  if (found.length !== 1) return fallback;
  const component = found[0]!.default;
  return typeof component === 'function' || (typeof component === 'object' && component !== null) ? (component as ComponentType) : fallback;
}

/** Settings sections the compute feature adds, given the (optional) Compute key section module. */
export function computeSettingsSections(keySection: Record<string, FeatureModule>): SettingsSectionDef[] {
  const Component = pickFeatureComponent(keySection, NoSection);
  if (Component === NoSection) return [];
  return [
    {
      id: 'compute-key',
      label: 'Compute key',
      title: 'Compute key',
      description: 'The GMI Compute API key for containers and sandboxes. It stays on this computer.',
      icon: KeyRound,
      // Right after the inference "API key" section (20).
      order: 25,
      Component,
    },
  ];
}

function NoSection() {
  return null;
}

const pageModules = import.meta.glob<FeatureModule>('./compute/index.tsx', { eager: true });
const keySectionModules = import.meta.glob<FeatureModule>('./settings/ComputeKeySection.tsx', { eager: true });

export const ComputePage: ComponentType = pickFeatureComponent(pageModules, ComputeStubPage);

/** Settings sections the compute feature adds (rendered by the Settings page in list order). */
export const COMPUTE_SETTINGS_SECTIONS: SettingsSectionDef[] = computeSettingsSections(keySectionModules);
