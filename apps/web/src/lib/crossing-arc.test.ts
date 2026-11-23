import { describe, expect, it } from 'vitest';

import { CROSSING_ARC_SLUGS, crossingArcFor } from './crossing-arc';
import { TICKET_ARC_SLUGS } from './ticket-arc';
import { mockGuide } from './mock';

/**
 * D1567 — the crossing arc is the second CURATED path through five real chapters, so the test
 * charges the same three things the ticket arc's test charges: the shape of the walk (ends,
 * neighbours, positions), the fact that every named slug actually ships in every locale, and
 * that the two arcs stay disjoint — a chapter belongs to at most one curated line.
 */

describe('crossing arc', () => {
  it('walks five chapters in reading order with honest ends', () => {
    expect(CROSSING_ARC_SLUGS).toHaveLength(5);
    const first = crossingArcFor(CROSSING_ARC_SLUGS[0]!);
    const last = crossingArcFor(CROSSING_ARC_SLUGS[4]!);
    const middle = crossingArcFor(CROSSING_ARC_SLUGS[2]!);

    expect(first).toMatchObject({ step: 1, total: 5, prev: null, next: CROSSING_ARC_SLUGS[1] });
    expect(last).toMatchObject({ step: 5, total: 5, next: null, prev: CROSSING_ARC_SLUGS[3] });
    expect(middle).toMatchObject({
      step: 3,
      prev: CROSSING_ARC_SLUGS[1],
      next: CROSSING_ARC_SLUGS[3],
    });
  });

  it('every slug in the arc is a chapter the corpus actually carries, in every locale', () => {
    for (const slug of CROSSING_ARC_SLUGS) {
      for (const locale of ['zh-HK', 'zh-CN', 'en'] as const) {
        const guide = mockGuide(slug, locale);
        expect(guide, `${locale} missing arc chapter ${slug}`).toBeDefined();
        expect(guide?.slug).toBe(slug);
      }
    }
  });

  it('a chapter outside the arc is not offered a place in it', () => {
    expect(crossingArcFor('hk-sha-tin-to-central-night-ticket-chronicle')).toBeNull();
    expect(crossingArcFor('not-a-chapter')).toBeNull();
    expect(crossingArcFor('')).toBeNull();
  });

  it('the two curated arcs are disjoint — no chapter serves two lines', () => {
    const shared = CROSSING_ARC_SLUGS.filter((slug) =>
      (TICKET_ARC_SLUGS as readonly string[]).includes(slug),
    );
    expect(shared).toEqual([]);
  });

  it('the five chapters really do tell one story about the border, across the arms', () => {
    const prose = CROSSING_ARC_SLUGS.map((slug) => {
      const en = mockGuide(slug, 'en');
      return (en?.body_blocks ?? [])
        .map((b) => (b.type === 'paragraph' || b.type === 'heading' ? b.text : ''))
        .join(' ');
    });
    for (const text of prose) expect(text).toMatch(/border|crossing|gate|truck|Man Kam To|Huanggang|Lo Wu/i);
    // The arc begins with the first rice truck through the gate and ends with the second one out.
    expect(prose[0]).toMatch(/Man Kam To|rice/i);
    expect(prose[4]).toMatch(/second truck|eight/i);
  });
});
