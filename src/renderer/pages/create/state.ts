/**
 * Create page UI state (module-level store, so the prompt and form survive switching pages).
 * Only per-viewer conveniences (chosen model per tab, gallery filter) are remembered in localStorage.
 */
import { create } from 'zustand';
import { CREATE_TABS, isCreateTab, type CreateTab } from './form';

export type GalleryFilter = 'all' | 'device';

/** Settings to load into the form once the model's schema is available ("Use these settings"). */
export interface FormPreset {
  modelId: string;
  /** Null keeps the prompt already in the form (history jobs carry none). */
  prompt: string | null;
  values: Record<string, unknown>;
}

interface CreateState {
  tab: CreateTab;
  /** Chosen model per tab. */
  selected: Partial<Record<CreateTab, string>>;
  query: string;
  prompt: string;
  /** Model whose schema the current `values` were built from (null until it loads). */
  formModelId: string | null;
  values: Record<string, unknown>;
  /** True after a run attempt: from then on, missing required fields are flagged. */
  touched: boolean;
  advancedOpen: boolean;
  preset: FormPreset | null;
  galleryFilter: GalleryFilter;
  /** Bumped to ask the form to focus the prompt (palette "New image", "Use these settings"). */
  focusSeq: number;
  setTab(tab: CreateTab): void;
  selectModel(tab: CreateTab, modelId: string): void;
  setQuery(query: string): void;
  setPrompt(prompt: string): void;
  setValue(name: string, value: unknown): void;
  /** Starts a form for a model: its defaults (plus a matching preset), keeping the prompt unless the preset has one. */
  initForm(modelId: string, values: Record<string, unknown>, prompt?: string | null): void;
  /** Switches to a model and queues settings to load into its form. */
  loadPreset(tab: CreateTab, preset: FormPreset): void;
  resetValues(values: Record<string, unknown>): void;
  setTouched(touched: boolean): void;
  setAdvancedOpen(open: boolean): void;
  setGalleryFilter(filter: GalleryFilter): void;
  requestFocus(): void;
}

const SELECTED_KEY = 'gmi.create.selected';
const FILTER_KEY = 'gmi.create.galleryFilter';
const TAB_KEY = 'gmi.create.tab';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage may be unavailable
  }
}

function readSelected(): Partial<Record<CreateTab, string>> {
  try {
    const raw: unknown = JSON.parse(read(SELECTED_KEY) ?? '{}');
    const out: Partial<Record<CreateTab, string>> = {};
    if (raw && typeof raw === 'object') {
      for (const tab of CREATE_TABS) {
        const v = (raw as Record<string, unknown>)[tab];
        if (typeof v === 'string' && v.length > 0 && v.length < 300) out[tab] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const storedTab = read(TAB_KEY);

export const useCreateUi = create<CreateState>((set, get) => ({
  tab: isCreateTab(storedTab) ? storedTab : 'image',
  selected: readSelected(),
  query: '',
  prompt: '',
  formModelId: null,
  values: {},
  touched: false,
  advancedOpen: false,
  preset: null,
  galleryFilter: read(FILTER_KEY) === 'device' ? 'device' : 'all',
  focusSeq: 0,
  setTab(tab) {
    write(TAB_KEY, tab);
    set({ tab, query: '' });
  },
  selectModel(tab, modelId) {
    const selected = { ...get().selected, [tab]: modelId };
    write(SELECTED_KEY, JSON.stringify(selected));
    write(TAB_KEY, tab);
    set({ tab, selected });
  },
  setQuery: (query) => set({ query }),
  setPrompt: (prompt) => set({ prompt }),
  setValue: (name, value) =>
    set((s) => {
      const values = { ...s.values };
      if (value === undefined) delete values[name];
      else values[name] = value;
      return { values };
    }),
  initForm(modelId, values, prompt) {
    set((s) => ({
      formModelId: modelId,
      values,
      prompt: prompt ?? s.prompt,
      touched: false,
      preset: s.preset?.modelId === modelId ? null : s.preset,
    }));
  },
  loadPreset(tab, preset) {
    const selected = { ...get().selected, [tab]: preset.modelId };
    write(SELECTED_KEY, JSON.stringify(selected));
    write(TAB_KEY, tab);
    // Clearing formModelId makes the form re-initialise from the schema with the preset applied.
    set((s) => ({ tab, selected, preset, formModelId: null, query: '', focusSeq: s.focusSeq + 1 }));
  },
  resetValues: (values) => set({ values, touched: false }),
  setTouched: (touched) => set({ touched }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  setGalleryFilter(galleryFilter) {
    write(FILTER_KEY, galleryFilter);
    set({ galleryFilter });
  },
  requestFocus: () => set((s) => ({ focusSeq: s.focusSeq + 1 })),
}));
