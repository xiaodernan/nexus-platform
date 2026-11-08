import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntentTime } from '../types';
import { mergeIntent, understandQuery } from './index';

/**
 * D721 — the mock plane read the hour a visitor typed and not the hour a visitor speaks.
 *
 * THE DEFECT. `CLOCK_RE` here is the service's, digit-for-digit, and the service never feeds raw
 * text to it: `timeparse.clock_match` rewrites the Chinese numerals first
 * (`numerals.normalise_numerals(text, only_before=_HOUR_MARKERS)`) and searches the rewritten
 * string. So 「9點」 was 09:00 on both planes while 「九點」 was 09:00 on the service and no time at
 * all here, and 「晚上九點」 came back as 18:00 — the evening window's opening hour, which is what
 * the mock answers when it finds a part of day and no clock. Measured before the repair over the
 * 33 queries of `tmp/d655_before.txt`, against the service's own `parse_time` in
 * `tmp/d655_service.txt`: 23 of them published nothing (19) or the window (4) where the service
 * published the hour, and every one of them is a sentence a Hong Kong user types.
 *
 * WHAT IT USES AS AUTHORITY. `nlu/numerals.py` and `nlu/canonical.py` read as TEXT (D626: a broken
 * table must not be able to satisfy its own assertion). The digit roster, the value of every digit
 * and the hour markers are taken from the service's declarations, so a numeral added there and not
 * here is a red test rather than a silent disagreement. The service holds one spelling per
 * character because its text is canonicalised before it is read; this plane has no canonicalisation
 * and hand-carries both scripts (D641), so the second spelling of each marker and of 兩 is derived
 * from `CANONICAL_FORMS` rather than remembered.
 *
 * WHERE THAT AUTHORITY IS BLIND, STATED LOUDLY. Two readings this unit does NOT resolve, and
 * PLAN.md carries both: a category cue that blocks the window still tells the service which half of
 * the day a bare hour means (「下午茶3點」 is 15:00 there and 03:00 here), and a named weekday moves
 * the day there (「星期日三點」 is Sunday) while this lane only knows 週六 and shifts it by a magic
 * +4. The last leg below pins both as they ship, so the unit that fixes either one has to change a
 * green test rather than discover the gap again.
 */

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'apps', 'ai', 'nexus_ai', 'nlu', 'numerals.py'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const nluDir = join(repoRoot, 'apps', 'ai', 'nexus_ai', 'nlu');
const numeralsSource = readFileSync(join(nluDir, 'numerals.py'), 'utf8');
const timeparseSource = readFileSync(join(nluDir, 'timeparse.py'), 'utf8');
const canonicalSource = readFileSync(join(nluDir, 'canonical.py'), 'utf8');
const mockSource = readFileSync(join(repoRoot, 'apps', 'web', 'src', 'lib', 'mock', 'index.ts'), 'utf8');

/** `"\u5169"` to the character it names — the service writes its tables as escapes (D409). */
function decodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** `numerals.CN_DIGITS` as the service declares it. Every branch that would return an empty roster
 *  throws, because a census over no digits charges nothing and a green that means "I read nothing"
 *  is the failure this file exists to refuse. */
function readDigitTable(source: string): Array<{ character: string; value: number }> {
  const open = source.indexOf('CN_DIGITS');
  if (open < 0) throw new Error('no CN_DIGITS in the service numerals module — nothing to compare against');
  const brace = source.indexOf('{', open);
  const end = source.indexOf('\n}', brace);
  if (brace < 0 || end < 0) throw new Error('CN_DIGITS did not close — a blind reader would report no digits and pass');
  const rows: Array<{ character: string; value: number }> = [];
  for (const match of source.slice(brace, end).matchAll(/"(\\u[0-9a-fA-F]{4})"\s*:\s*(\d+)/g)) {
    rows.push({ character: decodeEscapes(match[1] as string), value: Number(match[2]) });
  }
  if (rows.length < 12) throw new Error(`only ${rows.length} CN_DIGITS rows were read out of numerals.py — the roster is too thin to charge anything`);
  return rows;
}

/** The same table cut out of this lane's source, so the comparison is value-to-value and not
 *  "does the character appear somewhere in the file". */
