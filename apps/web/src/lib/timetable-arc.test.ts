import { describe, expect, it } from 'vitest';
import { mockGuide } from './mock';
import { timetableArcFor, TIMETABLE_ARC_SLUGS } from './timetable-arc';

/** D1590 — the timetable arc is a curated path through four real chapters, walkable both ways. */
describe('timetable arc', () => {
  it('names eight shipped chapters in order', () => {
    expect(TIMETABLE_ARC_SLUGS).toHaveLength(8);
    for (const slug of TIMETABLE_ARC_SLUGS) {
      expect(mockGuide(slug, 'zh-HK')?.slug, `missing ${slug}`).toBe(slug);
      expect(mockGuide(slug, 'en')?.slug, `missing EN arm ${slug}`).toBe(slug);
    }
  });

  it('gives honest positions and nulls at the two ends', () => {
    const first = timetableArcFor(TIMETABLE_ARC_SLUGS[0]!);
    expect(first?.step).toBe(1);
    expect(first?.total).toBe(8);
    expect(first?.prev).toBeNull();
    expect(first?.next).toBe(TIMETABLE_ARC_SLUGS[1]);
    const last = timetableArcFor(TIMETABLE_ARC_SLUGS[7]!);
    expect(last?.step).toBe(8);
    expect(last?.next).toBeNull();
    expect(last?.prev).toBe(TIMETABLE_ARC_SLUGS[6]);
    expect(timetableArcFor('hk-mong-kok-ging-fa-shu-mai-chronicle')).toBeNull();
  });
});
