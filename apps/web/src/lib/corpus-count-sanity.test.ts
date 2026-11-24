import { describe, expect, it } from 'vitest';
import { mockGuides } from './mock';

describe('atlas corpus count', () => {
  it('every locale sees all 191 numbered HK chapters from the seed', () => {
    for (const locale of ['zh-HK', 'zh-CN', 'en']) {
      const chapters = mockGuides(locale).filter((g) => g.slug.startsWith('hk-'));
      expect(chapters.length).toBe(191);
    }
  });
});