function readMockDigitTable(source: string): Array<{ character: string; value: number }> {
  const declared = /const CN_DIGITS = new Map<string, number>\(\[([\s\S]*?)\]\);/.exec(source);
  if (!declared) throw new Error('this lane no longer declares a CN_DIGITS map this census can read');
  const rows: Array<{ character: string; value: number }> = [];
  for (const match of (declared[1] ?? '').matchAll(/\['(.)',\s*(\d+)\]/g)) {
    rows.push({ character: match[1] as string, value: Number(match[2]) });
  }
  if (rows.length < 12) throw new Error(`only ${rows.length} rows were read out of this lane's CN_DIGITS — the splice would pass on an empty table`);
  return rows;
}

/** `timeparse._HOUR_MARKERS`, the characters that make a numeral an hour. */
function serviceHourMarkers(source: string): string[] {
  const match = /_HOUR_MARKERS\s*=\s*"([^"]*)"/.exec(source);
  if (!match) throw new Error('the service declares no _HOUR_MARKERS this reader can cut');
  return [...(match[1] ?? '')];
}

/** The markers this lane declares, read from its own declaration. */
function mockHourMarkers(source: string): string[] {
  const declared = /const HOUR_MARKERS = '([^']*)'/.exec(source);
  if (!declared) throw new Error('this lane no longer declares the HOUR_MARKERS string the census can read');
  return [...(declared[1] ?? '')];
}

/** `canonical.CANONICAL_FORMS` inverted: for a canonical character, the spellings a user may type. */
function typedSpellings(source: string, canonicalChar: string): string[] {
  const open = source.indexOf('CANONICAL_FORMS');
  if (open < 0) throw new Error('no CANONICAL_FORMS in canonical.py — the second spelling has no authority');
  const brace = source.indexOf('{', open);
  const end = source.indexOf('\n}', brace);
  if (brace < 0 || end < 0) throw new Error('CANONICAL_FORMS did not close — a blind reader would report no pairs and pass');
  const typed: string[] = [];
  let entries = 0;
  for (const match of source.slice(brace, end).matchAll(/"(\\u[0-9a-fA-F]{4})"\s*:\s*"(\\u[0-9a-fA-F]{4})"/g)) {
    entries += 1;
    if (decodeEscapes(match[2] as string) === canonicalChar) typed.push(decodeEscapes(match[1] as string));
  }
  if (entries < 50) throw new Error(`only ${entries} canonical pairs were read out of canonical.py — the table is not the product's`);
  return typed;
}

/** 00:30 on the Hong Kong clock: no window has closed, so a stated hour is the hour that was said. */
const EARLY = '2026-11-01T16:30:00Z';
/** 21:00 Hong Kong — a stated 9pm has already gone by. */
const AFTER_NINE = '2026-11-02T13:00:00Z';

const HK_OFFSET_MS = 8 * 3_600_000;

function publishedTime(query: string, nowIso: string): { type: string; starts_at: string | null } {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  try {
    const intent = understandQuery(query);
    if (!intent.time) throw new Error(`"${query}" published no time object at all — the lane answered nothing, not type none`);
    return { type: intent.time.type, starts_at: intent.time.starts_at ?? null };
  } finally {
    vi.useRealTimers();
  }
}

function hkHourMinute(iso: string): [number, number] {
  const shifted = new Date(Date.parse(iso) + HK_OFFSET_MS);
  return [shifted.getUTCHours(), shifted.getUTCMinutes()];
}

/** Every row is the hour the service's own `parse_time` printed for the same text at the same
 *  instant — the whole corpus is in `tmp/d655_service.txt`, run out of `tmp/d655_service_probe.py`.
 *  The pre-fix readings of the 33 strings that probe ran are in `tmp/d655_before.txt`; the ones
 *  added since have no pre-fix row, so the 23 counted above are counted over that corpus only. */
