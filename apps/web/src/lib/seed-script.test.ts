import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1500 — the chapter corpus is copy too. `check_ui_script.mjs` deliberately does NOT judge
 * the seed (its carrier has different locale rules), but the zh-HK chapter bodies are exactly
 * what a Traditional reader is answered in. A Simplified character typed into one of them is
 * the "错别字" class the owner named. This uses the product's OWN canonical table as authority
 * (never a hand-written list that could drift from it), charges only the zh-HK half of each
 * chapter, and prints exclusions with reasons so a silent carve-out is impossible.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

// Authority read as TEXT — a broken table must not satisfy its own assertion.
const CANONICAL = read('apps/ai/nexus_ai/nlu/canonical.py');
const simplified = new Set<string>(
  [...CANONICAL.matchAll(/"\\u([0-9a-fA-F]{4})":\s*"\\u[0-9a-fA-F]{4}"/g)]
    .map((m) => String.fromCharCode(parseInt(m[1]!, 16))),
);

// Exclusions with reasons — the same discipline as check_ui_script.mjs.
const EXCLUDED: Record<string, string> = {
  台: 'the product writes 平台 (not 平臺) throughout the corpus',
  面: '面 is Traditional for face/surface; 麵 is the noodle word',
  嘅: 'a Cantonese particle, not a script variant',
};
const charged = new Set([...simplified].filter((c) => !(c in EXCLUDED)));

const SEED = read('apps/web/src/lib/mock/seed.ts');

/** zh-HK prose only: body_blocks up to the body_blocks_en marker, per chapter. */
function zhProse(): Array<{ slug: string; text: string }> {
  const out: Array<{ slug: string; text: string }> = [];
  const starts = [...SEED.matchAll(/slug: '([^']+)', title: '([^']*)'/g)];
  for (let i = 0; i < starts.length; i += 1) {
    const match = starts[i]!;
    const slug = match[1]!;
    if (!slug.startsWith('hk-')) continue;
    const from = match.index ?? 0;
    const to = i + 1 < starts.length ? (starts[i + 1]?.index ?? SEED.length) : SEED.length;
    const block = SEED.slice(from, to).split('body_blocks_en:')[0]!;
    const texts = [...block.matchAll(/text: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
    out.push({ slug, text: texts.join('\n') });
  }
  return out;
}

describe('D1500 chapter corpus script', () => {
  it('the authority table is populated', () => {
    expect(simplified.size).toBeGreaterThan(100);
    expect(charged.size).toBeGreaterThan(100);
  });

  it('every zh-HK chapter body is free of Simplified-only characters', () => {
    const chapters = zhProse();
    expect(chapters.length).toBeGreaterThanOrEqual(170);
    const offenders: string[] = [];
    for (const { slug, text } of chapters) {
      const bad = [...new Set([...text].filter((c) => charged.has(c)))];
      if (bad.length) offenders.push(`${slug}: ${bad.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')}`);
    }
    expect(offenders, `${offenders.length} chapter(s) carry Simplified characters`).toEqual([]);
  });
});
