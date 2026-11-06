// Colour mode: dark by default, light on request, remembered in this browser. index.html sets
// html[data-theme] from the same key before the bundle runs, so a light page never flashes dark.
import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
export const THEME_STORE = 'recourse-theme';

export function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORE, theme);
    } catch {
      // storage refused (private mode): the choice lasts for this page only
    }
  }, [theme]);
  return [theme, setTheme];
}
