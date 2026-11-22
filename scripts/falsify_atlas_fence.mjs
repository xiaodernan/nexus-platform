#!/usr/bin/env node
/**
 * NEXUS D1534 — show that `check_atlas_lockstep.mjs` can fail for each reason it claims to exist, and
 * that its newest assertion (the chapter fence must be DERIVED) is a witnessed rule, not an assumption.
 *
 * The reason this reader exists at all: on 2026-11-22 the arc was at 178 chapters and the chapter-ask
 * system prompt said "THE 175-CHAPTER HONG KONG ARC". Nothing reddened, because the number lived inside
 * a sentence no test asserts on. The fix was to count the index's own rows; the gate is that a literal
 * digit in that position is now an OFFENDER. An assertion nobody has watched fail is a wish, so:
 *
 * Usage: node scripts/falsify_atlas_fence.mjs
 * Exit: 0 every arm held · 1 at least one did not.
 *
 * Every arm runs the SHIPPED checker with `--root` pointed at a fixture tree, so no arm can redden
 * another and none of them touches this tree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'check_atlas_lockstep.mjs');
const FIX = mkdtempSync(join(tmpdir(), 'nexus-d1534-atlas-'));

// The reader refuses a corpus of fewer than 100 canonical chapters (`nums.size < 100` -> NOT CHECKED),
// so the fixture corpus must clear that bar or every arm would be refused for the wrong reason. The
// small-N tree below exists precisely to witness that guard.
const N = 101;

const CN_D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function cnNumeral(n) {
  if (n < 10) return CN_D[n];
  if (n < 20) return '十' + (n % 10 ? CN_D[n % 10] : '');
  if (n < 100) return CN_D[Math.floor(n / 10)] + '十' + (n % 10 ? CN_D[n % 10] : '');
  const rest = n % 100;
  const head = CN_D[Math.floor(n / 100)] + '百';
  if (rest === 0) return head;
  return head + (rest < 10 ? '零' + CN_D[rest] : cnNumeral(rest));
}

const seedBody = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `    slug: 'hk-fixture-${i + 1}', title: '測試章節（香港系列 · 第${cnNumeral(i + 1)}章）', city: 'hong-kong',`,
  ).join('\n') + '\n';
const digestBody = (n) =>
  `# NEXUS — THE HONG KONG ARC ATLAS DIGEST · ${n} chapters, one line each\n` +
  Array.from({ length: n }, (_, i) => ` ${String(i + 1).padStart(3)} · 測試章節`).join('\n') + '\n';
const indexBody = (n) =>
  `# THE HONG KONG ARC — CHAPTER INDEX\n` +
  Array.from({ length: n }, (_, i) => ` ${String(i + 1).padStart(3)} · 測試章節`).join('\n') + '\n';

// The derived shape, byte-for-byte the pattern the shipped route uses.
const ROUTE_DERIVED = `def _atlas_chapter_count(index_text: str) -> int:
    return sum(1 for line in index_text.splitlines() if line.lstrip()[:1].isdigit())


_ATLAS_CHAPTERS = _atlas_chapter_count(_ATLAS_INDEX)

_ATLAS_BLOCK = (
    "\\n\\nTHE "
    + (str(_ATLAS_CHAPTERS) if _ATLAS_CHAPTERS else "HONG KONG")
    + "-CHAPTER HONG KONG ARC — order is chronological. Use it to understand\\n"
)
`;
// The shape D1534 removed: the number is a literal, and it can be wrong.
const ROUTE_LITERAL = (n) => `_ATLAS_BLOCK = (
    "\\n\\nTHE ${n}-CHAPTER HONG KONG ARC — order is chronological. Use it to understand\\n"
)
`;

const tree = (name, files) => {
  const dir = join(FIX, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return dir;
};

const base = (n = N, route = ROUTE_DERIVED) => ({
  'apps/web/src/lib/mock/seed.ts': seedBody(n),
  'apps/ai/nexus_ai/models/atlas_digest.txt': digestBody(n),
  'apps/ai/nexus_ai/models/atlas_index.txt': indexBody(n),
  'apps/ai/nexus_ai/api/routes_chapter.py': route,
});

const ARMS = [
  {
    name: 'a consistent derived tree: green, and the fence is reported as derived',
    fix: tree('green', base()),
    expect: 0,
    must: [/RESULT: PASS/, /fence derived/, new RegExp(`lockstep at ${N} chapters`)],
  },
  {
    name: 'the fence is a literal that happens to be RIGHT: still an offender (a literal can only drift)',
    fix: tree('literal-right', base(N, ROUTE_LITERAL(N))),
    expect: 1,
    must: [/RESULT: FAIL/, new RegExp(`fence is literal ${N}, not derived`)],
  },
  {
    name: 'the fence is a literal that is STALE — the exact failure of 2026-11-22',
    fix: tree('literal-stale', base(N, ROUTE_LITERAL(N - 3))),
    expect: 1,
    must: [/RESULT: FAIL/, new RegExp(`fence is literal ${N - 3}, not derived`)],
  },
  {
    name: 'the route has no fence at all: missing, not silently accepted',
    fix: tree('missing', base(N, '_ATLAS_BLOCK = ""\n')),
    expect: 1,
    must: [/RESULT: FAIL/, /fence is missing/],
  },
  {
    name: 'atlas_digest header falls behind the corpus',
    fix: tree('digest-header', (() => {
      const t = base();
      t['apps/ai/nexus_ai/models/atlas_digest.txt'] = digestBody(N).replace(`· ${N} chapters`, `· ${N - 1} chapters`);
      return t;
    })()),
    expect: 1,
    must: [/RESULT: FAIL/, new RegExp(`atlas_digest header ${N - 1} != corpus ${N}`)],
  },
  {
    name: 'atlas_index is missing a chapter line',
    fix: tree('index-short', (() => {
      const t = base();
      t['apps/ai/nexus_ai/models/atlas_index.txt'] = indexBody(N - 1);
      return t;
    })()),
    expect: 1,
    must: [/RESULT: FAIL/, new RegExp(`atlas_index has ${N - 1} chapter lines != corpus ${N}`)],
  },
  {
    name: 'a corpus too small to trust: refuses with exit 2 rather than passing a guess',
    fix: tree('too-small', base(5)),
    expect: 2,
    must: [/NOT CHECKED/, /only 5 canonical chapters/],
  },
  {
    name: 'a tree with no atlas plane at all: refuses, does not pass',
    fix: tree('empty', { 'apps/web/src/lib/mock/seed.ts': seedBody(N) }),
    expect: 2,
    must: [/NOT CHECKED/],
  },
];

let fails = 0;
for (const arm of ARMS) {
  let out, code;
  try {
    out = execFileSync('node', [CHECKER, '--root', arm.fix], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26,
    });
    code = 0;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = arm.must.filter((re) => !re.test(out));
  const ok = code === arm.expect && missed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${arm.expect} expected, ${code} printed   ${arm.name}`);
  if (code !== arm.expect) console.log(`        verdict differs — printed: ${(out.match(/RESULT.*/) || ['<no RESULT line>'])[0]}`);
  for (const m of missed) {
    console.log(`        expected text missing: ${m}`);
    console.log(out.split('\n').slice(0, 6).map((l) => '        | ' + l).join('\n'));
  }
}

rmSync(FIX, { recursive: true, force: true });
console.log(`\n  ${ARMS.length} arms · ${ARMS.length - fails} held · ${fails} missed`);
console.log('  grammar: the chapter fence must be DERIVED from the index it describes; a literal digit there');
console.log('           is an offender even when it is numerically correct, because a literal is the only');
console.log('           shape of that sentence that can be wrong — and was, for three chapters.');
if (fails) {
  console.log('\nRESULT: FAIL — the atlas reader does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS — reddens on a stale literal, on a correct literal, on a missing fence and on a short atlas;');
console.log('               refuses on a corpus too small to judge; stays green on the derivation');
