import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** D1590 — the third curated arc is wired to chapter pages and taught in both arms. */
describe('timetable arc wiring', () => {
  it('chapter pages choose the timetable arc and reuse the rail', () => {
    const page = read('apps/web/app/guides/[slug]/page.tsx');
    expect(page).toContain("import { timetableArcFor, TIMETABLE_ARC_SLUGS } from '@/lib/timetable-arc'");
    expect(page).toContain('const timetable = timetableArcFor(guide.slug);');
    expect(page).toContain('const arc = ticket ?? crossing ?? timetable ?? dawn;');
    expect(page).toContain('dict.growth.timetableArc');
  });

  it('the shared rail adapts its columns to arcs longer than five steps', () => {
    const rail = read('apps/web/src/components/ticket-arc-rail.tsx');
    expect(rail).toContain("total <= 5 ? 'sm:grid-cols-5' : total <= 8 ? 'sm:grid-cols-4'");
    expect(rail).toContain('className={`mt-4 grid gap-2 ${columns}`}');
  });

  it('both authored arms carry the copy and the shared primitive is local', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("eyebrow: '時刻表之弧 · 十一章'");
    expect(dict).toContain("eyebrow: 'TIMETABLE ARC · ELEVEN CHAPTERS'");
    const lib = read('apps/web/src/lib/timetable-arc.ts');
    expect(lib).toContain("from './story-arc'");
    expect(lib).not.toMatch(/\bfetch\s*\(/);
  });
});
