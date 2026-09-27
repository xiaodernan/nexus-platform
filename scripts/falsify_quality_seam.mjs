#!/usr/bin/env node
/**
 * NEXUS D156 — show that gate step 7 can fail, and that its `--quality` seam reaches the ANSWER SITES census
 * rather than only the declared-reads half of it.
 *
 * WHY THIS EXISTS. `check_jsonb_reads.mjs` documents `--quality=<path>` as the seam a witness uses so a plant
 * does not have to edit the tracked seed gate mid-run. The seam's reach had never been asked: an earlier probe
 * planted six occurrences of one citation and the census printed the same numbers with exit 0, because five of
 * the six were comment lines and the site census only walks rows inside the two `INSERT INTO … VALUES` blocks.
 * Aimed at a row the census does parse, four plants each did what the step claims (D156). This file is that
 * measurement, kept as an arm so the next reader does not re-derive it, and gate step 7 runs it.
 *
 * Every arm runs the SHIPPED checker as a subprocess over its own copy of the seed gate, written into the
 * system temp directory, so no arm edits a tracked file and no two arms can redden each other. The checker's
 * own `ROOT` is its working directory, so all arms run from the repository root: the plants change only the
 * answers, never the source they are compared against.
 *
 * Usage: node scripts/falsify_quality_seam.mjs
 * Exit: 0 every arm held · 1 at least one did not · 2 a plant could not be built (a mutation that no longer
 *       matches its anchor is an arm that proves nothing).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_jsonb_reads.mjs');
const TRACKED = join(ROOT, 'data', 'seed', 'quality.sql');
const FIX = join(tmpdir(), 'nexus-d156-falsify');

const die = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

// Read as text and write as text: this file's plants anchor on ordinary sentences, and a byte-level rewrite of
// a UTF-8 source would re-encode every § it passed.
const BASE = readFileSync(TRACKED, 'utf8');
if (BASE.includes('\r\n')) die('the seed gate is LF here; this harness assumes one line ending for its row plant');

/** Write `from` → `to` into its own fixture copy. A plant must hit its anchor exactly once or it proves nothing. */
function plant(name, from, to) {
  const hits = BASE.split(from).length - 1;
  if (hits !== 1) {
    die(`plant ${name}: its anchor occurs ${hits} time(s) in the tracked seed gate, not 1 — the anchor is stale`);
  }
  const p = join(FIX, name);
  writeFileSync(p, BASE.replace(from, to), 'utf8');
  return p;
}

const PAST_END = plant('past_end.sql', 'CollectionsController.java:243', 'CollectionsController.java:999999');
const NO_LINE = plant('no_line.sql', 'ImportService.java:193 (from documents d)',
  'ImportService.java (from documents d)');
const ROW_DROPPED = plant('row_dropped.sql',
  [' (\'orders\', \'metadata\', \'session_id\', \'empty-by-guard\', \'OrderRepository.java:97\',',
    '  \'guest-order lookup by session; orders is EMPTY by D64 because §109 forbids fabricated transactions\'),']
    .join('\n') + '\n', '');
const MARKER_GONE = plant('marker_gone.sql', 'INSERT INTO read_answer VALUES', 'INSERT INTO read_answer_x VALUES');
const CONTROL = plant('control.sql', 'INSERT INTO read_answer VALUES', 'INSERT INTO read_answer VALUES');

const CENSUS = /ANSWER SITES — (\d+) answer row\(s\) cite (\d+) source location\(s\) in (\d+) file\(s\); (\d+) distinct source line\(s\) read back/;
const SPANS = /line spans checked\s+(\d+) across (\d+) citation token/;

