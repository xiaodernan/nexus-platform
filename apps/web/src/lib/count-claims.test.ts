import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1509 — every chapter-COUNT claim in copy must match the real arc. Earlier advances
 * updated the English arm but left the Chinese at 106/87, so a reader switching
 * locale saw a different corpus size. This census charges BOTH arms.
 * Specific chapter references (e.g. 第一百零六章 as a chapter kicker) are NOT counts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const dict = read('apps/web/src/lib/i18n/dict.ts');

const STALE = [
  '一百零六章反覆走完一個 HK', '一百零六章香港系列指南', '一百零六章、三幕',
  '一百零六章反覆走一遍香港', '拓至第一百零六章', '一百零六章的完整馬拉松',
  '這一百零六章不是目錄',
  // D1542: the 178-era claims join the stale list as the corpus grows to 179.
  // D1561: the 181-era claims join it as the corpus grows to 182.
  // D1562: the 182-era claims join it as the corpus grows to 183.
  // D1568: the 183-era claims join it as the corpus grows to 184.
  // D1575: the 184-era claims join it as the corpus grows to 185.
  // D1583: the 185-era claims join it as the corpus grows to 186.
  // D1589: the 186-era claims join it as the corpus grows to 187.
  // D1593: the 187-era claims join it as the corpus grows to 188.
  // D1598: the 188-era claims join it as the corpus grows to 189.
  // D1602: the 189-era claims join it as the corpus grows to 190.
  // D1606: the 190-era claims join it as the corpus grows to 191.
  // D1610: the 191-era claims join it as the corpus grows to 192.
  // D1614: the 192-era claims join it as the corpus grows to 193.
  // D1617: the 193-era claims join it as the corpus grows to 194.
  '一百八十三章反覆走完一個 HK', '一百八十三章香港系列指南', '一百八十三章香港系列', '一百八十三章讀竟',
  'One hundred and eighty-three chapters', 'one hundred and eighty-three chapters',
  '一百八十二章反覆走完一個 HK', '一百八十二章香港系列指南', '一百八十二章香港系列', '一百八十二章讀竟',
  'One hundred and eighty-two chapters', 'one hundred and eighty-two chapters',
  '一百八十一章反覆走完一個 HK', '一百八十一章香港系列指南', '一百八十一章香港系列', '一百八十一章讀竟',
  'One hundred and eighty-one chapters', 'one hundred and eighty-one chapters',
  '一百八十四章反覆走完一個 HK', '一百八十四章香港系列指南', '一百八十四章香港系列', '一百八十四章讀竟',
  'One hundred and eighty-four chapters', 'one hundred and eighty-four chapters',
  '一百八十五章反覆走完一個 HK', '一百八十五章香港系列指南', '一百八十五章香港系列', '一百八十五章讀竟',
  'One hundred and eighty-five chapters', 'one hundred and eighty-five chapters',

  '一百七十八章反覆走完一個 HK', '一百七十八章香港系列指南', '一百七十八章香港系列', '一百七十八章讀竟',
  // D1587: the browser sweep caught hand-written English numerals the earlier phrase list missed.
  'hundred-and-eighty-six-chapter', '186-chapter HK series',
  'hundred-and-eighty-seven-chapter', '187-chapter HK series',
  'hundred-and-eighty-eight-chapter', '188-chapter HK series',
  'hundred-and-eighty-nine-chapter', '189-chapter HK series',
  'hundred-and-ninety-chapter', '190-chapter HK series',
  'hundred-and-ninety-one-chapter', '191-chapter HK series',
  'hundred-and-ninety-two-chapter', '192-chapter HK series',
  'hundred-and-ninety-three-chapter', '193-chapter HK series',
  'hundred-and-six-chapter', '172-chapter HK series', 'the full series now runs to 184',
  'one hundred and eighty-three',
  'One hundred and seventy-eight chapters',
];
const CURRENT = [
  '一百九十四一章反覆走完一個 HK', '一百九十四一章香港系列指南',
  '一百九十四一章香港系列', '一百九十四一章讀竟',
  'One hundred and ninety-four chapters',
  'the hundred-and-ninety-four-chapter marathon', '194-chapter HK series',
];

describe('chapter-count claims across locales', () => {
  it('no stale count claim survives in either authored arm', () => {
    const found = STALE.filter((s) => dict.includes(s));
    expect(found, `stale counts: ${found.join(' | ')}`).toEqual([]);
    // D1589: with the arc at 187, bare "八十七章" / "eighty-seven chapters" are SUBSTRINGS of
    // the current 187 wording. Boundary-aware regexes keep the old-87 arms without false reds.
    const bounded = [/(?<!一百)八十七章(?:香港系列|之後|，由凌晨|讀竟)/, /(?<!and )(?:E|e)ighty-seven chapters/]
      .filter((r) => r.test(dict)).map(String);
    expect(bounded, `bounded stale counts: ${bounded.join(' | ')}`).toEqual([]);
  });

  it('both arms carry the current count', () => {
    for (const s of CURRENT) expect(dict.includes(s), `missing ${s}`).toBe(true);
  });

  it('the chronicle page comment is not frozen at 105', () => {
    const page = read('apps/web/app/chronicle/page.tsx');
    expect(page).not.toContain('one city, one day, 105 chapters');
    expect(page).toContain('194 chapters');
  });
});
