import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D641 — the mock plane's matcher vocabulary answers only the script it was typed in.
 *
 * THE DEFECT. `apps/web/src/lib/prompts.ts` offers a Hong Kong reader 週末找一個適合情侶約會的地方, and
 * the mock plane answered it with NOTHING: zero cards, an empty results page. The cause is in this plane's
 * own lists — `TAG_HINTS` cued 约会, `CATEGORY_HINTS` cued 餐厅, the follow-up rules cued 太贵 — all in the
 * Simplified script. A Traditional query shares not one character with those cues, so it produced no
 * scene token, no category, and fell below the §6 relevance floor, which drops a complete miss instead of
 * ranking it. D606 repaired the copy a reader is ANSWERED in; nobody had asked what the reader TYPES.
 *
 * WHY A CENSUS AND NOT FIVE EDITS. The AI lane already knows this convention: `lexicon.py`'s cue lists
 * (`URGENCY_FLEXIBLE` holds 下週 AND 下周) and `timeparse.py` hand-carry both spellings. This plane lost it,
 * and a repair that only fixes the five prompts leaves the next cue written the same way. So this file
 * charges EVERY regex literal in the mock plane for carrying one script where the other one is the same
 * word — a rule with a reader attached, the same shape D606 used.
 *
 * WHAT IT USES AS AUTHORITY. The product's own two tables, read as TEXT from `apps/ai/nexus_ai/nlu/`
 * (never imported: a broken list must not be able to satisfy its own assertion — D626). For each character
 * pair they declare, the plane must cue BOTH spellings; the check is symmetric, so a Traditional-only list
 * is charged exactly like a Simplified-only one.
 *
 * WHERE THAT AUTHORITY IS BLIND, STATED LOUDLY. The tables carry 240 Simplified characters, not the whole
 * script: 周/週, 后/後, 验/驗 and 办/辦 are in neither `CANONICAL_FORMS` nor `_TRAD_SIMP_PAIRS`, so a
 * table-driven census cannot see those four conversions at all. They are declared below as
 * `HANDED_ON_PAIRS`, checked against the tables (if the AI lane ever adds one, this file is told to stop
 * hand-carrying it), and then charged like any table pair. The AI lane's tables are not this lane's to
 * edit, so the blind spot is named here and in the ledger rather than silently trusted away.
 */

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'apps', 'ai', 'nexus_ai', 'nlu', 'canonical.py'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));

/** Characters whose Traditional spelling the product's tables do not declare, so the plane must hand-carry
 *  both. Each is (simplified, traditional). */
const HANDED_ON_PAIRS: Array<[string, string]> = [
  ['周', '週'], ['后', '後'], ['验', '驗'], ['办', '辦'],
];

interface PairTable {
  /** simplified → traditional */
  forward: Map<string, string>;
  /** traditional → simplified */
  reverse: Map<string, string>;
  printed: string;
}

/**
 * Both tables, cut from the two Python sources as text. Every branch that would return an empty table
 * throws instead: a census over no pairs charges nothing, and a green run that means "I read nothing" is
 * the failure D606's own harness was built to refuse.
 */
function readPairTables(): PairTable {
  const forward = new Map<string, string>();
  const detail: { canonical: number; lexicon: number } = { canonical: 0, lexicon: 0 };

  const canonicalPath = join(repoRoot, 'apps', 'ai', 'nexus_ai', 'nlu', 'canonical.py');
  if (!existsSync(canonicalPath)) throw new Error(`no canonical.py at ${canonicalPath} — this census has no authority`);
  const canonical = readFileSync(canonicalPath, 'utf8');
  const cStart = canonical.indexOf('CANONICAL_FORMS');
  if (cStart < 0) throw new Error('canonical.py holds no CANONICAL_FORMS table this census can cut');
  const cBody = canonical.slice(cStart, canonical.indexOf('\n}', cStart));
  if (!cBody.includes('"')) throw new Error('the CANONICAL_FORMS slice is empty — the table was found but nothing could be read out of it');
  for (const m of cBody.matchAll(/"(\\u[0-9a-fA-F]{4})"\s*:\s*"(\\u[0-9a-fA-F]{4})"/g)) {
    const from = String.fromCharCode(parseInt(m[1]!.slice(2), 16));
    const to = String.fromCharCode(parseInt(m[2]!.slice(2), 16));
    detail.canonical += 1;
    if (from !== to) forward.set(from, to);
  }

  const lexiconPath = join(repoRoot, 'apps', 'ai', 'nexus_ai', 'nlu', 'lexicon.py');
  if (!existsSync(lexiconPath)) throw new Error(`no lexicon.py at ${lexiconPath} — this census has no authority`);
  const lexicon = readFileSync(lexiconPath, 'utf8');
  const lStart = lexicon.indexOf('_TRAD_SIMP_PAIRS');
  if (lStart < 0) throw new Error('lexicon.py holds no _TRAD_SIMP_PAIRS table this census can cut');
  const lBody = lexicon.slice(lStart, lexicon.indexOf('\n)', lStart));
  for (const m of lBody.matchAll(/\("([^"\\])",\s*"([^"\\])"\)/g)) {
    const [trad, simp] = [m[1]!, m[2]!];
    detail.lexicon += 1;
    if (trad !== simp && !forward.has(simp)) forward.set(simp, trad);
  }

  if (forward.size === 0) throw new Error('the pair table is empty — a census that charges nothing is not a census');
  const reverse = new Map<string, string>();
  for (const [simp, trad] of forward) if (!reverse.has(trad)) reverse.set(trad, simp);
  return { forward, reverse, printed: `${forward.size} simplified / ${reverse.size} traditional character(s) read (canonical.py ${detail.canonical} entries, lexicon.py ${detail.lexicon} pairs)` };
}