const STATED_HOURS: Array<[string, number, number]> = [
  ['九點', 9, 0], ['九点', 9, 0], ['九時', 9, 0], ['九时', 9, 0], ['晚上九點', 21, 0],
  ['三點半', 3, 30], ['十一點', 11, 0], ['十二點', 12, 0], ['二十點', 20, 0], ['十一點半', 11, 30],
  ['兩點', 2, 0], ['两点', 2, 0], ['兩點半', 2, 30], ['五點半', 5, 30], ['十點半', 10, 30],
  ['六時', 6, 0], ['六时', 6, 0], ['夜晚八時', 20, 0], ['朝早九點', 9, 0], ['晚上八點半', 20, 30],
  ['九點鐘', 9, 0], ['約七點', 7, 0], ['七點左右', 7, 0], ['零點', 0, 0],
  // The minutes of a numeral are not rewritten by the authority either: only_before is an hour
  // marker, so 「十五」 stays text and the tail group reads no minute. Both planes say 03:00.
  ['三點十五分', 3, 0], ['三點零分', 3, 0],
];

/**
 * Numerals that must NOT become an hour, for four different reasons the authority gives: the Chinese
 * ONE is never rewritten, so 「一點」 and 「安靜一點」 reach the clock as text and 一 stays a degree
 * (`numerals.py` says the product already decided this, twice, and `tmp/d655_service.txt` prints
 * `None` for all four sentences); a run the clock cannot show is refused after it is read, so
 * 「三十三點」 and 「二五點」 rewrite to 33 and 25 and then publish nothing; 「廿點」 is not in the
 * digit table at all; and 「下午茶」 carries no numeral. 「星期三」 is the one row here the service
 * does read — as a Wednesday range, not as an hour — and this lane reads no weekday name at all,
 * which is the second disagreement the last leg pins.
 */
const REFUSED = ['一點', '安靜一點', '安靜一点', '幫我找一間安靜一點的餐廳', '三十三點', '二五點', '廿點', '星期三', '下午茶'];

afterEach(() => {
  vi.useRealTimers();
});

