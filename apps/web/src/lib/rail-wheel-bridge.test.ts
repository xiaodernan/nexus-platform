/**
 * D1184 — pins for the wheel bridge decision and the attach contract. The function under
 * test is pure; `attachRailWheelBridge` itself needs a DOM, so the source-pin arms below
 * hold the discipline lines (fine pointers only, passive:false, preventDefault only when
 * consuming, release at both ends, no rAF, no timers).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decideWheelBridge } from '@nexus/ui';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(HERE, '../../../../packages/ui/src/trust/wheel-bridge.ts'),
  'utf8',
);

describe('decideWheelBridge', () => {
  const mid = { scrollLeft: 500, scrollWidth: 2000, clientWidth: 800 };

  it('bridges a downward wheel delta onto the strip mid-run', () => {
    expect(decideWheelBridge(mid, 0, 120)).toEqual({ kind: 'rail', scrollLeft: 620 });
  });

  it('bridges an upward wheel delta onto the strip mid-run', () => {
    expect(decideWheelBridge(mid, 0, -120)).toEqual({ kind: 'rail', scrollLeft: 380 });
  });

  it('releases the far end (down wheel at max scroll) back to the page', () => {
    expect(decideWheelBridge({ ...mid, scrollLeft: 1200 }, 0, 120)).toEqual({ kind: 'page' });
  });

  it('releases the near end (up wheel at zero scroll) back to the page', () => {
    expect(decideWheelBridge({ ...mid, scrollLeft: 0 }, 0, -120)).toEqual({ kind: 'page' });
  });

  it('native horizontal intent (|deltaX| >= |deltaY|) is untouched', () => {
    expect(decideWheelBridge(mid, 300, 400)).toEqual({ kind: 'rail', scrollLeft: 900 });
    expect(decideWheelBridge(mid, 500, 400)).toEqual({ kind: 'page' });
  });

  it('an unscrollable strip (max <= 1) releases to the page', () => {
    expect(decideWheelBridge({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 }, 0, 120)).toEqual({ kind: 'page' });
  });

  it('zero delta is a no-op for the page', () => {
    expect(decideWheelBridge(mid, 0, 0)).toEqual({ kind: 'page' });
  });

  it('never reverses a sign — a down delta always scrolls rightwards', () => {
    const d = decideWheelBridge(mid, 0, 120);
    expect(d.kind).toBe('rail');
    if (d.kind === 'rail') expect(d.scrollLeft).toBeGreaterThan(mid.scrollLeft);
  });
});

describe('attachRailWheelBridge source pins', () => {
  it('attaches only for fine pointers', () => {
    expect(SRC).toContain("matchMedia('(hover: hover) and (pointer: fine)')");
  });

  it('uses passive:false only on the consuming branch (preventDefault is real)', () => {
    expect(SRC).toContain('{ passive: false }');
    expect(SRC).toContain('event.preventDefault()');
  });

  it('releases the event at both ends (no page hijack)', () => {
    expect(SRC).toContain("'rail'");
    expect(SRC).toContain("'page'");
    expect(SRC).toContain('if (decision.kind !== \'rail\') return;');
  });

  it('imports nothing but the matchMedia global — no rAF, no timers, no React', () => {
    expect(SRC).not.toContain('requestAnimationFrame');
    expect(SRC).not.toContain('setTimeout');
    expect(SRC).not.toContain('setInterval');
    expect(SRC).not.toContain('useState');
    expect(SRC).not.toContain('useEffect');
  });
});
