/**
 * D1217 — arms for the insights operator scan's per-archetype action matrix.
 * Minimal but real: both locales carry six actions, order matches the client profiles,
 * and nothing is empty.
 */

import { describe, expect, it } from 'vitest';

import { getDict } from './i18n';

describe('/insights per-archetype measures (mandate §十 action matrix)', () => {
  const zh = getDict('zh-HK').insights;
  const en = getDict('en').insights;

  it('both locales carry exactly six actions', () => {
    expect(zh.actions).toHaveLength(6);
    expect(en.actions).toHaveLength(6);
  });

  it('profile order matches the simulator profiles in both locales', () => {
    expect(zh.actions.map((a) => a.profile)).toEqual(['匆匆客', '細讀生', '漫遊者', '瞎點黨', '靜默離場', '收藏家']);
    expect(en.actions.map((a) => a.profile)).toEqual([
      'impatient glance',
      'slow reader',
      'window shopper',
      'random tapper',
      'silent bounce',
      'bookmarker',
    ]);
  });

  it('every action is a non-empty bilingual instruction', () => {
    for (const a of zh.actions) expect(a.action.trim().length).toBeGreaterThan(14);
    for (const a of en.actions) expect(a.action.trim().length).toBeGreaterThan(14);
  });

  it('colAction header exists in both locales', () => {
    expect(zh.colAction).toContain('下一步');
    expect(en.colAction).toMatch(/Next/i);
    expect(zh.actionsHint).not.toContain('undefined');
  });
});
