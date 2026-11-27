import { useEffect, useState } from 'react';
import type { ThemePreference } from '@shared/contracts/app';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/** Applies the theme to <html> and returns whether dark mode is active. */
export function useApplyTheme(preference: ThemePreference | undefined): boolean {
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const dark = preference === 'dark' ? true : preference === 'light' ? false : systemDark;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return dark;
}
