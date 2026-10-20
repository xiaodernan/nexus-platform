#!/usr/bin/env node
/**
 * NEXUS — `scripts/check_line_cite_drift.mjs`, asked whether it can still see.
 *
 * The reader judges one property, so every arm changes exactly that property and nothing else: the text sitting
 * on the line a committed ledger citation named, between the commit that wrote the citation and HEAD. Each arm
 * builds a throwaway git repository under `.scratch/`, commits a code file and a one-line ledger that cites it,
 * then makes one further commit, and predicts the full verdict vector AND the exit codes before the run.
 *
 * Why the arms live in a temp repo instead of the shared working copy: an arm that edits `scripts/*.mjs` in a
 * tree another lane is committing from has burned this arc before, and this reader's inputs are two refs, so a
 * repository of its own is all it needs. The shipped file is the thing under test — same process, aimed by
 * `--repo`, never a reimplementation.
 *
 * The verdict vocabulary is DERIVED from the reader's bytes (D196): the harness reads the reader's own `counts`
 * declaration, so a class renamed or added in the reader cannot be silently unparsed here. `--reaim` is asserted
 * as an arm too (D202): its rows are the list a lane applies to clear MOVED, so they are matched field by field
 * rather than counted.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const READER = join(REPO, 'scripts', 'check_line_cite_drift.mjs');
const SCRATCH = join(REPO, '.scratch', 'd201_arms');

const readerSrc = readFileSync(READER, 'utf8');
const decl = /const counts = \{([^}]*)\}/.exec(readerSrc);
if (!decl) throw new Error('the reader has no `const counts = {...}` declaration, so its verdict vocabulary is not derivable here');
const CLASSES = decl[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split(':')[0].replace(/['"]/g, '').trim());
if (!CLASSES.includes('EXACT') || CLASSES.length < 4) throw new Error(`derived verdict classes look wrong: ${CLASSES.join(', ')}`);

// Every arm below is a real throwaway repository, so a machine that cannot start git is not a machine this
// harness can run on at all — and it used to say that by dying: an uncaught `spawnSync git EBUSY` with no
// RESULT line, which reads like a harness that failed rather than an environment that cannot host it.
// Measured 2026-10-03: exit 1, no RESULT line, and five more tools in scripts/ with the same shape.
const g = (dir, ...a) => {
  try {
    return execFileSync('git', ['-c', 'user.name=D201 Arm', '-c', 'user.email=arm@nexus.local', ...a], { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir, encoding: 'utf8' });
  } catch (err) {
    const reason = err.status == null && err.code ? String(err.code)
      : `git exited ${err.status} on [git ${a.join(' ')}] in ${dir}: ${String(err.stderr || '').trim().slice(0, 200)}`;
    console.log(`RESULT: NOT CHECKED — this harness drives real throwaway repositories, and git could not be started: ${reason}.`);
    console.log('  No arm below was run. A refusal is not a failure, and the two must not share a verdict line.');
    process.exit(2);
  }
};

function makeRepo(name, first, later) {
  // A fixture that already exists is not a fixture this harness may reuse. `git init` on the leftover
  // repository leaves its commits in place, `git add -A` finds nothing new, and `git commit` answers 1 with
  // *nothing to commit* — which the guard below then reports as "git could not be started", pointing at git
  // rather than at a fixture that survived an interrupted run. Measured after a killed run left `.git` behind.
  //
  // So an occupied name takes a suffix instead of being cleared. The first version cleared it first and then
  // took the suffix, which was pure cost: clearing a stale fixture costs about 0.4 s per file through this
  // host's delete shim, and the answer was already decided by whether the path existed. That version ran
  // fifteen minutes without printing a line and was killed by a timeout. A fresh path needs no clearing —
  // which is what `existsSync` is here to establish, not to warn about.
  const dir = existsSync(join(SCRATCH, name))
    ? join(SCRATCH, `${name}-${process.pid}`)
    : join(SCRATCH, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  g(dir, 'init', '-q');
  for (const [p, text] of Object.entries(first)) writeFileSync(join(dir, p), text.join('\n') + '\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'base');
  if (later) {
    for (const [p, text] of Object.entries(later)) writeFileSync(join(dir, p), text.join('\n') + '\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'mutate');
  }
  return dir;
}

function run(dir, extra) {
  const r = spawnSync(process.execPath, [READER, '--repo', dir, '--ledgers', 'L.md', ...extra], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const out = r.stdout ?? '';
  const counts = {};
  if (!/^verdict /m.test(out)) {
    // A flag refusal happens before the census runs, so there are no verdict lines to assert — but that is only
    // a legitimate shape when the reader itself said NOT CHECKED and stopped the run.
    if (r.status === 2 && /RESULT: NOT CHECKED/.test(out)) return { refusal: true, counts, judged: -1, verdict: 'NOT CHECKED', rc: r.status, out, rows: [] };
    throw new Error(`the reader printed no \`verdict EXACT: N\` line and no pre-census refusal (rc ${r.status}):\n${out}${r.stderr}`);
  }
  for (const c of CLASSES) {
    const hit = new RegExp(`^verdict ${c}: (\\d+)$`, 'm').exec(out);
    if (!hit) throw new Error(`the reader prints no \`verdict ${c}: N\` line, so this harness cannot assert it (D196: a class the harness has no sentence for must stop the run)`);
    counts[c] = Number(hit[1]);
  }
  const judged = /^judged by content: (\d+)$/m.exec(out);
  const frames = /^quoted error frames skipped \(file:LINE:COL\): (\d+)$/m.exec(out);
  if (!frames) throw new Error('the reader prints no `quoted error frames skipped` line, so this harness cannot assert the skip count');
  const result = /RESULT: (\w+)/.exec(out);
  if (!result) throw new Error(`the reader printed no RESULT line (rc ${r.status}):\n${out}${r.stderr}`);
  return { counts, frames: Number(frames[1]), judged: judged ? Number(judged[1]) : -1, verdict: result[1], rc: r.status, out, rows: out.split('\n').filter((l) => l.startsWith('reaim\t')) };
}

const A_LINES = ['line one', 'line two', 'THE TARGET LINE', 'line four'];
const cases = [];
const arm = (name, want, got, note) => cases.push({ name, want, got, note });
/** The whole vector, always: a class the arm does not aim at must be asserted at zero too. */
const vec = (a) => `${CLASSES.map((c) => `${c} ${a.counts[c]}`).join(' · ')} · judged ${a.judged} · rc ${a.rc}`;
const want = (cls, n, judged = 1, rc = 0) => `${CLASSES.map((c) => `${c} ${c === cls ? n : 0}`).join(' · ')} · judged ${judged} · rc ${rc}`;
/** A substring claim about the reader's own output, spelled so that a missing half is a MISMATCH line and not a
 *  silent pass — the two NOT-UNIQUE reasons are one class, and one arm each is what keeps both branches alive. */