describe('the mock plane reads the Chinese numeral hour the service reads (D721)', () => {
  it('reads its own authority: the digit table, its values and the hour markers', () => {
    const service = readDigitTable(numeralsSource);
    const mock = readMockDigitTable(mockSource);
    const mockValues = new Map(mock.map((row) => [row.character, row.value]));
    const wrong = service.filter((row) => mockValues.get(row.character) !== row.value);
    expect(wrong, `a digit the service values differently here: ${wrong.map((row) => `${row.character}=${String(row.value)} vs ${String(mockValues.get(row.character))}`).join(', ')}`).toEqual([]);
    // This plane has no canonicalisation, so every character needs both of its spellings — and the
    // second spelling comes from canonical.py, not from a memory of what 兩 looks like simplified.
    const unpaired = service
      .map((row) => row.character)
      .filter((character) => typedSpellings(canonicalSource, character).some((typed) => !mockValues.has(typed)));
    expect(unpaired, `the authority folds a spelling this lane does not carry: ${unpaired.join(', ')}`).toEqual([]);
    const markers = serviceHourMarkers(timeparseSource);
    const declared = mockHourMarkers(mockSource);
    const missingMarkers = markers.flatMap((marker) => [marker, ...typedSpellings(canonicalSource, marker)].filter((spelling) => !declared.includes(spelling)));
    expect(missingMarkers, `a numeral is rewritten before no marker here: ${missingMarkers.join(', ')}`).toEqual([]);
  });

  it('answers a Chinese-numeral hour with the hour the service answers it with', () => {
    for (const [query, hour, minute] of STATED_HOURS) {
      const published = publishedTime(query, EARLY);
      expect(published.type, `"${query}" published no time, and the service reads it at ${String(hour)}:${String(minute)}`).toBe('explicit');
      const [gotHour, gotMinute] = hkHourMinute(published.starts_at as string);
      expect([gotHour, gotMinute], `"${query}" was read as ${String(gotHour)}:${String(gotMinute)} in Hong Kong time, not ${String(hour)}:${String(minute)}`).toEqual([hour, minute]);
    }
  });

  it('leaves a numeral that is not an hour out of the clock', () => {
    for (const query of REFUSED) {
      const published = publishedTime(query, EARLY);
      expect(published.type, `"${query}" is not a stated hour and must not be published as one`).toBe('none');
      expect(published.starts_at, `"${query}" carried an invented instant`).toBeNull();
    }
  });

  it('publishes the digit and the numeral as one instant', () => {
    const pairs: Array<[string, string]> = [['九點', '9點'], ['十一點', '11點'], ['二十點', '20點'], ['六時', '6時'], ['晚上九點', '晚上9點'], ['兩點半', '2點半']];
    for (const [numeral, digit] of pairs) {
      for (const now of [EARLY, AFTER_NINE]) {
        const spoken = publishedTime(numeral, now);
        const typed = publishedTime(digit, now);
        expect(spoken.starts_at, `"${numeral}" and "${digit}" are one hour said two ways at ${now}`).toBe(typed.starts_at);
      }
    }
  });

  it('reads a numeral in the follow-up with the one reader the first turn uses', () => {
    // Parity alone would be green with BOTH readers blind, so each phrase also carries the hour the
    // authority publishes for it (the last row is the degree, which stays refused).
    const followUps: Array<[string, number | null]> = [
      ['九點', 9], ['晚上九點', 21], ['三點半', 3], ['十點半', 10], ['兩點', 2], ['七點左右', 7], ['安靜一點', null],
    ];
    for (const [followUp, hour] of followUps) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(EARLY));
      let merged;
      let firstTurn;
      try {
        merged = mergeIntent(null, followUp);
        firstTurn = understandQuery(followUp);
      } finally {
        vi.useRealTimers();
      }
      expect(merged.time, `"${followUp}" is read one way by understandQuery and another by mergeIntent`).toEqual(firstTurn.time);
      const time = merged.time as IntentTime;
      if (hour === null) {
        expect(time.type, `"${followUp}" is a degree, not an hour, and the merge published it as one`).toBe('none');
        expect(merged.unknowns, `"${followUp}" states no time, so the merge must still ask for one`).toContain('time');
        continue;
      }
      expect(time.type, `"${followUp}" names ${String(hour)} o'clock and the merge published no time`).toBe('explicit');
      expect(hkHourMinute(time.starts_at as string)[0], `"${followUp}" merged as the wrong hour`).toBe(hour);
      expect(merged.unknowns, 'the merge published a time and still lists it as missing').not.toContain('time');
      expect(merged.confidence.time, 'the merge published a time with no confidence in it').toBeGreaterThan(0);
    }
  });

  it('rolls a numeral hour the same way it rolls a typed one', () => {
    const late = publishedTime('晚上九點', AFTER_NINE);
    const [hour] = hkHourMinute(late.starts_at as string);
    expect(hour, 'a 9pm said at 9pm is still 9pm').toBe(21);
    const typedLate = publishedTime('晚上9點', AFTER_NINE);
    const spokenLate = publishedTime('晚上九點', AFTER_NINE);
    expect(new Date(Date.parse(spokenLate.starts_at as string)) > new Date(AFTER_NINE), 'the roll a typed hour gets, the numeral must get too').toBe(new Date(Date.parse(typedLate.starts_at as string)) > new Date(AFTER_NINE));
    expect(spokenLate.starts_at, 'the numeral rolled to a different instant than the digit').toBe(typedLate.starts_at);
  });

  it('pins the two readings this unit does not resolve, so the next one has to move them', () => {
    // (a) A category cue blocks the window here and still guesses the half-day in the service.
    const afternoon = publishedTime('下午茶三點', EARLY);
    expect(afternoon.starts_at, 'the mock reads 3點 in a 下午茶 sentence as the small hours').toBe(publishedTime('下午茶3點', EARLY).starts_at);
    expect(hkHourMinute(afternoon.starts_at as string)[0], 'this lane moved the afternoon-tea hour; PLAN carries the 15:00 the service answers').toBe(3);
    // (b) A named weekday moves the day in the service and is not a cue at all here.
    const sunday = publishedTime('星期日三點', EARLY);
    expect(hkHourMinute(sunday.starts_at as string)[0], 'the hour is read; the day is this lane’s own').toBe(3);
    expect(sunday.starts_at, 'a stated weekday must not silently borrow the weekend shift').toBe(publishedTime('三點', EARLY).starts_at);
  });
});
