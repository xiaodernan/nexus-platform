import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1087 — the home hero's dot-grid + ghost glyph are present, aria-hidden,
 * defined in globals.css, and carry no copy: decor, not message.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('D1087 home hero texture', () => {
  it('the hero renders dot-grid and ghost glyph, both aria-hidden decor', () => {
    const page = read('apps/web/app/page.tsx');
    expect(page).toContain('nexus-dot-grid');
    expect(page).toContain('nexus-ghost-glyph');
    expect(page).toContain('aria-hidden="true" className="nexus-dot-grid');
    expect(page).toContain('aria-hidden="true" className="nexus-ghost-glyph');
  });

  it('globals.css defines the utilities with accent-toned masks and no copy', () => {
    const css = read('apps/web/app/globals.css');
    expect(css).toContain('.nexus-dot-grid');
    expect(css).toContain('radial-gradient(rgb(var(--nexus-accent-rgb) / 0.14)');
    expect(css).toContain('-webkit-mask-image');
    expect(css).toContain('.nexus-ghost-glyph');
    expect(css).toContain('user-select: none');
  });
});