const has = (a, s) => (a.out.includes(s) ? 'has' : 'MISSING');

// 1 CONTROL — nothing moved. Every other arm is this plane plus one commit, so a mismatch here invalidates them.
{
  const dir = makeRepo('control', { 'src/a.mjs': A_LINES, 'L.md': ['the target is src/a.mjs:3'] });
  const a = run(dir, []);
  const s = run(dir, ['--strict', 'MOVED']);
  arm('control: unmutated plane', `${want('EXACT', 1)} · strict-MOVED PASS rc 0`,
    `${vec(a)} · strict-MOVED ${s.verdict} rc ${s.rc}`,
    'the base plane is asserted, not assumed');
}
// 2 MOVED — one line inserted above the target. The text survives; the number is stale.
{
  const dir = makeRepo('moved', { 'src/a.mjs': A_LINES, 'L.md': ['the target is src/a.mjs:3'] },
    { 'src/a.mjs': ['line one', 'line two', 'AN INSERTION', 'THE TARGET LINE', 'line four'] });
  const a = run(dir, []);
  const s = run(dir, ['--strict', 'MOVED']);
  const g2 = run(dir, ['--strict', 'GONE']);
  arm('MOVED: insertion above the target', `${want('MOVED', 1)} · strict-MOVED FAIL rc 1 · strict-GONE PASS rc 0`,
    `${vec(a)} · strict-MOVED ${s.verdict} rc ${s.rc} · strict-GONE ${g2.verdict} rc ${g2.rc}`,
    'the two strict classes are separate: a stale number must not read as a rewritten target');
}
// 3 GONE — the target's own text rewritten. The number is unchanged; the code the cite named is not there.
{
  const dir = makeRepo('gone', { 'src/a.mjs': A_LINES, 'L.md': ['the target is src/a.mjs:3'] },
    { 'src/a.mjs': ['line one', 'line two', 'THE TARGET LINE, SINCE REWORDED', 'line four'] });
  const a = run(dir, []);
  const s = run(dir, ['--strict', 'GONE']);
  arm('GONE: the target reworded', `${want('GONE', 1)} · strict-GONE FAIL rc 1`,
    `${vec(a)} · strict-GONE ${s.verdict} rc ${s.rc}`,
    'this is also where a reworded COMMENT lands, which is why GONE is a queue and not a default red');
}
// 4 NO-BASE — the citation was committed while the line it named was still uncommitted; the code landed later.
{
  const dir = makeRepo('nobase',
    { 'src/a.mjs': ['line one', 'line two', 'line three'], 'L.md': ['the target is src/a.mjs:5'] },
    { 'src/a.mjs': ['line one', 'line two', 'line three', 'line four', 'THE TARGET LINE', 'line six'] });
  const a = run(dir, []);
  arm('NO-BASE: cite predates the code it names', `${want('NO-BASE', 1)} · report REPORT rc 0`,
    `${vec(a)} · report ${a.verdict} rc ${a.rc}`,
    'the line did not exist at the commit that wrote the citing line, and exists at HEAD');
}
// 5 UNPATHED + the floor — a basename-only cite is counted, never judged, so nothing is judged and exit 2 is required.
{
  const dir = makeRepo('unpathed', { 'src/a.mjs': A_LINES, 'L.md': ['the target is a.mjs:3'] });
  const a = run(dir, []);
  arm('UNPATHED: basename-only cite', `${want('UNPATHED', 1, 0, 2)}`, vec(a),
    `the read-nothing floor must refuse this plane: ${a.out.split('\n').find((l) => l.startsWith('RESULT')) ?? '(no RESULT line)'}`);
}
// 6 NOT-AT-HEAD — a rooted path naming no file is step 8's class, named here and not rejudged.
{
  const dir = makeRepo('notheader', { 'src/a.mjs': A_LINES, 'L.md': ['see src/gone.mjs:2'] });
  const a = run(dir, []);
  arm('NOT-AT-HEAD: rooted path absent at HEAD', `${want('NOT-AT-HEAD', 1, 0, 2)}`, vec(a),
    `named, not rejudged: ${a.out.split('\n').find((l) => l.startsWith('RESULT')) ?? '(no RESULT line)'}`);
}
// 7 The flag seams — a strict class the reader does not emit, a flag it does not know, a comma-list it must
// accept, and `--reaim` carrying a verdict it cannot give. All four are refusals or acceptances decided before
// the census, so the shape asserted here is the exit code plus the RESULT word.
{
  const dir = makeRepo('flags', { 'src/a.mjs': A_LINES, 'L.md': ['the target is src/a.mjs:3'] });
  const bad = run(dir, ['--strict', 'BLANK']);
  const unknown = run(dir, ['--strictt', 'MOVED']);
  const combo = run(dir, ['--strict', 'MOVED,NOT-UNIQUE']);
  const conflict = run(dir, ['--reaim', '--strict', 'MOVED']);
  arm('refusals: unknown class, unknown flag, mode conflict, comma-list accepted',
    'rc 2 · rc 2 · comma PASS rc 0 · rc 2',
    `rc ${bad.rc} · rc ${unknown.rc} · comma ${combo.verdict} rc ${combo.rc} · rc ${conflict.rc}`,
    `${bad.out.trim().split('\n')[0]} | ${unknown.out.trim().split('\n')[0]} | ${conflict.out.trim().split('\n')[0]}`);
}

