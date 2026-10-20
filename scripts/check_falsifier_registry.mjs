#!/usr/bin/env node
/**
 * NEXUS D103 — validate data/seed/falsifiers.tsv against the assertions the gate actually files.
 *
 * The denominator is qc, not the text: most names are built at run time, by the rule "a name is assembled iff
 * its quoted constant does not appear in quality.sql" — 101 of the 216 on today's plane. D98 recorded 103 by
 * that same rule on the same-size plane, and the difference is not reconstructible: one name is D107's renamed
 * documents row, the last is a sweep row that existed on D98's catalogue read and not on this one. A total that
 * stays 216 does not mean the set stayed the same, which is why the rule is stated here and a count is not.
 * A prefix test would be the cheaper classifier and is the wrong one: `density: >= 300 merchants within 3km of
 * Sha Tin` is assembled from a bound variable (quality.sql:524) yet has no sweep-shaped prefix, while 14 names
 * are written-out constants that merely begin with one (`volume: chunks > 0`, quality.sql:170).
 * list is obtained the way D99/D100's harnesses get it — slice the shipped assertions at the hard-gate marker
 * (the verdict's RAISE would end the session, since the file sets ON_ERROR_STOP for itself), run them, read
 * the table back as one aggregated row so a name containing a newline cannot change the count.
 *
 * D118 wired this file into the gate as step 11 of scripts/db_gate_fresh.sh. Before that it ran only when a
 * person remembered to pass --db, which made the record's correctness a habit rather than a check.
 *
 * Usage: node scripts/check_falsifier_registry.mjs --db <loaded seed> [--container <name>] [--registry <path>]
 * Exit: 0 consistent · 1 a registry row is wrong · 2 not checkable. "Not checkable" is its own answer (D96):
 *       a reader that did not run is not a pass, and a registry validated against nothing is not green.
 *
 * D113 narrowed what a witness may be. 39 of the 61 rows then pointed at files under one machine's temporary
 * directory, and the check passed only while that machine kept them: measured by running this same script with
 * `TMPDIR` pointed at an empty directory, which reddened exactly those 39 rows and nothing else. A witness you
 * cannot open from a clean checkout is an anecdote with a filename, so a path witness is now resolved inside the
 * repository and must be a blob tracked at HEAD — the refusal says which of the three states it found (absent,
 * present but untracked, tracked), because "the file is there and the registry is still wrong" is the D110 case.
 * `--registry` exists so those refusals can be planted in a scratch copy instead of by editing the shipped file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DB = arg('--db', null), CONTAINER = arg('--container', 'nexus-platform-postgres');
const REGISTRY = resolve(ROOT, arg('--registry', join('data', 'seed', 'falsifiers.tsv')));
const notChecked = (why) => { console.error(`RESULT: NOT CHECKED — ${why}`); process.exit(2); };

const lines = readFileSync(join(ROOT, 'data', 'seed', 'quality.sql'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const mark = lines.filter((l) => l.startsWith('-- ====') && l.includes('C  hard gate'));
if (mark.length !== 1) notChecked('the hard-gate marker is missing or duplicated, so the slice has no safe end');
const slice = lines.slice(0, lines.indexOf(mark[0])).join('\n')
  + "\nSELECT count(*) || '#' || coalesce(string_agg(\"check\", chr(9) ORDER BY \"check\"), '') FROM qc;\n";

let live;
try {
  if (!DB) notChecked('no --db given; pass a loaded seed (scripts/db_gate_fresh.sh --keep)');
  // The slice used to travel on this call's stdin (`input:`), and the note that used to stand here was right
  // about the mechanism and wrong about the conclusion: `input:` does need the stdin slot to be `pipe`, and a
  // stdin pipe is the one thing this host refuses to give a child — `EBUSY` in about 3 ms, measured for every
  // other spawn in this repository (STATUS §253). So this call is not the exception to that spelling; it is
  // the call the spelling cannot serve. The slice is written to a file and copied in instead, and every spawn
  // here now takes the ignore-stdin form the rest of the tree uses.
  const sliceFile = join(tmpdir(), `nexus-qc-${process.pid}.sql`);
  const inContainer = `/tmp/nexus-qc-${process.pid}.sql`;
  writeFileSync(sliceFile, slice, 'utf8');
  execFileSync('docker', ['cp', sliceFile, `${CONTAINER}:${inContainer}`],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const out = execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', DB,
    '-v', 'ON_ERROR_STOP=0', '-tA', '-q', '-f', inContainer],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 });
  const lines = out.split('\n').filter((l) => l.includes('#') && l.length > 40);
  const line = lines.pop();
  if (!line) {
    notChecked(`no assertion line came back from the slice (${DB}) — psql answered ${out.length} byte(s), `
      + 'none of them the qc aggregate, so the slice either never reached the server or ended before its last statement');
  }
  const [count, joined] = line.split('#');
  live = new Set((joined || '').split('\t').map((s) => s.trim()).filter(Boolean));
  if (Number(count) !== live.size) notChecked(`qc declares ${count} rows, names came back as ${live.size} — lossy read`);
} catch (e) { notChecked(`live assertion list unreadable: ${String(e?.message ?? String(e)).split('\n')[0]}`); }

if (!existsSync(REGISTRY)) notChecked(`registry file not found: ${REGISTRY}`);
const rows = readFileSync(REGISTRY, 'utf8').split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('\t'));

// A path witness has to be readable by someone who only has the repository. Three states, told apart, because
// the second one is the defect this machine has already been caught with once (D110).
const fileState = (witness) => {
  const abs = resolve(ROOT, witness);
  const rel = relative(ROOT, abs);
  if (witness.startsWith('/') || /^[A-Za-z]:/.test(witness) || rel === '' || rel.startsWith('..')) {
    return { ok: false, why: 'names a path outside the repository' };
  }
  let type = null;
  try { type = execFileSync('git', ['cat-file', '-t', `HEAD:${witness}`], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { /* not tracked at HEAD */ }
  if (type === 'blob') return { ok: true, kind: 'file' };
  if (type) return { ok: false, why: `is tracked at HEAD as a ${type}, not a file` };
  if (existsSync(abs)) return { ok: false, why: 'exists in the working copy but is not tracked at HEAD' };
  return { ok: false, why: 'is nowhere — neither in the repository nor at HEAD' };
};

