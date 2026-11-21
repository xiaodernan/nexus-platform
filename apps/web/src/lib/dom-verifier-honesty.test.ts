import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1506 — the DOM clipping verifier must not pass on skeletons or decorative clipping. */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const src = readFileSync(join(repoRoot, 'scripts/verify_dom_clipping.mjs'), 'utf8');

describe('DOM clipping verifier honesty', () => {
  it('refuses to judge a streaming skeleton', () => {
    expect(src).toContain('is an unresolved streaming skeleton — refusing to judge');
    expect(src).toContain('process.exit(2)');
  });

  it('excludes purposefully clipped screen-reader-only text', () => {
    expect(src).toContain('(sr-only|nexus-sr-only)');
  });

  it('measures real text children, not decorative absolute nodes', () => {
    expect(src).toContain("getComputedStyle(k).position !== 'absolute'");
    expect(src).toContain('k.getBoundingClientRect().bottom > box.bottom - padB + 2');
  });

  it('waits for layout to settle before measuring', () => {
    expect(src).toContain('document.fonts.ready');
  });
});