const PAIRS = readPairTables();

/** The pairs this census charges: the product's tables, plus the four it is BLIND to and says so about. */
function chargedPairs(extra: Array<[string, string]>): Array<[string, string]> {
  const bySimp = new Map<string, string>(PAIRS.forward);
  for (const [simp, trad] of extra) if (!bySimp.has(simp)) bySimp.set(simp, trad);
  return [...bySimp.entries()];
}

interface RegexSite {
  file: string;
  line: number;
  body: string;
}

/**
 * Every regex literal in `source`, with comments and string literals skipped — the two ways a naive scan
 * charges prose (D606's arms: a `//` note is not copy, and a note that stays open to the end of the file
 * cuts the population to nothing). A `/` that opens a regex and never closes it on the same line throws:
 * silently skipping it would make this census blind, and blindness is not a pass.
 *
 * Regex-or-division is decided by the last character of CODE, remembered as the scan goes — not by looking
 * backwards through the raw text. The first version looked backwards and so read the last letter of a
 * comment as if it were code, took the cue on the next line for a division, and dropped it from the
 * population. Its own fixture leg is what found that.
 */
function regexLiteralsOf(source: string, file: string): RegexSite[] {
  const sites: RegexSite[] = [];
  let i = 0;
  let line = 1;
  let mode: 'code' | 'line' | 'block' | 'quote' = 'code';
  let quote = '';
  let lastCode = '';
  const step = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (source[k] === '\n') line += 1;
    i = to;
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1] ?? '';
    if (mode === 'line') {
      const end = source.indexOf('\n', i);
      step(i, end < 0 ? source.length : end);
      if (end >= 0) mode = 'code';
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; step(i, i + 2); continue; }
      step(i, i + 1);
      continue;
    }
    if (mode === 'quote') {
      if (ch === '\\') { step(i, i + 2); continue; }
      if (ch === quote) { mode = 'code'; lastCode = ch; }
      step(i, i + 1);
      continue;
    }
    if (ch === '/' && next === '/') { mode = 'line'; step(i, i + 2); continue; }
    if (ch === '/' && next === '*') { mode = 'block'; step(i, i + 2); continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { mode = 'quote'; quote = ch; step(i, i + 1); continue; }
    if (ch !== '/') { if (ch.trim() !== '') lastCode = ch; step(i, i + 1); continue; }
    // A `/` after a value — an identifier, a closing bracket, a literal — divides; anywhere else it opens.
    if (/[A-Za-z0-9_$)\]}']/.test(lastCode)) { lastCode = ch; step(i, i + 1); continue; }
    let j = i + 1;
    let classDepth = 0;
    let closed = -1;
    while (j < source.length) {
      const c = source[j]!;
      if (c === '\n') break;
      if (c === '\\') { j += 2; continue; }
      if (c === '[') classDepth += 1;
      else if (c === ']') classDepth = Math.max(0, classDepth - 1);
      else if (c === '/' && classDepth === 0) { closed = j; break; }
      j += 1;
    }
    if (closed < 0) throw new Error(`${file}:${line} holds a slash that opens a regex this reader cannot close — skipping it would make the census blind, not green`);
    sites.push({ file, line, body: source.slice(i + 1, closed) });
    // Flags trail the closing slash; they are not a cue body, and the literal itself is a value.
    let after = closed + 1;
    while (after < source.length && /[a-z]/.test(source[after]!)) after += 1;
    lastCode = ')';
    step(i, after);
  }
  return sites;
}

