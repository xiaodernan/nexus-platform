/**
 * D1317 — the Ah Wan dialogue island is fail-closed by construction.
 *
 * The daily page stands fine without her; this island only ADDS one voice in one tower. These
 * pins read the source the way the repo's island pins do.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const ISLAND = 'apps/web/src/components/ah-wan-dialogue.tsx';
const ROUTE = 'apps/web/app/api/nexus/ai/npc-ah-wan/route.ts';
const DAILY_PAGE = 'apps/web/app/daily/page.tsx';

describe('ah-wan-dialogue island', () => {
  const island = readFileSync(join(repoRoot, ISLAND), 'utf8');

  it('is a client component with exactly one send path, no timers, no storage, no retry', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
    expect(island).not.toContain('retry(');
  });

  it('its only network call is a single POST to the BFF ah-wan endpoint', () => {
    expect(island).toContain("fetch('/api/nexus/ai/npc-ah-wan'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('history');
  });

  it('an empty answer renders nothing — the page stands', () => {
    expect(island).toContain("if (phase.kind === 'gone') return null;");
    expect(island).toContain('answer.trim().length > 0');
  });

  it('it renders only the server-passed turns — never invented text', () => {
    expect(island).toContain('phase.turns');
    expect(island).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('the BFF route never answers for the model in mock mode', () => {
  const route = readFileSync(join(repoRoot, ROUTE), 'utf8');

  it('curates history server-side and is inert in mock mode', () => {
    expect(route).toContain('parseHistory');
    expect(route).toContain('mock_provider');
    expect(route).toContain('IS_MOCK');
  });
});

describe('/daily mounts the NPC exactly once, with dict labels', () => {
  const page = readFileSync(join(repoRoot, DAILY_PAGE), 'utf8');

  it('renders the NPC section once before the pillars, with dict labels', () => {
    expect(page).toContain('<AhWanDialogue');
    expect(page).toContain('labels={dict.home.npcAhWan}');
    expect((page.match(/<AhWanDialogue/g) ?? []).length).toBe(1);
    expect(page.indexOf('<AhWanDialogue')).toBeLessThan(page.indexOf('<HkDailyAlmanac'));
  });

  it('all three locales carry the npcAhWan labels', () => {
    const dict = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict.ts'), 'utf8');
    expect((dict.match(/npcAhWan: \{/g) ?? []).length).toBe(3); // interface + zh-HK + en
    const dictCn = readFileSync(join(repoRoot, 'apps/web/src/lib/i18n/dict-cn.ts'), 'utf8');
    expect((dictCn.match(/npcAhWan: \{/g) ?? []).length).toBe(1);
  });
});