const bad = [];
const keys = new Set();
const kinds = { commit: 0, file: 0 };
for (const r of rows) {
  const [check, unit, arm, witness] = r;
  if (r.length !== 4 || !check || !unit || !arm || !witness) { bad.push(`row is not check/unit/arm/witness: ${JSON.stringify(r)}`); continue; }
  if (!live.has(check)) bad.push(`not an assertion the gate files: ${check}`);
  const k = `${check}|${arm}`;
  if (keys.has(k)) bad.push(`duplicated (check, arm): ${k}`);
  keys.add(k);
  if (/^[0-9a-f]{7,40}$/.test(witness)) {
    try { execFileSync('git', ['cat-file', '-e', `${witness}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT }); kinds.commit++; }
    catch { bad.push(`witness is not a commit that exists (${witness}) for ${check}`); }
    continue;
  }
  const st = fileState(witness);
  if (st.ok) kinds.file++;
  else bad.push(`witness cannot be opened (${witness}: ${st.why}) for ${check}`);
}

for (const b of bad) console.error(`  registry problem: ${b}`);
const covered = new Set(rows.map((r) => r[0]).filter((c) => live.has(c)));
console.log(`  gate assertions   ${live.size}`);
console.log(`  registry read     ${relative(ROOT, REGISTRY).split('\\').join('/')} (${rows.length} rows)`);
console.log(`  registry rows     ${rows.length} (check, arm) pairs witnessed`);
console.log(`  witness kinds     ${kinds.commit} commit(s) · ${kinds.file} file(s) tracked at HEAD`
  + ' — nothing outside the repository counts, which is what makes the count reproducible');
console.log(`  assertions with a machine-checkable witness: ${covered.size} of ${live.size}`
  + ` (${(100 * covered.size / live.size).toFixed(1)}%) — grammar: a registry row naming the check,`
  + ' an arm that reddened it, and an artifact that is in the repository and still opens');

// A percentage is not actionable: a gap is only work once you can name what is missing. Printed every run
// and not behind a flag, because 90.7% was already the number this line printed while twenty assertions
// were unaccounted for — a total that cannot say which lines are missing is a green hiding its own list.
const gaps = [...live].filter((n) => !covered.has(n)).sort((a, b) => a.localeCompare(b));
if (gaps.length) {
  console.log(`  no witness yet     ${gaps.length} assertion(s) — named, not counted:`);
  for (const g of gaps) console.log(`      · ${g}`);
}
if (bad.length) { console.log('\nRESULT: FAIL — the registry is inconsistent with the gate'); process.exit(1); }
console.log('\nRESULT: PASS — every registry row names a live assertion, an arm, and an openable witness');
