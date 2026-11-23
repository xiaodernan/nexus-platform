import { describe, expect, it } from 'vitest';

import { TICKET_ARC_SLUGS, ticketArcFor } from './ticket-arc';
import { mockGuide } from './mock';

/**
 * D1563 — the ticket arc is a CURATED path through five real chapters, so the test charges
 * three things: the shape of the walk (ends, neighbours, positions), the fact that every named
 * slug actually ships, and that no other chapter accidentally joins the arc.
 */

describe('ticket arc', () => {
  it('walks five chapters in reading order with honest ends', () => {
    expect(TICKET_ARC_SLUGS).toHaveLength(5);
    const first = ticketArcFor(TICKET_ARC_SLUGS[0]!);
    const last = ticketArcFor(TICKET_ARC_SLUGS[4]!);
    const middle = ticketArcFor(TICKET_ARC_SLUGS[2]!);

    expect(first).toMatchObject({ step: 1, total: 5, prev: null, next: TICKET_ARC_SLUGS[1] });
    expect(last).toMatchObject({ step: 5, total: 5, next: null, prev: TICKET_ARC_SLUGS[3] });
    expect(middle).toMatchObject({
      step: 3,
      prev: TICKET_ARC_SLUGS[1],
      next: TICKET_ARC_SLUGS[3],
    });
  });

  it('every slug in the arc is a chapter the corpus actually carries, in every locale', () => {
    for (const slug of TICKET_ARC_SLUGS) {
      for (const locale of ['zh-HK', 'zh-CN', 'en'] as const) {
        const guide = mockGuide(slug, locale);
        expect(guide, `${locale} missing arc chapter ${slug}`).toBeDefined();
        expect(guide?.slug).toBe(slug);
      }
    }
  });

  it('a chapter outside the arc is not offered a place in it', () => {
    expect(ticketArcFor('hk-sha-tin-shui-chuen-o-morning-bus-chronicle')).toBeNull();
    expect(ticketArcFor('not-a-chapter')).toBeNull();
    expect(ticketArcFor('')).toBeNull();
  });

  it('the five chapters really do tell one story about the ticket, across the arms', () => {
    const words = TICKET_ARC_SLUGS.map((slug) => {
      const en = mockGuide(slug, 'en');
      return (en?.body_blocks ?? [])
        .map((b) => (b.type === 'paragraph' || b.type === 'heading' ? b.text : ''))
        .join(' ');
    });
    for (const prose of words) expect(prose).toMatch(/ticket/i);
    // The arc begins with a nameless one and ends with a ticket already waiting at the terminus.
    expect(words[0]).toMatch(/nameless/i);
    expect(words[4]).toMatch(/terminus/i);
  });
});
