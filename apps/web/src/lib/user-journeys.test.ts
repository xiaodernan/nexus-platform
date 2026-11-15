/**
 * D1206 — pins for the seeded ghost simulator. The module is pure; the pins are about shape,
 * determinism, and the two bilingual arms lighting equally.
 */

import { describe, expect, it } from 'vitest';

import { simulateJourneys, explainSnapshot, hourLabel } from './user-journeys';

describe('simulateJourneys (zh-HK)', () => {
  it('is deterministic for the same HK date', () => {
    const first = simulateJourneys('2026-11-15', 'zh-HK');
    const second = simulateJourneys('2026-11-15', 'zh-HK');
    expect(second.total).toBe(first.total);
    expect(second.buckets).toEqual(first.buckets);
    expect(second.hourRamp).toEqual(first.hourRamp);
  });

  it('changes with the date', () => {
    const a = simulateJourneys('2026-11-15', 'zh-HK');
    const b = simulateJourneys('2026-11-16', 'zh-HK');
    expect(a.hourRamp).not.toEqual(b.hourRamp);
  });

  it('always drives the six-profile mirror', () => {
    const snap = simulateJourneys('2026-11-15', 'zh-HK');
    expect(snap.buckets).toHaveLength(6);
    expect(snap.buckets.map((b) => b.profile)).toEqual(['匆匆客', '細讀生', '漫遊者', '瞎點黨', '靜默離場', '收藏家']);
  });

  it('carries zh copy for the recommendation and explain body', () => {
    const snap = simulateJourneys('2026-11-15', 'zh-HK');
    expect(snap.recommendation).toContain('讀者');
    expect(explainSnapshot(snap, 'zh-HK').body).toContain('今天的最高峰');
    expect(snap.headline).toContain('幽靈');
  });

  it('returns a sum equal to the provided total and a dated stamp', () => {
    const snap = simulateJourneys('2026-11-15', 'zh-HK');
    expect(snap.total).toBe(22);
    expect(snap.date).toBe('2026-11-15');
  });
});

describe('simulateJourneys (en)', () => {
  it('is deterministic for the same HK date', () => {
    const first = simulateJourneys('2026-11-15', 'en');
    const second = simulateJourneys('2026-11-15', 'en');
    expect(second.buckets).toEqual(first.buckets);
  });

  it('carries en copy for the recommendation and explain body', () => {
    const snap = simulateJourneys('2026-11-15', 'en');
    expect(snap.headline).toMatch(/ghosts/i);
    expect(snap.recommendation).toMatch(/reader/i);
    expect(explainSnapshot(snap, 'en').body).toContain('Top arrival');
  });

  it('mirror activates the same six profiles in English', () => {
    const snap = simulateJourneys('2026-11-15', 'en');
    expect(snap.buckets.map((b) => b.profile)).toEqual([
      'impatient glance',
      'slow reader',
      'window shopper',
      'random tapper',
      'silent bounce',
      'bookmarker',
    ]);
  });
});

describe('hourLabel helper', () => {
  it('renders bilingual labels', () => {
    expect(hourLabel(7, 'zh-HK')).toBe('07點');
    expect(hourLabel(7, 'en')).toBe('07:00');
  });
});
