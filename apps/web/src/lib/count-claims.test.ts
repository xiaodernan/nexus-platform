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
  '八十七章香港系列', '八十七章之後', '八十七章，由凌晨', '八十七章讀竟',
  '一百零六章反覆走完一個 HK', '一百零六章香港系列指南', '一百零六章、三幕',
  '一百零六章反覆走一遍香港', '拓至第一百零六章', '一百零六章的完整馬拉松',
  '這一百零六章不是目錄',
  'Eighty-seven chapters', 'eighty-seven chapters',
];
const CURRENT = [
  '一百七十四章反覆走完一個 HK', '一百七十四章香港系列指南',
  '一百七十四章香港系列', '一百七十四章讀竟',
  'One hundred and seventy-four chapters',
];

describe('chapter-count claims across locales', () => {
  it('no stale count claim survives in either authored arm', () => {
    const found = STALE.filter((s) => dict.includes(s));
    expect(found, `stale counts: ${found.join(' | ')}`).toEqual([]);
  });

  it('both arms carry the current count', () => {
    for (const s of CURRENT) expect(dict.includes(s), `missing ${s}`).toBe(true);
  });

  it('the chronicle page comment is not frozen at 105', () => {
    const page = read('apps/web/app/chronicle/page.tsx');
    expect(page).not.toContain('one city, one day, 105 chapters');
    expect(page).toContain('174 chapters');
  });
});
