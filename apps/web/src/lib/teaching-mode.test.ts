import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §5/§7 — teaching mode: the persistent per-control help on the home surface.
 * Source pins: a local-first client island, dict-owned copy, mounted next to the
 * newcomer strip. No network, no telemetry, no hand-written prose on the page.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/teaching-mode.tsx';
const HOME = 'apps/web/app/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('teaching mode', () => {
  it('is a local-first client island — no network and no telemetry', () => {
    const island = read(ISLAND);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain("STORAGE_KEY = 'nexus.teaching.on'");
    expect(island).toContain('window.localStorage');
    expect(island).toContain('aria-pressed={on}');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('XMLHttpRequest');
    expect(island).not.toContain('analytics');
  });

  it('home mounts it beside the newcomer strip, from dict copy', () => {
    const home = read(HOME);
    expect(home).toContain("import { TeachingMode } from '@/components/teaching-mode'");
    expect(home).toContain('<TeachingMode copy={dict.home.teaching} />');
    expect(home).toContain('<NewcomerTour copy={dict.home.newcomer} />');
  });

  it('both authored arms carry the five control→hint pairs and the toggle labels', () => {
    const dict = read(DICT);
    expect(dict).toContain("teaching: {");
    expect(dict).toContain("eyebrow: '操作教學'");
    expect(dict).toContain("eyebrow: 'HOW TO USE'");
    expect(dict).toContain("show: '顯示教學說明'");
    expect(dict).toContain("show: 'Show teaching hints'");
    // five pairs in each arm
    const zh = dict.slice(dict.indexOf("eyebrow: '操作教學'"));
    const en = dict.slice(dict.indexOf("eyebrow: 'HOW TO USE'"));
    expect((zh.slice(0, 1500).match(/control: '/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((en.slice(0, 1500).match(/control: '/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