/** Run the shipped checker with these arguments; return its rc, its census numbers, and its whole output. */
function run(...argv) {
  const r = spawnSync(process.execPath, [CHECKER, ...argv], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const c = CENSUS.exec(out);
  const s = SPANS.exec(out);
  if (!c || !s) return { rc: r.status, census: null, spans: null, out };
  return { rc: r.status, census: { rows: +c[1], cited: +c[2], files: +c[3], lines: +c[4] },
    spans: { checked: +s[1], tokens: +s[2] }, out };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* --------------------------------------------------------------------- arms */

// The control runs first and its numbers are what the plant arms predict against, so no arm's expectation is a
// transcription of a run someone remembered.
const SHIPPED = run();
const CTRL = run(`--quality=${CONTROL}`);
if (SHIPPED.rc !== 0 || CTRL.rc !== 0) die(`the shipped plane is not green (rc ${SHIPPED.rc}, control rc ${CTRL.rc})`);
if (!same(SHIPPED.census, CTRL.census) || !same(SHIPPED.spans, CTRL.spans)) {
  die(`an unmutated copy through the seam moved the census: ${JSON.stringify(SHIPPED.census)} vs ${JSON.stringify(CTRL.census)}`);
}
const N = CTRL.census;
const S = CTRL.spans;

const ARMS = [
  {
    name: 'control — the seam over an unmutated copy leaves every census number where the tracked file put it',
    args: [`--quality=${CONTROL}`], expectRc: 0,
    census: (c) => same(c, N), spans: (s) => same(s, S),
  },
  {
    name: 'cited line past the end of the file — the site census refutes it and the run reddens',
    args: [`--quality=${PAST_END}`], expectRc: 1,
    evidence: ['read_answer collections.seo.generated_by', 'the file has'],
    census: (c) => c.rows === N.rows && c.cited === N.cited && c.lines === N.lines - 1,
    spans: (s) => s.checked === S.checked - 1 && s.tokens === S.tokens,
  },
  {
    name: 'cited line number removed — a file with no line is reported twice: once for the cite, once for the row',
    args: [`--quality=${NO_LINE}`], expectRc: 1,
    evidence: ['with no line number', 'not one of them carries a line number'],
    census: (c) => c.rows === N.rows && c.cited === N.cited && c.lines === N.lines - 1,
    spans: (s) => s.checked === S.checked - 1 && s.tokens === S.tokens,
  },
  {
    name: 'answered row dropped — the parse-vs-census reconciliation catches it, and the counts move',
    args: [`--quality=${ROW_DROPPED}`], expectRc: 1,
    evidence: ['while its read census parsed'],
    census: (c) => c.rows === N.rows - 1 && c.cited === N.cited - 1,
  },
  {
    name: 'the space spelling reaches the same census as the `=` one (D156: before the fix it read the tracked file)',
    args: ['--quality', PAST_END], expectRc: 1,
    evidence: ['the file has'],
    census: (c) => c.rows === N.rows && c.cited === N.cited && c.lines === N.lines - 1,
    spans: (s) => s.checked === S.checked - 1,
  },
  {
    name: 'an unknown flag is a refusal with exit 2, not a silence about the wrong plane',
    args: [`--qualit=${PAST_END}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'unknown option', 'flags this reader parses'],
  },
  {
    name: 'an empty --quality value is a refusal, not a fallback to the tracked file',
    args: ['--quality='], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'without a path'],
  },
  {
    name: 'the file the seam names is the file the census opens (its anchor gone, the checker says which path)',
    args: [`--quality=${MARKER_GONE}`], expectRc: 1,
    evidence: ['Could not find the read_answer table in', MARKER_GONE],
  },
];

let held = 0;
const misses = [];
for (const arm of ARMS) {
  const r = run(...arm.args);
  const why = [];
  if (r.rc !== arm.expectRc) why.push(`rc ${r.rc}, expected ${arm.expectRc}`);
  for (const e of arm.evidence ?? []) if (!r.out.includes(e)) why.push(`does not print ${JSON.stringify(e)}`);
  if (arm.census && !arm.census(r.census ?? {})) why.push(`census ${JSON.stringify(r.census)}`);
  if (arm.spans && !arm.spans(r.spans ?? {})) why.push(`spans ${JSON.stringify(r.spans)}`);
  if (why.length === 0) {
    held += 1;
    console.log(`ok    ${arm.name}  [rc ${r.rc}]`);
  } else {
    misses.push(arm.name);
    console.log(`FAIL  ${arm.name}  — ${why.join('; ')}`);
    console.log(`      ${r.out.split(/\r?\n/).filter((l) => l.includes('ANSWER SITES') || l.startsWith('  - ')).join('\n      ')}`);
  }
}

console.log(`\nCONTROL CENSUS — ${JSON.stringify(N)} line spans ${JSON.stringify(S)} (the tracked plane's own numbers)`);
console.log(ARMS.length - misses.length === ARMS.length
  ? `RESULT: PASS — ${held} of ${ARMS.length} arms held; the seam reaches the site census and the gate step that runs it`
  : `RESULT: FAIL — ${held} of ${ARMS.length} arms held; did not hold: ${misses.join(' | ')}`);
process.exit(misses.length === 0 ? 0 : 1);
