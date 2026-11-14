/**
 * D1163 — the print-annual chapter numeral for the /hong-kong hub cards.
 *
 * 1-based Roman numerals, bounded to the classical range (1–3999); outside it the helper
 * degrades to the raw decimal string instead of throwing — a card must never crash on a
 * numbering edge.
 */

const ROMAN: readonly [value: number, numeral: string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export const romanOf = (n: number): string => {
  if (!Number.isFinite(n) || n < 1 || n > 3999) return String(n);
  let rest = Math.floor(n);
  let out = '';
  for (const [value, numeral] of ROMAN) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
};
