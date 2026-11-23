import { describe, expect, it } from 'vitest';
import { demoBehavior, eventsForDay } from './behavior-events';

/** D1513 — the §九 behavior simulation must be deterministic, labelled and non-empty. */
describe('demo behavior events', () => {
  it('is deterministic for the same HK date', () => {
    const a = demoBehavior('2026-11-21', 'zh-HK');
    const b = demoBehavior('2026-11-21', 'zh-HK');
    expect(a).toEqual(b);
    expect(a.total_events).toBeGreaterThan(0);
    expect(a.demo).toBe(true);
    expect(a.degraded).toBe(false);
  });

  it('a different day brings a different crowd', () => {
    const a = demoBehavior('2026-11-21', 'zh-HK');
    const b = demoBehavior('2026-11-22', 'zh-HK');
    expect(a.total_events).not.toBe(b.total_events);
  });

  it('carries all the fields the analytics page renders', () => {
    const r = demoBehavior('2026-11-21', 'en');
    expect(r.daily).toHaveLength(7);
    expect(r.hourly).toHaveLength(24);
    expect(r.projection_next_7_days).toHaveLength(7);
    expect(r.top_events.length).toBeGreaterThan(0);
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations.every((x) => x.startsWith('demo'))).toBe(true);
  });

  it('daily totals sum to the grand total and hourly sums match', () => {
    const r = demoBehavior('2026-11-21', 'zh-HK');
    expect(r.daily.reduce((a, [, n]) => a + n, 0)).toBe(r.total_events);
    expect(r.hourly.reduce((a, h) => a + h.n, 0)).toBe(r.total_events);
  });

  it('the funnel is ordered, shares are honest, and the weakest transition is named (D1569)', () => {
    const r = demoBehavior('2026-11-21', 'zh-HK');
    expect(r.funnel.map((f) => f.step)).toEqual(['view', 'click', 'search', 'read', 'save']);
    // Every session starts with a view; a day's crowd may not reach every step — zero is honest.
    expect(r.funnel[0]!.share).toBe(1);
    expect(r.funnel.every((f) => f.share >= 0 && f.share <= 1 && f.sessions <= r.profiles.reduce((a, p) => a + p.sessions, 0))).toBe(true);
    const weakest = r.recommendations.find((x) => x.includes('weakest transition'));
    expect(weakest).toMatch(/demo funnel weakest transition: \w+→\w+ keeps \d+% of sessions/);
    // Profiles: one row per ghost crowd; every session belongs to exactly one profile, and
    // depths are real event-set sizes bounded by the pipeline length.
    expect(r.profiles.length).toBeGreaterThan(0);
    expect(r.profiles.every((p) => p.sessions > 0 && p.avg_depth >= 1 && p.avg_depth <= 5)).toBe(true);
    const sorted = [...r.profiles].sort((a, b) => b.sessions - a.sessions);
    expect(r.profiles.map((p) => p.actor)).toEqual(sorted.map((p) => p.actor));
  });

  it('one day of raw events is honest and shaped right', () => {
    const rows = eventsForDay('2026-11-21', 'zh-HK');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.session_id.startsWith('demo-') && e.hour >= 0 && e.hour < 24)).toBe(true);
  });
});
