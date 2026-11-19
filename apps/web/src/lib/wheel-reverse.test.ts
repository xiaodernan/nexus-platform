import { describe, expect, it } from 'vitest';

import {
  WHEEL_REVERSE_KEY,
  isInteractiveWheelTarget,
  readWheelReversePreference,
  wheelReversePixels,
  wheelReverseShouldIntercept,
  writeWheelReversePreference,
} from './wheel-reverse';

describe('wheelReversePixels', () => {
  it('passes pixel deltas through unchanged', () => {
    expect(wheelReversePixels({ deltaY: 120, deltaMode: 0 })).toBe(120);
  });
  it('scales line deltas by 16', () => {
    expect(wheelReversePixels({ deltaY: 3, deltaMode: 1 })).toBe(48);
  });
  it('scales page deltas by 80', () => {
    expect(wheelReversePixels({ deltaY: 1, deltaMode: 2 })).toBe(80);
  });
});

describe('isInteractiveWheelTarget', () => {
  it('returns true for a text input', () => {
    const el = { closest: () => ({}) };
    expect(isInteractiveWheelTarget(el)).toBe(true);
  });
  it('returns false for a plain div', () => {
    const el = { closest: () => null };
    expect(isInteractiveWheelTarget(el)).toBe(false);
  });
  it('returns false when closest throws', () => {
    const el = {
      closest: () => {
        throw new Error('bad selector');
      },
    };
    expect(isInteractiveWheelTarget(el)).toBe(false);
  });
  it('returns false for non-elements', () => {
    expect(isInteractiveWheelTarget(null)).toBe(false);
    expect(isInteractiveWheelTarget('nope')).toBe(false);
  });
});

describe('wheelReverseShouldIntercept', () => {
  const base = { defaultPrevented: false, deltaY: 100, ctrlKey: false, metaKey: false, target: { closest: () => null } };
  it('intercepts a plain vertical wheel', () => {
    expect(wheelReverseShouldIntercept(base)).toBe(true);
  });
  it('yields to an already-handled event', () => {
    expect(wheelReverseShouldIntercept({ ...base, defaultPrevented: true })).toBe(false);
  });
  it('yields to pinch-zoom gestures', () => {
    expect(wheelReverseShouldIntercept({ ...base, ctrlKey: true })).toBe(false);
    expect(wheelReverseShouldIntercept({ ...base, metaKey: true })).toBe(false);
  });
  it('yields when the delta is not vertical', () => {
    expect(wheelReverseShouldIntercept({ ...base, deltaY: 0 })).toBe(false);
  });
  it('yields inside interactive controls', () => {
    expect(wheelReverseShouldIntercept({ ...base, target: { closest: () => ({}) } })).toBe(false);
  });
});

describe('wheelReversePreference persistence', () => {
  const makeStorage = () => {
    const bag = new Map<string, string>();
    return {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
    };
  };
  it('round-trips the flag', () => {
    const s = makeStorage();
    expect(readWheelReversePreference(s)).toBe(false);
    writeWheelReversePreference(s, true);
    expect(s.getItem(WHEEL_REVERSE_KEY)).toBe('1');
    expect(readWheelReversePreference(s)).toBe(true);
    writeWheelReversePreference(s, false);
    expect(readWheelReversePreference(s)).toBe(false);
  });
  it('degrades honestly when storage throws (private mode)', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readWheelReversePreference(bad)).toBe(false);
    expect(() => writeWheelReversePreference(bad, true)).not.toThrow();
  });
});
