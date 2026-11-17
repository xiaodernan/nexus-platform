/**
 * D1306 — the world-guide beacon is fail-closed by construction, with one deliberate exception.
 *
 * The chapter stands fine without the model; this card only ADDS a compass button. These pins
 * read the source the way the repo's island pins do:
 *
 *   - it is a client component with no timers, no polling, no storage;
 *   - it POSTs exactly once to the BFF world-guide endpoint with slug + locale + surface;
 *   - the only answer it renders is the one the server sent — including the lane's deterministic
 *     LIVE fallback template (a product-authored compass, clearly not a model invention); an
 *     EMPTY answer (mock mode / hard failure) renders NOTHING, §105 discipline intact;
 *   - the suggestion chips are the doors the deterministic selection chose (passed through from
 *     the server), never slugs the model made up.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const ISLAND = 'apps/web/src/components/world-guide-beacon.tsx';
const ROUTE = 'apps/web/app/api/nexus/ai/world-guide/route.ts';
const CHAPTER_PAGE = 'apps/web/app/guides/[slug]/page.tsx';
const HOME_PAGE = 'apps/web/app/page.tsx';
const GUIDES_INDEX = 'apps/web/app/guides/page.tsx';

describe('world-guide-beacon island', () => {
  const island = readFileSync(join(repoRoot, ISLAND), 'utf8');

  it('is a client component with exactly one ask path, no timers, no storage, no retry', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
    expect(island).not.toContain('retry(');
  });

  it('its only network call is a single POST to the BFF world-guide endpoint', () => {
    expect(island).toContain("fetch('/api/nexus/ai/world-guide'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('chapterSlug');
    expect(island).toContain('surface');
  });

  it('an empty answer renders nothing — the chapter stands', () => {
    expect(island).toContain("if (phase.kind === 'gone') return null;");
    expect(island).toContain('answer.trim().length > 0');
  });

  it('it renders only the server-passed answer and suggestion doors (never invented text)', () => {
    expect(island).toContain('phase.answer');
    expect(island).toContain('phase.suggestions');
    expect(island).toContain('/guides/${s.slug}');
    expect(island).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('the world-guide BFF curates the doors; the AI lane only phrases', () => {
  const route = readFileSync(join(repoRoot, ROUTE), 'utf8');

  it('curates candidates from the same read path the reader uses, never from the model', () => {
    expect(route).toContain('guideList');
    expect(route).toContain("'/ai/v1/world/guide'");
    expect(route).toContain('MAX_CANDIDATES');
  });

  it('in mock mode the lane is inert (CI and offline never pay for a call)', () => {
    expect(route).toContain('mock_provider');
    expect(route).toContain('IS_MOCK');
  });
});

describe('the chapter page mounts the beacon once, beside the companion', () => {
  const page = readFileSync(join(repoRoot, CHAPTER_PAGE), 'utf8');

  it('renders GuideView, the companion and the beacon exactly once each, with dict labels', () => {
    expect(page).toContain('<GuideView guide={guide} locale={locale} />');
    expect(page).toContain('<WorldGuideBeacon');
    expect(page).toContain('labels={dict.growth.worldGuide}');
    expect((page.match(/<WorldGuideBeacon/g) ?? []).length).toBe(1);
    expect((page.match(/<ChapterAskLive/g) ?? []).length).toBe(1);
  });

  it('the front door and the trailhead each mount the beacon exactly once', () => {
    const home = readFileSync(join(repoRoot, HOME_PAGE), 'utf8');
    expect(home).toContain('<WorldGuideBeacon');
    expect(home).toContain('surface="home"');
    expect(home).toContain('labels={dict.growth.worldGuide}');
    expect((home.match(/<WorldGuideBeacon/g) ?? []).length).toBe(1);
    const trailhead = readFileSync(join(repoRoot, GUIDES_INDEX), 'utf8');
    expect(trailhead).toContain('<WorldGuideBeacon');
    expect(trailhead).toContain('surface="guides"');
    expect((trailhead.match(/<WorldGuideBeacon/g) ?? []).length).toBe(1);
  });

  it('all three locales carry the worldGuide labels', () => {
    const dict = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict.ts'), 'utf8');
    expect((dict.match(/worldGuide: \{/g) ?? []).length).toBe(3); // interface + zh-HK + en
    const dictCn = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict-cn.ts'), 'utf8');
    expect((dictCn.match(/worldGuide: \{/g) ?? []).length).toBe(1);
  });
});
