import { describe, expect, it } from 'vitest';

import { mockGuides } from './mock';
import type { Guide } from './types';
import { readingThread, threadProgress, threadTokens } from './reading-thread';

/**
 * D1517 — the reading thread (§六): which door to open next, and why.
 *
 * The corpus is 177 chapters and an index is a list, not a path. These legs pin the properties the
 * promise rests on — determinism, no door already walked, a reason attached to every door, a thread
 * that spans the reader's world instead of clustering in it, and the honest empty states.
 */

const guide = (slug: string, title: string, body: string): Guide => ({
  slug,
  title,
  description: body,
  city: 'hong-kong',
  category: 'activities',
  body_blocks: [{ type: 'paragraph', text: body }],
  generated_by: 'ai',
  reviewed_by_human: false,
  published_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  flags: { demo: true },
});

const CORPUS: Guide[] = [
  guide('a', '叉燒的早上', '叉燒 爐火 清晨 的 第一碟 飯'),
  guide('b', '叉燒的黃昏', '叉燒 爐火 黃昏 的 最後一碟 飯'),
  guide('c', '雨天的走廊', '有蓋 走廊 雨天 港鐵 一站'),
  guide('d', '完全無關的一章', '量子 潮汐 恆星 演算 尺規'),
];

describe('the copy crosses into a client island, so it is all strings', () => {
  // D1521: D1517 shipped this copy with three arrow functions in it. The page is a Server
  // Component and the island a Client Component, so Next.js refused the payload at render time
  // and the whole /guides page answered 加載失敗 — the feature was invisible in the browser
  // while every unit test was green, because no test looked at the payload's SHAPE. The
  // counters and the 《title》 wrapper are templates now, and this leg is the guard.
  it('carries no function in any locale', async () => {
    const { getDict } = await import('./i18n');
    for (const locale of ['zh-HK', 'zh-CN', 'en'] as const) {
      const copy = getDict(locale).growth.readingThread as Record<string, unknown>;
      for (const [key, value] of Object.entries(copy)) {
        expect(typeof value, `${locale}.growth.readingThread.${key}`).toBe('string');
      }
    }
  });

  it('every template names the placeholders it will be filled with', async () => {
    const { getDict } = await import('./i18n');
    for (const locale of ['zh-HK', 'zh-CN', 'en'] as const) {
      const copy = getDict(locale).growth.readingThread;
      expect(copy.progress).toContain('{read}');
      expect(copy.progress).toContain('{total}');
      expect(copy.percent).toContain('{percent}');
      expect(copy.via).toContain('{title}');
    }
  });
});

describe('threadTokens', () => {
  it('carries CJK bigrams and Latin words, and nothing else', () => {
    const tokens = threadTokens('叉燒 Ra men 叉燒');
    expect(tokens.has('叉燒')).toBe(true);
    expect(tokens.has('ra')).toBe(true);
    expect(tokens.has('men')).toBe(true);
    expect(tokens.size).toBe(3);
  });

  it('does not bridge a CJK/Latin boundary into a fake bigram', () => {
    // the CJK run ends where the Latin word begins, so the bigram inside the run survives and the
    // boundary itself never becomes a token.
    const tokens = threadTokens('叉燒ra');
    expect(tokens.has('叉燒')).toBe(true);
    expect(tokens.has('燒r')).toBe(false);
    expect(tokens.has('ra')).toBe(true);
    expect(tokens.size).toBe(2);
  });
});

describe('readingThread', () => {
  it('offers the chapter that continues what the reader finished', () => {
    const thread = readingThread(CORPUS, ['a'], { steps: 1 });
    expect(thread).toHaveLength(1);
    const [first] = thread;
    expect(first?.slug).toBe('b');
    expect(first?.via).toBe('a');
    expect(first?.shared).toContain('叉燒');
    expect(first?.href).toBe('/guides/b');
    expect(first?.score).toBeGreaterThan(0);
  });

  it('never offers a chapter the reader already finished', () => {
    const thread = readingThread(CORPUS, ['a', 'b', 'c', 'd'], { steps: 3 });
    expect(thread).toEqual([]);
  });

  it('answers an empty thread for a reader who has read nothing', () => {
    // an arbitrary ranking is not a path; the island shows "start anywhere" instead.
    expect(readingThread(CORPUS, [], { steps: 3 })).toEqual([]);
  });

  it('is deterministic — the same read-set always produces the same thread', () => {
    const first = readingThread(CORPUS, ['a', 'c'], { steps: 3 });
    const second = readingThread(CORPUS, ['c', 'a'], { steps: 3 });
    expect(first.map((step) => step.slug)).toEqual(second.map((step) => step.slug));
  });

  it('spans the reader world instead of clustering in one corner of it', () => {
    const spread: Guide[] = [
      guide('read-1', '叉燒的早上', '叉燒 爐火 清晨 的 第一碟 飯'),
      guide('read-2', '雨天的走廊', '有蓋 走廊 雨天 港鐵 一站'),
      guide('near-1', '叉燒的午後', '叉燒 爐火 午後 的 第二碟 飯'),
      guide('near-2', '叉燒的深夜', '叉燒 爐火 深夜 的 第三碟 飯'),
      guide('far-1', '走廊的盡頭', '有蓋 走廊 港鐵 雨天 盡頭'),
    ];
    const thread = readingThread(spread, ['read-1', 'read-2'], { steps: 3 });
    expect(thread.length).toBeGreaterThanOrEqual(2);
    expect(new Set(thread.map((step) => step.via)).size).toBe(thread.length);
    expect(thread.map((step) => step.slug)).toContain('far-1');
  });

  it('attaches a reason to every door it offers', () => {
    const thread = readingThread(CORPUS, ['a'], { steps: 3 });
    for (const step of thread) {
      expect(step.shared.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
    }
  });

  it('orders by score, then by slug — no hidden randomness', () => {
    const thread = readingThread(CORPUS, ['a', 'c'], { steps: 4 });
    const scores = thread.map((step) => step.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });
});

describe('the shipped corpus', () => {
  const guides = mockGuides('zh-HK');

  it('is large enough for a thread to be worth computing', () => {
    expect(guides.length).toBeGreaterThan(150);
  });

  it('threads the real corpus from a real read-set', () => {
    const read = guides.slice(0, 12).map((item) => item.slug);
    const thread = readingThread(guides, read, { steps: 3 });
    expect(thread).toHaveLength(3);
    for (const step of thread) {
      expect(read).not.toContain(step.slug);
      expect(step.via).toBeTruthy();
      expect(step.shared.length).toBeGreaterThan(0);
    }
    expect(new Set(thread.map((step) => step.via)).size).toBe(3);
  });

  it('reports progress the island can print', () => {
    const progress = threadProgress(guides, guides.slice(0, 44).map((item) => item.slug));
    expect(progress.read).toBe(44);
    expect(progress.total).toBe(guides.length);
    expect(progress.percent).toBe(Math.round((44 / guides.length) * 100));
  });
});
