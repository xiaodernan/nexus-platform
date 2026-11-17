/**
 * D1286 — the first chapter in the canon with a full EN arm.
 *
 * Pin the substitution discipline: locale 'en' swaps the fixture's EN arm wholesale (title,
 * description, all blocks — the same beats, no translation shell); a chapter without an EN arm
 * renders its Traditional HK text unchanged and never gets machine-mangled; 'zh-CN' rides the
 * opencc fold as before.
 */
import { describe, expect, it } from 'vitest';

import { mockGuide } from './mock';

describe('chapter 106 ships in three arms', () => {
  it('the zh-HK arm is the Traditional HK voice', () => {
    const guide = mockGuide('hk-sham-shui-po-pawnshop-chronicle', 'zh-HK');
    expect(guide).not.toBeNull();
    expect(guide?.title).toContain('鄭伯');
    expect(guide?.description).toContain('欽州街');
    expect(guide?.body_blocks.some((b) => b.type === 'paragraph' && b.text.includes('深水埗'))).toBe(true);
  });

  it('the en arm is the SAME story in English — never folded, never the HK glyph', () => {
    const guide = mockGuide('hk-sham-shui-po-pawnshop-chronicle', 'en');
    expect(guide).not.toBeNull();
    expect(guide?.title).toMatch(/Master Cheng/);
    expect(guide?.description).toMatch(/synthetic guide/i);
    const prose = (guide?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Cheng/);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('the zh-CN arm is the opencc fold of the Traditional source (English blocks pass through)', () => {
    const guide = mockGuide('hk-sham-shui-po-pawnshop-chronicle', 'zh-CN');
    expect(guide).not.toBeNull();
    expect(guide?.title).toMatch(/郑伯/);
    expect(guide?.title).toMatch(/第106章|第一百零六章/);
    expect(guide?.body_blocks.some((b) => b.type === 'paragraph' && b.text.includes('深水埗'))).toBe(true);
  });

  it('a chapter without an EN arm renders its Traditional HK text in en mode — honest fallback by design', () => {
    const guide = mockGuide('hk-star-ferry-last-sailing-chronicle', 'en');
    expect(guide).not.toBeNull();
    expect(guide?.title).toContain('船長炳');
  });
});
