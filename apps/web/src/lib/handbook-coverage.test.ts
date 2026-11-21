import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1505 — the embedded handbook must teach the features the product actually has. */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const dict = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict.ts'), 'utf8');

describe('handbook coverage of current features', () => {
  it('states the real chapter count, not the old 87 or the stale 172', () => {
    // D1517: the handbook said 172 while the shipped series is 175 (measured: 175 hk-* guides in
    // the seed). A manual that under-reports the world is a manual that loses the reader's trust.
    expect(dict).toContain('一百七十五章按時辰攤成七層');
    expect(dict).toContain('One hundred and seventy-five chapters arranged by the hour');
    expect(dict).not.toContain('一百七十二章');
    expect(dict).not.toContain('八十七章按時辰攤成七層');
    expect(dict).not.toContain('Eighty-seven chapters arranged by the hour');
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
