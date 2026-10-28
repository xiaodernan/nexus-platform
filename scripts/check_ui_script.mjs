#!/usr/bin/env node
/**
 * NEXUS D606 — the copy a zh-HK reader is answered in, and the script it is written in.
 *
 * THE DEFECT. `apps/web/src/lib/i18n/dict.ts` declares `Locale = 'zh-HK' | 'en'`, collapses every
 * `zh*` spelling the browser offers onto ONE dictionary (`normalizeLocale` in that file), and sets
 * `htmlLang: 'zh-HK'`. That one dictionary was written in the Simplified script — 精选, 你附近热门,
 * 商户中心, 用一句话找到今天想去的地方 — beside entries of the same file already in Traditional (精選合集,
 * 收錄, 資料, 回覆), so the two spellings of ONE word sat in the same object: `collections: '精选'` and
 * `collectionsTitle: '精選合集'`. A Hong Kong reader was answered in the script of another market, and the
 * file could not agree with itself about which script it was writing.
 *
 * THE MAGNITUDE, AND THE COMMAND THAT RE-MEASURES IT. Laid out as a plane and aimed at it with `--repo`,
 * this reader printed `FAIL — 1,260 simplified character(s) in 491 literal(s) of 2 zh block(s)` on the
 * committed copy of the two carriers; the recipe is `git show <this file's parent>:apps/web/src/lib/i18n/
 * dict.ts` (and trust-labels.ts, plus the two AI tables) into a directory, then
 * `node scripts/check_ui_script.mjs --repo=<that directory>`, because a before-figure that outlives its
 * commit is only a memory unless someone can re-run it. On the repaired carriers in this repository it
 * prints `PASS — 0 simplified character(s) over 814 literal(s)`, and `scripts/falsify_ui_script.mjs`
 * re-derives the population count it asserts from its own baseline run — so a carrier that grows cannot
 * quietly make this header true again.
 *
 * WHY THIS IS A GATE AND NOT A ONE-OFF EDIT. The convention is not this lane's invention. D483 found
 * exactly this shape in the AI's follow-up question bank — "its zh-HK section was written in the
 * SIMPLIFIED script (a copy-paste of the zh-CN section, with one Traditional exception), so a Hong Kong
 * user was asked 请问几位？ beside 預算大概幾多？" — repaired it there by hand, and named the rule
 * ("the zh-HK section is in the product's canonical spelling"). Nothing carried that rule into the web
 * plane, so the web plane kept the defect at a hundred times the size. This reader is the rule with a
 * reader attached: it re-runs, so the next copy-paste from a zh-CN source is caught rather than found
 * again by a screenshot.
 *
 * WHAT IT READS.
 *   THE PAIR TABLE — `apps/ai/nexus_ai/nlu/canonical.py` (`CANONICAL_FORMS`) and
 *   `apps/ai/nexus_ai/nlu/lexicon.py` (`_TRAD_SIMP_PAIRS`). This reader DERIVES its character knowledge
 *   from the two tables the product already maintains, rather than typing a third list by hand; the AI
 *   lane's own gates (D435, D446, D447) keep those tables honest, so a pair added for the NLU is a pair
 *   this reader knows without an edit here.
 *   THE CARRIERS — every top-level `const zh…: … = {` block in `apps/web/src/lib/i18n/*.ts`. Structural
 *   admission: the declaration's own shape (a `zh`-prefixed locale constant) is what makes a block part
 *   of the population, not a name written into this file. `en` blocks are not read.
 *
 * WHAT IT CHARGES. Only STRING LITERALS inside those blocks — comments and prose are not copy, and
 * charging them would make this reader a gate on this repository's English-language discussion of
 * Chinese. A literal is an offender when it holds a character the pair table maps to a different one,
 * MINUS the three characters below, and the exclusions are PRINTED WITH THEIR COUNTS so an exclusion
 * that is holding nothing is visible rather than silent:
 *   台 — the product writes 平台 throughout these carriers and 平臺 nowhere; the table's canonical
 *         臺 is a word choice this product has already made the other way.
 *   面 — 面 is a legitimate Traditional character (頁面, 版面); its canonical 麵 is a different word
 *         (noodles). Charging the character would demand 頁麵 from a page that means "page". The
 *         exclusion is about the CHARACTER: the word 面包 (bakery) is 麵包 in Traditional and the
 *         repair converts that one, which is why the printed 面 count can fall by one while nothing
 *         here charges 面.
 *   嘅 — a Cantonese particle, not a Simplified spelling. Its canonical 的 rewrites a WORD, and the
 *         seed's own reviews carry it as Hong Kong text. It is not in the pair table at all, so the
 *         count this reader prints for it is 0× by construction — listed because an exclusion nobody
 *         needs is a hiding place, and the reader cannot tell the two apart silently.
 *
 * WHAT IT DOES NOT DO, stated rather than implied.
 *   - It does not judge the seed's Chinese, the AI's reply templates, the console fixtures or the mock
 *     plane. Those carriers hold their own script decisions (the AI's zh-CN bank is Simplified ON
 *     PURPOSE, D483) and are named as residue in the ledger section this reader came with.
 *   - It does not know whether a Traditional character is the RIGHT word, only whether a Simplified-only
 *     one is in copy that declares itself zh-HK. A copy that writes 臺 for every 平台 passes.
 *   - It does not read the running site. It reads the shipped source; a locale switch at runtime still
 *     renders the same literals.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGS = {
  '--repo': { kind: 'value', unit: 'path' },
  '--verbose': { kind: 'switch' },
  '--report': { kind: 'switch' },
};

/** Characters the pair table maps but this reader does not charge, each with the measurement that says
 *  why. An exclusion with no reason is a hiding place, so the reason is data, printed with the count. */
