import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** D1612 — the fourth curated arc is wired to chapter pages and taught in both arms. */
describe('dawn arc wiring', () => {
  it('chapter pages choose the dawn arc last and reuse the rail', () => {
    const page = read('apps/web/app/guides/[slug]/page.tsx');
    expect(page).toContain("import { dawnArcFor, DAWN_ARC_SLUGS } from '@/lib/dawn-arc'");
    expect(page).toContain('const arc = ticket ?? crossing ?? timetable ?? dawn;');
    expect(page).toContain('dict.growth.dawnArc');
  });

  it('both arms carry the copy, the handbook teaches all four arcs', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("eyebrow: '破曉之弧 · 六章'");
    expect(dict).toContain("eyebrow: 'DAWN ARC · SIX CHAPTERS'");
    expect(dict).toContain('破曉之弧」：第 33、8、20、6、51、192 章');
    expect(dict).toContain('the DAWN ARC (chapters 33, 8, 20, 6, 51 and 192)');
    // the stale "four-stop" timetable claim must be gone
    expect(dict).not.toContain('四站路徑在任一章底部都看得到');
  });
});
