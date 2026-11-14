import { describe, expect, it } from 'vitest';

import { almanacIndex, cyrb53, hkDateKey } from './almanac';

describe('D1112 HK daily almanac — the algorithm layer', () => {
  it('cyrb53 is deterministic and stable across repeat calls', () => {
    expect(cyrb53('2026-11-14')).toBe(cyrb53('2026-11-14'));
    expect(Number.isInteger(cyrb53(''))).toBe(true);
    expect(cyrb53('2026-11-14')).not.toBe(cyrb53('2026-11-15'));
  });

  it('cyrb53 stays inside 53 bits so it round-trips losslessly as a JS number', () => {
    for (const key of ['2026-01-01', '2026-12-31', '1970-01-01', '2030-06-30', '2099-02-28']) {
      const h = cyrb53(key);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(Number(1n << 53n));
    }
  });

  it('almanacIndex always lands inside the pool and refuses an empty pool', () => {
    for (const size of [1, 2, 7, 12, 33]) {
      const idx = almanacIndex('2026-11-14', size);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(size);
    }
    expect(() => almanacIndex('2026-11-14', 0)).toThrow(RangeError);
  });

  it('adjacent days produce different indices almost surely (no two-year stasis)', () => {
    const first = almanacIndex('2026-11-14', 12);
    const hits = new Set<number>();
    for (let d = 0; d < 30; d += 1) {
      const key = `2026-11-${String(d + 1).padStart(2, '0')}`;
      hits.add(almanacIndex(key, 12));
    }
    // 30 days across a pool of 12 — a deterministic hash must show up somewhere else.
    expect(hits.size).toBeGreaterThan(1);
    expect(first).toBe(almanacIndex('2026-11-14', 12));
  });

  it('hkDateKey orders en-CA as YYYY-MM-DD and respects the Asia/Hong_Kong zone', () => {
    // 2026-11-14T16:30:00Z is already 2026-11-15 00:30 in HK.
    expect(hkDateKey(new Date('2026-11-14T16:30:00Z'))).toBe('2026-11-15');
    expect(hkDateKey(new Date('2026-11-14T15:59:59Z'))).toBe('2026-11-14');
  });

  it('the island ships no telemetry surface and no fetch path', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const island = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'hk-daily-almanac.tsx'),
      'utf8',
    );
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('XMLHttpRequest');
    expect(island).not.toContain('analytics');
  });
});
