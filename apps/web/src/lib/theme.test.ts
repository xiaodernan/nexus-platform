import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { THEME_BOOTSTRAP_SCRIPT, THEME_CLASS, THEME_STORAGE_KEY, isTheme } from './theme';

/**
 * Three places have to agree about where a theme lives: the palette (which writes the rules for a
 * class), the script that runs before the first paint (which reads the stored choice), and the
 * control a reader clicks (which writes both). Nothing in the type system connects them, so this
 * reads the palette as TEXT — importing it would let a broken sheet satisfy its own assertion —
 * and checks that the names the code uses are the names the sheet ships.
 *
 * The failure this guards is the one that would be invisible: a renamed class or a changed key
 * leaves every file type-correct, every unit test green, and the reader with a dark theme that
 * quietly returns to light on the next reload.
 */

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'packages', 'ui', 'src', 'styles', 'tokens.css'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(repoRoot, 'packages', 'ui', 'src', 'styles', 'tokens.css'), 'utf8');

describe('the theme has one name, and the palette ships it', () => {
  it('uses the class the palette writes its dark block against', () => {
    expect(tokensCss, `tokens.css has no ".${THEME_CLASS} {" block for the theme class`).toMatch(
      new RegExp(`\\.${THEME_CLASS}\\s*\\{`),
    );
    expect(THEME_CLASS).toBe('dark');
  });

  it('names the dark palette inside the class the code toggles', () => {
    // The block must actually carry the dark ink and surface, or the class would repaint nothing.
    const block = tokensCss.slice(tokensCss.indexOf(`.${THEME_CLASS} {`));
    expect(block.slice(0, 4000)).toContain('--nexus-ink:');
    expect(block.slice(0, 4000)).toContain('--nexus-surface:');
  });

  it('stores the choice under one key, and the bootstrap script reads that key', () => {
    expect(THEME_STORAGE_KEY).toBe('nexus-theme');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(THEME_CLASS);
  });

  it('applies the stored theme before the first paint, and survives a browser that refuses storage', () => {
    // The script must be a single expression that cannot throw on the way to the first paint: a
    // throw here would leave the page unstyled, and a missing try/catch is exactly that.
    expect(THEME_BOOTSTRAP_SCRIPT.startsWith('(function(){try{')).toBe(true);
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('}catch(e){}})();');
  });

  it('cancels the skeleton shimmer itself under reduced motion, not only a pseudo-element', () => {
    // The animation lives on the `.nexus-shimmer` element, set by `[animation:nexus-shimmer_1.5s_infinite]`
    // in `primitives/Skeleton.tsx`. A reduced-motion block that cancels only `.nexus-shimmer::after` cancels
    // an element that never exists — the page shipped 28 running animations to a reduced-motion request,
    // which WebKit reported and the §78 leg caught (D812).
    const reducedBlocks = [
      ...tokensCss.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([^@]*?)\n\}/gs),
    ].map((match) => match[1] ?? '');
    expect(reducedBlocks.length, 'tokens.css has no reduced-motion block at all').toBeGreaterThan(0);
    const shimmerBlock = reducedBlocks.find((block) => block.includes('.nexus-shimmer'));
    expect(shimmerBlock, 'no reduced-motion block in tokens.css names .nexus-shimmer').toBeTruthy();

    if (!shimmerBlock) {
      throw new Error('no reduced-motion block in tokens.css names .nexus-shimmer');
    }
    // The bare class must be a stated target: a `.nexus-shimmer` followed by `,` or `{` — never
    // satisfied by `.nexus-shimmer::after` alone, whose first following character is `:`.
    expect(shimmerBlock).toMatch(/(^|[\s,{])\.nexus-shimmer\s*[,{]/m);
    expect(shimmerBlock).toContain('animation: none !important');
  });

  it('accepts only the two themes the product has', () => {
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('system')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });
});
