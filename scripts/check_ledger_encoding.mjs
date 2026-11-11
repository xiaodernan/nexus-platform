#!/usr/bin/env node
/**
 * NEXUS D959 — the prose plane carries an encoding census, so an invisible byte can no longer sit in it.
 *
 * NUMBERING. D957 and D958 were taken by a concurrent lane (07d14bd) with real code: it removed the
 * never-called `redis_enabled` function (a D922 leftover) and three never-read W3C wire-name constants
 * (a D884 leftover) that the AI job's new no-dead-constants census caught. Per the D939/D940, D953/D954
 * and D955/D956 yield pattern, this unit takes D959 rather than colliding with a shipped ledger entry.
 *
 * THE HOLE. D954 fixed a self-test whose LF needle silently no-op'd against a CRLF plane; D952 pinned a
 * credential plane; D956 closed the tinted-ground contrast blind spot. All three shared one root cause:
 * the BYTES disagreed with the intent, silently. This reader generalizes that lesson to the prose itself.
 * Measured 2026-11-11 across all 40 tracked `*.md` files, 4 carried codepoints that no Markdown prose
 * should ever contain:
 *     docs/STATUS.md        6 x U+0007 (BEL), 78 x C1 (U+0080..U+009F), 1 x U+FFFD
 *     docs/PLAN.md          1 x U+0008 (backspace)
 *     docs/TESTING.md       2 x U+FFFD
 *     DEVELOPMENT_PLAN.md   1 x U+FFFD
 * = 89 forbidden codepoints; 28 byte-exact bijective Latin-1 mis-read runs (25 C1-bearing, 3 `Â·`/`Â§`).
 * A BEL or C1 is invisible in an editor, survives review, and breaks every byte-targeted tool that reads
 * a ledger one line at a time — the exact class of silence D954/D952/D956 kept finding one instance of.
 * It is baked into every historical commit (no clean ancestor to restore), so it needs a census + policy.
 *
 * TWO AXES, BOTH PROVABLE — this reader never guesses a glyph:
 *   A — FORBIDDEN CODEPOINTS. C0 controls except HT(09)/LF(0A)/CR(0D), DEL(7F), the C1 block (80..9F),
 *       and U+FFFD (the replacement char, which by definition means "a decode already failed here").
 *       None of these is legitimate prose. U+FFFD is named even though it is itself the symptom: a plane
 *       that still contains one has a byte nobody can read, and a census that ignores that is a false pass.
 *   B — BIJECTIVE MOJIBAKE RUNS. A maximal Latin-1 run `[\u0080-\u00FF]+` whose bytes, read back as UTF-8,
 *       decode to different text with no replacement char AND re-encode to the exact original bytes. That
 *       round-trip (Buffer.from(run,'latin1').toString('utf8') -> re-encode == run) is the byte-exact inverse
 *       of a latin1-misread: it proves the run IS a mis-decoded UTF-8 sequence (e.g. `â\x80\x94` -> an
 *       em dash, `å®\x89é\x9D\x99` -> CJK), not a legitimate accented Latin word. A lone `é`, `§`, `·`,
 *       or `—` is NOT bijective under this test and is left alone. The repair for axis B writes back that
 *       inverse; nothing is invented.
 *
 * THE REPAIR, RECORDED SO IT CAN BE RE-CHECKED (all four files, all UTF-8, each kept in its own EOL plane):
 *   - 25 bijective C1 runs + 3 bijective `Â·`/`Â§` runs (D393/D678-era section): byte-exact latin1->UTF-8
 *     inverse. Includes `â\x80\x94`->`—`, `â\x89\x88`->`≈`, `Â§`->`§`, and CJK phrases. Where a phrase's
 *     round-trip was lossy (1 GBK fragment `æ\x83³é£\x9Fæ\x97¥åð` -> `想食日...` with a dropped byte), the
 *     inverse is NOT applied; instead a clean IN-DOCUMENT anchor is used (`我想食日式菜` stands a few lines
 *     below, line 15503 of the pre-repair plane), so the restoration comes from the ledger's own evidence.
 *   - 6 x BEL where an `a` was eaten and 1 x backspace where a `b` was eaten: the escape MECHANISM proves
 *     the letter (`a` -> `\a` = BEL, `b` -> `\b` = backspace when a string literal lost its backslash).
 *     Restored to `a`/`b`; context confirms the words (`accessibility`, `access`, `address`, `bookable`).
 *   - TESTING.md `read <FFFD><FFFD>8.4`: the two replacement chars are the two bytes of `§` (U+00A7 =
 *     C2 A7) after a mis-decode; the same file writes `§8.3`/`§8.5` and uses `§` 35 times, and the commit
 *     that introduced the line is titled "...across §8.3/§8.5". Restored to `read §8.4` — from context,
 *     not guesswork.
 *   - 2 genuinely LOSSY glyphs (a GBK-mojibaked ramen query `鎷夐<FFFD>`, a lost emoji heading prefix in
 *     DEVELOPMENT_PLAN.md whose siblings are 🎯/📅/📋/⚠️/📊/📈): the original bytes are unrecoverable, so
 *     this unit does NOT fabricate them. Each U+FFFD becomes the self-describing ASCII sentinel `[U+FFFD]`,
 *     which keeps the "a byte was lost here" fact visible and greppable while removing the unreadable
 *     codepoint. A future lane with the source can replace the sentinel with the true glyph.
 *
 * WHAT IT DOES NOT CLAIM. It is a SOURCE census, not a renderer: it does not say the page renders, that a
 * screen reader agreed, or that a repaired CJK phrase is the author's exact intended glyph where the bytes
 * were already lossy (the 2 sentinels name precisely where that limit is). It does not census binary files,
 * source code, or lockfiles — only tracked Markdown prose, which is what the ledgers and plans are. A
 * legitimate non-ASCII character (>= U+00A0 that is not U+FFFD) is never an offender. It does not assert
 * the repairs are the ONLY possible reading; it asserts every one is byte-provable or context-proved by
 * the ledger's own text, and that the two that are neither are marked, not silently guessed.
 *
 * SELF-TEST. `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in memory on a
 * plane built from the real files: a BEL, a C1, a DEL, a U+FFFD, a backspace, a bijective mojibake run,
 * cuts the CI / ATLAS / ledger wiring, and removes the reader from disk — 10 arms, each must redden for
 * cause. The ledger arm deletes the HEADING line (not just the token): this reader's own falsifier prose
 * quotes the section number, so a token-replace would leave a second anchor and stay green (D954's class).
 * A false-positive guard then feeds a plane
 * full of LEGITIMATE prose (§, ·, —, café, naïve, a full emoji, CJK, curly quotes) and requires GREEN —
 * the check that this census does not become the thing that punishes non-ASCII writing. A no-op snapshot
 * guard (D954's invariant) fails any arm whose corruption did not change a byte.
 *
 * Usage:  node scripts/check_ledger_encoding.mjs [--self-test] [--report]
 * Exit:   0 every prose file is clean and the wiring holds · 1 an offender · 2 plane unreadable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_ledger_encoding.mjs';
const WIRING = [CI, ATLAS, STATUS, SELF];

/** Every tracked Markdown file is in the census plane (found at runtime via `git ls-files`). */
function trackedMarkdown() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
    return out.toString('utf8').split('\u0000').filter((p) => p.toLowerCase().endsWith('.md'));
  } catch {
    return null;
  }
}

