import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1496 — the backend-only Wayfinder StateGraph gets a real user door: a BFF route and a
 * panel on /world. The fixed mood vocabulary is enforced at the proxy so a client cannot
 * smuggle free text into the model call.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PANEL = 'apps/web/src/components/wayfinder-panel.tsx';
const BFF = 'apps/web/app/api/nexus/ai/wayfinder/route.ts';
const WORLD = 'apps/web/app/world/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('wayfinder user surface', () => {
  it('the panel is a click-only client island with a fixed mood vocabulary', () => {
    const panel = read(PANEL);
    expect(panel.startsWith("'use client';")).toBe(true);
    expect(panel).toContain("const MOODS = ['continue', 'revisit', 'late_night', 'warm_food', 'keep_the_promise']");
    expect(panel).toContain("fetch('/api/nexus/ai/wayfinder'");
    expect(panel).toContain('disabled={busy}');
    expect(panel).not.toContain('useEffect');
  });

  it('the BFF validates position and mood before proxying', () => {
    const bff = read(BFF);
    expect(bff).toContain("'/ai/v1/world/wayfinder'");
    expect(bff).toContain('MOODS.has(body.mood)');
    expect(bff).toContain('Math.min(1000, Math.max(0, Math.trunc(body.position)))');
    expect(bff).toContain("reason: 'mock_provider'");
  });

  it('/world mounts the panel next to the story recap, from dict copy', () => {
    const world = read(WORLD);
    expect(world).toContain("import { WayfinderPanel } from '@/components/wayfinder-panel'");
    expect(world).toContain('<WayfinderPanel locale={locale} copy={t.wayfinder} />');
    expect(world).toContain('<StoryRecap');
  });

  it('both authored arms carry the mood vocabulary and result labels', () => {
    const dict = read(DICT);
    expect(dict).toContain('wayfinder: {');
    expect(dict).toContain("eyebrow: '向導 · 讀者狀態'");
    expect(dict).toContain("eyebrow: 'WAYFINDER · READER STATE'");
    expect(dict).toContain("keep_the_promise: '想看守約的人'");
    expect(dict).toContain("keep_the_promise: 'Keeping a promise'");
  });
});
