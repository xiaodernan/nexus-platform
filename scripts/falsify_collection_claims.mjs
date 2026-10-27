#!/usr/bin/env node
/**
 * NEXUS D576 -- both sides of scripts/check_collection_claims.mjs, shown rather than asserted.
 *
 * A validator whose first run is also its first test has not been tested, so every arm below states the
 * verdict it expects BEFORE the shipped reader is called, and the harness exits non-zero if a prediction
 * misses. The arms come in pairs: each "the reader must catch this" arm has a "the reader must NOT catch
 * this" twin that differs in exactly one property, so neither can pass by luck.
 *
 * THE PLANE. The reader reads GENERATED ROWS, so the harness generates them: it runs the shipped
 * `data/seed/generate.py` into a directory under the system temp dir, once, and every arm then gets its
 * own copy of the seven row files the reader reads. The repository's own `data/seed/out` is never the
 * fixture -- it is one shared generated directory (a residue this repository already carries), and an arm
 * that ran against it would be reading whatever the last generation left behind.
 *
 * THE ARMS, AND WHAT EACH PAIR IS ABOUT.
 *
 *   THE DEFECT          a copy whose number, kinds, stages or membership no longer match its own rows is
 *                       caught -- and the same copy with nothing changed is not, because the shipped rows
 *                       already agree with it.
 *
 *   THE WORDS           a title that stops carrying the word its claim needs is caught -- and a title that
 *                       still carries it is not.
 *
 *   THE UNDECLARED      a collection the vocabulary does not declare is caught (its copy is a copy nobody
 *                       checks), and a collection the vocabulary declares but the seed does not ship is
 *                       caught too (its claims are claims about nothing).
 *
 *   THE REFUSALS        a rows file that is absent, a vocabulary that declares a check this reader does not
 *                       implement, an unknown flag, and a flag given twice are all refusals (exit 2), not
 *                       verdicts -- "did not run" and "found nothing" are different answers.
 *
 * Every arm gets its own copy of the rows, so no arm can borrow another arm's redness. Every mutation
 * asserts that the text it rewrites is present in the copy, so an arm cannot pass by silently running an
 * unmutated plane -- the failure mode D110 named.
 *
 * Usage: node scripts/falsify_collection_claims.mjs
 * Exit:  0 every prediction held; 1 an arm missed (the reader cannot do what its docblock says)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSpawnFailure, safeRemove, spawnReason } from './spawn_guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_collection_claims.mjs');
const GENERATOR = join(ROOT, 'data', 'seed', 'generate.py');
const VOCAB = join(ROOT, 'data', 'seed', 'claim_vocabulary.json');
// D575 -- the fixture root carries this process's PID. The house convention is one fixed root per
// falsifier, which is what the sibling harnesses do -- but a fixed root means two runs of THIS harness
// share one tree, and the second run's `safeRemove` deletes the first run's fixtures mid-arm. A
// per-process root makes the arms independent of when they are run.
const FIX = join(tmpdir(), `nexus-d576-falsify-${process.pid}`);
const SEED = join(FIX, 'seed');

/** The seven row files the reader reads. Nothing else is copied: the fixture is what the reader reads. */
const ROWS = [
  '22_collections.csv', '06_merchants.csv', '09_locations.csv', '05_categories.csv',
  '11_merchant_categories.csv', '15_availability_slots.csv', '04_user_preferences.csv',
];

if (!existsSync(GENERATOR) || !existsSync(VOCAB)) {
  console.log('RESULT: NOT CHECKED — the seed generator or the claim vocabulary is absent, so no plane can be '
    + 'generated and no arm was run.');
  process.exit(2);
}

let vocab;
try {
  vocab = JSON.parse(readFileSync(VOCAB, 'utf8'));
} catch (e) {
  console.log(`RESULT: NOT CHECKED — the claim vocabulary is unreadable (${e.code ?? e.message}), so no arm was run.`);
  process.exit(2);
}
const DISCLAIMER = vocab.disclaimer;

/* ---------------------------------------------------------------- the plane */

safeRemove(FIX);  // batched: a bulk `rmSync` of >50 files is refused by this host's delete shim
mkdirSync(SEED, { recursive: true });

/**
 * Generate the rows the arms mutate.
 *
 * The `ci` preset is used because it is the plane CI generates: an arm that reddens here is an arm that
 * reddens on the runner. `PYTHONDONTWRITEBYTECODE=1` is set because a stale `.pyc` (same size, same second)
 * is a real failure mode on this host, and an arm that ran yesterday's generator would be an arm that tested
 * nothing.
 */
