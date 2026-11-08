/**
 * The theme's stored choice — one key, one class, one promise.
 *
 * `packages/ui/src/styles/tokens.css` says: "a theme switch is a single `class` change on `<html>`
 * (no re-render / no FOUC flash when the inline script in `app/layout.tsx` applies the stored theme
 * before paint)". This file is the other half of that sentence: the key and the class name, written
 * once, so the inline script that runs before the first paint and the button a reader clicks
 * afterwards cannot disagree about where the choice lives.
 *
 * The default is LIGHT, and it stays light until a reader chooses otherwise: following the operating
 * system's `prefers-color-scheme` would change the product's appearance without anyone deciding it,
 * and this project does not make that trade in a side effect.
 */

export const THEME_STORAGE_KEY = 'nexus-theme';

/** The class the palette's dark block is written against (`tokens.css`: `.dark { … }`). */
export const THEME_CLASS = 'dark';

export type Theme = 'light' | 'dark';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/**
 * The script that runs BEFORE the first paint.
 *
 * It is written as a string because it has to run before React hydrates — a component that toggles
 * the class would arrive with the page already painted in the wrong theme, which is the flash the
 * token sheet says must not happen. It reads the stored choice and puts the class on `<html>`,
 * and it does nothing when storage is unavailable rather than throwing on the way to the first
 * paint.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(v==='dark')document.documentElement.classList.add(${JSON.stringify(THEME_CLASS)});}catch(e){}})();`;
