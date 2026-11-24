import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * D1609 — §十 identity lock. The owner's personal facts were hallucinated before; the identity
 * record in this repo (the milestone ledger) and all shipped copy surfaces must carry the canonical
 * spellings and never the forbidden product name. Tests and historical negative assertions are not
 * read here; the gate looks only at shipped copy and at the ledger's identity record.
 */
describe('owner identity lock', () => {
  const shipped = [
    'apps/web/src/lib/i18n/dict.ts',
    'apps/web/src/lib/i18n/dict-cn.ts',
    'docs/SHOWCASE.json',
  ].map((rel) => ({ rel, text: read(rel) }));

  it('never ships the forbidden product name', () => {
    for (const { rel, text } of shipped) {
      expect(text.includes('隐图'), `${rel} carries the forbidden product name`).toBe(false);
    }
  });

  it('keeps the canonical identity facts in the ledger record', () => {
    const ledger = read('docs/STATUS.md');
    for (const fact of ['赵欣曈', '南方科技大学', '香港中文大学', '全国中学生物理竞赛', '江西省一等奖', '江西省二等奖', '法狗狗', 'IELTS 6.5', '546', '隐盾']) {
      expect(ledger.includes(fact), `identity fact missing from the ledger: ${fact}`).toBe(true);
    }
  });

  it('the ledger never states the forbidden name as a positive fact', () => {
    const ledger = read('docs/STATUS.md');
    // Historical entries quote the forbidden word only inside explicit zero-count assertions.
    const lines = ledger.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.includes('隐图')) continue;
      const context = `${lines[Math.max(0, i - 1)]} ${lines[i]}`;
      const negative = /×0|zero|ZERO|not\.toContain|never|零|stale|forbidden|`.+`/.test(context);
      expect(negative, `positive forbidden name: ${lines[i]!.slice(0, 140)}`).toBe(true);
    }
  });
});
