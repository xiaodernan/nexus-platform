import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntentTime } from '../types';
import { mergeIntent, understandQuery } from './index';

/**
 * D646 — the mock plane published a time the visitor never said, and never read one they did.
 *
 * THE DEFECT. This lane answered the whole time question with one boolean, `evening`, whose cue list
 * carried the bare characters 点/點 and the words 晚市 and evenight. So 「帮我找一间安静一點的餐厅」
 * — where 一點 means *a bit* — came back as an explicit 19:00 that nobody said, and so did
 * 「下午3點」: every stated hour became 7pm. On the other side, the service reads 今晚, 深夜, 早上,
 * 午市, 19:30, 7時15分 and 9am, and this plane read none of them. The invented hour is the worse half,
 * because `components/search-results.tsx` posts the last intent back as `previous_intent`, the stream
 * route forwards it, and `mockSearchStream` merges the new words into it with `mergeIntent` — so a
 * time the visitor never said survives into the next turn. §8 names the rule: never guess party size
 * or a time the user did not state.
 *
 * WHAT IT USES AS AUTHORITY. `apps/ai/nexus_ai/nlu/timeparse.py` read as TEXT — its `PART_OF_DAY`
 * rows, its `HK_TZ` offset, its `CLOCK_RE` shapes (never imported: a broken list must not be able to
 * satisfy its own assertion — D626). Every part-of-day word the service answers with a window, this
 * plane must answer with the same instant; every clock the service can read, both planes must read
 * the same hour. That is a rule over the whole table, so a word added on one plane and not the other
 * is a red test rather than a silent disagreement.
 *
 * WHERE THAT AUTHORITY IS BLIND, STATED LOUDLY. Three things this file does NOT make agree, and
 * PLAN.md carries: the service rewrites Chinese numerals before reading a clock, so 「九點」 is 9pm
 * there and nothing here; the service has a `range` type for a window and this plane's `IntentTime`
 * does not, so a day named without an hour («週六») becomes no time plus a question instead of a
 * span; and the day arithmetic is still this lane's own magic (+4 days for a weekend), which is
 * charged as a separate unit — the weekend legs below therefore assert the HOUR and that the day
 * moved out, not which day it landed on.
 */

interface ServiceWindow {
  label: string;
  tokens: string[];
  start: [number, number];
  end: [number, number];
}

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'apps', 'ai', 'nexus_ai', 'nlu', 'timeparse.py'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const timeparsePath = join(repoRoot, 'apps', 'ai', 'nexus_ai', 'nlu', 'timeparse.py');
const timeparseSource = readFileSync(timeparsePath, 'utf8');
const canonicalPath = join(repoRoot, 'apps', 'ai', 'nexus_ai', 'nlu', 'canonical.py');
const canonicalSource = readFileSync(canonicalPath, 'utf8');

/**
 * `PART_OF_DAY` cut out of the service's source. Every branch that would return an empty table
 * throws: a census over no rows charges nothing, and a green run that means "I read nothing" is the
 * failure this file exists to refuse.
 */
function readWindows(source: string): ServiceWindow[] {
  const open = source.indexOf('PART_OF_DAY');
  if (open < 0) throw new Error('no PART_OF_DAY in the service time parser — nothing to compare against');
  const bracket = source.indexOf('[', open);
  const end = source.indexOf('\n]', bracket);
  if (bracket < 0 || end < 0) throw new Error('PART_OF_DAY did not close — the reader would be blind, not green');
  const block = source.slice(bracket, end);
  const rows: ServiceWindow[] = [];
  for (const match of block.matchAll(/\("([a-z_]+)",\s*\(([^)]*)\),\s*time\((\d+),\s*(\d+)\),\s*time\((\d+),\s*(\d+)\)\)/gs)) {
    const tokens = [...(match[2] ?? '').matchAll(/"([^"]+)"/g)].map((token) => token[1] as string);
    rows.push({
      label: match[1] as string,
      tokens,
      start: [Number(match[3]), Number(match[4])],
      end: [Number(match[5]), Number(match[6])],
    });
  }
  if (rows.length < 4) throw new Error(`only ${rows.length} PART_OF_DAY rows were read out of ${timeparsePath}`);
  return rows;
}

