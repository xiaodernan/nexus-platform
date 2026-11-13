import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1039 — the homepage rails finally render as they did at the start of the microservice arc:
 * one allSettled composition, cards SSR'd with the rails themselves, no hydration discipline
 * standing in the way. This probe pins what the rail pipeline still guarantees after the
 * D1039 reversion — meaning the server does the wait, the browser receives complete rails.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = read('apps/web/app/page.tsx');
const HOME_RAILS = read('apps/web/src/lib/rails-stream.ts');
const DATA = read('apps/web/src/lib/data.ts');

describe('D1039 — the server-side rail discipline: settled at render, not streamed', () => {
  it('page.tsx composes rails through the settled homeRails(), not Suspense', () => {
    expect(PAGE).toContain('await homeRails(');
    expect(PAGE).not.toContain('<Suspense');
    expect(PAGE).toContain('<CardRail');
  });

  it('rails-stream exports RAIL_ORDER in canonical order', () => {
    expect(HOME_RAILS).toContain("['popular_near_you', 'for_you', 'trending', 'recommended', 'recently_viewed'] as const");
    expect(HOME_RAILS).toContain('export async function loadRailCards');
    expect(HOME_RAILS).toContain('RAIL_DEFS');
  });

  it('homeRails holds the \'FAILED-of-X\' degraded contract', () => {
    expect(DATA).toContain('export async function homeRails');
    expect(DATA).toContain('RAIL_DEFS.map((def) => loadRailCards(def.key, request))');
    expect(DATA).toContain('rails unavailable`)');
    expect(DATA).toContain('export type { RailsRequest, RailKey }');
  });
});
