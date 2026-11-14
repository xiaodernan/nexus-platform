import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1163 — the HK series cards carry a print-annual chapter numeral.
 *
 *   - the Roman numeral helper is pure, bounded to 1–3999, and survives cross-check values
 *     (I / IV / IX / XLIII / XLIV / CDXCIX / MMMCMXCIX)
 *   - the card mounts the numeral as a purely decorative, aria-hidden backdrop behind the
 *     content — never a link target, never interactive, never relied on for meaning
 *   - the numeral is an accent-tint at ~9% opacity; the card remains legible in both themes
 *   - the index comes from `cards.map((card, index)` — display order, not an "idempotence" claim
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const COMPONENT = 'apps/web/src/components/hk-series-progress.tsx';
const source = () => readFileSync(join(repoRoot, COMPONENT), 'utf8');

// the numeral helper lives in src/lib/roman-numeral.ts — pure, shared, tested
import { romanOf } from '@/lib/roman-numeral';

describe('D1163 chapter-card roman numeral', () => {
  it('romanOf walks the conversion table in order', () => {
    expect(romanOf(1)).toBe('I');
    expect(romanOf(4)).toBe('IV');
    expect(romanOf(9)).toBe('IX');
    expect(romanOf(39)).toBe('XXXIX');
    expect(romanOf(42)).toBe('XLII');
    expect(romanOf(43)).toBe('XLIII');
    expect(romanOf(44)).toBe('XLIV');
    expect(romanOf(58)).toBe('LVIII');
    expect(romanOf(89)).toBe('LXXXIX');
    expect(romanOf(99)).toBe('XCIX');
    expect(romanOf(499)).toBe('CDXCIX');
    expect(romanOf(1994)).toBe('MCMXCIV');
    expect(romanOf(3999)).toBe('MMMCMXCIX');
  });

  it('romanOf degrades to the raw decimal outside 1..3999 instead of throwing', () => {
    expect(romanOf(0)).toBe('0');
    expect(romanOf(-3)).toBe('-3');
    expect(romanOf(4000)).toBe('4000');
    expect(romanOf(Number.NaN)).toBe('NaN');
  });

  it('mounts the numeral as decoration only — never a link, never focusable', () => {
    const src = source();
    const numeral = src.indexOf('{romanOf(index + 1)}');
    expect(numeral).toBeGreaterThan(-1);
    const block = src.slice(numeral - 520, numeral + 60);
    expect(block).toContain('aria-hidden="true"');
    expect(block).toContain('pointer-events-none');
    expect(block).toContain('-bottom-4');
    expect(block).not.toContain('<button');
    expect(block).not.toContain('role="img"');
    expect(block).not.toMatch(/tabindex/i);
  });

  it('index comes from the map — display order, stable under any dict ordering', () => {
    const src = source();
    expect(src).toContain('cards.map((card, index)');
  });
});