function readHourOffset(source: string): number {
  const match = /HK_TZ\s*=\s*timezone\(timedelta\(hours=(\d+)/.exec(source);
  if (!match) throw new Error('HK_TZ was not read as a fixed offset — the two planes cannot be compared by instant');
  return Number(match[1]);
}

/**
 * `lexicon.CATEGORY_SYNONYMS`, read as TEXT: the surfaces a request FINDS, which is what decides
 * whether a time cue merely opens a word naming a thing (`timeparse._guarded_cues` builds its guard
 * out of exactly this table). Only a row's list VALUES are read — a bucket's own key is not a word
 * a visitor types.
 *
 * The service canonicalises each surface before comparing it; this reader does not, because the fold
 * is the AI lane's table and this plane carries both scripts already (D641). What it must not lose is
 * a pair the fold creates, so a surface that reaches the guard in either spelling has to be named in
 * the mock's own list, which the leg below asks for by literal.
 */
function categorySurfaces(source: string): string[] {
  const open = source.indexOf('CATEGORY_SYNONYMS');
  if (open < 0) throw new Error('no CATEGORY_SYNONYMS in the service lexicon — the guard would have nothing to be built from');
  const brace = source.indexOf('{', open);
  const end = source.indexOf('\n}', brace);
  if (brace < 0 || end < 0) throw new Error('CATEGORY_SYNONYMS did not close — a blind reader would report no surfaces and pass');
  const surfaces = new Set<string>();
  for (const row of source.slice(brace, end).matchAll(/"[a-z_]+":\s*\[([^\]]*)\]/gs)) {
    for (const term of (row[1] ?? '').matchAll(/"([^"]*)"/g)) surfaces.add((term[1] ?? '').toLowerCase());
  }
  if (surfaces.size < 100) throw new Error(`only ${surfaces.size} category surfaces were read out of the lexicon — the roster is too thin to guard anything`);
  return [...surfaces];
}

/** `timeparse._guarded_cues`: every cue of the window table that only opens longer category surfaces. */
function guardedCuePairs(tokens: string[], surfaces: string[]): Array<{ cue: string; surfaces: string[] }> {
  const rows = tokens
    .map((cue) => ({ cue, surfaces: surfaces.filter((surface) => surface.length > cue.length && surface.startsWith(cue)).sort() }))
    .filter((row) => row.surfaces.length > 0);
  if (rows.length === 0) throw new Error('no cue in the service table opens a category word — the guard is unwitnessed, not satisfied');
  return rows;
}

const WINDOWS = readWindows(timeparseSource);
const HK_OFFSET_MS = readHourOffset(timeparseSource) * 3_600_000;
const ALL_TOKENS = WINDOWS.flatMap((window) => window.tokens.map((token) => ({ token, window })));
const GUARDED = guardedCuePairs(ALL_TOKENS.map((entry) => entry.token), categorySurfaces(readFileSync(join(repoRoot, 'apps', 'ai', 'nexus_ai', 'nlu', 'lexicon.py'), 'utf8')));

/** The mock's own source: the other side of every roster comparison below. */
const MOCK_SOURCE = readFileSync(join(repoRoot, 'apps', 'web', 'src', 'lib', 'mock', 'index.ts'), 'utf8');

/**
 * The mock's roster, read from `index.ts` as TEXT — the side D646's leg could not see. That leg
 * asked whether the mock CARRIED what the service reads, so a word the service RETIRED could
 * stay in the mock's table forever: 午市 sat in the noon band for a unit after D677 took it out
 * of the service's, and the door stayed green.
 */
function readMockWindows(source: string): ServiceWindow[] {
  const open = source.indexOf('PART_OF_DAY_WINDOWS');
  if (open < 0) throw new Error('no PART_OF_DAY_WINDOWS in the mock — there is no roster to compare');
  const end = source.indexOf('\n];', open);
  if (end < 0) throw new Error('PART_OF_DAY_WINDOWS did not close — the reader would be blind, not green');
  const rows: ServiceWindow[] = [];
  for (const match of source.slice(open, end).matchAll(/label:\s*'([a-z_]+)'[^}]*?tokens:\s*\[([^\]]*)\]/gs)) {
    const tokens = [...(match[2] ?? '').matchAll(/'([^']*)'/g)].map((token) => token[1] as string);
    rows.push({ label: match[1] as string, tokens, start: [0, 0], end: [0, 0] });
  }
  if (rows.length < 4) throw new Error(`only ${rows.length} mock bands were read out of the mock source`);
  return rows;
}

