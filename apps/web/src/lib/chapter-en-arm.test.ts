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

  it('chapter 50 (Yau Ma Tei dumpling house) ships in three arms too', () => {
    const hk = mockGuide('hk-yauma-tei-dumpling-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/佐敦吉華餃麵店/);
    const cn = mockGuide('hk-yauma-tei-dumpling-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/佐敦吉华饺面店/);
    const en = mockGuide('hk-yauma-tei-dumpling-chronicle', 'en');
    expect(en?.title).toMatch(/Yau Ma Tei dumpling/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/pink towel/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /legend of the pink towel/i.test(b.text))).toBe(true);
  });

  it('chapter 51 (Kwun Tong’s “Dawn Herald”) ships in three arms too', () => {
    const hk = mockGuide('hk-kwun-tong-newsboy-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/觀塘『曙光報紙』的分送員/);
    const cn = mockGuide('hk-kwun-tong-newsboy-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/观塘『曙光报纸』的分送员/);
    const en = mockGuide('hk-kwun-tong-newsboy-chronicle', 'en');
    expect(en?.title).toMatch(/Dawn Herald/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Uncle Ng/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /iron gate at first light/i.test(b.text))).toBe(true);
  });

  it('chapter 52 (the Kowloon Bay garment factory) ships in three arms too', () => {
    const hk = mockGuide('hk-kowloon-bay-garment-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/九龍灣製衣廠/);
    const cn = mockGuide('hk-kowloon-bay-garment-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/九龙湾制衣厂/);
    const en = mockGuide('hk-kowloon-bay-garment-chronicle', 'en');
    expect(en?.title).toMatch(/Kowloon Bay garment factory/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Old Chan/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /wife called cloth/i.test(b.text))).toBe(true);
  });

  it('chapter 53 (the On Shu Tong clinic) ships in three arms too', () => {
    const hk = mockGuide('hk-acu-clinic-opens-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/安樹堂的開診時間/);
    const cn = mockGuide('hk-acu-clinic-opens-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/安树堂的开诊时间/);
    const en = mockGuide('hk-acu-clinic-opens-chronicle', 'en');
    expect(en?.title).toMatch(/On Shu Tong/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Aunty Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /dialogue of yin and yang/i.test(b.text))).toBe(true);
  });

  it('chapter 54 (the Golden Source cloth shop) ships in three arms too', () => {
    const hk = mockGuide('hk-sham-shui-po-fabric-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/金源布莊/);
    const cn = mockGuide('hk-sham-shui-po-fabric-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/金源布庄.*零头布/);
    const en = mockGuide('hk-sham-shui-po-fabric-chronicle', 'en');
    expect(en?.title).toMatch(/Golden Source/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Sister Wu/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /second spring/i.test(b.text))).toBe(true);
  });

  it('chapter 55 (the Lok Ma Chau outpost) ships in three arms too', () => {
    const hk = mockGuide('hk-loko-ma-chau-barrier-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/落馬洲禁區的通勤前哨/);
    const cn = mockGuide('hk-loko-ma-chau-barrier-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/落马洲禁区/);
    const en = mockGuide('hk-loko-ma-chau-barrier-chronicle', 'en');
    expect(en?.title).toMatch(/Lok Ma Chau/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Leung/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /gate machines at 6:15/i.test(b.text))).toBe(true);
  });

  it('chapter 56 (the Yau Ma Tei veterans’ supper) ships in three arms too', () => {
    const hk = mockGuide('hk-yauma-tei-opera-supper-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/油麻地粵劇牌樓老倌/);
    const cn = mockGuide('hk-yauma-tei-opera-supper-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/油麻地粤剧牌楼老倌/);
    const en = mockGuide('hk-yauma-tei-opera-supper-chronicle', 'en');
    expect(en?.title).toMatch(/after-show supper/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Yau Sir/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /fourth drum/i.test(b.text))).toBe(true);
  });

  it('chapter 57 (the Tai Po wholesale market) ships in three arms too', () => {
    const hk = mockGuide('hk-taipo-wholesale-market-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/大埔墟農產品批發市場/);
    const cn = mockGuide('hk-taipo-wholesale-market-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/大埔墟农产品批发市场/);
    const en = mockGuide('hk-taipo-wholesale-market-chronicle', 'en');
    expect(en?.title).toMatch(/Tai Po wholesale market/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ting Ting/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /arithmetic on the scale/i.test(b.text))).toBe(true);
  });

  it('chapter 58 (the Kwai Chung container terminal) ships in three arms too', () => {
    const hk = mockGuide('hk-container-terminal-noon-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/青衣貨櫃碼頭的橋吊午休/);
    const cn = mockGuide('hk-container-terminal-noon-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/青衣货柜码头的桥吊午休/);
    const en = mockGuide('hk-container-terminal-noon-chronicle', 'en');
    expect(en?.title).toMatch(/Kwai Chung container terminal/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Cheong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /char siu rice/i.test(b.text))).toBe(true);
  });

  it('chapter 59 (the Fai Kee shoe shop) ships in three arms too', () => {
    const hk = mockGuide('hk-yuen-long-shoemaker-shop-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/輝記鞋材店/);
    const cn = mockGuide('hk-yuen-long-shoemaker-shop-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/辉记鞋材店/);
    const en = mockGuide('hk-yuen-long-shoemaker-shop-chronicle', 'en');
    expect(en?.title).toMatch(/Fai Kee Shoe Materials Shop/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Auntie Chow/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /sound of the abacus/i.test(b.text))).toBe(true);
  });

  it('chapter 60 (the Ping Li dried-peel walk-up) ships in three arms too', () => {
    const hk = mockGuide('hk-mong-kok-ping-li-grocery-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/平利果皮批發/);
    const cn = mockGuide('hk-mong-kok-ping-li-grocery-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/平利果皮批发/);
    const en = mockGuide('hk-mong-kok-ping-li-grocery-chronicle', 'en');
    expect(en?.title).toMatch(/Ping Li/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Boss Chan/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /salted-egg record book/i.test(b.text))).toBe(true);
  });

  it('chapter 61 (Master Chan’s cross-border night shift) ships in three arms too', () => {
    const hk = mockGuide('hk-shenzhen-huanggang-night-gate-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/皇崗口岸以北的第一道閘機/);
    const cn = mockGuide('hk-shenzhen-huanggang-night-gate-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/皇岗口岸以北的第一道闸机/);
    const en = mockGuide('hk-shenzhen-huanggang-night-gate-chronicle', 'en');
    expect(en?.title).toMatch(/Master Chan/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Chan/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /traffic control in the radio/i.test(b.text))).toBe(true);
  });

  it('chapter 62 (Lo Wu’s night-market stalls) ships in three arms too', () => {
    const hk = mockGuide('hk-shenzhen-luohu-night-market-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/羅湖口岸以南的夜市小販/);
    const cn = mockGuide('hk-shenzhen-luohu-night-market-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/罗湖口岸以南的夜市小贩/);
    const en = mockGuide('hk-shenzhen-luohu-night-market-chronicle', 'en');
    expect(en?.title).toMatch(/night-market stalls south of Lo Wu/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Old Tiao/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /memories of the cans/i.test(b.text))).toBe(true);
  });

  it('chapter 63 (the North River market porters) ships in three arms too', () => {
    const hk = mockGuide('hk-sham-shui-po-north-river-market-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/深水埗北河街市/);
    const cn = mockGuide('hk-sham-shui-po-north-river-market-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/北河街市/);
    const en = mockGuide('hk-sham-shui-po-north-river-market-chronicle', 'en');
    expect(en?.title).toMatch(/North River Market/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Chan/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /sound of carrying vegetables/i.test(b.text))).toBe(true);
  });

  it('chapter 64 (Ho Ming on the Man Kam To run) ships in three arms too', () => {
    const hk = mockGuide('hk-man-kam-to-driver-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/榕記米業/);
    const cn = mockGuide('hk-man-kam-to-driver-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/榕记米业/);
    const en = mockGuide('hk-man-kam-to-driver-chronicle', 'en');
    expect(en?.title).toMatch(/Ho Ming/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ho Ming/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /mercury light/i.test(b.text))).toBe(true);
  });

  it('chapter 65 (Ho Ming’s third return run) ships in three arms too', () => {
    const hk = mockGuide('hk-man-kam-to-return-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/浩明第三班折返/);
    const cn = mockGuide('hk-man-kam-to-return-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/浩明第三班折返/);
    const en = mockGuide('hk-man-kam-to-return-chronicle', 'en');
    expect(en?.title).toMatch(/third run back/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/thirty-nine boxes/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /third run at the port/i.test(b.text))).toBe(true);
  });

  it('chapter 66 (Ho Ming’s morning rice-bucket) ships in three arms too', () => {
    const hk = mockGuide('hk-man-kam-to-morning-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/浩明的早班米斗/);
    const cn = mockGuide('hk-man-kam-to-morning-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/浩明的早班米斗/);
    const en = mockGuide('hk-man-kam-to-morning-chronicle', 'en');
    expect(en?.title).toMatch(/morning rice-bucket/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ho Ming/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /accuracy of the bucket/i.test(b.text))).toBe(true);
  });

  it('chapter 67 (Ho Ming’s second rice truck) ships in three arms too', () => {
    const hk = mockGuide('hk-man-kam-to-second-truck-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/浩明的第二輛米車/);
    const cn = mockGuide('hk-man-kam-to-second-truck-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/浩明的第二辆米车/);
    const en = mockGuide('hk-man-kam-to-second-truck-chronicle', 'en');
    expect(en?.title).toMatch(/second rice truck/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/banyan leaf/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /different about the second truck/i.test(b.text))).toBe(true);
  });

  it('chapter 68 (Ah Cheong’s return coach at Huanggang) ships in three arms too', () => {
    const hk = mockGuide('hk-huanggang-return-coach-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/返城班車的司機阿昌/);
    const cn = mockGuide('hk-huanggang-return-coach-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/返城班车的司机阿昌/);
    const en = mockGuide('hk-huanggang-return-coach-chronicle', 'en');
    expect(en?.title).toMatch(/return coach at Huanggang Port/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Cheong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Two dialects on the waiting bench/i.test(b.text))).toBe(true);
  });

  it('chapter 69 (the Star Ferry at nine-fifteen) ships in three arms too', () => {
    const hk = mockGuide('hk-central-pier-star-ferry-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/天星小輪——維港的慢拍/);
    const cn = mockGuide('hk-central-pier-star-ferry-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/天星小轮——维港的慢拍/);
    const en = mockGuide('hk-central-pier-star-ferry-chronicle', 'en');
    expect(en?.title).toMatch(/Star Ferry/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Octopus gate/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Octopus gate/i.test(b.text))).toBe(true);
  });

  it('chapter 70 (the three minutes mid-harbour) ships in three arms too', () => {
    const hk = mockGuide('hk-central-pier-star-ferry-midbay-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/維港中間那三分鐘/);
    const cn = mockGuide('hk-central-pier-star-ferry-midbay-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/维港中间那三分钟/);
    const en = mockGuide('hk-central-pier-star-ferry-midbay-chronicle', 'en');
    expect(en?.title).toMatch(/three honest minutes/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/one loudest second/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /one loudest second/i.test(b.text))).toBe(true);
  });

  it('chapter 71 (the Mong Kok flower market) ships in three arms too', () => {
    const hk = mockGuide('hk-mong-kok-flower-market-closeout-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/旺角花墟——走花市的最後一站/);
    const cn = mockGuide('hk-mong-kok-flower-market-closeout-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/旺角花墟——走花市的最后一站/);
    const en = mockGuide('hk-mong-kok-flower-market-closeout-chronicle', 'en');
    expect(en?.title).toMatch(/flower market/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/chrysanthemums/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /last cut before closing/i.test(b.text))).toBe(true);
  });

  it('chapter 72 (Old Ho’s Ding-ding tram) ships in three arms too', () => {
    const hk = mockGuide('hk-central-tram-ding-ding-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/中環電車——老何的叮叮慢拍/);
    const cn = mockGuide('hk-central-tram-ding-ding-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/中环电车——老何的叮叮慢拍/);
    const en = mockGuide('hk-central-tram-ding-ding-chronicle', 'en');
    expect(en?.title).toMatch(/Ding-ding/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Old Ho/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Old Ho’s Ding-ding tempo/i.test(b.text))).toBe(true);
  });

  it('chapter 73 (Wing Lei Street’s film room) ships in three arms too', () => {
    const hk = mockGuide('hk-wing-lei-street-analog-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/永利街——黃生的膠片修補室/);
    const cn = mockGuide('hk-wing-lei-street-analog-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/中环永利街——黄生的胶片修补室/);
    const en = mockGuide('hk-wing-lei-street-analog-chronicle', 'en');
    expect(en?.title).toMatch(/Wing Lei Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Mr Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /last 35mm reel/i.test(b.text))).toBe(true);
  });

  it('chapter 74 (Chief Chen’s lunchbox hour) ships in three arms too', () => {
    const hk = mockGuide('hk-central-mandarin-oriental-chef-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/文華東方酒店——陳總廚的飯盒時光/);
    const cn = mockGuide('hk-central-mandarin-oriental-chef-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/文华东方酒店——陈总厨的饭盒时光/);
    const en = mockGuide('hk-central-mandarin-oriental-chef-chronicle', 'en');
    expect(en?.title).toMatch(/Chief Chen/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Chief Chen/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /lunch that is not on the menu/i.test(b.text))).toBe(true);
  });

  it('chapter 75 (the Wan Chai pawnshop) ships in three arms too', () => {
    const hk = mockGuide('hk-wan-chai-pawnshop-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/擺押局——老黃生的中午開櫃/);
    const cn = mockGuide('hk-wan-chai-pawnshop-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/摆押局——老黄生的中午开柜/);
    const en = mockGuide('hk-wan-chai-pawnshop-chronicle', 'en');
    expect(en?.title).toMatch(/Wan Chai pawnshop/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Old Mr Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /first of the month, the drawer day/i.test(b.text))).toBe(true);
  });

  it('chapter 76 (the Chai Wan industrial ovens) ships in three arms too', () => {
    const hk = mockGuide('hk-chai-wan-oven-close-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/爐主阿九關爐的第五聲/);
    const cn = mockGuide('hk-chai-wan-oven-close-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/炉主阿九关炉的第五声/);
    const en = mockGuide('hk-chai-wan-oven-close-chronicle', 'en');
    expect(en?.title).toMatch(/Chai Wan industrial building/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Nine/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /five egg tarts at closing/i.test(b.text))).toBe(true);
  });

  it('chapter 77 (the Ngau Tau Kok fishball stall) ships in three arms too', () => {
    const hk = mockGuide('hk-kwun-tong-fishball-stall-dusk-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/魚蛋檔的黃生關燈/);
    const cn = mockGuide('hk-kwun-tong-fishball-stall-dusk-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/鱼蛋档的黄生关灯/);
    const en = mockGuide('hk-kwun-tong-fishball-stall-dusk-chronicle', 'en');
    expect(en?.title).toMatch(/fishball stall/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Mr Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /order the lights go off/i.test(b.text))).toBe(true);
  });

  it('chapter 78 (Old Master Lee’s half-side scale) ships in three arms too', () => {
    const hk = mockGuide('hk-kowloon-bay-scalemaker-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/老秤匠阿利的半邊天秤/);
    const cn = mockGuide('hk-kowloon-bay-scalemaker-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/老秤匠阿利的半边天秤/);
    const en = mockGuide('hk-kowloon-bay-scalemaker-chronicle', 'en');
    expect(en?.title).toMatch(/half-side scale/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Lee/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /half-side scale/i.test(b.text))).toBe(true);
  });

  it('chapter 79 (Granny’s end-of-day stall) ships in three arms too', () => {
    const hk = mockGuide('hk-temple-street-alpo-market-closing-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/廟街——阿婆的尾盤檔/);
    const cn = mockGuide('hk-temple-street-alpo-market-closing-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/庙街——阿婆的尾盘档/);
    const en = mockGuide('hk-temple-street-alpo-market-closing-chronicle', 'en');
    expect(en?.title).toMatch(/Temple Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Granny/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /little ritual of closing/i.test(b.text))).toBe(true);
  });

  it('chapter 80 (the Choi Chun Mansion store) ships in three arms too', () => {
    const hk = mockGuide('hk-sham-shui-po-tuk-stall-late-night-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/財俊大廈士多/);
    const cn = mockGuide('hk-sham-shui-po-tuk-stall-late-night-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/财俊大厦士多/);
    const en = mockGuide('hk-sham-shui-po-tuk-stall-late-night-chronicle', 'en');
    expect(en?.title).toMatch(/Choi Chun Mansion/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Mei/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /store at dusk/i.test(b.text))).toBe(true);
  });

  it('chapter 81 (the Wong Tai Sin incense) ships in three arms too', () => {
    const hk = mockGuide('hk-wong-tai-sin-temple-incense-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/黃大仙祠——黃先生來上香/);
    const cn = mockGuide('hk-wong-tai-sin-temple-incense-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/黄大仙祠——黄先生来上香/);
    const en = mockGuide('hk-wong-tai-sin-temple-incense-chronicle', 'en');
    expect(en?.title).toMatch(/Wong Tai Sin/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Mr Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /thirty years of incense/i.test(b.text))).toBe(true);
  });

  it('chapter 82 (Ah Leung’s Snow Factory Street tailor) ships in three arms too', () => {
    const hk = mockGuide('hk-central-snow-factory-street-tailor-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/雪廠街——阿良的西裝舖/);
    const cn = mockGuide('hk-central-snow-factory-street-tailor-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/雪厂街——阿良的西装舖/);
    const en = mockGuide('hk-central-snow-factory-street-tailor-chronicle', 'en');
    expect(en?.title).toMatch(/Snow Factory Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Leung/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /evening on Snow Factory Street/i.test(b.text))).toBe(true);
  });

  it('chapter 83 (Sister Wong’s night court) ships in three arms too', () => {
    const hk = mockGuide('hk-wan-chai-night-court-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/軒尼詩道——書記官黃姐/);
    const cn = mockGuide('hk-wan-chai-night-court-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/轩尼诗道——书记官黄姐/);
    const en = mockGuide('hk-wan-chai-night-court-chronicle', 'en');
    expect(en?.title).toMatch(/Hennessy Road/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Sister Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /lights-out ritual/i.test(b.text))).toBe(true);
  });

  it('chapter 84 (Granny Tam Wa’s siu mai) ships in three arms too', () => {
    const hk = mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/金花街——譚華阿婆的最後一鍋燒賣/);
    const cn = mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/金花街——谭华阿婆的最后一锅烧卖/);
    const en = mockGuide('hk-mong-kok-ging-fa-shu-mai-chronicle', 'en');
    expect(en?.title).toMatch(/Ging Fa Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Granny Tam Wa/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /tail-end of Ging Fa Street/i.test(b.text))).toBe(true);
  });

  it('chapter 85 (the late-night Jordan Road sugar water) ships in three arms too', () => {
    const hk = mockGuide('hk-jordan-way-shu-lao-sugar-water-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/佐敦道——謝老人的深夜糖水/);
    const cn = mockGuide('hk-jordan-way-shu-lao-sugar-water-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/佐敦道——谢老人的深夜糖水/);
    const en = mockGuide('hk-jordan-way-shu-lao-sugar-water-chronicle', 'en');
    expect(en?.title).toMatch(/Jordan Road/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Uncle Tse/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /forty-one years of black sugar water/i.test(b.text))).toBe(true);
  });

  it('chapter 86 (Brother Siu’s midnight pharmacy) ships in three arms too', () => {
    const hk = mockGuide('hk-yauma-tei-midnight-pharmacy-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/廟街——蕭哥藥房/);
    const cn = mockGuide('hk-yauma-tei-midnight-pharmacy-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/庙街——萧哥药房/);
    const en = mockGuide('hk-yauma-tei-midnight-pharmacy-chronicle', 'en');
    expect(en?.title).toMatch(/Brother Siu/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Brother Siu/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /Brother Siu’s lamp/i.test(b.text))).toBe(true);
  });

  it('chapter 87 (Mr Wong’s dye factory) ships in three arms too', () => {
    const hk = mockGuide('hk-tai-po-market-dye-factory-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/大埔墟——黃先生的染廠/);
    const cn = mockGuide('hk-tai-po-market-dye-factory-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/大埔墟——黄先生的染厂/);
    const en = mockGuide('hk-tai-po-market-dye-factory-chronicle', 'en');
    expect(en?.title).toMatch(/dye factory/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Mr Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /colours of dye/i.test(b.text))).toBe(true);
  });

  it('chapter 88 (Master Leung’s locksmith) ships in three arms too', () => {
    const hk = mockGuide('hk-sai-ying-pun-locksmith-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/西營盤——第三街——梁師傅鎖匠鋪/);
    const cn = mockGuide('hk-sai-ying-pun-locksmith-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/西营盘——第三街——梁师傅锁匠铺/);
    const en = mockGuide('hk-sai-ying-pun-locksmith-chronicle', 'en');
    expect(en?.title).toMatch(/Third Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Master Leung/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /last key/i.test(b.text))).toBe(true);
  });

  it('chapter 89 (the clock-calibration night shift) ships in three arms too', () => {
    const hk = mockGuide('hk-kwun-tong-night-calibration-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/周廠長校錶車間的夜班/);
    const cn = mockGuide('hk-kwun-tong-night-calibration-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/周厂长校表车间的夜班/);
    const en = mockGuide('hk-kwun-tong-night-calibration-chronicle', 'en');
    expect(en?.title).toMatch(/Manager Chow/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Factory Manager Chow/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /sweetness of time/i.test(b.text))).toBe(true);
  });

  it('chapter 90 (the Yuen Chau Street night sweep) ships in three arms too', () => {
    const hk = mockGuide('hk-sham-shui-po-night-sweeper-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/元州街——黃叔掃路的夜更/);
    const cn = mockGuide('hk-sham-shui-po-night-sweeper-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/元州街——黄叔扫路的夜更/);
    const en = mockGuide('hk-sham-shui-po-night-sweeper-chronicle', 'en');
    expect(en?.title).toMatch(/Yuen Chau Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Uncle Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /last sweep of the night watch/i.test(b.text))).toBe(true);
  });

  it('chapter 91 (the Aberdeen boat-house supper) ships in three arms too', () => {
    const hk = mockGuide('hk-aberdeen-boat-house-dinner-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/船灣——黃生的船屋晚飯/);
    const cn = mockGuide('hk-aberdeen-boat-house-dinner-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/船湾——黄生的船屋晚饭/);
    const en = mockGuide('hk-aberdeen-boat-house-dinner-chronicle', 'en');
    expect(en?.title).toMatch(/boat bay/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Mr Wong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /fish-head soup/i.test(b.text))).toBe(true);
  });

  it('chapter 92 (the Keswick Street newspaper stall) ships in three arms too', () => {
    const hk = mockGuide('hk-causeway-bay-newsstand-closing-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/記利佐治街——李阿打烊的報紙檔/);
    const cn = mockGuide('hk-causeway-bay-newsstand-closing-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/记利佐治街——李阿打烊的报纸档/);
    const en = mockGuide('hk-causeway-bay-newsstand-closing-chronicle', 'en');
    expect(en?.title).toMatch(/Keswick Street/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Lee/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /pulse of six old papers/i.test(b.text))).toBe(true);
  });

  it('chapter 93 (Yau Leung Industrial Building parcels) ships in three arms too', () => {
    const hk = mockGuide('hk-kwun-tong-parcel-sorting-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/友諒工業大廈——阿莊的包裹處/);
    const cn = mockGuide('hk-kwun-tong-parcel-sorting-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/友谅工业大厦——阿庄的包裹处/);
    const en = mockGuide('hk-kwun-tong-parcel-sorting-chronicle', 'en');
    expect(en?.title).toMatch(/Yau Leung Industrial Building/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Chong/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /reassurance of the tray machine/i.test(b.text))).toBe(true);
  });

  it('chapter 94 (Ah Kwok’s Quarry Bay roastery) ships in three arms too', () => {
    const hk = mockGuide('hk-quarry-bay-coffee-roastery-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/阿郭的咖啡烘焙的午後/);
    const cn = mockGuide('hk-quarry-bay-coffee-roastery-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/阿郭的咖啡烘焙/);
    const en = mockGuide('hk-quarry-bay-coffee-roastery-chronicle', 'en');
    expect(en?.title).toMatch(/coffee-roasting/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Kwok/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /fire of one bag/i.test(b.text))).toBe(true);
  });

  it('chapter 95 (Ah Chung Lee’s typewriter shop) ships in three arms too', () => {
    const hk = mockGuide('hk-tseung-kwan-o-typewriter-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/李阿忠的打字機行/);
    const cn = mockGuide('hk-tseung-kwan-o-typewriter-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/李阿忠的打字机行/);
    const en = mockGuide('hk-tseung-kwan-o-typewriter-chronicle', 'en');
    expect(en?.title).toMatch(/typewriter shop/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Chung Lee/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /afternoon not yet closed/i.test(b.text))).toBe(true);
  });

  it('chapter 96 (Ah Hung’s East Wind art-supply store) ships in three arms too', () => {
    const hk = mockGuide('hk-yuen-long-art-supply-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/阿雄的東風畫材行/);
    const cn = mockGuide('hk-yuen-long-art-supply-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/阿雄的东风画材行/);
    const en = mockGuide('hk-yuen-long-art-supply-chronicle', 'en');
    expect(en?.title).toMatch(/East Wind art-supply store/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Ah Hung/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /ink of Fung Cheong Road/i.test(b.text))).toBe(true);
  });

  it('chapter 97 (the Yung Shue Wan rice boxes) ships in three arms too', () => {
    const hk = mockGuide('hk-namdir-bay-pot-steamed-rice-chronicle', 'zh-HK');
    expect(hk?.title).toMatch(/榕樹灣——德興陶的蒸飯盒/);
    const cn = mockGuide('hk-namdir-bay-pot-steamed-rice-chronicle', 'zh-CN');
    expect(cn?.title).toMatch(/榕树湾——德兴陶的蒸饭盒/);
    const en = mockGuide('hk-namdir-bay-pot-steamed-rice-chronicle', 'en');
    expect(en?.title).toMatch(/Yung Shue Wan/i);
    const prose = (en?.body_blocks ?? [])
      .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? block.text : ''))
      .join(' ');
    expect(prose).toMatch(/Tak Hing/i);
    expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en?.body_blocks.some((b) => b.type === 'heading' && /rice boxes steamed from midnight/i.test(b.text))).toBe(true);
  });
});
