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

  it('chapter 18 (the Central Bourse) ships in three arms too', () => {
    const hk = mockGuide('hk-central-bourse-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/中環交易所/);
    const cn = mockGuide('hk-central-bourse-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/中环交易所/);
    const en = mockGuide('hk-central-bourse-chronicle', 'en');
    expect(en?.title).toMatch(/Central Bourse/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Hang Seng/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /closing bell|The bell/i.test(b.text))).toBe(true);
  });

  it('chapter 19 (the ER vigil) ships in three arms too', () => {
    const hk = mockGuide('hk-er-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/急症室/);
    const cn = mockGuide('hk-er-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/急症室/);
    const en = mockGuide('hk-er-chronicle', 'en');
    expect(en?.title).toMatch(/Three in the morning/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/triage/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /The waiting/i.test(b.text))).toBe(true);
  });

  it('chapter 20 (the window cleaner) ships in three arms too', () => {
    const hk = mockGuide('hk-window-cleaner-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/抹窗師傅/);
    const cn = mockGuide('hk-window-cleaner-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/抹窗师傅/);
    const en = mockGuide('hk-window-cleaner-chronicle', 'en');
    expect(en?.title).toMatch(/Four in the morning/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/cradle men/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /rope first/i.test(b.text))).toBe(true);
  });

  it('chapter 21 (the last fare) ships in three arms too', () => {
    const hk = mockGuide('hk-last-taxi-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/半夜十二點半/);
    const cn = mockGuide('hk-last-taxi-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/半夜十二点半/);
    const en = mockGuide('hk-last-taxi-chronicle', 'en');
    expect(en?.title).toMatch(/Half-past midnight/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Hung Hom/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /last fare/i.test(b.text))).toBe(true);
  });

  it('chapter 22 (the school bus) ships in three arms too', () => {
    const hk = mockGuide('hk-school-bus-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/校巴/);
    const cn = mockGuide('hk-school-bus-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/校巴/);
    const en = mockGuide('hk-school-bus-chronicle', 'en');
    expect(en?.title).toMatch(/Half-past eight/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Po Yun Road/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Her route is a secret/i.test(b.text))).toBe(true);
  });

  it('chapter 23 (the dish-washing auntie) ships in three arms too', () => {
    const hk = mockGuide('hk-dishwash-auntie-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/洗碗阿姨/);
    const cn = mockGuide('hk-dishwash-auntie-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/洗碗阿姨/);
    const en = mockGuide('hk-dishwash-auntie-chronicle', 'en');
    expect(en?.title).toMatch(/second act/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/bong jei/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /She knows every plate/i.test(b.text))).toBe(true);
  });

  it('chapter 24 (the tower cleaner) ships in three arms too', () => {
    const hk = mockGuide('hk-night-cleaner-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/塔樓清潔工/);
    const cn = mockGuide('hk-night-cleaner-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/塔楼清洁工/);
    const en = mockGuide('hk-night-cleaner-chronicle', 'en');
    expect(en?.title).toMatch(/One in the morning/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/nineteen floors/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /corridor light/i.test(b.text))).toBe(true);
  });

  it('chapter 25 (the last pot of tong sui) ships in three arms too', () => {
    const hk = mockGuide('hk-last-tong-sui-urn-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/最後一鍋糖水/);
    const cn = mockGuide('hk-last-tong-sui-urn-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/最后一锅糖水/);
    const en = mockGuide('hk-last-tong-sui-urn-chronicle', 'en');
    expect(en?.title).toMatch(/last pot/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Auntie Nine/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Three kinds of people/i.test(b.text))).toBe(true);
  });

  it('chapter 26 (the fish-ball stall) ships in three arms too', () => {
    const hk = mockGuide('hk-fishball-stall-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/魚蛋檔/);
    const cn = mockGuide('hk-fishball-stall-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/鱼蛋档/);
    const en = mockGuide('hk-fishball-stall-chronicle', 'en');
    expect(en?.title).toMatch(/fish-ball stall/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/fierce flame/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /skewer craft/i.test(b.text))).toBe(true);
  });

  it('chapter 27 (the newspaper wrapper) ships in three arms too', () => {
    const hk = mockGuide('hk-newspaper-wrapper-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/報館/);
    const cn = mockGuide('hk-newspaper-wrapper-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/报馆/);
    const en = mockGuide('hk-newspaper-wrapper-chronicle', 'en');
    expect(en?.title).toMatch(/newspaper wrapping/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Yun/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Folding and dispatch/i.test(b.text))).toBe(true);
  });

  it('chapter 28 (the pigeon coop) ships in three arms too', () => {
    const hk = mockGuide('hk-pigeon-coop-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/雀籠房/);
    const cn = mockGuide('hk-pigeon-coop-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/雀笼房/);
    const en = mockGuide('hk-pigeon-coop-chronicle', 'en');
    expect(en?.title).toMatch(/pigeon coop/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Pak/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Assembly and the race/i.test(b.text))).toBe(true);
  });

  it('chapter 29 (the Taikoo City shelter) ships in three arms too', () => {
    const hk = mockGuide('hk-typhoon-shelter-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/太古城候車亭/);
    const cn = mockGuide('hk-typhoon-shelter-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/太古城候车亭/);
    const en = mockGuide('hk-typhoon-shelter-chronicle', 'en');
    expect(en?.title).toMatch(/Taikoo City shelter/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/seventy per cent/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /The instant the rain breaks/i.test(b.text))).toBe(true);
  });

  it('chapter 30 (the congee long table) ships in three arms too', () => {
    const hk = mockGuide('hk-soup-kitchen-communal-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/粥府的長枱/);
    const cn = mockGuide('hk-soup-kitchen-communal-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/粥府的长台/);
    const en = mockGuide('hk-soup-kitchen-communal-chronicle', 'en');
    expect(en?.title).toMatch(/long table/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Auntie Nine/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /three kinds of people/i.test(b.text))).toBe(true);
  });

  it('chapter 31 (the cardboard-box old man) ships in three arms too', () => {
    const hk = mockGuide('hk-estate-cardboard-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/紙箱老伯/);
    const cn = mockGuide('hk-estate-cardboard-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/纸箱老伯/);
    const en = mockGuide('hk-estate-cardboard-chronicle', 'en');
    expect(en?.title).toMatch(/cardboard-box old man/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Cardboard Ah Pak/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Thirty boxes/i.test(b.text))).toBe(true);
  });

  it('chapter 32 (the drive-thru) ships in three arms too', () => {
    const hk = mockGuide('hk-drive-thru-midnight-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/麥當勞得來速/);
    const cn = mockGuide('hk-drive-thru-midnight-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/麦当劳得来速/);
    const en = mockGuide('hk-drive-thru-midnight-chronicle', 'en');
    expect(en?.title).toMatch(/drive-thru/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Kin/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /ever-lit light/i.test(b.text))).toBe(true);
  });

  it('chapter 33 (the vending machine) ships in three arms too', () => {
    const hk = mockGuide('hk-vending-machine-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/紙包飲品販賣機/);
    const cn = mockGuide('hk-vending-machine-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/纸包饮品贩卖机/);
    const en = mockGuide('hk-vending-machine-chronicle', 'en');
    expect(en?.title).toMatch(/Midnight/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/eighteen dollars/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /trial of eighteen dollars/i.test(b.text))).toBe(true);
  });

  it('chapter 34 (Tung Chung) ships in three arms too', () => {
    const hk = mockGuide('hk-tung-chung-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/東涌/);
    const cn = mockGuide('hk-tung-chung-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/东涌/);
    const en = mockGuide('hk-tung-chung-chronicle', 'en');
    expect(en?.title).toMatch(/Tung Chung/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Sing/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /wind that blows every day/i.test(b.text))).toBe(true);
  });

  it('chapter 35 (Peng Chau) ships in three arms too', () => {
    const hk = mockGuide('hk-peng-chau-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/坪洲/);
    const cn = mockGuide('hk-peng-chau-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/坪洲/);
    const en = mockGuide('hk-peng-chau-chronicle', 'en');
    expect(en?.title).toMatch(/Peng Chau/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Sang/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /iron box/i.test(b.text))).toBe(true);
  });

  it('chapter 36 (Tai O) ships in three arms too', () => {
    const hk = mockGuide('hk-tai-o-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/大澳/);
    const cn = mockGuide('hk-tai-o-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/大澳/);
    const en = mockGuide('hk-tai-o-chronicle', 'en');
    expect(en?.title).toMatch(/Tai O/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Sister Ah Wa/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /no one is cooking/i.test(b.text))).toBe(true);
  });

  it('chapter 37 (the cross-water ferry) ships in three arms too', () => {
    const hk = mockGuide('hk-north-run-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/隔水渡輪/);
    const cn = mockGuide('hk-north-run-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/隔水渡轮/);
    const en = mockGuide('hk-north-run-chronicle', 'en');
    expect(en?.title).toMatch(/cross-water|ferry/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Chung/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /iron frame/i.test(b.text))).toBe(true);
  });

  it('chapter 38 (the north drifter) ships in three arms too', () => {
    const hk = mockGuide('hk-beijing-writer-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/北漂作家/);
    const cn = mockGuide('hk-beijing-writer-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/北漂作家/);
    const en = mockGuide('hk-beijing-writer-chronicle', 'en');
    expect(en?.title).toMatch(/north drifter/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Chen/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /northern decision/i.test(b.text))).toBe(true);
  });

  it('chapter 39 (the Teochew market) ships in three arms too', () => {
    const hk = mockGuide('hk-teochew-markets-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/潮州話．旺角菜市場/);
    const cn = mockGuide('hk-teochew-markets-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/潮州话．旺角菜市场/);
    const en = mockGuide('hk-teochew-markets-chronicle', 'en');
    expect(en?.title).toMatch(/Teochew/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Auntie Wah/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Teochew is the normal talk/i.test(b.text))).toBe(true);
  });

  it('chapter 40 (the Filipina guard) ships in three arms too', () => {
    const hk = mockGuide('hk-filipino-central-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/名媛的中環寫字樓/);
    const cn = mockGuide('hk-filipino-central-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/名媛的中环写字楼/);
    const en = mockGuide('hk-filipino-central-chronicle', 'en');
    expect(en?.title).toMatch(/Filipina|Central office/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah May/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /iron plate/i.test(b.text))).toBe(true);
  });

  it('chapter 41 (the curry-fish pot) ships in three arms too', () => {
    const hk = mockGuide('hk-mumbai-curry-central-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/灣仔咖哩魚飯堂/);
    const cn = mockGuide('hk-mumbai-curry-central-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/湾仔咖哩鱼饭堂/);
    const en = mockGuide('hk-mumbai-curry-central-chronicle', 'en');
    expect(en?.title).toMatch(/curry-fish/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Cheong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /curry devotion/i.test(b.text))).toBe(true);
  });

  it('chapter 42 (the Filipina Sundays) ships in three arms too', () => {
    const hk = mockGuide('hk-vic-park-sunday-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/維園的外國傭工/);
    const cn = mockGuide('hk-vic-park-sunday-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/维园的外国佣工/);
    const en = mockGuide('hk-vic-park-sunday-chronicle', 'en');
    expect(en?.title).toMatch(/Filipina/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Sister Ah Lin/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /hugs that only happen on Sundays/i.test(b.text))).toBe(true);
  });

  it('chapter 43 (Hopewell’s Sunday) ships in three arms too', () => {
    const hk = mockGuide('hk-hopewell-sunday-lunch-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/霍普韋爾的外傭午餐/);
    const cn = mockGuide('hk-hopewell-sunday-lunch-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/霍普韦尔的外佣午餐/);
    const en = mockGuide('hk-hopewell-sunday-lunch-chronicle', 'en');
    expect(en?.title).toMatch(/Hopewell/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Sister Ah Lan/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /revolution of the rooftop photo/i.test(b.text))).toBe(true);
  });

  it('chapter 44 (the Guanyin loan) ships in three arms too', () => {
    const hk = mockGuide('hk-temple-circuit-sunday-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/觀音借/);
    const cn = mockGuide('hk-temple-circuit-sunday-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/观音借/);
    const en = mockGuide('hk-temple-circuit-sunday-chronicle', 'en');
    expect(en?.title).toMatch(/Guanyin/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Lan/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /etiquette of three incense sticks/i.test(b.text))).toBe(true);
  });

  it('chapter 45 (the last Sunday queue) ships in three arms too', () => {
    const hk = mockGuide('hk-last-queue-sunday-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/星期天最後一間有排隊的餐廳/);
    const cn = mockGuide('hk-last-queue-sunday-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/星期天最后一间有排队的餐厅/);
    const en = mockGuide('hk-last-queue-sunday-chronicle', 'en');
    expect(en?.title).toMatch(/last restaurant with a queue/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Hing/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /light after nine/i.test(b.text))).toBe(true);
  });

  it('chapter 46 (Lo Wu’s two-way currency) ships in three arms too', () => {
    const hk = mockGuide('hk-loohu-weekend-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/羅湖站的雙向貨幣/);
    const cn = mockGuide('hk-loohu-weekend-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/罗湖站的双向货币/);
    const en = mockGuide('hk-loohu-weekend-chronicle', 'en');
    expect(en?.title).toMatch(/two-way currency/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Kit/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /etiquette of two-way currency/i.test(b.text))).toBe(true);
  });

  it('chapter 47 (the Huanggang staff canteen) ships in three arms too', () => {
    const hk = mockGuide('hk-huanggang-crossing-crew-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/皇崗口岸的員工餐廳/);
    const cn = mockGuide('hk-huanggang-crossing-crew-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/皇岗口岸的员工餐厅/);
    const en = mockGuide('hk-huanggang-crossing-crew-chronicle', 'en');
    expect(en?.title).toMatch(/Huanggang Port/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Yee/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /ticket that goes both ways/i.test(b.text))).toBe(true);
  });

  it('chapter 48 (MixC World’s designers’ street) ships in three arms too', () => {
    const hk = mockGuide('hk-mixc-world-designer-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/萬象天地的設計師街/);
    const cn = mockGuide('hk-mixc-world-designer-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/万象天地的设计师街/);
    const en = mockGuide('hk-mixc-world-designer-chronicle', 'en');
    expect(en?.title).toMatch(/MixC World/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Yin/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /etiquette of two currencies/i.test(b.text))).toBe(true);
  });

  it('chapter 49 (Lo Wu’s first trolley shift) ships in three arms too', () => {
    const hk = mockGuide('hk-loohu-trolleys-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/羅湖行李手車的第一班趟/);
    const cn = mockGuide('hk-loohu-trolleys-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/罗湖行李手车的第一班趟/);
    const en = mockGuide('hk-loohu-trolleys-chronicle', 'en');
    expect(en?.title).toMatch(/Lo Wu luggage trolleys/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Fuk/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /passwords of the small hours/i.test(b.text))).toBe(true);
  });
});
