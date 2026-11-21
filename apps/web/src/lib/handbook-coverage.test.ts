import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1505 — the embedded handbook must teach the features the product actually has. */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const dict = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict.ts'), 'utf8');

describe('handbook coverage of current features', () => {
  it('states the real chapter count, not the old 87', () => {
    expect(dict).toContain('一百七十二章按時辰攤成七層');
    expect(dict).toContain('One hundred and seventy-two chapters arranged by the hour');
    expect(dict).not.toContain('八十七章按時辰攤成七層');
    expect(dict).not.toContain('Eighty-seven chapters arranged by the hour');
  });

  it('teaches the new LLM lanes in both arms', () => {
    expect(dict).toContain("title: '問整座城 · /world'");
    expect(dict).toContain("title: 'Ask the whole city — /world'");
    expect(dict).toContain("title: '帶你玩 · /try'");
    expect(dict).toContain("title: 'Guided play — /try'");
    expect(dict).toContain('零 token');
    expect(dict).toContain('cost zero tokens');
  });

  it('the tour grew to nine steps in both arms', () => {
    expect(dict).toContain('三分鐘，九步上手');
    expect(dict).toContain('Nine steps, three minutes');
  });
});
