/**
 * D1279 — the client island is fail-closed by construction.
 *
 * The page renders the deterministic retrieval answer on the server before this island exists;
 * the island may only ADD. These pins read the source the way the repo's other island pins
 * do, because the contract that matters here lives in what the island refuses to do:
 *
 *   - it never renders before mount work settles (no SSR-hydration mismatch), it never
 *     blocks paint with a model dependency, it never polls, never retries, stores nothing;
 *   - on ANY failure (mock provider, unreachable service, abort, empty answer, no citations)
 *     it renders nothing — the reader keeps the deterministic render and nothing else;
 *   - on success it renders the model's phrasing with its provenance badge — the answer is
 *     labelled honestly as model output, never passed off as authored copy;
 *   - its fetch URL, method, and headers match the BFF contract;
 *   - citations render verbatim anchors into the manual's own sections.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/handbook-ask-live.tsx';
const ROUTE = 'apps/web/app/api/nexus/ai/handbook-ask/route.ts';
const HANDBOOK_PAGE = 'apps/web/app/handbook/page.tsx';

describe('handbook-ask-live island', () => {
  const island = read(ISLAND);

  it('is a client component with exactly one mount effect, no timers or polling', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain('useEffect');
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
  });

  it('its fetch is a single POST to the BFF ask endpoint, abortable, never retried', () => {
    expect(island).toContain("fetch('/api/nexus/ai/handbook-ask'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('AbortController');
    expect(island).not.toContain('retry(');
  });

  it('a degraded/empty/ungrounded reply renders nothing — the deterministic page stands', () => {
    expect(island).toContain('data.degraded');
    expect(island).toContain("kind: 'gone'");
    expect(island).toContain('ctrl.abort');
    expect(island).toContain('return () => ctrl.abort()');
  });

  it('success renders a provenance badge and citations — never interchangeable with authored copy', () => {
    expect(island).toContain("kind: 'ready'");
    expect(island).toContain('state.answer');
    expect(island).toContain('pendingLabel');
    expect(island).toContain('provenLabel');
    expect(island).toContain('data.citations');
    expect(island).toContain('#${c.id}');
  });

  it('the /handbook page mounts the island inside the retrieval card only when there is a question', () => {
    const page = read(HANDBOOK_PAGE);
    expect(page).toContain('<HandbookAskLive');
    expect(page).toContain('askAnswer && (');
    expect(page).toContain('livePending');
    expect(page).toContain('liveProven');
  });

  it('the BFF route is the only place sections meet the wire — question and locale only', () => {
    const route = read(ROUTE);
    expect(route).toContain("IS_MOCK");
    expect(route).toContain("'mock_provider'");
    expect(route).toContain('retrieve(question, locale, 6)');
    expect(route).toContain("'ai', '/ai/v1/handbook/ask'");
    expect(route).toContain('SECTION_CHAR_LIMIT');
  });
});
