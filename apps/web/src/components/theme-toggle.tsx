'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { THEME_CLASS, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

/**
 * The theme switch the token sheet has been promising since it shipped (`tokens.css`: "a theme
 * switch is a single `class` change on `<html>` … the inline script in `app/layout.tsx` applies the
 * stored theme before paint"). The palette, the preset's `darkMode: ['class']` and the icon set's
 * `sun`/`moon` were all shipped; the control that puts the class on `<html>` was not.
 *
 * Two decisions worth naming:
 *
 *  - **The ICONS are CSS-driven, the LABEL is state-driven.** `dark:hidden` / `hidden dark:block`
 *    swap the glyph with the theme itself, so a reader who chose dark never sees the light icon
 *    flash during hydration. The accessible name is the one thing CSS cannot change for a screen
 *    reader, so it comes from state and settles a tick after hydration.
 *  - **The stored value is the truth, and the class is a copy of it.** The button writes the class
 *    and the storage together; the inline script in the layout reads the storage before the first
 *    paint, so a reload lands on the same theme without a flash.
 */
export function ThemeToggle({ labels }: { labels: { toDark: string; toLight: string } }) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains(THEME_CLASS) ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next: Theme = document.documentElement.classList.contains(THEME_CLASS) ? 'light' : 'dark';
    document.documentElement.classList.toggle(THEME_CLASS, next === 'dark');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A browser that refuses storage (private mode, blocked cookies) still gets the theme for
      // this page; it simply does not survive a reload, which is the honest behaviour.
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      data-nexus-theme-toggle=""
      aria-label={theme === 'dark' ? labels.toLight : labels.toDark}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Icon name="moon" size={16} className="dark:hidden" />
      <Icon name="sun" size={16} className="hidden dark:block" />
    </button>
  );
}