/** The CJK characters every regex literal in the mock plane can match, with the line that carried each. */
function vocabularyChars(sites: RegexSite[]): Map<string, string> {
  const seen = new Map<string, string>();
  for (const site of sites) {
    for (const ch of site.body) {
      if (!/[\u3400-\u9fff]/.test(ch)) continue;
      if (!seen.has(ch)) seen.set(ch, `${site.file}:${site.line}`);
    }
  }
  return seen;
}

/**
 * One-script violations: a character the plane cues in one script while its pair is cued nowhere. The pair
 * list is an argument rather than a global so a fixture can be graded on exactly the pairs it declares —
 * charging a two-character fixture against 240 table pairs would report a number, not a verdict.
 * The rule is symmetric: it reads the Simplified and the Traditional side of each pair alike.
 */
function oneScriptCues(sites: RegexSite[], pairs: Array<[string, string]>): string[] {
  const cued = vocabularyChars(sites);
  const problems: string[] = [];
  for (const [simp, trad] of pairs) {
    if (simp === trad) continue;
    if (cued.has(simp) && !cued.has(trad)) problems.push(`${simp}→${trad} cued only as ${simp} at ${cued.get(simp)}`);
    else if (cued.has(trad) && !cued.has(simp)) problems.push(`${simp}→${trad} cued only as ${trad} at ${cued.get(trad)}`);
  }
  return problems;
}

const ALL_PAIRS = chargedPairs(HANDED_ON_PAIRS);

/** The mock plane's matcher files — everything here decides what a typed query is understood as. */
function matcherSites(): RegexSite[] {
  const dir = join(repoRoot, 'apps', 'web', 'src', 'lib', 'mock');
  if (!existsSync(dir)) throw new Error(`no mock plane at ${dir} — nothing to census`);
  const sites: RegexSite[] = [];
  for (const name of readdirSync(dir).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f)).sort()) {
    const file = join(dir, name);
    sites.push(...regexLiteralsOf(readFileSync(file, 'utf8'), `apps/web/src/lib/mock/${name}`));
  }
  return sites;
}

const SITES = matcherSites();

