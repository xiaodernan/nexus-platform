import { describe, expect, it } from 'vitest';

import { WEEKDAY_LABELS, weekdayLabel } from './format';

/**
 * `weekdayLabel` is the one weekday vocabulary both surfaces render. `app/merchant/settings` prints the
 * `business_hours` rows through it, and so does the public merchant page, so a change here is a change to
 * copy that is on screen twice.
 *
 * The expected strings are written out below rather than read from `WEEKDAY_LABELS`, because a test that
 * reads the table it is testing cannot fail when the table moves. The page this replaced carried its own
 * copy of the table with two locales in it and a different vocabulary from the shared one — the same seven
 * rows read one way on the console and another way on the public page — and nothing in the repository
 * compared either of them to anything.
 */
const EXPECTED: Record<string, string[]> = {
  'zh-HK': ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
  'zh-CN': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

/**
 * One expected label, or a throw that names what is missing.
 *
 * `noUncheckedIndexedAccess` is right that `EXPECTED['zh-HK'][0]` can be `undefined` — a `Record` lookup
 * is not a contract. Non-null assertions would silence it at every site; this keeps the compiler's point
 * and turns a miss into a failure that says which locale and which day, instead of a `toBe(undefined)`
 * that passes for as long as nobody looks.
 */
function at(locale: string, day: number): string {
  const labels = EXPECTED[locale];
  if (!labels) throw new Error(`EXPECTED has no weekday row for ${locale}`);
  const label = labels[day];
  if (label === undefined) throw new Error(`EXPECTED[${locale}] has no day ${day}`);
  return label;
}

describe('weekdayLabel', () => {
  for (const [locale, labels] of Object.entries(EXPECTED)) {
    it(`renders the ${locale} week in order, Sunday through Saturday`, () => {
      expect(labels).toHaveLength(7);
      expect(Array.from({ length: 7 }, (_, day) => weekdayLabel(day, locale))).toEqual(labels);
    });
  }

  it('is the table the module ships, so an edit there cannot pass unnoticed', () => {
    expect(WEEKDAY_LABELS).toEqual(EXPECTED);
  });

  it('wraps a day outside the week instead of returning an empty label', () => {
    expect(weekdayLabel(7, 'zh-HK')).toBe(at('zh-HK', 0));
    expect(weekdayLabel(14, 'en')).toBe(at('en', 0));
    expect(weekdayLabel(-1, 'zh-HK')).toBe(at('zh-HK', 6));
  });

  it('defaults to zh-HK, which is the site default', () => {
    expect(weekdayLabel(3)).toBe(at('zh-HK', 3));
  });

  it('falls back to English for a locale it does not hold', () => {
    expect(weekdayLabel(2, 'fr')).toBe(at('en', 2));
  });

  it('returns an empty label rather than a wrong one when the day is not a number', () => {
    expect(weekdayLabel(Number.NaN, 'zh-HK')).toBe('');
  });
});
