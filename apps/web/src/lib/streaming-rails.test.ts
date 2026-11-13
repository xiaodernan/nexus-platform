import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1032 — the home route streams its five rails, one `<Suspense>` boundary each, and this probe
 * keeps that architecture load-bearing rather than aspirational.
 *
 * What is pinned:
 *   1. `app/page.tsx` maps `RAIL_ORDER` into one `<Suspense>` per rail with
 *      `fallback={<RailSkeleton />}` — never a `Promise.allSettled` that waits on the slowest
 *      rail before first paint, never a `homeRails` import (the promise of streamed children);
 *   2. `rails-stream.ts` exports `RAIL_ORDER` exactly the five rails, the shared
 *      `loadRailCards` loader, and keeps the browser-out guard;
 *   3. `rail-section.tsx` re-renders `dict.merchant.degradedTitle` on fetch failure — the §105
 *      partial-page-with-stated-reason policy, now per section instead of page-wide;
 *   4. `rail-skeleton.tsx` carries the same copy discipline as the loading boundaries —
 *      sr-only `dict.states.loading`, aria-hidden decorative layers, motion-reduce collapse;
 *   5. `data.ts` holds `homeRails` — the degrade test's pinned entry point — composed over
 *      `RAIL_DEFS`, with the degraded reason formula preserved.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = read('apps/web/app/page.tsx');
const STREAM = read('apps/web/src/lib/rails-stream.ts');
const SECTION = read('apps/web/src/components/rail-section.tsx');
const SKELETON = read('apps/web/src/components/rail-skeleton.tsx');
const DATA = read('apps/web/src/lib/data.ts');

describe('D1032 — the streamed-home architecture is load-bearing', () => {
  it('the page maps RAIL_ORDER into <Suspense> boundaries, and no longer waits', () => {
    expect(PAGE).toContain("import { RAIL_ORDER } from '@/lib/rails-stream';");
    expect(PAGE.match(/RAIL_ORDER.map/g)?.length).toBe(1); // the boundary map itself
    expect(PAGE).toContain('<Suspense key={key} fallback={<RailSkeleton />}>');
    expect(PAGE).toContain('<RailSection railKey={key}');
    expect(PAGE).not.toContain('homeRails(');
    expect(PAGE).not.toContain('allSettled');
  });

  it('RAIL_ORDER and the loader are exported and server-only', () => {
    expect(STREAM).toContain("['popular_near_you', 'for_you', 'trending', 'recommended', 'recently_viewed'] as const");
    expect(STREAM).toContain('export async function loadRailCards');
    expect(STREAM).toContain("if (typeof window !== 'undefined')");
  });

  it('a rail whose fetch throws renders the dictionary’s degrade title, never fixtures', () => {
    expect(SECTION).toContain('dict.merchant.degradedTitle');
    expect(SECTION).toContain('cards = null;');
    expect(SECTION).toContain("if (cards === null)");
    expect(SECTION).toContain('export async function RailSection');
    expect(SECTION).not.toContain('mockHomeRails(');
    expect(SECTION).not.toContain('loadHomeRails');
  });

  it('the fallback skeleton honours the same copy and a11y discipline as the boundaries', () => {
    expect(SKELETON).toContain('<span role="status" className="sr-only">{dict.states.loading}</span>');
    expect(SKELETON).toContain('aria-hidden="true"');
    expect(SKELETON).toContain('motion-reduce:animate-none');
    expect(SKELETON).toContain('rail-scroll');
  });

  it('homeRails keeps its pinned contract — composed over RAIL_DEFS, degraded line intact', () => {
    expect(DATA).toContain('export async function homeRails');
    expect(DATA).toContain('RAIL_DEFS.map((def) => loadRailCards(def.key, request))');
    expect(DATA).toContain('rails unavailable`)');
    expect(DATA).toContain("export type { RailsRequest } from './rails-stream';");
  });
});
