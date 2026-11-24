import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1563 — the wiring discipline: copy exists in BOTH authored arms, the rail is mounted on the
 * chapter page, and the page derives its titles from the current locale's corpus (so a rename
 * upstream can never leave a stale string inside the rail).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const KEYS = ['eyebrow', 'title', 'intro', 'progress', 'previous', 'next', 'pathLabel'] as const;

describe('ticket arc wiring', () => {
  it('both authored arms carry every copy key', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    for (const key of KEYS) {
      // One key in the type declaration, one value in each of the two arms.
      expect(dict.split(`${key}:`).length - 1, `ticketArc.${key} multiplicity`).toBeGreaterThanOrEqual(3);
    }
    expect(dict).toContain('ticketArc: {');
    expect(dict).toContain('這張票，走過了香港的一天');
    expect(dict).toContain('This ticket walked a whole Hong Kong day');
  });

  it('the simplified arms are regenerated from the authored ones', () => {
    const cn = read('apps/web/src/lib/i18n/dict-cn.ts');
    expect(cn).toContain('ticketArc: {');
    expect(cn).toContain('这张票，走过了香港的一天');
  });

  it('the chapter page mounts the rail behind a null-safe arc lookup', () => {
    const page = read('apps/web/app/guides/[slug]/page.tsx');
    expect(page).toContain("import { TicketArcRail } from '@/components/ticket-arc-rail'");
    expect(page).toContain('ticketArcFor(guide.slug)');
    expect(page).toContain('if (!arc) return null;');
    // D1567 + D1590: copy follows the arc — ticket, crossing or timetable.
    expect(page).toContain('ticket ? dict.growth.ticketArc : crossing ? dict.growth.crossingArc : dict.growth.timetableArc');
  });

  it('the rail derives all five titles from the corpus, in the current locale', () => {
    const page = read('apps/web/app/guides/[slug]/page.tsx');
    expect(page).toContain('corpus.find((g) => g.slug === s)?.title');
  });
});

describe('crossing arc wiring (D1567)', () => {
  it('both authored arms carry every copy key', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    for (const key of KEYS) {
      // One key in the type declaration, one value in each of the two arms.
      expect(dict.split(`${key}:`).length - 1, `crossingArc.${key} multiplicity`).toBeGreaterThanOrEqual(6);
    }
    expect(dict).toContain('crossingArc: {');
    expect(dict).toContain('同一道口岸，由午夜走到早晨');
    expect(dict).toContain('One border, from midnight into the morning');
  });

  it('the simplified arms are regenerated from the authored ones', () => {
    const cn = read('apps/web/src/lib/i18n/dict-cn.ts');
    expect(cn).toContain('crossingArc: {');
    expect(cn).toContain('同一道口岸，由午夜走到早晨');
  });

  it('the chapter page mounts the second arc behind the same null-safe lookup', () => {
    const page = read('apps/web/app/guides/[slug]/page.tsx');
    expect(page).toContain("import { crossingArcFor, CROSSING_ARC_SLUGS } from '@/lib/crossing-arc'");
    expect(page).toContain('crossingArcFor(guide.slug)');
    expect(page).toContain("ticket ? dict.growth.ticketArc : crossing ? dict.growth.crossingArc : dict.growth.timetableArc");
  });
});
