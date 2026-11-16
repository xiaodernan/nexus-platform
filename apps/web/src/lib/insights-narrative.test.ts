/**
 * D1280 — the insights narrative island is fail-closed by construction.
 *
 * The deterministic ghost view renders on the server first and the island may only ADD a
 * second read — a provenance-badged model paragraph. These pins hold the island to its
 * contract: no polling, no storage, no blocking paint, nothing on mock failure.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/insights-narrative.tsx';
const PAGE = 'apps/web/app/insights/page.tsx';

describe('insights-narrative island', () => {
  const island = read(ISLAND);

  it('is a client component with one mount effect, no timers, no polling, no storage', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain('useEffect');
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
  });

  it('one POST on mount, abortable, fail-closed on ANY failure', () => {
    expect(island).toContain("fetch('/api/nexus/ai/insights-read'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('AbortController');
    expect(island).toContain('return () => ctrl.abort()');
    expect(island).toContain("kind: 'gone'");
  });

  it('success renders a provenance badge and never an unlabelled model claim', () => {
    expect(island).toContain('provenLabel');
    expect(island).toContain('focusLabel');
    expect(island).toContain('state.paragraph');
    expect(island).toContain('state.focus');
  });

  it('the /insights page mounts it after the deterministic views, inside the same render tree', () => {
    const page = read(PAGE);
    expect(page).toContain('<InsightsNarrative');
    expect(page).toContain('narrativePending');
    expect(page).toContain('narrativeProven');
  });
});
