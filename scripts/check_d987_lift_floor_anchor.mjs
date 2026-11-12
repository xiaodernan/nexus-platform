#!/usr/bin/env node
/**
 * NEXUS D987 — the stated-preference LIFT floors must be anchored to a MEASURED plane, not a
 * stale comment, while staying far enough above random exchange to catch a silent lane.
 *
 * THE HOLE (CI run 43212889312, the first full `ai` job the D980–D986 batch ever ran): the
 * concurrent D981 fold re-aimed 18 NLU/ranking probes onto the D705 relevance change but left
 * `apps/ai/tests/test_the_stated_preference_moves_the_ranking_of_the_live_plane.py` pinned to a
 * 2026-10-30 measurement table (`hybrid_v1+postgres+vector`). On the CI `--now`-anchored plane
 * (2026-11-12, `hybrid_v1+postgres` — no vector leg, hashing chunks) five of six lifts moved:
 * pet 4.04→5.94, outdoor 3.50→2.30, parking 2.89→3.35, mtr 3.01→3.35. The `有戶外座位的餐廳`
 * floor of 2.5 reddened CI at a measured 2.30 — even though top10 share 0.50 against a 0.22
 * population base is a plain 2.3x lift, i.e. the preference lane was plainly NOT silent.
 *
 * THE FIX (one test file, anchored to two measured planes): the docstring now records BOTH
 * anchors side by side (so a third anchor sees the drift instead of silently inheriting a stale
 * table); the outdoor floor drops 2.5→2.0 — still 2x the random-exchange baseline (lift 1.0 =
 * the lane stopped handing `intent_preferences` in, the regression THIS door exists to catch),
 * so a genuinely silent lane still reddens it, while the anchor-driven 0.2 shake is absorbed.
 * All other floors already hold on both measured planes (quiet 2.32, pet 5.94, parking 3.35,
 * mtr 3.35) and are untouched. The `date_occasion` case stays VACUOUS (corpus constant).
 *
 * WHAT THIS reader HOLDS: the outdoor floor is exactly 2.0 (not re-pinned to the stale 2.5, not
 * lowered under the sensitivity line); EVERY working floor stays >= 1.8 (comfortably above 1.0);
 * the two-anchor measurement table is present with the four moved values cited honestly; the
 * falsifier assertion still compares lift against `>= WORKING[query]` (never weakened to `> 0`
 * or a constant); the vacuous case is still declared; and CI / ATLAS / ledger wiring is intact.
 * A jsdom-free, DB-free SOURCE gate — the DB-plane lift values themselves are measured by the
 * pytest door on a seeded plane, not re-run here.
 *
 * SELF-TEST: --self-test plants corruptions in memory — restore the stale 2.5 floor, drop the
 * outdoor floor under the 1.8 line, delete a moved measurement value, weaken the `>=` falsifier,
 * undeclare the vacuous case, cut CI/ATLAS/ledger wiring — and requires EACH to redden for its
 * RIGHT expect tag while the real plane holds. D954 no-op guard, D959 line-anchored `## 987.`
 * heading, and a GREEN control (a legitimate comment edit) keep the judge honest.
 *
 * Usage:  node scripts/check_d987_lift_floor_anchor.mjs [--self-test] [--report] [--ci=<path>]
 * Exit:   0 every claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const CI_OVERRIDE = argv.find((a) => a.startsWith('--ci='))?.slice('--ci='.length);

const PROBE = 'apps/ai/tests/test_the_stated_preference_moves_the_ranking_of_the_live_plane.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d987_lift_floor_anchor.mjs';
const PATHS = [PROBE, CI, ATLAS, STATUS, SELF];

const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 987\. D987(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the lift-floor plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the outdoor floor is anchored to the measured CI plane, not the stale 2.5. */
  has(PROBE, '"有戶外座位的餐廳": 2.0,', 'the outdoor floor is 2.0 on the --now anchor', 'OUTDOOR-2.0');
  absent(PROBE, '"有戶外座位的餐廳": 2.5,', 'the stale 2.5 floor is gone', 'OUTDOOR-NO-STALE');

  /* 2 — every working floor stays comfortably above random exchange (1.0), so a silent lane
        still reddens the door; none was dropped under the sensitivity line. */
  for (const [needle, label] of [
    ['"安靜的咖啡店": 1.8,', 'quiet floor 1.8'],
    ['"可以帶寵物的餐廳": 2.5,', 'pet floor 2.5'],
    ['"有停車場的餐廳": 2.0,', 'parking floor 2.0'],
    ['"近地鐵站的餐廳": 2.0,', 'mtr floor 2.0'],
  ]) has(PROBE, needle, `${label} intact`, 'FLOOR-' + label.split(' ')[0].toUpperCase());
  const floors = [...t(PROBE).matchAll(/"[^\"]+": ([0-9]+\.[0-9]+),/g)].map((m) => Number(m[1]));
  const underLine = floors.filter((n) => n < 1.8);
  if (underLine.length) offenders.push(`MISSING — ${PROBE}: floors below the 1.8 sensitivity line (${underLine.join(', ')})${tag('FLOOR-SENSITIVITY')}`);
  else notes.push(`held every floor >= 1.8 (${floors.length} floors)`);

  /* 3 — the two-anchor measurement table is present and HONEST about what moved. */
  has(PROBE, '2026-10-30 lift', 'the old anchor column is declared', 'TABLE-OLD');
  has(PROBE, '2026-11-12 lift', 'the CI --now anchor column is declared', 'TABLE-NOW');
  for (const moved of ['5.94', '2.30', '3.35']) {
    has(PROBE, moved, `the moved measurement ${moved} is recorded`, 'TABLE-MOVED-' + moved.replace('.', ''));
  }

  /* 4 — the falsifier is not weakened: lift is still compared against the floor with >=. */
  has(PROBE, 'assert got["lift"] >= WORKING[query],', 'the lift>=floor falsifier is intact', 'FALSIFIER');
  has(PROBE, 'VACUOUS = "適合情侶約會的地方"', 'the vacuous corpus-constant case stays declared', 'VACUOUS');
  has(PROBE, 'random exchange is 1.0', 'the 2x-random sensitivity rationale is stated', 'SENSITIVITY-RATIONALE');

  /* 5 — wiring: CI runs this reader; ATLAS lists it; ledger line-anchored. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the anchored probe', 'ATLAS-PROBE');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 987. D987\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D987 heading line');

  return { offenders, notes, unchecked: null, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');
const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  f.set(p, text.split(from).join(to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const ciPath = CI_OVERRIDE ?? CI;
  const base = judge(real, present, ciPath);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['stale 2.5 outdoor floor restored', mutate(real, PROBE, '"有戶外座位的餐廳": 2.0,', '"有戶外座位的餐廳": 2.5,'), 'OUTDOOR-2.0'],
    ['outdoor floor dropped under sensitivity', mutate(real, PROBE, '"有戶外座位的餐廳": 2.0,', '"有戶外座位的餐廳": 1.2,'), 'FLOOR-SENSITIVITY'],
    ['quiet floor weakened', mutate(real, PROBE, '"安靜的咖啡店": 1.8,', '"安靜的咖啡店": 1.1,'), 'FLOOR-SENSITIVITY'],
    ['parking floor erased', mutate(real, PROBE, '"有停車場的餐廳": 2.0,', '"有停車場的餐廳": 0.5,'), 'FLOOR-SENSITIVITY'],
    ['old-anchor column removed', mutate(real, PROBE, '2026-10-30 lift', 'OLD lift'), 'TABLE-OLD'],
    ['new-anchor column removed', mutate(real, PROBE, '2026-11-12 lift', 'NEW lift'), 'TABLE-NOW'],
    ['moved pet measurement falsified', mutate(real, PROBE, '5.94', '4.04'), 'TABLE-MOVED-594'],
    ['falsifier weakened to >0', mutate(real, PROBE, 'assert got["lift"] >= WORKING[query],', 'assert got["lift"] > 0,'), 'FALSIFIER'],
    ['vacuous case undeclared', mutate(real, PROBE, 'VACUOUS = "適合情侶約會的地方"', 'VACUOUS = "none"'), 'VACUOUS'],
    ['sensitivity rationale removed', mutate(real, PROBE, 'random exchange is 1.0', 'random exchange is neutral'), 'SENSITIVITY-RATIONALE'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, 'node scripts/_absent.mjs --self-test'), 'CI-READER'],
    ['ATLAS reader row erased', mutate(real, ATLAS, `\`${SELF}\``, '`scripts/_removed.mjs`'), 'ATLAS-READER'],
    ['ATLAS probe row erased', mutate(real, ATLAS, PROBE, 'apps/ai/tests/_removed.py'), 'ATLAS-PROBE'],
    ['ledger D987 heading removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [label, arm, tagName] of arms) {
    const expect = arm.expect ?? tagName;
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(46)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) { console.log(`  self-test  ${label.padEnd(46)} NO-OP (defect!)`); allCaught = false; continue; }
    const out = judge(arm.files, arm.present ?? present, ciPath);
    const red = out.offenders.length > 0 || out.unchecked;
    const rightReason = out.offenders.some((o) => o.includes(expect));
    const pass = red && rightReason;
    console.log(`  self-test  ${label.padEnd(46)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expect}"`);
    if (!pass) { allCaught = false; for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o); }
  }
  // GREEN control: a legitimate comment rewording must NOT redden (guards an overfit judge).
  {
    const f = new Map(real);
    f.set(PROBE, (f.get(PROBE) ?? '').replace(
        'the anchor-driven 0.2 shake is absorbed',
        'the corpus-anchor variability is absorbed'));
    const out = judge(f, present, ciPath);
    const controlGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate comment rewording stays GREEN'.padEnd(46)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!controlGreen) allCaught = false;
  }
  // Real plane still holds.
  {
    const out = judge(real, present, ciPath);
    const realGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate plane stays GREEN'.padEnd(46)} green offenders=${out.offenders.length}`);
    if (!realGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  console.log(`  self-test  all arms redden for cause + guards green: ${allCaught} (${arms.length} corruption arms)`);
  process.exit(allCaught ? 0 : 1);
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk();
const result = judge(files, present, ciPath);
if (result.unchecked) { console.log('RESULT: NOT CHECKED — ' + result.unchecked); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log('  ' + n);
if (result.offenders.length) {
  console.log(`FALSE LIFT-FLOOR (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D987 lift floors anchored to measured planes, ${result.notes.length} holds`);