const isForbidden = (n) =>
  (n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d) || // C0 except HT/LF/CR
  n === 0x7f ||                                           // DEL
  (n >= 0x80 && n <= 0x9f) ||                             // C1 block
  n === 0xfffd;                                           // replacement char

const label = (n) => {
  if (n === 0xfffd) return 'U+FFFD (replacement char)';
  if (n === 0x7f) return 'U+007F (DEL)';
  if (n >= 0x80 && n <= 0x9f) return `U+${n.toString(16).toUpperCase().padStart(4, '0')} (C1)`;
  return `U+${n.toString(16).toUpperCase().padStart(4, '0')} (C0)`;
};

/** Byte-exact inverse of a latin1 mis-read; null unless it round-trips bijectively to different text. */
function mojibakeInverse(run) {
  let iv;
  try { iv = Buffer.from(run, 'latin1').toString('utf8'); } catch { return null; }
  if (iv === run || iv.includes('\uFFFD')) return null;
  try { if (Buffer.from(iv, 'utf8').toString('latin1') !== run) return null; } catch { return null; }
  return iv;
}
const LATIN_RUN = /[\u0080-\u00ff]+/g;

/** Pure over a path->text map + the set of physically present paths. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  let proseFiles = 0;
  let forbiddenCount = 0;
  let mojibakeCount = 0;

  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the prose plane is empty or unreadable — a census that found nothing cleared nothing', proseFiles, forbiddenCount, mojibakeCount };
  }

  for (const [p, text] of files) {
    if (!p.toLowerCase().endsWith('.md')) continue; // only Markdown prose is censused
    proseFiles += 1;

    // Axis A — forbidden codepoints, with an exact line number and a printable context.
    const lines = text.split('\n');
    let line = 1;
    let col = 1;
    for (let i = 0; i < text.length; i += 1) {
      const n = text.codePointAt(i);
      if (n === 0x0a) { line += 1; col = 1; continue; }
      if (isForbidden(n)) {
        forbiddenCount += 1;
        const raw = lines[line - 1] ?? '';
        const shown = JSON.stringify(raw.slice(Math.max(0, col - 9), col + 8));
        offenders.push(`FORBIDDEN — ${p}:${line}:${col} carries ${label(n)} (context ${shown})`);
      }
      if (n > 0xffff) i += 1; // a surrogate pair is one codepoint / one column
      col += 1;
    }

    // Axis B — bijective latin1->UTF-8 mojibake runs (provable, so repairable without guessing).
    LATIN_RUN.lastIndex = 0;
    let m;
    let lastEnd = 0;
    let runLine = 1;
    while ((m = LATIN_RUN.exec(text)) !== null) {
      const run = m[0];
      // A Latin-1 run cannot contain LF (0x0A is outside 0x80..0xFF), so all newlines live in the gaps.
      const gap = text.slice(lastEnd, m.index);
      for (let k = 0; k < gap.length; k += 1) if (gap.charCodeAt(k) === 0x0a) runLine += 1;
      lastEnd = m.index + run.length;
      const iv = mojibakeInverse(run);
      if (iv === null) continue; // legitimate accent, section sign, em dash, etc.
      mojibakeCount += 1;
      offenders.push(`MOJIBAKE  — ${p}:${runLine} holds a latin1 mis-read (${JSON.stringify(run)} -> ${JSON.stringify(iv)}); byte-exact inverse exists`);
    }
  }

  if (proseFiles === 0) {
    return { offenders, notes, unchecked: 'no tracked Markdown file was readable — a census that found nothing cleared nothing', proseFiles, forbiddenCount, mojibakeCount };
  }
  notes.push(`held ${proseFiles} tracked Markdown file(s) under both axes`);

  // Wiring: CI self-test chain, ATLAS reverse census, this ledger section, and the reader itself.
  const has = (p, needle, why) => {
    if (!(files.get(p) ?? '').includes(needle)) offenders.push(`MISSING — ${p}: ${why} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${why}`);
  };
  // D959 lesson from the self-test itself: a plain `.includes` on the section number is satisfiable by
  // this very reader's falsifier prose quoting the heading. The wiring must assert a HEADING exists,
  // not that the token appears somewhere — so anchor to line start, EOL-agnostic (D954's invariant).
  const hasHeading = (p, heading, why) => {
    const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'm');
    if (!re.test(files.get(p) ?? '')) offenders.push(`MISSING — ${p}: ${why} (expected a line starting with ${JSON.stringify(heading)})`);
    else notes.push(`held ${why}`);
  };
  has(CI, `node ${SELF} --self-test`, 'CI runs this reader in the self-test chain');
  has(ATLAS, SELF, 'ATLAS lists this reader');
  hasHeading(STATUS, '## 959. D959', 'the ledger holds a §959 heading');
  if (!present.has(SELF)) offenders.push(`ABSENT — ${SELF}: this reader ships on disk`);
  else notes.push('held this reader ships on disk');

  return { offenders, notes, unchecked: null, proseFiles, forbiddenCount, mojibakeCount };
}

function fromDisk() {
  const paths = trackedMarkdown();
  if (paths === null) return null;
  const files = new Map();
  const present = new Set();
  for (const p of [...paths, ...WIRING.filter((w) => !paths.includes(w))]) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present, paths };
}

const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');

/* A plane of legitimate prose: non-ASCII that is NOT forbidden and NOT a bijective mojibake run. */
const LEGITIMATE = 'café naïve résumé §8.4 § 7 · middle dot — em dash – en dash 中文 한글 "curly" \u{1F680} rocket 😀 é £ ± ≤ ≥';

