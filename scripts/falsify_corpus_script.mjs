#!/usr/bin/env node
/**
 * NEXUS D1535 — show that `check_corpus_script.mjs` can fail for each reason it claims to exist, and
 * that its refusals refuse.
 *
 * The reader was written because the measurement it performs found 93 dirty literals on its first run.
 * An assertion is only worth keeping once it has been watched go red on purpose — otherwise every later
 * green run means nothing. The arms come in pairs that differ in exactly one property, so none of them
 * can hold by luck.
 *
 * Usage: node scripts/falsify_corpus_script.mjs
 * Exit: 0 every arm held · 1 at least one did not.
 *
 * Each arm gets its own copy of the corpus and the inventory under the system temp directory, so no arm
 * can borrow another's redness and the working tree is never the fixture.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_corpus_script.mjs');
const FIX = join(tmpdir(), 'nexus-d1535-corpus-falsify');
const CORPUS = join('apps', 'web', 'src', 'lib', 'mock', 'seed.ts');
const INVENTORY = join('scripts', 'data', 'simp-only-chars.txt');

rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

/** A fixture plane: the real corpus and the real inventory, copied. Nothing else is read. */
function plane(slug, { corpus = true, inventory = true } = {}) {
  const dir = join(FIX, slug);
  mkdirSync(join(dir, dirname(CORPUS)), { recursive: true });
  mkdirSync(join(dir, dirname(INVENTORY)), { recursive: true });
  if (corpus) copyFileSync(join(ROOT, CORPUS), join(dir, CORPUS));
  if (inventory) copyFileSync(join(ROOT, INVENTORY), join(dir, INVENTORY));
  return dir;
}

/** Splice one exact span; refuse when the count is not 1 so an arm cannot pass on an unmutated tree. */
function swap(dir, from, to) {
  const abs = join(dir, CORPUS);
  const text = readFileSync(abs, 'utf8');
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`the corpus holds ${n} × ${JSON.stringify(from)}, not 1`);
  writeFileSync(abs, text.replace(from, () => to), 'utf8');
  return dir;
}

const ARMS = [
  {
    name: 'control: the shipped corpus as it stands',
    dir: () => plane('control'),
    expect: 0,
    must: [/RESULT: PASS/, /0 simplified character\(s\) over \d+ literal\(s\)/],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'a planted 挂 (the shape the reader found 56 times) reddens and is named with its line',
    dir: () => swap(plane('plant-hang'), '阿樂把停車牌掛起', '阿樂把停車牌挂起'),
    expect: 1,
    must: [/RESULT: FAIL/, /WRONG-SCRIPT .*seed\.ts:\d+ \[挂\]/, /挂×1/],
  },
  {
    name: 'a planted compound (货 + 源) reports the character, not the phrase',
    dir: () => swap(plane('plant-compound'), '他的貨源是果欄', '他的货源是果欄'),
    expect: 1,
    must: [/RESULT: FAIL/, /\[货\]/, /货×1/],
  },
  {
    name: 'the same planted character in a COMMENT is prose, not copy — the scanner keeps the distinction',
    dir: () => {
      const d = plane('plant-comment');
      const abs = join(d, CORPUS);
      writeFileSync(abs, `// 挂 is the Simplified form of 掛\n${readFileSync(abs, 'utf8')}`, 'utf8');
      return d;
    },
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: '皇后 costs nothing: 后 is the queen word, and the exclusion is doing work',
    dir: () => plane('hou'),
    expect: 0,
    must: [/RESULT: PASS/],
  },
  {
    name: 'KNOWN LIMIT, asserted rather than assumed: 后 is excluded by CHARACTER, so 最后 is not caught',
    // A word-level allowlist was tried and rejected: the measured bigram set for 台 alone is 92 entries,
    // and a 92-entry list nobody reads is worse than the 22-character list they can. The limit is real —
    // 4 genuine errors (里面 / 托管 / 托我 / 涌進) were found by MEASURING the bigrams, then repaired by
    // hand; the census itself cannot see them. This arm pins that boundary so it stays a known one.
    dir: () => swap(plane('hou-limit'), '皇后大道東盡頭', '最后大道東盡頭'),
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'REFUSAL: the corpus is not in the plane',
    dir: () => plane('no-corpus', { corpus: false }),
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /no corpus at/],
  },
  {
    name: 'REFUSAL: the inventory is not in the plane — no silent downgrade to the queried pairs',
    dir: () => plane('no-inventory', { inventory: false }),
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /no simp-only-chars\.txt at/],
  },
  {
    name: 'REFUSAL: a corpus too small to be this corpus — a scan that read nothing is not a pass',
    dir: () => {
      const d = plane('tiny', { corpus: false });
      mkdirSync(join(d, dirname(CORPUS)), { recursive: true });
      writeFileSync(join(d, CORPUS), "export const a = ['合成示例'];\n", 'utf8');
      return d;
    },
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /fewer than the/],
  },
  {
    name: 'REFUSAL: a literal that never closes — the rest of the file was not judged',
    dir: () => {
      const d = plane('unterminated');
      const abs = join(d, CORPUS);
      writeFileSync(abs, `${readFileSync(abs, 'utf8')}\nconst broken = '合成\n`, 'utf8');
      return d;
    },
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /never closes/],
  },
];

let fails = 0;
for (const arm of ARMS) {
  let dir;
  try {
    dir = arm.dir();
  } catch (e) {
    fails += 1;
    console.log(`MISSED  setup failed   ${arm.name}`);
    console.log(`        ${e.message}`);
    continue;
  }
  let out, code;
  try {
    out = execFileSync('node', [CHECKER, '--repo', dir], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26,
    });
    code = 0;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = arm.must.filter((re) => !re.test(out));
  const found = (arm.absent || []).filter((re) => re.test(out));
  const ok = code === arm.expect && missed.length === 0 && found.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${arm.expect} expected, ${code} printed   ${arm.name}`);
  for (const m of missed) console.log(`        expected text missing: ${m}`);
  for (const m of found) console.log(`        text that must not appear was found: ${m}`);
  if (!ok) console.log(out.split('\n').slice(0, 7).map((l) => '        | ' + l).join('\n'));
}

rmSync(FIX, { recursive: true, force: true });
console.log(`\n  ${ARMS.length} arms · ${ARMS.length - fails} held · ${fails} missed`);
console.log('  grammar: every string literal of the chapter corpus is judged against the 3,873-character');
console.log('           opencc inventory minus the named exclusions; comments are prose, not copy; and a');
console.log('           plane that cannot be read to its end is refused rather than reported clean.');
if (fails) {
  console.log('\nRESULT: FAIL — the corpus census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS — charges a planted Simplified character and names its line, ignores comments,');
console.log('               keeps 皇后 green, records the character-level limit on 后 as a known one, and');
console.log('               refuses an unreadable plane');
