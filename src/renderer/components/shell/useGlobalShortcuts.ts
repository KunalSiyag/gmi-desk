import { useEffect } from 'react';
import { isMac } from '@renderer/lib/gmi';
import { useSettings, useUpdateSettings } from '@renderer/lib/hooks';
import { useUi } from '@renderer/lib/store';
import { NAV_PAGES } from '@renderer/pages/registry';

/** App-wide keyboard shortcuts (T3 Code style). */
export function useGlobalShortcuts(): void {
  const navigate = useUi((s) => s.navigate);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const collapsed = settings.data?.sidebarCollapsed ?? false;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = isMac() ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        setPaletteOpen(!useUi.getState().paletteOpen);
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        navigate('chat', { new: '1' });
      } else if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        updateSettings.mutate({ sidebarCollapsed: !collapsed });
      } else if (key === ',') {
        event.preventDefault();
        navigate('settings');
      } else if (/^[1-9]$/.test(key) && !event.shiftKey) {
        const page = NAV_PAGES[Number(key) - 1];
        if (page) {
          event.preventDefault();
          navigate(page);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, setPaletteOpen, updateSettings, collapsed]);
}
