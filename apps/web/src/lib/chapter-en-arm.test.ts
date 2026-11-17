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

  it('the arc opener (chapter 1) ships in three arms too', () => {
    const hk = mockGuide('hk-food-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/香港三餐/);
    const cn = mockGuide('hk-food-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/香港三餐/);
    const en = mockGuide('hk-food-chronicle', 'en');
    expect(en?.title).toMatch(/Three meals a day/);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && b.text.includes('Hong Kong is an epic written in fire'))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'list'
      && Array.isArray((b as { items?: string[] }).items)
      && (b as { items: string[] }).items.some((i) => i.includes('set meal')))).toBe(true);
  });

  it('chapter 2 (siu mei) ships in three arms too', () => {
    const hk = mockGuide('hk-siu-mei-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/燒味/);
    const cn = mockGuide('hk-siu-mei-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/烧味/);
    const en = mockGuide('hk-siu-mei-chronicle', 'en');
    expect(en?.title).toMatch(/Roast meats/);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && b.text.includes('two in the morning'))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /light and charcoal/i.test(b.text))).toBe(true);
  });

  it('chapter 3 (dim sum) ships in three arms too', () => {
    const hk = mockGuide('hk-dim-sum-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/早茶/);
    const cn = mockGuide('hk-dim-sum-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/早茶/);
    const en = mockGuide('hk-dim-sum-chronicle', 'en');
    expect(en?.title).toMatch(/Yum cha/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /character of a steamer/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /har gow/i.test(b.text))).toBe(true);
  });

  it('chapter 4 (temple street) ships in three arms too', () => {
    const hk = mockGuide('hk-temple-street-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/廟街/);
    const cn = mockGuide('hk-temple-street-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/庙街/);
    const en = mockGuide('hk-temple-street-chronicle', 'en');
    expect(en?.title).toMatch(/Temple Street/);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /soup-pot brothers/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /why the signboard/i.test(b.text))).toBe(true);
  });

  it('chapter 5 (cha chaan teng) ships in three arms too', () => {
    const hk = mockGuide('hk-cha-chaan-teng-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/茶餐廳/);
    const cn = mockGuide('hk-cha-chaan-teng-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/茶餐厅/);
    const en = mockGuide('hk-cha-chaan-teng-chronicle', 'en');
    expect(en?.title).toMatch(/Cha chaan teng/);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /silk-stocking/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /three things/i.test(b.text))).toBe(true);
  });

  it('chapter 6 (dawn fish market) ships in three arms too', () => {
    const hk = mockGuide('hk-fish-market-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/天光魚市/);
    const cn = mockGuide('hk-fish-market-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/天光鱼市/);
    const en = mockGuide('hk-fish-market-chronicle', 'en');
    expect(en?.title).toMatch(/Dawn Fish Market/);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /half-past four/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /rhythm of the fish market/i.test(b.text))).toBe(true);
  });

  it('chapter 7 (Auntie Chun Fa) ships in three arms too', () => {
    const hk = mockGuide('hk-yu-huei-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/春花姨/);
    const cn = mockGuide('hk-yu-huei-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/春花姨/);
    const en = mockGuide('hk-yu-huei-chronicle', 'en');
    expect(en?.title).toMatch(/Auntie Chun Fa/);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /three in the morning/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /basin, the clock/i.test(b.text))).toBe(true);
  });

  it('chapter 8 (fruit market) ships in three arms too', () => {
    const hk = mockGuide('hk-fruit-market-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/果欄/);
    const cn = mockGuide('hk-fruit-market-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/果栏/);
    const en = mockGuide('hk-fruit-market-chronicle', 'en');
    expect(en?.title).toMatch(/fruit market/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /ten past three/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /one day begins before dawn/i.test(b.text))).toBe(true);
  });

  it('chapter 9 (tong sui) ships in three arms too', () => {
    const hk = mockGuide('hk-tongsui-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/糖水/);
    const cn = mockGuide('hk-tongsui-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/糖水/);
    const en = mockGuide('hk-tongsui-chronicle', 'en');
    expect(en?.title).toMatch(/Tong sui/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /after dinner, nobody is in a hurry/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Fire and the stone mill/i.test(b.text))).toBe(true);
  });

  it('chapter 10 (ice house) ships in three arms too', () => {
    const hk = mockGuide('hk-bing-sat-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/冰室/);
    const cn = mockGuide('hk-bing-sat-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/冰室/);
    const en = mockGuide('hk-bing-sat-chronicle', 'en');
    expect(en?.title).toMatch(/Ice house/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && (/1960|North Point/i.test(b.text)))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /pineapple has nothing/i.test(b.text))).toBe(true);
  });

  it('chapter 11 (cart noodles) ships in three arms too', () => {
    const hk = mockGuide('hk-cart-noodles-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/車仔麵/);
    const cn = mockGuide('hk-cart-noodles-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/车仔面/);
    const en = mockGuide('hk-cart-noodles-chronicle', 'en');
    expect(en?.title).toMatch(/Cart noodles/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /eleven at night/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /six small pots/i.test(b.text))).toBe(true);
  });

  it('chapter 12 (preserved-egg congee) ships in three arms too', () => {
    const hk = mockGuide('hk-congee-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/皮蛋瘦肉粥/);
    const cn = mockGuide('hk-congee-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/皮蛋瘦肉粥/);
    const en = mockGuide('hk-congee-chronicle', 'en');
    expect(en?.title).toMatch(/Preserved-egg pork congee/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /(2am|substantial)/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /last thing the city says/i.test(b.text))).toBe(true);
  });

  it('chapter 13 (Lion Rock) ships in three arms too', () => {
    const hk = mockGuide('hk-lion-rock-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/獅子山/);
    const cn = mockGuide('hk-lion-rock-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/狮子山/);
    const en = mockGuide('hk-lion-rock-chronicle', 'en');
    expect(en?.title).toMatch(/Lion Rock/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /half-six in the evening/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /lion rock/i.test(b.text))).toBe(true);
  });

  it('chapter 14 (Cheung Chau) ships in three arms too', () => {
    const hk = mockGuide('hk-cheung-chau-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/長洲/);
    const cn = mockGuide('hk-cheung-chau-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/长洲/);
    const en = mockGuide('hk-cheung-chau-chronicle', 'en');
    expect(en?.title).toMatch(/Cheung Chau/i);
    expect(en?.body_blocks.some((b) => b.type === 'paragraph' && /eight in the morning/i.test(b.text))).toBe(true);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /route and the sea-breeze/i.test(b.text))).toBe(true);
  });

  it('chapter 15 (the evening MTR page) ships in three arms too', () => {
    const hk = mockGuide('hk-mtr-evening-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/十八點半/);
    const cn = mockGuide('hk-mtr-evening-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/十八点半/);
    const en = mockGuide('hk-mtr-evening-chronicle', 'en');
    expect(en?.title).toMatch(/Half past six/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/card-swipe/);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /half a face/i.test(b.text))).toBe(true);
  });

  it('chapter 16 (Lei Yue Mun) ships in three arms too', () => {
    const hk = mockGuide('hk-lei-yue-mun-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/鯉魚門/);
    const cn = mockGuide('hk-lei-yue-mun-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/鲤鱼门/);
    const en = mockGuide('hk-lei-yue-mun-chronicle', 'en');
    expect(en?.title).toMatch(/Lei Yue Mun/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/half past six/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /calling of prices/i.test(b.text))).toBe(true);
  });

  it('chapter 17 (Ham Kwong baked sesame cakes) ships in three arms too', () => {
    const hk = mockGuide('hk-bakery-dawn-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/鹹光燒餅/);
    const cn = mockGuide('hk-bakery-dawn-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/咸光烧饼/);
    const en = mockGuide('hk-bakery-dawn-chronicle', 'en');
    expect(en?.title).toMatch(/Ham Kwong/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/three o’clock in the morning/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /tripod hedgehog/i.test(b.text))).toBe(true);
  });
});