/**
 * `canonical.CANONICAL_FORMS`, read as TEXT: the service canonicalises its text BEFORE it reads
 * (D446 canonicalises its own cue tables at import), so the question for a word is never "is it
 * literally in the service's table" but "does the service READ it" — which is what
 * canonical(word) being in that table means. The rows are written as \uXXXX escapes, and
 * `JSON.parse` reads exactly that shape.
 */
function readCanonicalForms(source: string): Map<string, string> {
  const open = source.indexOf('CANONICAL_FORMS');
  if (open < 0) throw new Error('no CANONICAL_FORMS in the service canonicaliser');
  const brace = source.indexOf('{', open);
  const end = source.indexOf('\n}', brace);
  if (brace < 0 || end < 0) throw new Error('CANONICAL_FORMS did not close — the reader would be blind, not green');
  const forms = new Map<string, string>();
  for (const row of source.slice(brace, end).matchAll(/"((?:\\u[0-9a-fA-F]{4})+)"\s*:\s*"((?:\\u[0-9a-fA-F]{4})+)"/g)) {
    forms.set(JSON.parse(`"${row[1]}"`) as string, JSON.parse(`"${row[2]}"`) as string);
  }
  if (forms.size < 100) throw new Error(`only ${forms.size} canonical forms were read out of the canonicaliser`);
  return forms;
}

/**
 * `timeparse.MENU_OCCASION_TOKENS`, read as TEXT: the words the service took OUT of its clock
 * tables (D677). They name a meal occasion, not an hour, so the service understands them and
 * narrows nothing with them — a table of its own, not a row of any band.
 */
function readMenuOccasionTokens(source: string): string[] {
  const match = /MENU_OCCASION_TOKENS\s*=\s*\(([^)]*)\)/.exec(source);
  if (!match) throw new Error('no MENU_OCCASION_TOKENS in the service time parser');
  const tokens = [...(match[1] ?? '').matchAll(/"([^"]+)"/g)].map((token) => token[1] as string);
  if (tokens.length === 0) throw new Error('MENU_OCCASION_TOKENS was read as an empty table');
  return tokens;
}

/** The Hong Kong wall clock of an instant, `dayShift` days later, as the published ISO string. */
function hkInstant(now: Date, hour: number, minute: number, dayShift = 0): string {
  const shifted = new Date(now.getTime() + HK_OFFSET_MS + dayShift * 86_400_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute) - HK_OFFSET_MS).toISOString();
}

function hkHourMinute(iso: string): [number, number] {
  const shifted = new Date(Date.parse(iso) + HK_OFFSET_MS);
  return [shifted.getUTCHours(), shifted.getUTCMinutes()];
}

/**
 * `Intent.time` is nullable, and every reading below needs to say what it means when the lane
 * published no time object at all. An optional chain would report `undefined` and let a leg pass on
 * a turn that returned nothing; this names the query that was answered with silence.
 */
function timeOf(intent: { time?: IntentTime | null }, query: string): IntentTime {
  if (!intent.time) throw new Error(`"${query}" published no time object at all — the lane answered nothing, not type none`);
  return intent.time;
}

function publishedTime(query: string, nowIso: string): { type: string; starts_at: string | null } {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  try {
    const time = timeOf(understandQuery(query), query);
    return { type: time.type, starts_at: time.starts_at ?? null };
  } finally {
    vi.useRealTimers();
  }
}

/** 00:30 on the Hong Kong clock — every window below is still ahead, so nothing rolls. */
const EARLY = '2026-11-01T16:30:00Z';
/** 17:05 Hong Kong — the afternoon window has opened but not closed; morning has closed. */
const LATE_AFTERNOON = '2026-11-02T09:05:00Z';
/** 21:00 Hong Kong — a stated 8pm is already past. */
const AFTER_EIGHT = '2026-11-02T13:00:00Z';

