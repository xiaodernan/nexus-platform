#!/usr/bin/env node
/**
 * NEXUS D930 — every Java source basename in the shipped plane is unique.
 *
 * WHY THIS RULE EXISTS. The ledgers cite Java classes by their BARE class stem — `EventsController:63`
 * (D69/D87/D88, STATUS §65/§568) — and `check_ledger_citations.mjs` resolves a bare stem by basename.
 * When D929 added `services/cloud/events-service/.../EventsController.java` beside the long-shipped
 * `services/platform/.../growth/EventsController.java`, those six historical cites became AMBIGUOUS
 * and the ledger gate went RED. The cite was never wrong; the new file stole a name an old paragraph
 * already owned. That is the failure mode this gate prevents: a new module silently making an EXISTING,
 * correct citation unresolvable, which no test of the new module would ever notice.
 *
 * THE INVARIANT. Across every Java source the repository ships (excluding VENDOR_DIRS: target/, tmp/,
 * .scratch/, build output, …), no two files may share a basename. Java itself permits two same-named
 * classes in different packages, so a compiler will NOT catch this; the ledgers' bare-stem grammar
 * cannot tell them apart, so the citation plane requires a stricter rule than javac does. If a second
 * `Foo.java` is genuinely needed, the ledger citing `Foo:NN` must be rewritten to a path-qualified cite
 * first — and this gate is what forces that conversation to happen in the commit that adds the file.
 *
 * WHAT THIS DOES NOT SAY: that any cited line says what its prose claims (that is the ledger reader's
 * job), that the Java compiles (Maven does), or anything about non-Java basenames. It reads paths, not
 * file contents, and writes nothing.
 *
 * SELF-TEST: `judge` is pure over a Set of relative paths. `--self-test` plants two collisions —
 * two files with the same basename in different packages, and the exact collision the D929 plane
 * had — requires each to redden, and requires two NON-collisions (case-only difference, distinct
 * names) to stay green, while the real plane holds zero offenders. A gate that cannot be made red,
 * or one that reddens on a case-only difference, is not a usable gate.
 *
 * Usage:  node scripts/check_java_basenames.mjs [--self-test] [--verbose]
 * Exit:   0 every basename unique · 1 an offender · 2 the plane could not be read.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_DIRS } from './source_index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const VERBOSE = process.argv.includes('--verbose');

/** Walk every non-vendor Java source under root; return forward-slash relative paths. */
function javaPaths(root, dir = '', out = []) {
  let entries;
  try { entries = readdirSync(join(root, dir)); } catch { return out; }
  for (const name of entries) {
    if (VENDOR_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    let st;
    try { st = statSync(join(root, rel)); } catch { continue; }
    if (st.isDirectory()) javaPaths(root, rel, out);
    else if (name.endsWith('.java')) out.push(rel);
  }
  return out;
}

/**
 * Pure over an iterable of relative paths. A basename held by 2+ DISTINCT full paths is the
 * offender the ledger reader would file AMBIGUOUS. Paths are de-duplicated: the disk walker cannot
 * emit one file twice, so a repeated path is not a fault class this gate needs to judge. Java class
 * names AND the ledgers' bare-stem grammar are case-sensitive, so `Foo` and `foo` are different
 * cites and correctly stay green — that arm exists to prove the gate is not over-eager.
 */
export function judge(paths) {
  const list = [...new Set([...paths].map((p) => p.replace(/\\/g, '/')))];
  if (list.length === 0) {
    return { offenders: [], unchecked: 'the Java plane is empty — a census that found no sources cleared nothing' };
  }
  const byStem = new Map();
  for (const norm of list) {
    const slash = norm.lastIndexOf('/');
    const base = norm.slice(slash + 1);
    if (!base.endsWith('.java')) continue;
    const stem = base.slice(0, -'.java'.length);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(norm);
  }
  const offenders = [];
  const notes = [];
  for (const [stem, holders] of byStem) {
    if (holders.length > 1) {
      offenders.push(`COLLISION ${stem}.java — ${[...holders].sort().join(' | ')} — a bare \`${stem}:NN\` cite cannot resolve`);
    }
  }
  notes.push(`held ${byStem.size} distinct Java class basenames, 0 collisions`);
  return { offenders, notes, unchecked: null, files: list.length };
}

function fromDisk() {
  const paths = javaPaths(ROOT);
  return { plane: paths, readError: null };
}

let result;
if (SELF_TEST) {
  const arms = [
    ['real plane holds', fromDisk().plane, false],
    ['two packages, same class', ['a/one/Foo.java', 'b/two/Foo.java'], true],
    ['the D929 collision', ['services/cloud/events-service/EventsController.java',
      'services/platform/growth/EventsController.java'], true],
    ['case differs, not a collision', ['a/Foo.java', 'b/foo.java'], false],
    ['distinct names stay green', ['a/Foo.java', 'b/Bar.java'], false],
  ];
  let allCaught = true;
  for (const [label, plane, wantRed] of arms) {
    const j = judge(plane);
    const red = j.unchecked !== null || j.offenders.length > 0;
    const ok = red === wantRed;
    if (!ok) allCaught = false;
    console.log(`  self-test  ${label.padEnd(30)} ${ok ? 'OK' : 'MISMATCH'} (red=${red}, expected=${wantRed}, offenders=${j.offenders.length})`);
  }
  console.log(`  self-test  all arms behaved: ${allCaught}`);
  process.exit(allCaught ? 0 : 1);
}

const { plane, readError } = fromDisk();
if (readError) {
  console.log(`RESULT: NOT CHECKED — ${readError}`);
  process.exit(2);
}
result = judge(plane);
if (result.unchecked) {
  console.log(`RESULT: NOT CHECKED — ${result.unchecked}`);
  process.exit(2);
}
for (const n of result.notes) console.log(`  ${n}`);
if (VERBOSE) for (const p of result.files ?? []) console.log(`    ${p}`);
if (result.offenders.length) {
  console.log(`\nFALSE JAVA BASENAMES (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} collision(s); a bare class-stem cite is ambiguous (exit 1)`);
  process.exit(1);
}
console.log(`RESULT: PASS — ${result.files} Java sources, every basename unique (exit 0)`);
process.exit(0);
