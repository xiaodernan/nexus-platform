import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §7 — guided play coach: the /try page must be a guided session, not just a static list.
 * Local-first progress, dict-owned copy, checkable steps with an honest completion state.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COACH = 'apps/web/src/components/guided-play-coach.tsx';
const TRY = 'apps/web/app/try/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('guided play coach', () => {
  it('is a local-first client island with real progress state', () => {
    const island = read(COACH);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain("STORAGE_KEY = 'nexus.guided-play.v1'");
    expect(island).toContain('window.localStorage');
    expect(island).toContain('role="progressbar"');
    expect(island).toContain('aria-valuenow={done.length}');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('analytics');
  });

  it('/try mounts it above the five detailed steps, derived from the same flow', () => {
    const page = read(TRY);
    expect(page).toContain("import { GuidedPlayCoach } from '@/components/guided-play-coach'");
    expect(page).toContain('<GuidedPlayCoach');
    expect(page).toContain('copy={dict.home.guidedPlay}');
    expect(page).toContain('steps={flow.steps.map(');
  });

  it('both authored arms carry the completion and reset copy', () => {
    const dict = read(DICT);
    expect(dict).toContain('guidedPlay: {');
    expect(dict).toContain("eyebrow: '帶你玩 · 5 步'");
    expect(dict).toContain("eyebrow: 'GUIDED PLAY · 5 STEPS'");
    expect(dict).toContain("completeTitle: '五步都走過了");
    expect(dict).toContain("completeTitle: 'All five walked");
    expect(dict).toContain('progress: (done, total) =>');
  });
});
