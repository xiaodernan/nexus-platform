#!/usr/bin/env node
/**
 * NEXUS D883 — the atlas page is a claim about the repository, so it is checked in both directions.
 *
 * FORWARD: every backticked token that looks like a repository-relative FILE path in `docs/ATLAS.md`
 * must exist. A renamed module, a deleted smoke or a typo'd citation reddens here. Prose, shell
 * commands, `STATUS §NN` marks, directories without an extension and tokens containing a glob,
 * variable or template bracket are not paths and are deliberately not judged.
 *
 * REVERSE (the census): every `scripts/check_<name>.mjs`, `scripts/verify_<name>.mjs`,
 * `scripts/<name>.sh`, `docs/<name>.md` and each cloud module's pom.xml the repository ships must
 * be NAMED on the atlas page.
 * This is the half that makes an "integration" page honest: adding a reader without adding its row is
 * a visible failure instead of silent drift. The census is scoped to those five populations — a new
 * .py helper or a new .java class does not need an atlas row.
 *
 * SELF-TEST: `--self-test` falsifies BOTH halves. (1) It rewrites the first cited path into a name no
 * commit holds and asserts a MISSING PATH offender. (2) It erases one reader's name from the page and
 * asserts an UNCITED offender. A gate that cannot be made red is not a gate. It also asserts the real
 * page produces none, so a permanently-broken atlas cannot pass its own falsifier.
 *
 * WHAT THIS DOES NOT SAY: that any reader the atlas lists is currently green (run `verify_all.mjs`),
 * that a listed smoke was run, that the paths are the *right* paths for the sentence they sit in,
 * or anything about the contents of a file beyond its existence. It never starts a service, touches
 * the database or writes to the tree except under --self-test's in-memory string.
 *
 * Usage:
 *   node scripts/check_atlas.mjs
 *   node scripts/check_atlas.mjs --verbose
 *   node scripts/check_atlas.mjs --self-test
 *   node scripts/check_atlas.mjs --dir=<repo-root-copy>     # census a planted tree
 *
 * Exit: 0 the atlas holds and is complete · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const VERBOSE = argv.includes('--verbose');
const dirArg = argv.find((a) => a.startsWith('--dir='));
const ROOT = dirArg ? resolve(dirArg.slice('--dir='.length)) : DEFAULT_ROOT;

const ATLAS = 'docs/ATLAS.md';
const PATH_TOKEN = /^[A-Za-z0-9_./-]+\.(?:md|mjs|sh|java|py|ts|tsx|sql|yaml|yml|json|xml|txt|css|csv|tsv)$/;

/** The five populations an atlas row must cover. */
function populations(root) {
  const list = (dir, pattern) => {
    try {
      return readdirSync(join(root, dir))
        .filter((f) => pattern.test(f))
        .map((f) => `${dir}/${f}`)
        .sort();
    } catch { return []; }
  };
  const modules = (() => {
    try {
      return readdirSync(join(root, 'services/cloud'))
        .filter((m) => existsSync(join(root, 'services/cloud', m, 'pom.xml')))
        .map((m) => `services/cloud/${m}/pom.xml`)
        .sort();
    } catch { return []; }
  })();
  return [
    ['reader (check)', list('scripts', /^check_.*\.mjs$/)],
    ['reader (verify)', list('scripts', /^verify_.*\.mjs$/)],
    ['smoke / launcher', list('scripts', /\.sh$/)],
    ['design page', list('docs', /\.md$/)],
    ['cloud module', modules],
  ];
}

/**
 * The judge is pure over (text, root) so --self-test can feed it a corrupted atlas without writing
 * anything to disk. Returns { offenders, checked, notes }.
 */
