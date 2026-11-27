// The Code page's registration (harness.md §12). H3-0 points `CodePage` at pages/code/.
import { CodeXml } from 'lucide-react';
import CodePageImpl from './code';
import CodeSettings from './code/settings';
import type { PageMeta } from './registry';
import type { SettingsSectionDef } from './settings/sections';

export const CODE_PAGE_META: PageMeta = {
  id: 'code',
  title: 'Code',
  icon: CodeXml,
  shortcut: '6',
  keywords: ['agent', 'threads', 'repository', 'git', 'worktree', 'coding'],
};

export const CodePage = CodePageImpl;

/** Settings sections the Code feature adds (rendered by the Settings page in list order). */
export const CODE_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: 'code',
    label: 'Code',
    title: 'Code',
    description: 'Defaults for agent threads, the sandbox, permission rules and MCP servers.',
    icon: CodeXml,
    order: 75,
    Component: CodeSettings,
  },
];
