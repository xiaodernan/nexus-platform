/**
 * D1283 — the wheel-direction self-test, as a pure decision.
 *
 * A mouse wheel reports `deltaY` with its sign already resolved by the operating system. A
 * Windows reader whose driver flips the axis, or a macOS reader with Natural scrolling on,
 * experiences that as "往上滑、睇下面；往下滑、睇上面". The product cannot flip it back —
 * the OS owns the sign — but the product CAN tell the reader which side of the line the
 * fault lives on, in five seconds, inside the manual.
 *
 * The island collects two signed sums over deliberate gestures (one downward, one upward) and
 * asks the pair: does a downward gesture yield a positive sum (page looks down) while an
 * upward gesture yields a negative one? That is `normal`. The exact contradiction is
 * `inverted`. Anything too weak to judge — fewer than ~one notch in total, or mixed signs —
 * is `inconclusive`, which is the honest answer for trackpads, hovers and fat fingers.
 *
 * One number per direction, no smoothing, no timers.
 */

export type WheelVerdict = 'normal' | 'inverted' | 'inconclusive';

/** Below this magnitude the sample stream is too weak to judge (trackpads, hover noise). */
export const WHEEL_SIGNAL = 60;
/** Two signed-same-direction notches of travel close a gesture phase. */
export const WHEEL_ADVANCE = 300;

export function classifyWheelPair(downTotal: number, upTotal: number): WheelVerdict {
  if (!Number.isFinite(downTotal) || !Number.isFinite(upTotal)) return 'inconclusive';
  if (Math.abs(downTotal) < WHEEL_SIGNAL || Math.abs(upTotal) < WHEEL_SIGNAL) return 'inconclusive';
  const downSign = Math.sign(downTotal);
  const upSign = Math.sign(upTotal);
  if (downSign > 0 && upSign < 0) return 'normal';
  if (downSign < 0 && upSign > 0) return 'inverted';
  return 'inconclusive';
}

export function accumulateWheelDelta(prev: number, deltaY: number): number {
  if (!Number.isFinite(deltaY)) return prev;
  // Only the vertical axis decides; a diagonal gesture contributes its vertical component.
  return prev + deltaY;
}
