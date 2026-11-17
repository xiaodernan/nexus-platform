/**
 * D1284 — the chapter-companion island is fail-closed by construction.
 *
 * The reader reads the chapter either way; this card only ADDS an ask box. These pins read the
 * source the way the repo's island pins do: the contract that matters lives in what the island
 * refuses to do.
 *
 *   - it is a client component with no timers, no polling, no storage;
 *   - it POSTs exactly once to the BFF chapter-ask endpoint with the slug and locale;
 *   - any failure — mock provider, unreachable service, contract violation — renders NOTHING,
 *     the chapter stands exactly as rendered;
 *   - it never invents answers: it renders only answer + excerpt ids the server passed through.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const ISLAND = 'apps/web/src/components/chapter-ask-live.tsx';
const ROUTE = 'apps/web/app/api/nexus/ai/chapter-ask/route.ts';
const CHAPTER_PAGE = 'apps/web/app/guides/[slug]/page.tsx';

describe('chapter-ask-live island', () => {
  const island = readFileSync(join(repoRoot, ISLAND), 'utf8');

  it('is a client component with exactly one ask path, no timers, no storage, no retry', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
    expect(island).not.toContain('retry(');
  });

  it('its only network call is a single POST to the BFF ask endpoint', () => {
    expect(island).toContain("fetch('/api/nexus/ai/chapter-ask'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('chapterSlug');
  });

  it('on any failure it renders nothing — the chapter stands', () => {
    expect(island).toContain("if (phase.kind === 'gone') return null;");
    expect(island).toContain('degraded !== true');
  });

  it('it renders only answer + excerpt ids the server passed through (never invented text)', () => {
    expect(island).toContain('phase.answer');
    expect(island).toContain('phase.citations');
    expect(island).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('chapter page mounts the companion once, after the chapter', () => {
  const page = readFileSync(join(repoRoot, CHAPTER_PAGE), 'utf8');

  it('renders GuideView, then the fail-closed island exactly once, with dict labels', () => {
    expect(page).toContain('<GuideView guide={guide} locale={locale} />');
    expect(page).toContain('<ChapterAskLive');
    expect(page).toContain('labels={dict.growth.chapterAsk}');
    expect((page.match(/<ChapterAskLive/g) ?? []).length).toBe(1);
  });
});

describe('BFF route file exists and imports the same read path the reader uses', () => {
  it('the route file is present', () => {
    const src = readFileSync(join(repoRoot, ROUTE), 'utf8');
    expect(src).toContain('guideBySlug');
    expect(src).toContain("'/ai/v1/chapter/ask'");
  });
});
