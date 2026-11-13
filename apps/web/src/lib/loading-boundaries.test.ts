import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1031 — every dynamic consumer route ships a loading boundary, and every boundary
 * carries the same contract the home boundary set (D1028/D1029/D1030):
 *
 *   - the file exists under `apps/web/app/<route>/loading.tsx`;
 *   - one sr-only caption announces the dictionary's loading state (`dict.states.loading`);
 *   - decorative layers are `aria-hidden="true"`, never on the a11y tree;
 *   - at least one shimmer collapses under `motion-reduce:animate-none` (prefers-reduced
 *     motion is honoured for every animated element — every file here ships at least one);
 *   - no copy is hand-set: the caption literally reads `{dict.states.loading}`.
 *
 * A file that breaks the contract is a boundary, not a silent --force of the §155/D981 discipline.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const BOUNDARIES = [
  'apps/web/app/loading.tsx',
  'apps/web/app/search/loading.tsx',
  'apps/web/app/m/[slug]/loading.tsx',
  'apps/web/app/o/[slug]/loading.tsx',
  'apps/web/app/[city]/loading.tsx',
  'apps/web/app/[city]/[category]/loading.tsx',
  'apps/web/app/[city]/[category]/[facet]/loading.tsx',
] as const;

describe('D1031 loading boundaries — every dynamic consumer route honours the contract', () => {
  for (const rel of BOUNDARIES) {
    describe(rel, () => {
      it('exists and carries the contract markers', () => {
        expect(existsSync(join(repoRoot, rel)), `${rel} must exist`).toBe(true);
        const text = read(rel);
        expect(text, 'one sr-only caption announces the loading state').toContain('<span role="status" className="sr-only">{dict.states.loading}</span>');
        expect(text.indexOf('aria-hidden="true"'), 'decorative nodes are aria-hidden').toBeGreaterThanOrEqual(0);
        expect(text, 'at least one shimmer honours prefers-reduced-motion').toContain('motion-reduce:animate-none');
      });

      it('renders no hand-set copy (the dictionary is the only source)', () => {
        const text = read(rel);
        // an sr-only caption that does NOT read from the dictionary would leak copy into the tree
        expect(text).toContain('{dict.states.loading}');
        // none of the two dict values appears as a literal anywhere else in the file
        expect(text).not.toContain('Loading…');
        expect(text).not.toContain('加載中');
      });
    });
  }

  it('the reduced-motion whitelist in the design system cancels these shimmers', () => {
    const css = read('packages/ui/src/styles/tokens.css');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.nexus-shimmer');
  });
});
