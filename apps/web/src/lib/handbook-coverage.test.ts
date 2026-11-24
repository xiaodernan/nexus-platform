import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1505 — the embedded handbook must teach the features the product actually has. */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const dict = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict.ts'), 'utf8');
const dictCn = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict-cn.ts'), 'utf8');

describe('handbook coverage of current features', () => {
  it('states the real chapter count, not the old 87 or the stale 172', () => {
    // D1517: the handbook said 172 while the shipped series is 179 (measured: 179 hk-* guides in
    // the seed). A manual that under-reports the world is a manual that loses the reader's trust.
    expect(dict).toContain('一百八十九章按時辰攤成七層');
    expect(dict).toContain('One hundred and eighty-nine chapters arranged by the hour');
    expect(dict).not.toContain('一百七十二章');
    expect(dict).not.toMatch(/(?<!一百)八十七章按時辰攤成七層/);
    expect(dict).not.toMatch(/(?<!and )Eighty-seven chapters arranged by the hour/);
  });

  it('teaches the ticket arc in both arms (D1565)', () => {
    // The five-chapter arc is a new way into the world; a manual that omits it hides a door.
    expect(dict).toContain('另有「票之弧」：第 179 至 183 章講同一張票走過一整天');
    expect(dict).toContain('There is also the TICKET ARC: chapters 179–183 tell the story of one ticket across a whole day');
  });

  it('teaches the measured world statistics in both arms (D1601)', () => {
    expect(dict).toContain('世界普查、七層實測明細');
    expect(dict).toContain('a measured world census, a per-layer breakdown');
  });

  it('teaches the timetable arc in both arms (D1590)', () => {
    expect(dict).toContain('時刻表之弧」：第 184 至 189 章');
    expect(dict).toContain('the TIMETABLE ARC (chapters 184–189)');
  });

  it('teaches the crossing arc in both arms (D1567)', () => {
    // The border's night into morning is the second curated arc; the manual must name it too.
    expect(dict).toContain('還有「渡之弧」：第 64、61、62、65、67 章講同一道口岸');
    expect(dict).toContain('There is also the CROSSING ARC: chapters 64, 61, 62, 65 and 67 tell one border');
    // The simplified arm is regenerated, not hand-kept — one leg proves the sync.
    expect(dictCn).toContain('还有「渡之弧」：第 64、61、62、65、67 章讲同一道口岸');
  });

  it('teaches the reading thread in both arms (D1517)', () => {
    expect(dict).toContain("title: '續讀線 · /guides'");
    expect(dict).toContain("title: 'Reading thread · /guides'");
    expect(dict).toContain('零 token、零網絡');
    expect(dict).toContain('zero tokens, zero network');
  });

  it('teaches the new LLM lanes in both arms', () => {
    expect(dict).toContain("title: '問整座城 · /world'");
    expect(dict).toContain("title: 'Ask the whole city — /world'");
    expect(dict).toContain("title: '帶你玩 · /try'");
    expect(dict).toContain("title: 'Guided play — /try'");
    expect(dict).toContain('零 token');
    expect(dict).toContain('cost zero tokens');
  });

  it('the tour grew to ten steps in both arms', () => {
    expect(dict).toContain('三分鐘，十步上手');
    expect(dict).toContain('Ten steps, three minutes');
  });
});