const PYTHON = process.env.PYTHON || 'python';
try {
  execFileSync(PYTHON, [GENERATOR, '--counts', 'ci', '--out', SEED, '--no-images'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
} catch (e) {
  if (isSpawnFailure(e)) {
    console.log(`RESULT: NOT CHECKED — the generator could not be started (${spawnReason(e)}), so no arm was run.`);
    process.exit(2);
  }
  console.log(`RESULT: NOT CHECKED — the generator failed (${spawnReason(e)}):`);
  console.log(String(e.stdout ?? '').split('\n').slice(-8).join('\n'));
  console.log(String(e.stderr ?? '').split('\n').slice(-8).join('\n'));
  process.exit(2);
}
for (const file of ROWS) {
  if (!existsSync(join(SEED, file))) {
    console.log(`RESULT: NOT CHECKED — the generated plane holds no ${file}, so the reader has nothing to read.`);
    process.exit(2);
  }
}

/** One fixture plane per arm: the seven row files and the vocabulary, under the system temp directory. */
function fixture(slug) {
  const dir = join(FIX, slug.replace(/[^\w]+/g, '_').slice(0, 40));
  mkdirSync(join(dir, 'out'), { recursive: true });
  for (const f of ROWS) copyFileSync(join(SEED, f), join(dir, 'out', f));
  copyFileSync(VOCAB, join(dir, 'claim_vocabulary.json'));
  return dir;
}

/* ---------------------------------------------------------------- the mutations */

const readRows = (d, file) => readFileSync(join(d, 'out', file), 'utf8');
const writeRows = (d, file, text) => writeFileSync(join(d, 'out', file), text, 'utf8');

/** The lines of the collections file, one CSV row per line. */
const collectionLines = (d) => readRows(d, '22_collections.csv').split('\n');

/** The index of the one row that holds this slug; refuse when the row is not there. */
function rowIndex(lines, slug) {
  const i = lines.findIndex((l) => l.includes(`,${slug},`));
  if (i < 0) throw new Error(`the fixture holds no collection row for ${slug}`);
  return i;
}

/** The first merchant id a row cites. */
function firstSubjectId(line) {
  const m = /"subject_id"":""([0-9a-f-]{36})""/.exec(line);
  if (!m) throw new Error('the fixture row cites no merchant id');
  return m[1];
}

// The copy's stop count, edited by one.
const plantCountDrift = (d) => {
  const lines = collectionLines(d);
  const i = rowIndex(lines, 'sha-tin-date-night');
  const m = /全線共(\d+)個站。/.exec(lines[i]);
  if (!m) throw new Error('the guide row holds no count sentence');
  lines[i] = lines[i].replace(m[0], () => `全線共${Number(m[1]) + 1}個站。`);
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// A member of the Tai Wai list replaced with one from the Sha Tin list.
const plantForeignMember = (d) => {
  const lines = collectionLines(d);
  const guide = lines[rowIndex(lines, 'sha-tin-date-night')];
  const tai = rowIndex(lines, 'tai-wai-under-100');
  const from = firstSubjectId(tai ? lines[tai] : '');
  const to = firstSubjectId(guide);
  lines[tai] = lines[tai].replace(from, () => to);
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// The title stops carrying the word its price claim needs.
const plantTitlePriceWord = (d) => {
  const lines = collectionLines(d);
  const i = rowIndex(lines, 'tai-wai-under-100');
  if (!lines[i].includes('HK$100')) throw new Error('the Tai Wai row holds no price word');
  lines[i] = lines[i].replace('HK$100', () => '100');
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// The copy stops ending with the declared disclaimer.
const plantDisclaimerDropped = (d) => {
  const lines = collectionLines(d);
  const i = rowIndex(lines, 'sha-tin-date-night');
  const needle = `。 ${DISCLAIMER},`;
  if (!lines[i].includes(needle)) throw new Error('the guide row holds no disclaimer');
  lines[i] = lines[i].replace(needle, () => '。,');
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// A collection no claim declares.
const plantUndeclaredCollection = (d) => {
  const lines = collectionLines(d);
  const guide = lines[rowIndex(lines, 'sha-tin-date-night')];
  const id = firstSubjectId(guide);
  const items = `[{"subject_type":"merchant","subject_id":"${id}","note":"Sha Tin · $"}]`;
  const row = [
    '11111111-2222-3333-4444-555555555555',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-00000000d001',
    'collection',
    'undeclared-collection',
    'Undeclared Collection',
    '未聲明清單',
    `全部成員都喺沙田區。 ${DISCLAIMER}`,
    '/demo/img/restaurant.svg',
    `"${items.replace(/"/g, '""')}"`,
    'public',
    'demo',
    '"{}"',
    '2026-09-01 11:00:00+08',
    '2026-08-23 11:00:00+08',
    '2026-09-22 11:00:00+08',
  ].join(',');
  lines.push(row);
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// A collection the vocabulary declares, and the seed does not ship.
const plantMissingCollection = (d) => {
  const lines = collectionLines(d);
  const i = rowIndex(lines, 'quiet-meals-near-me');
  lines.splice(i, 1);
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// The itinerary names a stage no member offers.
const plantUnknownStage = (d) => {
  const lines = collectionLines(d);
  const i = rowIndex(lines, 'weekend-family-sha-tin');
  const m = /由([^。]+)組成嘅示範一日行程。/.exec(lines[i]);
  if (!m) throw new Error('the itinerary row holds no stage sentence');
  lines[i] = lines[i].replace(m[0], () => `由${m[1]}、下午茶組成嘅示範一日行程。`);
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// The copy names a kind no member is.
const plantExtraKind = (d) => {
  const lines = collectionLines(d);
  const i = rowIndex(lines, 'quiet-meals-near-me');
  const m = /全部成員都係安靜嘅([^。]+)。/.exec(lines[i]);
  if (!m) throw new Error('the quiet-tables row holds no kinds sentence');
  lines[i] = lines[i].replace(m[0], () => `全部成員都係安靜嘅${m[1]}、酒吧。`);
  writeRows(d, '22_collections.csv', lines.join('\n'));
};

// The demo consumer's home district is no longer the one the title claims.
const plantConsumerHome = (d) => {
  const lines = readRows(d, '04_user_preferences.csv').split('\n');
  const i = lines.findIndex((l) => l.includes('home_district'));
  if (i < 0) throw new Error('the fixture holds no home_district preference');
  if (!lines[i].includes('Sha Tin')) throw new Error('the home_district preference names no Sha Tin');
  lines[i] = lines[i].replace('Sha Tin', () => 'Mong Kok');
  writeRows(d, '04_user_preferences.csv', lines.join('\n'));
};

// The vocabulary declares a check this reader does not implement.
const plantUnknownCheck = (d) => {
  const abs = join(d, 'claim_vocabulary.json');
  const parsed = JSON.parse(readFileSync(abs, 'utf8'));
  parsed.checks.weather_all = 'a check this reader does not implement';
  writeFileSync(abs, JSON.stringify(parsed, null, 2), 'utf8');
};

// A rows file the reader needs is absent.
const plantMissingRows = (d) => {
  const abs = join(d, 'out', '15_availability_slots.csv');
  if (!existsSync(abs)) throw new Error('the fixture holds no slots file to remove');
  unlinkSync(abs);
};

/* ---------------------------------------------------------------- the arms */

const ARMS = [
  {
    name: 'control: the generated plane as it stands',
    apply: () => {},
    expect: 0,
    must: [/RESULT: PASS/, /claims checked\s+[1-9]\d*/],
    absent: [/FAILURES/],
  },
  {
    name: "the copy's stop count edited by one",
    apply: plantCountDrift,
    expect: 1,
    must: [/RESULT: FAIL/, /claims \d+, but the list holds \d+ distinct member\(s\)/],
  },
  {
    name: 'a member of the Tai Wai list replaced with one from Sha Tin',
    apply: plantForeignMember,
    expect: 1,
    must: [/RESULT: FAIL/, /is not in Tai Wai, so the copy's claim/],
  },
  {
    name: 'the title stops carrying the word its price claim needs',
    apply: plantTitlePriceWord,
    expect: 1,
    must: [/RESULT: FAIL/, /does not carry them/],
  },
  {
    name: 'the copy stops ending with the declared disclaimer',
    apply: plantDisclaimerDropped,
    expect: 1,
    must: [/RESULT: FAIL/, /does not end with the declared disclaimer/],
  },
  {
    name: 'a collection no claim declares',
    apply: plantUndeclaredCollection,
    expect: 1,
    must: [/RESULT: FAIL/, /no claim in the vocabulary declares it/],
  },
  {
    name: 'a collection the vocabulary declares and the seed does not ship',
    apply: plantMissingCollection,
    expect: 1,
    must: [/RESULT: FAIL/, /the shipped plane carries no such collection/],
  },
  {
    name: 'the itinerary names a stage no member offers',
    apply: plantUnknownStage,
    expect: 1,
    must: [/RESULT: FAIL/, /the stage ".*", which the vocabulary does not declare/],
  },
  {
    name: 'the copy names a kind no member is',
    apply: plantExtraKind,
    expect: 1,
    must: [/RESULT: FAIL/, /named bar which no member is/],
  },
  {
    name: "the demo consumer's home district is no longer the one the title claims",
    apply: plantConsumerHome,
    expect: 1,
    must: [/RESULT: FAIL/, /the demo consumer's declared home district is not/],
  },
  {
    name: 'REFUSAL: the vocabulary declares a check this reader does not implement',
    apply: plantUnknownCheck,
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /declares the check `weather_all`/],
  },
  {
    name: 'REFUSAL: a rows file the reader needs is absent',
    apply: plantMissingRows,
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /the slots rows are absent/],
  },
  {
    name: 'REFUSAL: an unknown flag',
    apply: () => {},
    expect: 2,
    args: ['--nope=1'],
    must: [/RESULT: NOT CHECKED/, /unknown option --nope/],
  },
  {
    name: 'REFUSAL: --out given twice — which plane is the run',
    apply: () => {},
    expect: 2,
    noOut: true,
    args: ['--out=a', '--out=b'],
    must: [/RESULT: NOT CHECKED/, /--out was given 2 times/],
  },
  {
    name: '--report over a red plant still prints the failure and exits 0',
    apply: plantCountDrift,
    expect: 0,
    args: ['--report'],
    must: [/FAILURES \(\d+\)/, /claims \d+, but the list holds \d+ distinct member\(s\)/],
  },
  {
    name: '--out <dir> (spaced) reaches the planted plane',
    apply: plantCountDrift,
    expect: 1,
    spaced: true,
    must: [/RESULT: FAIL/, /claims \d+, but the list holds \d+ distinct member\(s\)/],
  },
  {
    name: '--out=<dir> (glued) aims the same reader at the same plane',
    apply: plantCountDrift,
    expect: 1,
    must: [/RESULT: FAIL/, /claims \d+, but the list holds \d+ distinct member\(s\)/],
  },
];

const results = [];
for (const arm of ARMS) {
  const dir = fixture(arm.name);
  arm.apply(dir);
  const argv = [...(arm.args ?? [])];
  if (!arm.noOut) {
    if (arm.spaced) argv.push('--out', join(dir, 'out'));
    else argv.push(`--out=${join(dir, 'out')}`);
  }
  argv.push(`--vocab=${join(dir, 'claim_vocabulary.json')}`);
  let out;
  let code;
  try {
    out = execFileSync('node', [CHECKER, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26,
    });
    code = 0;
  } catch (e) {
    if (isSpawnFailure(e)) {
      console.log(`RESULT: NOT CHECKED — the reader could not be started (${spawnReason(e)}).`);
      process.exit(2);
    }
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = (arm.must ?? []).filter((re) => !re.test(out));
  const printed = (arm.absent ?? []).filter((re) => re.test(out));
  results.push({ arm, code, missed, printed, out });
}

let fails = 0;
for (const r of results) {
  const ok = r.code === r.arm.expect && r.missed.length === 0 && r.printed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  if (r.code !== r.arm.expect) {
    console.log(`        verdict differs -- the arm printed: ${r.out.split('\n').filter((l) => /RESULT|FAILURES|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
  for (const m of r.missed) {
    console.log(`        expected text missing: ${m}   -- printed: ${r.out.split('\n').filter((l) => /RESULT|FAILURES|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
  for (const m of r.printed) {
    console.log(`        text printed that must not be: ${m}   -- printed: ${r.out.split('\n').filter((l) => /RESULT|FAILURES|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped reader as a subprocess on its own copy of the generated');
console.log('           rows, so no arm can redden another; each mutation refuses if the text it rewrites is');
console.log('           absent, so no arm can pass by running an unmutated plane.');
if (fails) {
  console.log('\nRESULT: FAIL -- the collection-claim reader does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- the reader reddens on a copy that no longer matches its own rows, keeps quiet on the');
console.log('           shipped plane, and refuses when it cannot run');