afterEach(() => {
  vi.useRealTimers();
});

describe('the mock plane publishes only the time a query states (D646)', () => {
  it('reads its own authority: the service windows, their bounds and the +08:00 clock', () => {
    expect(WINDOWS.map((window) => window.label).sort(), `labels read from ${timeparsePath}`).toEqual(
      ['afternoon', 'deep_night', 'evening', 'late_night', 'morning', 'night', 'noon'],
    );
    expect(ALL_TOKENS.length, 'no part-of-day word was read out of the service table').toBeGreaterThanOrEqual(35);
    for (const window of WINDOWS) {
      expect(window.tokens.length, `${window.label} carries no cue — the row was read wrong`).toBeGreaterThanOrEqual(3);
    }
    // The roster has to be in the shipped file, not only in the lane's behaviour.
    const missing = ALL_TOKENS.filter(({ token }) => !MOCK_SOURCE.includes(`'${token}'`)).map(({ token }) => token);
    expect(missing, `the mock roster does not carry the words the service answers: ${missing.join(', ')}`).toEqual([]);
  });

  it('answers every part-of-day word with the window the service answers it with', () => {
    for (const { token, window } of ALL_TOKENS) {
      const published = publishedTime(token, EARLY);
      expect(published.type, `"${token}" published no time, but the service opens the ${window.label} window`).toBe('explicit');
      expect(published.starts_at, `"${token}" opened the wrong instant`).toBe(hkInstant(new Date(EARLY), window.start[0], window.start[1]));
    }
  });

  it('answers a stated clock with the hour that was typed, not with 19:00', () => {
    const stated: Array<[string, number, number]> = [
      ['下午3點', 15, 0], ['下午3点', 15, 0], ['晚上7點', 19, 0], ['中午12點', 12, 0], ['早上7點', 7, 0],
      ['7點', 7, 0], ['10點', 10, 0], ['7點半', 7, 30], ['7時15分', 7, 15], ['7时15分钟', 7, 15],
      ['7點20分', 7, 20], ['19:30', 19, 30], ['7：30', 7, 30], ['3pm', 15, 0], ['9am', 9, 0],
      ['12pm', 12, 0], ['12am', 0, 0],
    ];
    for (const [query, hour, minute] of stated) {
      const published = publishedTime(query, EARLY);
      expect(published.type, `"${query}" published no time`).toBe('explicit');
      const [gotHour, gotMinute] = hkHourMinute(published.starts_at as string);
      expect([gotHour, gotMinute], `"${query}" was read as ${String(gotHour)}:${String(gotMinute)} in Hong Kong time, not ${String(hour)}:${String(minute)}`).toEqual([hour, minute]);
    }
  });

  it('publishes no time for a 点 that is not a clock, nor for a word it never learned', () => {
    const silent = ['安静一點', '下午茶', '幫我找一間安靜一點的餐廳', '我想食点心', '附近有早点吗', '重點推薦', '跨站点', '有没有便宜一点的咖啡', '想食晚市', '晚市有位吗', 'evenight', '近一点', '找一间有 WiFi 的咖啡馆'];
    for (const query of silent) {
      const published = publishedTime(query, EARLY);
      expect(published.type, `"${query}" is not a time and must not be published as one`).toBe('none');
      expect(published.starts_at, `"${query}" carried an invented instant`).toBeNull();
    }
  });

  it('reads a cue that only opens a category word as the thing, not the hour', () => {
    const surfaces = GUARDED.flatMap((pair) => pair.surfaces);
    const uncarried = surfaces.filter((surface) => !MOCK_SOURCE.includes(`'${surface}'`));
    expect(uncarried, `the service guards a cue with a surface this lane does not carry: ${uncarried.join(', ')}`).toEqual([]);
    for (const pair of GUARDED) {
      for (const surface of pair.surfaces) {
        const named = publishedTime(surface, EARLY);
        expect(named.type, `"${surface}" names a thing, but the lane opened the window of "${pair.cue}" anyway`).toBe('none');
        expect(named.starts_at, `"${surface}" carried an invented instant`).toBeNull();
        const bare = publishedTime(pair.cue, EARLY);
        expect(bare.type, `"${pair.cue}" alone still dates the turn — the guard protects the surface, not the word`).toBe('explicit');
      }
    }
    // The guard is positional, as the service's `_reads_as_a_time` is: every reading is checked, not the first.
    const both = publishedTime('下午茶有，下午也有', EARLY);
    expect(both.type, 'a second, bare 下午 after a category must open the window again').toBe('explicit');
    expect(both.starts_at, `"${both.starts_at}" is not the afternoon window the second reading names`).toBe(hkInstant(new Date(EARLY), 14, 0));
    const statedAndNamed = publishedTime('下午3點去食下午茶', EARLY);
    expect(statedAndNamed.type, 'the category does not swallow the clock that sits beside it').toBe('explicit');
    expect(hkHourMinute(statedAndNamed.starts_at as string), 'the cue at index 0 dates 「下午3點去食下午茶」; the one inside 下午茶 does not').toEqual([15, 0]);
  });

  it('asks for the time in the same breath it says it has none', () => {
    const corpus = ['今晚', '深夜', '下午3點', '周六', '周末', '安静一點', '19:30', '帮我找附近适合朋友聚会的餐廳', '早上', '宵夜', '近一点', '推薦一間安靜一點的餐廳'];
    for (const query of corpus) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(EARLY));
      let intent;
      try {
        intent = understandQuery(query);
      } finally {
        vi.useRealTimers();
      }
      const time = timeOf(intent, query);
      const stated = time.type !== 'none';
      const asked = intent.unknowns.includes('time');
      // Both directions of the §8 floor: a published time may not also be an open question, and
      // a question may not be asked about a time the lane already claims to know.
      expect(asked, `"${query}": unknowns says ${asked ? "'time' is missing" : "'time' is known"} while time.type says ${time.type}`).toBe(!stated);
      expect((intent.confidence.time ?? 0) > 0, `"${query}": confidence.time disagrees with time.type`).toBe(stated);
    }
  });

  it('rolls a window and a clock the way the service does when the moment has passed', () => {
    const afternoon = publishedTime('下午', LATE_AFTERNOON);
    expect(afternoon.starts_at, 'a window that is still open stays tonight, even past its opening hour').toBe(hkInstant(new Date(LATE_AFTERNOON), 14, 0));
    const morning = publishedTime('早上', LATE_AFTERNOON);
    expect(morning.starts_at, 'a window that has closed rolls to tomorrow').toBe(hkInstant(new Date(LATE_AFTERNOON), 7, 0, 1));
    const stated = publishedTime('晚上7點', LATE_AFTERNOON);
    expect(stated.starts_at, 'a stated 7pm said at 17:05 is still today').toBe(hkInstant(new Date(LATE_AFTERNOON), 19, 0));
    const past = publishedTime('晚上8點', AFTER_EIGHT);
    expect(past.starts_at, 'a stated 8pm said at 9pm is tomorrow').toBe(hkInstant(new Date(AFTER_EIGHT), 20, 0, 1));
  });

  it('moves a stated weekend hour out of today without changing the hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EARLY));
    let weekend;
    try {
      weekend = understandQuery('週六晚上7點');
    } finally {
      vi.useRealTimers();
    }
    const time = timeOf(weekend, '週六晚上7點');
    expect(time.type).toBe('explicit');
    const starts = time.starts_at as string;
    expect(hkHourMinute(starts), 'the stated hour survived the day arithmetic').toEqual([19, 0]);
    expect(Date.parse(starts) > Date.parse(EARLY) + 86_400_000, `${starts} did not move a weekend out`).toBe(true);
    const simplified = publishedTime('周六晚上7點', EARLY);
    expect(simplified.starts_at, '週六 and 周六 must be the same day for the same hour').toBe(starts);
  });

  it('reads a follow-up with the one reader the first turn uses', () => {
    for (const followUp of ['今晚', '下午3點', '深夜', '周六晚上7點', '19:30', '安静一點', '近一点']) {
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
      if (timeOf(merged, followUp).type !== 'none') {
        expect(merged.unknowns, 'the merge published a time and still lists it as missing').not.toContain('time');
        expect(merged.confidence.time, 'the merge published a time with no confidence in it').toBeGreaterThan(0);
      }
    }
  });

  it('keeps the currency cue after the alternative that matched nothing was dropped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EARLY));
    try {
      for (const query of ['预算500 hkd', '500 hkdb', '500港幣', '500港币', '預算500']) {
        expect(understandQuery(query).budget?.max, `"${query}" lost its budget with the dead alternative`).toBe(500);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('spells the clock every way the service spells it', () => {
    const mockClockSource = MOCK_SOURCE.match(/const CLOCK_RE = (\/.*\/i)/)?.[1];
    if (!mockClockSource) throw new Error('this lane no longer declares a CLOCK_RE the census can read');
    const markers = serviceClockMarkers(timeparseSource);
    expect(markers.length, 'no spelling was read out of the service CLOCK_RE').toBeGreaterThanOrEqual(10);
    // The mock clock carries the `i` flag, so AM and am are one spelling there and two in the table.
    const missing = markers.filter((marker) => !mockClockSource.toLowerCase().includes(marker.toLowerCase()));
    expect(missing, `the service reads a clock this lane cannot spell: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * D852 — the mock plane read a word the service had already retired.
 *
 * THE DEFECT. `timeparse.MENU_OCCASION_TOKENS` holds 午市 in a table of its own (D677): the word
 * names the lunch SERVICE — the meal occasion — and never a clock hour, so the service
 * understands it and narrows nothing with it. The mock's noon band still carried it as a clock
 * cue, so 「午市」 came back as an explicit 11:30 that nobody said, and 「午市三點」 as 15:00 where
 * the authority answers 03:00: the band supplied the half of the day that a meal occasion has no
 * opinion about. The invented hour survives into the next turn, because the client posts the
 * last intent back as `previous_intent` and the mock merges the new words into it.
 *
 * WHY THE OLD DOOR DID NOT SEE IT. The roster leg above asks ONE direction: does the mock carry
 * what the service reads? A word the service RETIRED is invisible to that question — the mock
 * carrying 午市 was never "missing" anything. So this block compares the two rosters BAND FOR
 * BAND after the service's own canonicalisation, which is the direction a retirement shows up in.
 */
describe('the mock plane reads no word the service retired (D852)', () => {
  const MOCK_WINDOWS = readMockWindows(MOCK_SOURCE);
  const CANONICAL_FORMS = readCanonicalForms(canonicalSource);
  const MENU_OCCASION = readMenuOccasionTokens(timeparseSource);

  /** `canonical.canonical`: one character in, one character out. */
  const canonicalise = (text: string): string =>
    [...text].map((character) => CANONICAL_FORMS.get(character) ?? character).join('');

  it('carries the service roster band for band, after the service canonicalises its own', () => {
    expect(MOCK_WINDOWS.map((window) => window.label).sort(), 'the mock and the service disagree on the bands themselves').toEqual(
      WINDOWS.map((window) => window.label).sort(),
    );
    for (const window of WINDOWS) {
      const service = [...new Set(window.tokens.map(canonicalise))].sort();
      const mock = [...new Set((MOCK_WINDOWS.find((row) => row.label === window.label)?.tokens ?? []).map(canonicalise))].sort();
      expect(mock, `the mock's ${window.label} band is not the service's`).toEqual(service);
    }
  });

  it('reads no word the service took out of its clock tables', () => {
    const clockWords = new Set(MOCK_WINDOWS.flatMap((window) => window.tokens.map(canonicalise)));
    for (const token of MENU_OCCASION) {
      expect(clockWords.has(canonicalise(token)), `"${token}" is a meal occasion on the service, never a clock`).toBe(false);
    }
  });

  it('publishes no hour for a meal occasion, and reads the clock beside it as it stands', () => {
    const silent = ['午市', '食午市', '想食午市', '午市有位吗', '有午市嘅餐廳', '食午市嘅地方', '午餐'];
    for (const query of silent) {
      const published = publishedTime(query, EARLY);
      expect(published.type, `"${query}" names a meal occasion and must not be published as an hour`).toBe('none');
      expect(published.starts_at, `"${query}" carried an invented instant`).toBeNull();
    }
    // The clock beside the occasion is read as it stands: no band, so no band to tilt its half.
    const noon = publishedTime('午市12點', EARLY);
    expect(noon.type, '"午市12點" names a clock and must be published as one').toBe('explicit');
    expect(hkHourMinute(noon.starts_at as string), '"午市12點" was read as the wrong hour').toEqual([12, 0]);
    const three = publishedTime('午市三點', EARLY);
    expect(three.type, '"午市三點" names a clock and must be published as one').toBe('explicit');
    expect(hkHourMinute(three.starts_at as string), '"午市三點" was tilted into the afternoon by a band that names no hour').toEqual([3, 0]);
    // The noon band still supplies the half of the day for its OWN words.
    expect(publishedTime('中午', EARLY).starts_at, '中午 opens the noon window the service opens').toBe(hkInstant(new Date(EARLY), 11, 30));
    expect(hkHourMinute(publishedTime('中午三點', EARLY).starts_at as string), '"中午三點" was not tilted the way the service tilts it').toEqual([15, 0]);
  });

  it('merges a meal occasion the way the first turn reads it', () => {
    for (const query of ['午市', '午市三點', '午市12點']) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(EARLY));
      let merged;
      let firstTurn;
      try {
        merged = mergeIntent(null, query);
        firstTurn = understandQuery(query);
      } finally {
        vi.useRealTimers();
      }
      expect(merged.time, `"${query}" is read one way by understandQuery and another by mergeIntent`).toEqual(firstTurn.time);
      if (timeOf(merged, query).type === 'none') {
        expect(merged.unknowns, `"${query}" published no hour and must still ask for one`).toContain('time');
        expect(merged.confidence.time, `"${query}" published no hour and must not claim confidence in one`).toBe(0);
      }
    }
  });
});

/** The three alternation groups and one character class of the service's `CLOCK_RE`, as one pattern. */
function clockPatternOf(source: string): string {
  const body = /CLOCK_RE = re\.compile\(([\s\S]*?)\n\)/.exec(source)?.[1];
  if (!body) throw new Error('CLOCK_RE was not read out of the service source');
  const parts = [...body.matchAll(/r"([^"]*)"/g)].map((part) => part[1] ?? '');
  if (parts.length < 2) throw new Error(`only ${parts.length} raw string of CLOCK_RE were read — the pattern would be cut short`);
  return parts.join('');
}

/**
 * Every literal an alternation can match, plus every character a class can match. Innermost groups are
 * replaced and the scan repeats, so `半` is still read out of a group that nests another one. An
 * alternative holding an escape, a quantifier or a brace is a shape rather than a spelling and is left
 * alone — this census charges spellings, not grammar.
 *
 * The class body is read as `[^\]\[]*`, never as the common `[^][]*` idiom: in JavaScript `[^]` is a
 * legal class that matches every character, so the idiom stops matching a two-character class and
 * `[:：]` went unread — the census reported the clock spellings it could see and was green while
 * blind. An arm that deletes the full-width colon now reddens it.
 */
function serviceClockMarkers(source: string): string[] {
  let pattern = clockPatternOf(source);
  const markers = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    for (const group of pattern.matchAll(/\((?:\?:)?([^()]*)\)/g)) {
      const alternatives = (group[1] ?? '').split('|');
      for (const alternative of alternatives) {
        const clean = alternative.trim();
        if (clean.length === 0 || /[[\]{}\\()]/.test(clean)) continue;
        markers.add(clean);
      }
    }
    for (const charClass of pattern.matchAll(/\[([^\]\[]*)\]/g)) {
      for (const char of (charClass[1] ?? '')) if (char !== '-') markers.add(char);
    }
    const replaced = pattern.replace(/\((?:\?:)?[^()]*\)/g, '§');
    if (replaced === pattern) break;
    pattern = replaced;
  }
  return [...markers].filter((marker) => marker !== '§');
}