export const EXCLUSIONS = {
  台: { to: '臺', why: 'the product writes 平台 throughout these carriers and 平臺 nowhere in apps/' },
  面: { to: '麵', why: '面 is Traditional for face/surface (頁面); 麵 is the noodle word' },
  嘅: { to: '的', why: 'a Cantonese particle, not a script variant; the seed carries it as HK text' },
};

/**
 * Read the two tables the product already keeps.
 *
 * The blocks are located by their own declarations (`CANONICAL_FORMS: dict[str, str] = {` and
 * `_TRAD_SIMP_PAIRS: tuple[…] = (`) and cut at the first line that closes a top-level brace, so a
 * stray escape sequence in the docstring above or below the table is not read as a pair. canonical.py
 * writes its keys as `\uXXXX` on purpose (its own D409 lesson: a writer's memory of a CJK code point is
 * not a reference), so this reader unescapes rather than matching glyphs.
 */
export function readPairTable(repo) {
  const detail = { canonical: 0, lexicon: 0 };
  const table = new Map();
  const problems = [];

  const cPath = join(repo, 'apps/ai/nexus_ai/nlu/canonical.py');
  if (!existsSync(cPath)) problems.push(`no canonical.py at ${cPath}`);
  else {
    const src = readFileSync(cPath, 'utf8');
    const start = src.indexOf('CANONICAL_FORMS');
    const body = blockFrom(src, start);
    if (body === null) problems.push('canonical.py holds no CANONICAL_FORMS table this reader can cut');
    else {
      for (const m of body.matchAll(/"(\\u[0-9a-fA-F]{4})"\s*:\s*"(\\u[0-9a-fA-F]{4})"/g)) {
        const from = unescapeGlyph(m[1]);
        const to = unescapeGlyph(m[2]);
        if (from !== to) table.set(from, to);
        detail.canonical += 1;
      }
    }
  }

  const lPath = join(repo, 'apps/ai/nexus_ai/nlu/lexicon.py');
  if (!existsSync(lPath)) problems.push(`no lexicon.py at ${lPath}`);
  else {
    const src = readFileSync(lPath, 'utf8');
    const start = src.indexOf('_TRAD_SIMP_PAIRS');
    const body = blockFrom(src, start);
    if (body === null) problems.push('lexicon.py holds no _TRAD_SIMP_PAIRS table this reader can cut');
    else {
      for (const m of body.matchAll(/\("([^"\\])",\s*"([^"\\])"\)/g)) {
        const [trad, simp] = [m[1], m[2]];
        if (trad !== simp && !table.has(simp)) table.set(simp, trad);
        detail.lexicon += 1;
      }
    }
  }

  if (table.size === 0) problems.push('the pair table is empty — a census that charges nothing is not a census');
  return { table, detail, problems };
}

