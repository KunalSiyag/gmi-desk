import { BookOpen, Boxes, Gauge, Hand, MessageSquare, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import type { PageId } from '@shared/contracts/app';
import { CODE_PAGE_META } from './registry.code';
import { COMPUTE_PAGE_META } from './registry.compute';

export interface PageMeta {
  id: PageId;
  title: string;
  icon: LucideIcon;
  /** Shortcut shown in the sidebar/palette (handled in useGlobalShortcuts). */
  shortcut?: string;
  /** Extra words that find the page in the command palette. */
  keywords?: string[];
}

export const PAGE_META: Record<PageId, PageMeta> = {
  chat: { id: 'chat', title: 'Chat', icon: MessageSquare, shortcut: '1' },
  models: { id: 'models', title: 'Models', icon: Boxes, shortcut: '2' },
  create: { id: 'create', title: 'Create', icon: Sparkles, shortcut: '3' },
  usage: { id: 'usage', title: 'Usage', icon: Gauge, shortcut: '4' },
  docs: { id: 'docs', title: 'Docs', icon: BookOpen, shortcut: '5' },
  code: CODE_PAGE_META,
  compute: COMPUTE_PAGE_META,
  settings: { id: 'settings', title: 'Settings', icon: Settings, shortcut: ',' },
  welcome: { id: 'welcome', title: 'Welcome', icon: Hand },
};

/** Pages listed in the sidebar navigation, in order; ⌘/Ctrl+1…9 follow this order (Code = 6, Compute = 7). */
export const NAV_PAGES: PageId[] = ['chat', 'models', 'create', 'usage', 'docs', 'code', 'compute'];