// 8 The plane guard — CI's default checkout is a depth-1 clone, where blame dates every line to the grafted
// commit. The same ledger and code, cloned two ways: the shallow plane must refuse, the full one must answer.
// The `--no-local` is load-bearing: `git clone --depth 1 <path>` silently IGNORES --depth (the local transport
// hard-links the objects), and the first version of this arm measured rc 0 on what it believed was a shallow
// plane. `--no-local` forces the upload-pack path, where depth is honored and `.git/shallow` is written.
{
  const src = makeRepo('deep', { 'src/a.mjs': A_LINES, 'L.md': ['the target is src/a.mjs:3'] });
  // Clone targets get unique names for the same reason `makeRepo` does: clearing a stale tree costs about
  // 0.4 s per file here, and `git clone` refuses a destination that exists at all — measured as
  // `fatal: destination path '…\full' already exists and is not an empty directory`. A name nobody has
  // used needs no clearing and cannot collide.
  const dst = join(SCRATCH, `shallow-${process.pid}`);
  execFileSync('git', ['clone', '-q', '--no-local', '--depth', '1', src, dst], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const shallowFlag = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: dst, encoding: 'utf8' }).trim();
  if (shallowFlag !== 'true') throw new Error(`the arm's own plane is not shallow (${shallowFlag}), so this arm would test nothing`);
  const full = join(SCRATCH, `full-${process.pid}`);
  execFileSync('git', ['clone', '-q', src, full], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const a = run(dst, []);
  const b = run(full, []);
  arm('shallow plane refuses, full plane answers', 'shallow rc 2 · full rc 0', `shallow rc ${a.rc} · full rc ${b.rc}`,
    `the shallow clone would otherwise have printed \`${vec(a)}\` — a confident verdict on a plane it cannot date: ${a.out.split('\n').find((l) => l.startsWith('RESULT')) ?? '(no RESULT line)'}`);
}