function unescapeGlyph(s) {
  return String.fromCharCode(parseInt(s.slice(2), 16));
}

/** The text from `start` to the line that closes the block, or null when the name is absent. */
function blockFrom(src, start) {
  if (start < 0) return null;
  const lines = src.slice(start).split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (/^\}/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.length ? out.join('\n') : null;
}

/**
 * Every top-level `const zh…: T = {` block in one carrier.
 *
 * The block ENDS at the first `};` in column 0, which is how the two shipped carriers are written. A
 * `zh` block whose close this reader cannot find is a refusal, not a silent short block: a truncated
 * population would make the census read greener than the file.
 */
export function zhBlocks(src, file) {
  const lines = src.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^const (zh[A-Za-z0-9_]*)\s*:\s*[A-Za-z0-9_[\]<>| ]+\s*=\s*\{/.exec(lines[i]);
    if (!m) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\};/.test(lines[j])) { end = j; break; }
    }
    if (end < 0) return { blocks, problems: [`${file}: const ${m[1]} at line ${i + 1} has no closing }; in column 0`] };
    blocks.push({ name: m[1], from: i + 1, to: end + 1, lines: lines.slice(i + 1, end) });
  }
  return { blocks, problems: [] };
}

/**
 * The string literals of a block, with their line numbers.
 *
 * One left-to-right scanner over the block's text, tracking six states (code, `//` comment, `/*`
 * comment, `'`, `"`, backtick) so the two mistakes a regex makes here are not made: a `//` comment that
 * contains an apostrophe is not the start of a literal (a regex would run the literal from the quote to
 * the next one and charge the comment's Chinese as copy), and a quote inside a comment is not copy. The
 * header's promise — literals only, prose never — is this function's job to keep, which is why it is a
 * scanner and not a pattern.
 */
export function literalsOf(block) {
  const out = [];
  const text = block.lines.join('\n');
  let i = 0;
  let line = block.from + 1;
  let mode = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      // A `//` comment ends at the newline. The first version of this scanner advanced the line counter
      // here and left `mode` set, so the comment ran to the END OF THE BLOCK: a planted `//` note cut the
      // carrier's population from 814 literals to 50 and still printed PASS. Its own arm found that, which
      // is why the arm exists.
      line += 1;
      if (mode === 'line') mode = null;
      i += 1;
      continue;
    }
    if (mode === 'line') { i += 1; continue; }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = null; i += 2; continue; }
      i += 1; continue;
    }
    if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
    if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const start = i;
      const startLine = line;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '\n' && ch !== '`') break;
        if (text[i] === ch) { i += 1; break; }
        i += 1;
      }
      // The span itself is not returned as text: the scanner walks it once, so re-slicing here would
      // need the newline count it may contain.
      out.push({ line: startLine, span: text.slice(start, i) });
      line += (text.slice(start, i).match(/\n/g) ?? []).length;
      continue;
    }
    i += 1;
  }
  return out;
}

export function scanCarriers(repo, table, carriers) {
  const offenders = [];
  const excludedSeen = new Map(Object.keys(EXCLUSIONS).map((c) => [c, 0]));
  const blocksJudged = [];
  const problems = [];
  let literals = 0;

  for (const file of carriers) {
    const rel = file.slice(repo.length + 1).replace(/\\/g, '/');
    const src = readFileSync(file, 'utf8');
    const { blocks, problems: bp } = zhBlocks(src, rel);
    problems.push(...bp);
    for (const block of blocks) {
      // Reach, not rendering: the block's identifier must be READ somewhere in the file outside the block's
      // own lines. `zhHK` is read by the `DICTS` registry and `zhLabels` by the `trustLabels()` picker — an
      // earlier draft required a `Record<Locale>` map specifically and so accused the second one of being
      // dead copy. A flag that fires on shipped code is a lie with a good name, so the harness pins both
      // directions.
      const outside = src.split(/\r?\n/).filter((_, k) => k < block.from - 1 || k > block.to - 1)
        .some((l) => new RegExp('\\b' + block.name + '\\b').test(l));
      blocksJudged.push({ rel, name: block.name, from: block.from, to: block.to, referenced: outside });
      for (const lit of literalsOf(block)) {
        literals += 1;
        const chars = [];
        for (const c of new Set([...lit.span])) {
          if (!table.has(c)) continue;
          if (EXCLUSIONS[c]) excludedSeen.set(c, excludedSeen.get(c) + 1);
          else chars.push(c);
        }
        if (chars.length) offenders.push({ rel, line: lit.line, block: block.name, chars, span: lit.span });
      }
    }
  }
  return { offenders, literals, blocksJudged, excludedSeen, problems };
}