describe('the mock plane answers both script spellings of what a reader types (D641)', () => {
  it('reads its own population: regex literals found, comments not charged', () => {
    const cjk = vocabularyChars(SITES);
    // Anti-vacuity: a scanner that found nothing would let every closure leg below pass green.
    expect(SITES.length, `no regex literal was read out of the mock plane (${PAIRS.printed})`).toBeGreaterThan(40);
    expect(cjk.size, 'no CJK character was read out of the mock plane').toBeGreaterThan(80);
    // The words the defect was made of. 約 is copy inside TAG_HINTS' repaired cue; the block comment this
    // unit added above it also says 約會 as prose, so a green here does not prove the cue was read.
    expect(cjk.has('約'), 'the repaired TAG_HINTS cue 約會 was not read — the census is not looking at the shipped list').toBe(true);
    expect(cjk.has('會'), 'the repaired TAG_HINTS cue 約會 was not read').toBe(true);
    // 聚 is cued (聚會) and 会 is cued (约会 side) — the pair the shipped prompt 朋友聚会 relies on.
    expect(cjk.has('聚') && cjk.has('會'), 'neither script of the gathering cue was read').toBe(true);
  });

  it('charges every pair the product tables declare, in both directions', () => {
    const problems = oneScriptCues(SITES, ALL_PAIRS);
    expect(problems, `the mock plane cues these words in ONE script only:\n${problems.join('\n')}\n(authority: ${PAIRS.printed}; pairs charged: ${ALL_PAIRS.length})`).toEqual([]);
  });

  it('hand-carries the four pairs the product tables are blind to — and is blind only where it says', () => {
    const blind = HANDED_ON_PAIRS.filter(([simp, trad]) => !PAIRS.forward.has(simp) && !PAIRS.reverse.has(trad));
    expect(blind.map(([s, t]) => s + t), 'the AI tables now declare a pair this file hand-carries; retire it from HANDED_ON_PAIRS').toEqual(HANDED_ON_PAIRS.map(([s, t]) => s + t));
    const cued = vocabularyChars(SITES);
    const missing = HANDED_ON_PAIRS
      .filter(([simp, trad]) => (cued.has(simp) || cued.has(trad)) && !(cued.has(simp) && cued.has(trad)))
      .map(([simp, trad]) => `${simp}/${trad} appears as ${cued.has(simp) ? simp : trad} only`);
    expect(missing, `the hand-carried pairs must be cued in both scripts:\n${missing.join('\n')}`).toEqual([]);
    // 周 is the pair the shipped prompts actually exercise: 週末 is what a Hong Kong reader taps, 周末 is
    // what the §6 starter prompts were written in before D641.
    expect(cued.has('週') && cued.has('周'), 'neither script of 周/週 is cued at all').toBe(true);
  });

  it('refuses to call a truncated regex a clean population', () => {
    // A regex literal never spans a line, so an unclosed `/` is where a scanner starts losing cues.
    // Reading past it would report a smaller vocabulary and a greener plane than the file on disk.
    const truncated = 'const cues = [/约会;\nconst more = [/餐厅/];';
    expect(() => regexLiteralsOf(truncated, 'fixture.ts')).toThrow(/cannot close/);
  });

  it('the scanner: a // comment is not vocabulary, and does not swallow the cues after it', () => {
    const fixture = [
      'const cues = [',
      "  // a note about 对比 in prose, with an apostrophe's trap",
      "  /约会/,",
      "  /* a block note spanning",
      "     lines, still prose 对比 */",
      "  /餐厅/,",
      '];',
    ].join('\n');
    const sites = regexLiteralsOf(fixture, 'fixture.ts');
    // The count, not just the characters: a scanner that lost one of the two cues and still happened to
    // read the surviving one's character would pass the four assertions below.
    expect(sites.length, 'the fixture holds exactly two regex literals').toBe(2);
    expect(vocabularyChars(sites).has('对'), 'a character from a // comment was charged as vocabulary').toBe(false);
    expect(vocabularyChars(sites).has('比'), 'a character from a block comment was charged as vocabulary').toBe(false);
    expect(vocabularyChars(sites).has('约'), 'the cue after the line comment was not read').toBe(true);
    expect(vocabularyChars(sites).has('餐'), 'the cue after the block comment was not read — a // or /* note that stays open cuts the population to nothing').toBe(true);
  });

  it('the scanner: an escaped slash and a class are one literal, not two', () => {
    const sites = regexLiteralsOf(String.raw`const a = /日\/料|餐厅/; const b = /[/]约会/;`, 'fixture.ts');
    expect(sites.length, 'a `/` inside a class or escape split the literal').toBe(2);
    expect(sites[0]!.body).toBe('日\\/料|餐厅');
    expect(vocabularyChars(sites).has('料'), 'the literal after the escaped slash was lost').toBe(true);
  });

  it('the census goes red on a one-script cue, and green on the same cue with its pair', () => {
    const dirty = regexLiteralsOf('const hints = [/约会|date/];', 'fixture.ts');
    const problems = oneScriptCues(dirty, [['约', '約']]);
    expect(problems.length, 'a Simplified-only cue passed the census').toBe(1);
    expect(problems[0]).toContain('约→約');

    const paired = regexLiteralsOf('const hints = [/约会|約會|date/];', 'fixture.ts');
    expect(oneScriptCues(paired, [['约', '約']]), 'the same cue with both scripts was still charged').toEqual([]);

    // The mirror direction: a Traditional-only list is the same defect, and must be charged the same way.
    const tradOnly = regexLiteralsOf('const hints = [/約會|date/];', 'fixture.ts');
    const mirrored = oneScriptCues(tradOnly, [['约', '約']]);
    expect(mirrored.length, 'a Traditional-only cue passed the census').toBe(1);
    expect(mirrored[0]).toContain('only as 約');
  });

  it('the census reads the authority as text, so a broken table cannot satisfy itself', () => {
    expect(PAIRS.forward.size).toBeGreaterThanOrEqual(200);
    expect(PAIRS.forward.get('约'), 'the table no longer folds 约').toBe('約');
    expect(PAIRS.reverse.get('約'), 'the table no longer folds back').toBe('约');
    // The four hand-carried pairs are genuinely absent from the product tables today — the claim in the
    // docblock, measured rather than remembered.
    for (const [simp, trad] of HANDED_ON_PAIRS) {
      expect(PAIRS.forward.has(simp) || PAIRS.reverse.has(trad), `${simp}/${trad} is now in the AI tables; retire the hand-carried entry`).toBe(false);
    }
  });
});
