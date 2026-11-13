import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1056 — the command palette keeps its discipline in source:
 *
 *   - mounted exactly once in the document shell (input-owning surface count = 1);
 *   - opened only from the document listener, only via Meta/Ctrl+K outside typing lanes;
 *   - a `role=dialog` with an accessible name, scrim aria-hidden, Esc and scrim close it;
 *   - body overflow is pinned and restored on every exit path;
 *   - the only navigation target is `paletteSearchPath` (the ordinary /search route);
 *   - no provider key, base URL or model name appears anywhere in the island;
 *   - the reduced-motion contract for the panel exists in the CSS it animates with.
 *
 * A palette that forks the search route, leaks a key, or cannot be closed with the
 * keyboard is not a command palette; it is a trap.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COMPONENT = 'apps/web/src/components/command-palette.tsx';
const LAYOUT = 'apps/web/app/layout.tsx';
const GLOBAL_CSS = 'apps/web/app/globals.css';
const HELPERS = 'apps/web/src/lib/palette.ts';

describe('D1056 command palette', () => {
  it('is a client island mounted exactly once in the document shell', () => {
    const layout = read(LAYOUT);
    expect(layout).toContain("import { CommandPalette } from '@/components/command-palette';");
    expect((layout.match(/<CommandPalette/g) ?? []).length).toBe(1);
    const component = read(COMPONENT);
    expect(component.startsWith("'use client';")).toBe(true);
  });

  it('is a labelled modal dialog whose scrim and Esc close the surface', () => {
    const component = read(COMPONENT);
    expect(component).toContain('role="dialog"');
    expect(component).toContain('aria-modal="true"');
    expect(component).toContain('aria-label={labels.searchLabel}');
    expect(component).toContain('aria-hidden="true"');
    expect(component).toContain('isCloseShortcut');
  });

  it('hooks the global key only through the lib/palette helpers', () => {
    const component = read(COMPONENT);
    expect(component).toContain("from '@/lib/palette'");
    expect(component).toContain('isOpenPaletteShortcut');
    expect(component).not.toMatch(/keyCode/);
    expect(component).not.toMatch(/['"]Cmd['"]/);
  });

  it('pins and restores body overflow on open and close', () => {
    const component = read(COMPONENT);
    expect(component).toContain("document.body.style.overflow = 'hidden'");
    expect(component).toContain("document.body.style.overflow = previous");
    expect(component).toContain('returnFocusRef.current');
  });

  it('submits only to the ordinary /search route and never carries secrets', () => {
    const component = read(COMPONENT);
    expect(component).toContain('paletteSearchPath');
    expect(component).not.toMatch(/wkapi|api[_-]?key|sk-[A-Za-z0-9]/i);
    const helpers = read(HELPERS);
    expect(helpers).toContain('/search?');
    expect(helpers).not.toMatch(/wkapi|api[_-]?key|sk-[A-Za-z0-9]/i);
  });

  it('ships a reduced-motion fallback for the panel animation', () => {
    const css = read(GLOBAL_CSS);
    expect(css).toContain('@keyframes nexus-palette-in');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nexus-palette \[role="dialog"\][\s\S]*?animation: none/);
  });
});
