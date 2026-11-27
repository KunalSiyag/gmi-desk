import { FileCode2, Sparkles } from 'lucide-react';
import { useCommandRegistry, useUi } from '@renderer/lib/store';

let registered = false;

/**
 * Catalog commands that make sense from any page (e.g. right after a "New on GMI" notification).
 * They route through the Models page params, which owns the dialog and filters. Registered once at
 * startup; page-only commands (refresh, mark seen, leaderboard) are registered while the page is open.
 */
export function registerGlobalCatalogCommands(): void {
  if (registered) return;
  registered = true;
  useCommandRegistry.getState().register('catalog.global', [
    {
      id: 'catalog.showNew',
      label: 'Show new models',
      group: 'Models',
      icon: <Sparkles />,
      keywords: ['new', 'catalog', 'recent', 'added', 'models'],
      run: () => useUi.getState().navigate('models', { filter: 'new' }),
    },
    {
      id: 'catalog.exportOpenCode',
      label: 'Export models for OpenCode / T3 Code',
      group: 'Models',
      icon: <FileCode2 />,
      keywords: ['opencode', 't3', 'config', 'export', 'provider'],
      run: () => useUi.getState().navigate('models', { export: '1' }),
    },
  ]);
}
