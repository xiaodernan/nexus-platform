/**
 * D1283 — the wheel-direction self-test pins.
 *
 * Pure decision table for the verdict logic (this is the part that is allowed to be wrong in
 * only one way — politely refusing to judge), plus the island's own source discipline pins,
 * matching the house style of the other island pins.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyWheelPair, accumulateWheelDelta, WHEEL_SIGNAL } from './wheel-check';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const ISLAND = 'apps/web/src/components/wheel-check.tsx';
const PAGE = 'apps/web/app/handbook/page.tsx';

describe('classifyWheelPair', () => {
  it('judges a normal machine normal (down gesture → positive, up gesture → negative)', () => {
    expect(classifyWheelPair(240, -240)).toBe('normal');
    expect(classifyWheelPair(120, -130)).toBe('normal');
  });

  it('judges an OS-flipped machine inverted (down gesture → negative, up gesture → positive)', () => {
    expect(classifyWheelPair(-240, 240)).toBe('inverted');
    expect(classifyWheelPair(-120, 160)).toBe('inverted');
  });

  it('refuses to judge below the signal floor, on equal signs, and on nonsense', () => {
    expect(classifyWheelPair(WHEEL_SIGNAL - 1, -240)).toBe('inconclusive');
    expect(classifyWheelPair(240, -(WHEEL_SIGNAL - 1))).toBe('inconclusive');
    expect(classifyWheelPair(240, 120)).toBe('inconclusive'); // both positive — one gesture mis-armed
    expect(classifyWheelPair(-240, -120)).toBe('inconclusive');
    expect(classifyWheelPair(Number.NaN, -240)).toBe('inconclusive');
    expect(classifyWheelPair(240, Number.POSITIVE_INFINITY)).toBe('inconclusive');
  });
});

describe('accumulateWheelDelta', () => {
  it('sums only finite vertical deltas and keeps a running accumulator', () => {
    let acc = 0;
    acc = accumulateWheelDelta(acc, 100);
    acc = accumulateWheelDelta(acc, 100);
    acc = accumulateWheelDelta(acc, Number.NaN);
    expect(acc).toBe(200);
    expect(accumulateWheelDelta(acc, -120)).toBe(80);
  });
});

describe('wheel-check island discipline', () => {
  const island = readFileSync(join(repoRoot, ISLAND), 'utf8');

  it('is a client component with no timers, no storage, no network', () => {
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('setInterval');
    expect(island).not.toContain('setTimeout');
    expect(island).not.toContain('localStorage');
    expect(island).not.toContain('sessionStorage');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('http');
  });

  it('listens at window capture only while armed, and hands the wheel back on the verdict', () => {
    expect(island).toContain("window.addEventListener('wheel', onWheel, { capture: true, passive: false })");
    expect(island).toContain("window.removeEventListener('wheel', onWheel");
    expect(island).toContain('if (stage === \'idle\' || stage === \'done\') return;');
    expect(island).toContain('event.preventDefault()');
  });

  it('renders the verdict as a polite live status, never a navigation or side effect', () => {
    expect(island).toContain('role="status"');
    expect(island).toContain("setStage('done')");
    expect(island).not.toContain('location');
    expect(island).not.toContain('window.open');
  });
});

describe('handbook page mounts the check once, above the fold of the manual', () => {
  const page = readFileSync(join(repoRoot, PAGE), 'utf8');

  it('imports and renders WheelCheck with the dict-driven labels', () => {
    expect(page).toContain("import { WheelCheck } from '@/components/wheel-check';");
    expect(page).toContain('<WheelCheck labels={copy.wheelCheck} />');
    expect((page.match(/<WheelCheck/g) ?? []).length).toBe(1);
  });
});