function judge(text, root) {
  const offenders = [];
  const checked = [];
  if (!text || !text.trim()) {
    return { offenders: [`${ATLAS} is empty or unreadable — a map with no rows has cleared nothing`], checked, notes: [] };
  }

  /* forward: every path-looking backtick token resolves */
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  const paths = [...new Set(spans.filter((s) => PATH_TOKEN.test(s)))];
  for (const p of paths) {
    const abs = join(root, p);
    checked.push(p);
    if (!existsSync(abs)) offenders.push(`MISSING PATH — \`${p}\` does not exist under ${root}`);
  }
  if (paths.length === 0) offenders.push('NO PATHS — the atlas cites zero file paths, so the forward rule asked nothing');

  /* reverse: every shipped reader / doc / smoke / module is named */
  const notes = [];
  for (const [label, files] of populations(root)) {
    for (const f of files) {
      if (!text.includes(f) && !text.includes(`/${f}`)) {
        offenders.push(`UNCITED ${label} — \`${f}\` ships but the atlas never names it`);
      }
    }
    notes.push(`${label}: ${files.length} file(s) required on the page`);
  }
  return { offenders, checked, notes };
}

function main() {
  let text;
  try { text = readFileSync(join(ROOT, ATLAS), 'utf8'); }
  catch (e) {
    console.log(`RESULT: NOT CHECKED — ${ATLAS} cannot be read under ${ROOT}: ${e.message}`);
    return 2;
  }

  const live = judge(text, ROOT);
  console.log('NEXUS ATLAS — one page, checked in both directions');
  console.log(`  plane read        ${ROOT}`);
  console.log(`  cited paths       ${live.checked.length} distinct repository-relative file path(s)`);
  for (const n of live.notes) console.log(`  census            ${n}`);
  if (VERBOSE) for (const p of live.checked) console.log(`    exists  ${p}`);

  if (SELF_TEST) {
    /* Falsify the forward rule: corrupt the FIRST cited path, expect a red judge. */
    const first = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).find((s) => PATH_TOKEN.test(s));
    if (!first) {
      console.log('SELF-TEST: FAIL — the atlas cites no path to corrupt, so the falsifier proved nothing');
      return 1;
    }
    const corrupted = text.replace(`\`${first}\``, '`docs/__atlas_absent_falsifier__.md`');
    const planted = judge(corrupted, ROOT);
    const caught = planted.offenders.some((o) => o.includes('__atlas_absent_falsifier__'));
    console.log(`  self-test (forward)  corrupted \`${first}\` → \`docs/__atlas_absent_falsifier__.md\``);
    console.log(`  self-test (forward)  planted offender(s): ${planted.offenders.length}, caught: ${caught}`);

    /* Falsify the reverse census: erase one censused reader's name from every occurrence. */
    const victim = 'scripts/check_cloud_edge.mjs';
    const erased = text.split(victim).join('a-reader-nobody-named');
    const planted2 = judge(erased, ROOT);
    const caught2 = planted2.offenders.some((o) => o.includes('UNCITED') && o.includes('check_cloud_edge.mjs'));
    console.log(`  self-test (census)   erased \`${victim}\` from the page`);
    console.log(`  self-test (census)   planted offender(s): ${planted2.offenders.length}, caught: ${caught2}`);

    if (!caught || !caught2) {
      console.log('SELF-TEST: FAIL — a broken atlas did NOT redden both halves of the gate');
      return 1;
    }
    if (live.offenders.length) {
      console.log(`SELF-TEST: FAIL — the real atlas already has ${live.offenders.length} offender(s); the falsifier is not the reason the gate is red`);
      for (const o of live.offenders) console.log(`  - ${o}`);
      return 1;
    }
    console.log('  self-test         the real atlas holds, and both corruptions redden');
  }

  if (live.offenders.length) {
    console.log(`\nOFFENDERS (${live.offenders.length}):`);
    for (const o of live.offenders) console.log(`  - ${o}`);
    console.log('\nRESULT: FAIL — the atlas is not a trustworthy map of this tree');
    return 1;
  }
  console.log('\nWHAT THIS DOES NOT SAY: that any listed reader is green, that any listed smoke ran,');
  console.log('or that a path is the right path for the sentence it sits in. Existence and completeness only.');
  console.log(`\nRESULT: PASS — ${live.checked.length} cited path(s) exist and every shipped reader,`);
  console.log('document, smoke and cloud module is named on the page');
  return 0;
}

process.exitCode = main();