// 9 NOT-UNIQUE by duplication — the text the cite pointed at survives, but HEAD holds it twice, so naming one
// occurrence would be the reader guessing which one the sentence meant. MOVED must stay empty for this shape:
// a stale-but-aimable number and an unaimable one are different work for the lane that has to fix them.
{
  const dir = makeRepo('dup', { 'src/a.mjs': ['line one', 'DUP TEXT', 'line three'], 'L.md': ['the target is src/a.mjs:2'] },
    { 'src/a.mjs': ['INSERT', 'line one', 'DUP TEXT', 'line three', 'DUP TEXT'] });
  const a = run(dir, []);
  const s = run(dir, ['--strict', 'NOT-UNIQUE']);
  const m = run(dir, ['--strict', 'MOVED']);
  arm('NOT-UNIQUE: two lines at HEAD hold the text', `${want('NOT-UNIQUE', 1)} · strict-NOT-UNIQUE FAIL rc 1 · strict-MOVED PASS rc 0 · dup-reason has`,
    `${vec(a)} · strict-NOT-UNIQUE ${s.verdict} rc ${s.rc} · strict-MOVED ${m.verdict} rc ${m.rc} · dup-reason ${has(a, '2 lines at HEAD hold it (3, 5)')}`,
    `the reason row: ${a.out.split('\n').find((l) => l.trim().startsWith('L.md:1 ->')) ?? '(none)'}`);
}
// 10 NOT-UNIQUE by blankness — the citation named a line that was EMPTY in the commit that wrote it, so the
// number never pointed at text and no later move can make it do so. This is the second reason branch, and an
// arm for it exists because a class with two reasons and one tested half is still a half-vacuous class.
{
  const dir = makeRepo('blank', { 'src/a.mjs': ['line one', '', 'line three'], 'L.md': ['the target is src/a.mjs:2'] },
    { 'src/a.mjs': ['INSERT', 'line one', '', 'line three'] });
  const a = run(dir, []);
  arm('NOT-UNIQUE: the cited line was blank when written', `${want('NOT-UNIQUE', 1)} · blank-reason has`,
    `${vec(a)} · blank-reason ${has(a, 'named a blank line when it was written')}`,
    `the reason row: ${a.out.split('\n').find((l) => l.trim().startsWith('L.md:1 ->')) ?? '(none)'}`);
}
// 11 --reaim — the list a lane applies. Its numbers are derived by the same census that files the verdicts, it
// carries one row per MOVED citation, and the `--limit` that trims the printed detail rows must not trim it: a
// capped list would let a lane re-aim twelve citations and believe it had cleared twenty-four.
{
  const dir = makeRepo('reaim',
    { 'src/a.mjs': ['ONE', 'TWO', 'THREE', 'FOUR'], 'L.md': ['first src/a.mjs:2', 'second src/a.mjs:3', 'third src/a.mjs:4'] },
    { 'src/a.mjs': ['INS', 'ONE', 'TWO', 'THREE', 'FOUR'] });
  const a = run(dir, []);
  const b = run(dir, ['--reaim']);
  const c = run(dir, ['--reaim', '--limit', '1']);
  arm('--reaim prints every derived number, uncapped',
    `${want('MOVED', 3, 3)} · reaim|L.md:1|src/a.mjs|2|3 / reaim|L.md:2|src/a.mjs|3|4 / reaim|L.md:3|src/a.mjs|4|5 · REAIM rc 0 · --limit 1 still 3`,
    `${vec(a)} · ${b.rows.map((x) => x.replace(/\t/g, '|')).join(' / ')} · ${b.verdict} rc ${b.rc} · --limit 1 still ${c.rows.length}`,
    `the RESULT line: ${b.out.split('\n').find((l) => l.startsWith('RESULT')) ?? '(none)'}`);
}

