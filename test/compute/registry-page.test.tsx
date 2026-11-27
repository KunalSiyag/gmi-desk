// C1-0: the Compute page registration (pages/registry.compute.ts). C1-E's page and C1-A's Settings section plug in
// by file presence, so neither has to edit the registration.
import { describe, expect, it } from 'vitest';
import {
  COMPUTE_PAGE_META,
  COMPUTE_SETTINGS_SECTIONS,
  ComputePage,
  ComputeStubPage,
  computeSettingsSections,
  pickFeatureComponent,
} from '@renderer/pages/registry.compute';
import { buildSettingsSections } from '@renderer/pages/settings/sections';

function FakePage() {
  return null;
}

describe('pickFeatureComponent', () => {
  it('falls back while the module is absent, malformed or ambiguous', () => {
    expect(pickFeatureComponent({}, ComputeStubPage)).toBe(ComputeStubPage);
    expect(pickFeatureComponent({ './compute/index.tsx': {} }, ComputeStubPage)).toBe(ComputeStubPage);
    expect(pickFeatureComponent({ './compute/index.tsx': { default: 'nope' } }, ComputeStubPage)).toBe(ComputeStubPage);
    expect(pickFeatureComponent({ a: { default: FakePage }, b: { default: FakePage } }, ComputeStubPage)).toBe(ComputeStubPage);
  });

  it("uses the module's default export once it exists", () => {
    expect(pickFeatureComponent({ './compute/index.tsx': { default: FakePage } }, ComputeStubPage)).toBe(FakePage);
  });
});

describe('the Compute registration', () => {
  it('keeps the nav meta (⌘/Ctrl+7)', () => {
    expect(COMPUTE_PAGE_META).toMatchObject({ id: 'compute', title: 'Compute', shortcut: '7' });
  });

  it("serves C1-E's page when pages/compute/index.tsx exists, else the stub", () => {
    const pages = import.meta.glob<{ default?: unknown }>('../../src/renderer/pages/compute/index.tsx', { eager: true });
    expect(ComputePage).toBe(pickFeatureComponent(pages, ComputeStubPage));
  });

  it('adds Settings › Compute key (after API key) only when C1-A provides the section component', () => {
    expect(computeSettingsSections({})).toEqual([]);
    const sections = computeSettingsSections({ './settings/ComputeKeySection.tsx': { default: FakePage } });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: 'compute-key', label: 'Compute key', order: 25, Component: FakePage });
    const ids = buildSettingsSections(sections).map((s) => s.id);
    expect(ids.indexOf('compute-key')).toBe(ids.indexOf('keys') + 1);

    const present = import.meta.glob<{ default?: unknown }>('../../src/renderer/pages/settings/ComputeKeySection.tsx', { eager: true });
    expect(COMPUTE_SETTINGS_SECTIONS).toEqual(computeSettingsSections(present));
  });
});