export function carrierFiles(repo) {
  const dir = join(repo, 'apps/web/src/lib/i18n');
  if (!existsSync(dir)) return { files: [], problems: [`no i18n directory at ${dir}`] };
  const files = readdirSync(dir)
    .filter((f) => /\.ts$/.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
  return { files, problems: [] };
}

function main() {
  const parsed = parseFlags(process.argv.slice(2), FLAGS);
  if (!parsed.ok) {
    console.log(`RESULT: NOT CHECKED — ${parsed.reason}`);
    process.exit(2);
  }
  const repo = resolve(parsed.value['--repo'] ?? resolve(HERE, '..'));
  const verbose = parsed.flag['--verbose'];
  const reportOnly = parsed.flag['--report'];

  const { table, detail, problems } = readPairTable(repo);
  const { files, problems: cp } = carrierFiles(repo);
  problems.push(...cp);
  if (problems.length || table.size === 0 || files.length === 0) {
    console.log('RESULT: NOT CHECKED — the census could not be armed on this plane');
    for (const p of problems.length ? problems : ['no carrier file was found in the population']) console.log(`  ${p}`);
    console.log(`  pair table: ${table.size} character(s) read from canonical.py (${detail.canonical} entries) and lexicon.py (${detail.lexicon} pairs)`);
    process.exit(2);
  }

  const r = scanCarriers(repo, table, files);
  console.log(`zh-HK UI script census — ${repo}`);
  console.log(`pair table: ${table.size} simplified character(s) known (canonical.py ${detail.canonical}, lexicon.py ${detail.lexicon})`);
  for (const b of r.blocksJudged) {
    console.log(`block ${b.name} — ${b.rel}:${b.from}-${b.to}${b.referenced ? '' : '  UNREFERENCED (nothing in this file reads the block, so its copy may not be what the site renders — disclosed, not charged)'}`);
  }
  const seen = [...r.excludedSeen.entries()].map(([c, n]) => `${c}→${EXCLUSIONS[c].to} ${n}× (${EXCLUSIONS[c].why})`);
  console.log(`excluded, counted not charged: ${seen.join(' | ')}`);

  if (r.problems.length) {
    console.log(`RESULT: NOT CHECKED — ${r.problems.length} carrier(s) could not be read to their end`);
    for (const p of r.problems) console.log(`  ${p}`);
    process.exit(2);
  }

  const chars = r.offenders.reduce((a, o) => a + o.chars.length, 0);
  if (verbose || r.offenders.length) {
    for (const o of r.offenders) {
      const fix = [...o.span].map((c) => (o.chars.includes(c) ? table.get(c) : c)).join('');
      console.log(`  WRONG-SCRIPT ${o.rel}:${o.line} [${o.chars.join('')}] ${o.span.slice(0, 96)}`);
      if (verbose) console.log(`             →    ${fix.slice(0, 96)}`);
    }
  }
  const tail = reportOnly ? '  (--report: printed, not enforced)' : '';
  if (chars > 0) {
    console.log(`RESULT: FAIL — ${chars} simplified character(s) in ${r.offenders.length} literal(s) of ${r.blocksJudged.length} zh block(s) that declare zh-HK${tail}`);
    process.exit(reportOnly ? 0 : 1);
  }
  console.log(`RESULT: PASS — 0 simplified character(s) over ${r.literals} literal(s) of ${r.blocksJudged.length} zh block(s); ${r.excludedSeen.size} character(s) excluded by name`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