if (SELF_TEST) {
  const real = fromDisk();
  if (real === null) { console.log('RESULT: NOT CHECKED — git ls-files could not be read'); process.exit(2); }
  const base = judge(real.files, real.present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real prose plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }

  const VICTIM = STATUS;
  // Each arm returns { files, present, expect } — `expect` is a substring the reddened offender MUST carry,
  // so an arm that goes red for the WRONG reason (e.g. a mojibake arm tripping axis A) still fails the test.
  // Corruptions are APPENDED as their own line so no arm can accidentally break a load-bearing heading.
  const plant = (suffix, expect) => {
    const f = new Map(real.files);
    f.set(VICTIM, f.get(VICTIM) + suffix);
    return { files: f, present: real.present, expect };
  };
  const armFiles = (p, fn, expect) => {
    const f = new Map(real.files);
    f.set(p, fn(f.get(p) ?? ''));
    return { files: f, present: real.present, expect };
  };
  const arms = [
    ['a BEL is planted', plant('\n\u0007PLANTED\n', 'U+0007 (C0)')],
    ['a C1 control is planted', plant('\n\u0080PLANTED\n', 'U+0080 (C1)')],
    ['a DEL is planted', plant('\n\u007fPLANTED\n', 'U+007F (DEL)')],
    ['a replacement char is planted', plant('\n\uFFFDPRANTED\n', 'U+FFFD')],
    ['a backspace is planted', plant('\n\u0008PLANTED\n', 'U+0008 (C0)')],
    // A bijective run with NO forbidden codepoint: `Â·` (C2 B7) round-trips to `·`. If this arm reddens,
    // axis B is proven to judge independently of axis A (both of its bytes are >= 0xA0, not forbidden).
    ['a bijective mojibake run is planted', plant('\nÂ·PLANTED\n', 'MOJIBAKE')],
    ['CI self-test chain cut', armFiles(CI, (t) => t.replace(`node ${SELF} --self-test`, ''), 'MISSING — ' + CI)],
    ['ATLAS row erased', armFiles(ATLAS, (t) => t.split(/\r?\n/).filter((l) => !l.includes(SELF)).join('\n'), 'MISSING — ' + ATLAS)],
    // Delete only the HEADING line, not the token: the §959 prose itself quotes `## 959. D959` in the
    // falsifier paragraph, so a token-replace leaves a second anchor and the arm would stay GREEN (the
    // D954 vacuous-needle class, caught by this reader's own first self-test run). Removing the line
    // proves hasHeading — not `.includes` — is what holds the ledger wiring. EOL-agnostic.
    ['ledger §959 heading removed', armFiles(STATUS, (t) => t.split(/\r?\n/).filter((l) => !/^## 959\. D959(?=\s|$)/.test(l)).join('\n'), 'MISSING — ' + STATUS)],
  ];
  // The reader-absent arm changes only `present`, not file bytes.
  const absentPresent = new Set(real.present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real.files, present: absentPresent, expect: 'ABSENT — ' + SELF }]);

  const sig = (a) => snapshot(a.files) + '\u0001' + [...a.present].sort().join(',');
  const baseSig = sig(real);
  let allCaught = true;
  for (const [labelText, arm] of arms) {
    if (sig(arm) === baseSig) { // D954 invariant: a corruption that changes nothing is a defect, never a pass
      console.log(`  self-test  ${labelText.padEnd(42)} NO-OP (defect!)`);
      allCaught = false;
      continue;
    }
    const j = judge(arm.files, arm.present);
    const joined = j.offenders.join(' | ');
    const red = j.unchecked !== null || j.offenders.length > 0;
    const rightReason = joined.includes(arm.expect);
    const pass = red && rightReason;
    if (!pass) allCaught = false;
    console.log(`  self-test  ${labelText.padEnd(42)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${j.offenders.length} expect=${JSON.stringify(arm.expect)}`);
    if (red && !rightReason) for (const o of j.offenders.slice(0, 2)) console.log('      got: ' + o);
  }

  // False-positive guard: legitimate non-ASCII prose must stay GREEN on BOTH axes.
  const legitFiles = new Map(real.files);
  legitFiles.set(VICTIM, LEGITIMATE + '\n' + (real.files.get(VICTIM) ?? ''));
  const legitJudge = judge(legitFiles, real.present);
  const legitGreen = legitJudge.offenders.length === 0 && legitJudge.unchecked === null;
  if (!legitGreen) allCaught = false;
  console.log(`  self-test  ${'legitimate non-ASCII prose stays GREEN'.padEnd(42)} ${legitGreen ? 'green' : 'RED (defect!)'} offenders=${legitJudge.offenders.length}`);
  if (!legitGreen) for (const o of legitJudge.offenders.slice(0, 4)) console.log('      ' + o);

  console.log(`  self-test  all arms redden for cause + guard green: ${allCaught} (${arms.length} corruption arms + 1 guard)`);
  process.exit(allCaught ? 0 : 1);
}

const plane = fromDisk();
if (plane === null || plane.paths.length === 0) {
  console.log('RESULT: NOT CHECKED — no tracked Markdown plane was found; a census that found nothing clears nothing (exit 2)');
  process.exit(2);
}
const result = judge(plane.files, plane.present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (result.offenders.length) {
  console.log(`FALSE ENCODING (${result.offenders.length}) — ${result.forbiddenCount} forbidden codepoint(s), ${result.mojibakeCount} bijective mojibake run(s):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s) across ${result.proseFiles} Markdown file(s)`);
  process.exit(REPORT ? 0 : 1);
}
for (const n of result.notes) console.log(`  ${n}`);
console.log(`RESULT: PASS — D959 prose encoding census clean across ${result.proseFiles} Markdown file(s), ${result.notes.length} holds`);
process.exit(0);
