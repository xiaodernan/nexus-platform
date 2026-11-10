#!/usr/bin/env node
/**
 * NEXUS D891 — the shared blob reader stays shared.
 *
 * D888 and D890 each wrote their own `git cat-file` record walker. D891 extracted both into
 * scripts/git_blobs.mjs. A refactor a person can undo by pasting the parser back into one caller
 * is not a refactor this repository can rely on, so this gate reads the plane and asks:
 *
 *   1. the shared module exists, exports headTree and catFileBatch, keeps stdin as a pipe (the
 *      `ignore` + `input` pair that silently delivers nothing is the defect DECISIONS §253 found),
 *      and handles the "missing" header explicitly;
 *   2. BOTH citation readers import it and call both functions;
 *   3. no third scripts/*.mjs carries a second copy of the batch or the NUL-delimited tree token.
 *
 * SELF-TEST: the judge is pure over (path -> text), so --self-test plants three corruptions in
 * memory — an erased import, a pasted parser in a fake third file, and an empty plane — and requires
 * each to redden or to refuse. A gate that cannot be made red is not a gate.
 *
 * WHAT THIS DOES NOT SAY: that either reader's census is CORRECT (verify_citation_engine_parity.mjs
 * and verify_line_cite_parity.mjs compare behaviour), that the readers are green right now, or
 * anything about files outside scripts/. It spawns no git command and writes nothing.
 *
 * Usage:  node scripts/check_shared_blob_reader.mjs [--self-test] [--verbose]
 * Exit:   0 the plane is shared · 1 an offender · 2 the plane could not be read.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const VERBOSE = process.argv.includes('--verbose');

const SHARED = 'scripts/git_blobs.mjs';
const CALLERS = [
  'scripts/check_citation_supports_sentence.mjs',
  'scripts/check_line_cite_drift.mjs',
];
// Split deliberately: this file must not itself spell the token it hunts for, or it would report
// itself as the third parser. The concatenation is the only place the whole literal exists.
const BATCH_TOKEN = "['cat-file', " + "'--batch']";
const TREE_TOKEN = "['ls-tree', '-r', '-z', " + "'HEAD']";

/** Pure over a (path -> text) map so the falsifier never touches the tree. */
export function judge(files) {
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders: [], unchecked: 'the scripts plane is empty or unreadable — a census that found nothing has cleared nothing' };
  }
  const offenders = [];
  const notes = [];
  const shared = files.get(SHARED);
  if (shared === undefined) {
    offenders.push(`MISSING MODULE — ${SHARED} does not exist; the two readers have nothing to share`);
  } else {
    if (!/export function headTree\b/.test(shared)) offenders.push(`MISSING EXPORT — ${SHARED} does not export headTree`);
    if (!/export function catFileBatch\b/.test(shared)) offenders.push(`MISSING EXPORT — ${SHARED} does not export catFileBatch`);
    if (!/stdio:\s*\['pipe',\s*'pipe',\s*'ignore'\]/.test(shared)) {
      offenders.push(`SILENT PAYLOAD — ${SHARED} does not keep stdin as a pipe; the request list is the payload`);
    }
    if (!/header\.endsWith\(' missing'\)/.test(shared)) {
      offenders.push(`MISSING CASE — ${SHARED} does not handle git's "missing" header explicitly`);
    }
    notes.push(`${SHARED}: exports, pipe stdin and the missing case read`);
  }
  for (const caller of CALLERS) {
    const text = files.get(caller);
    if (text === undefined) {
      offenders.push(`MISSING CALLER — ${caller} does not exist; the extraction has lost a consumer`);
      continue;
    }
    if (!/from '\.\/git_blobs\.mjs'/.test(text)) offenders.push(`NO IMPORT — ${caller} does not import ${SHARED}`);
    if (!/\bheadTree\(/.test(text)) offenders.push(`NO headTree CALL — ${caller} still walks the tree itself`);
    if (!/\bcatFileBatch\(/.test(text)) offenders.push(`NO catFileBatch CALL — ${caller} still parses the batch itself`);
    notes.push(`${caller}: import + both calls read`);
  }
  const duplicates = [...files.entries()]
    .filter(([p, t]) => p !== SHARED && (t.includes(BATCH_TOKEN) || t.includes(TREE_TOKEN)))
    .map(([p]) => p);
  for (const p of duplicates) offenders.push(`DUPLICATE PARSER — ${p} carries a second copy of the batch/tree literal`);
  notes.push(`third parser: ${duplicates.length} file(s) outside ${SHARED} carry the forbidden literal`);
  return { offenders, notes, unchecked: null };
}

function readPlane() {
  const files = new Map();
  let names;
  try { names = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).sort(); }
  catch { return files; }
  for (const name of names) {
    try { files.set(`scripts/${name}`, readFileSync(join(ROOT, 'scripts', name), 'utf8')); }
    catch { /* an unreadable file is absent from the census and judged as such */ }
  }
  return files;
}

function main() {
  const plane = readPlane();
  const live = judge(plane);
  console.log('NEXUS — one shared blob reader, checked in both directions');
  console.log(`  plane read        ${plane.size} scripts/*.mjs file(s) under ${ROOT}`);
  for (const n of live.notes ?? []) console.log(`  ${n}`);
  if (VERBOSE) for (const n of CALLERS) console.log(`  caller            ${n}: ${plane.get(n)?.length ?? 0} chars`);

  if (SELF_TEST) {
    const erased = new Map(plane);
    const victim = CALLERS[0];
    erased.set(victim, plane.get(victim).split("from './git_blobs.mjs'").join("from './elsewhere.mjs'"));
    const caughtImport = judge(erased).offenders.some((o) => o.includes('NO IMPORT'));

    const pasted = new Map(plane);
    pasted.set('scripts/__fake_third_parser__.mjs', `const buf = execFileSync('git', ${BATCH_TOKEN});`);
    const caughtDuplicate = judge(pasted).offenders.some((o) => o.includes('DUPLICATE PARSER'));

    const empty = judge(new Map());
    const caughtEmpty = Boolean(empty.unchecked);

    console.log(`  self-test (import)    erased ${victim}'s import -> caught: ${caughtImport}`);
    console.log(`  self-test (3rd copy)  planted a second parser -> caught: ${caughtDuplicate}`);
    console.log(`  self-test (no plane)  empty scripts plane -> refused: ${caughtEmpty}`);
    console.log(`  self-test (live)      real plane offenders: ${live.offenders.length}`);
    if (!caughtImport || !caughtDuplicate || !caughtEmpty || live.offenders.length || live.unchecked) {
      console.log('\nSELF-TEST: FAIL — a corruption did not redden, or the real plane is already red');
      return 1;
    }
    console.log('  self-test         all three corruptions redden and the real plane holds');
  }

  if (live.unchecked) {
    console.log(`\nRESULT: NOT CHECKED — ${live.unchecked}`);
    return 2;
  }
  if (live.offenders.length) {
    console.log(`\nOFFENDERS (${live.offenders.length}):`);
    for (const o of live.offenders) console.log(`  - ${o}`);
    console.log('\nRESULT: FAIL — the blob parser is no longer one implementation');
    return 1;
  }
  console.log('\nWHAT THIS DOES NOT SAY: that either census is correct, that the readers are green now,');
  console.log('or anything about files outside scripts/. Behaviour is compared by the two parity runners.');
  console.log('\nRESULT: PASS — both citation readers call the one shared blob reader, no third parser');
  return 0;
}

process.exitCode = main();