// 12 The quoted-frame skip — `file:LINE:COL` is how a runtime spells where it crashed, so a ledger quoting a
// stack frame is not claiming anything about today's line numbers. Two planes: one built only of frames must
// refuse with the frame sentence rather than report a clean census, and a frame sharing a plane with a real
// citation must not take the real citation's judgement with it.
{
  const later = { 'src/a.mjs': ['INS', 'line one', 'line two', 'THE TARGET LINE', 'line four'] };
  const only = makeRepo('frames_only', { 'src/a.mjs': A_LINES, 'L.md': ['at ledgerText (src/a.mjs:3:12)'] }, later);
  const mixed = makeRepo('frames_mixed', { 'src/a.mjs': A_LINES, 'L.md': ['at ledgerText (src/a.mjs:3:12)', 'the target is src/a.mjs:3'] }, later);
  const a = run(only, []);
  const b = run(mixed, []);
  arm('quoted error frames: skipped, counted, and not a hiding place',
    `frames-only ${want('EXACT', 0, 0, 2)} · frames 1 · sentence has || mixed ${want('MOVED', 1)} · frames 1`,
    `frames-only ${vec(a)} · frames ${a.frames} · sentence ${has(a, 'quoted error frame (file:LINE:COL)')} || mixed ${vec(b)} · frames ${b.frames}`,
    `the frames-only refusal reads: ${a.out.split('\n').find((l) => l.startsWith('RESULT')) ?? '(no RESULT line)'}`);
}

let matched = 0;for (const c of cases) {
  const hit = c.got === c.want;
  matched += hit ? 1 : 0;
  console.log(`${hit ? 'MATCHED ' : 'MISMATCH'} ${c.name}\n      predicted: ${c.want}\n      measured : ${c.got}\n      ${c.note}`);
}
console.log(`\narms: ${matched}/${cases.length} MATCHED · vocabulary derived from the reader: ${CLASSES.join(', ')}`);
if (matched !== cases.length) { console.log('RESULT: FAIL — a prediction did not hold, so the reader is not the reader this file describes'); process.exit(1); }
console.log(`RESULT: PASS — ${matched}/${cases.length} arms, each a one-property change on a repository of its own`);
