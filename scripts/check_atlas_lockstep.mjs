#!/usr/bin/env node
/**
 * D1474 — the frozen atlas must never fall behind the corpus it describes.
 *
 * D1468 found `atlas_digest.txt` / `atlas_index.txt` frozen at 147 chapters while the arc had
 * reached 156: the chapter-ask system prompt told the model the world ended nine chapters early.
 * The generators exist; what was missing was a READER that refuses drift. This is that reader.
 *
 * Four sources of truth must agree on N:
 *   1. `apps/web/src/lib/mock/seed.ts` — the canonical corpus (max 第N章 number).
 *   2. `apps/ai/nexus_ai/models/atlas_digest.txt` — header "N chapters" + N ordered lines.
 *   3. `apps/ai/nexus_ai/models/atlas_index.txt` — N ordered lines.
 *   4. `apps/ai/nexus_ai/api/routes_chapter.py` — the "THE N-CHAPTER ..." fence, which must be
 *      DERIVED from the index rather than written as a literal (see the D1534 note below).
 *
 * D1534 — why source 4 inverted its assertion. This reader used to require a literal digit in
 * routes_chapter.py and compare it to N. That made the reader a participant in the drift it exists
 * to catch: the literal was correct at 175, the arc reached 178, and the prompt told the model the
 * world ended three chapters early — for three chapters, silently, because a wrong number inside a
 * sentence no test asserts on is invisible. The route now counts the index's own numbered rows
 * (`_atlas_chapter_count`), so the sentence is right by construction. The assertion therefore
 * inverted: a LITERAL number here is now the offender, because a literal is the only shape of this
 * sentence that can be wrong.
 *
 * Exit 0 agree · 1 offender (drift) · 2 unreadable plane (a refusal, not a pass).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// D1534: `--root` exists so `falsify_atlas_fence.mjs` can point the SAME shipped checker at a fixture
// tree instead of a copy of it. A mutation whose only difference is the code under test is the only
// kind that proves anything about the code under test.
const argRoot = process.argv.indexOf('--root');
const ROOT = resolve(
  argRoot > -1 && process.argv[argRoot + 1]
    ? process.argv[argRoot + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..'),
);
const p = (rel) => join(ROOT, rel);

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const MUL = { 十: 10, 百: 100, 千: 1000 };
function cnInt(raw) {
  let total = 0, cur = 0;
  for (const ch of raw) {
    if (ch === '零') continue;
    if (CN[ch] !== undefined) cur = cur * 10 + CN[ch];
    else if (MUL[ch] !== undefined) { total += (cur || 1) * MUL[ch]; cur = 0; }
    else return null;
  }
  return total + cur;
}

let seed, digest, index, route;
try {
  seed = readFileSync(p('apps/web/src/lib/mock/seed.ts'), 'utf8');
  digest = readFileSync(p('apps/ai/nexus_ai/models/atlas_digest.txt'), 'utf8');
  index = readFileSync(p('apps/ai/nexus_ai/models/atlas_index.txt'), 'utf8');
  route = readFileSync(p('apps/ai/nexus_ai/api/routes_chapter.py'), 'utf8');
} catch (e) {
  console.log('RESULT: NOT CHECKED — atlas plane unreadable: ' + e.message);
  process.exit(2);
}

const nums = new Set();
for (const m of seed.matchAll(/title: '[^']*第([一二三四五六七八九十百零]{1,7})章[^']*'/g)) {
  const n = cnInt(m[1]);
  if (n !== null && n > 0) nums.add(n);
}
if (nums.size < 100) {
  console.log(`RESULT: NOT CHECKED — only ${nums.size} canonical chapters parsed from seed.ts`);
  process.exit(2);
}
const corpusN = Math.max(...nums);

const digestN = Number((digest.match(/^# .*?·\s*(\d+)\s+chapters/m) || [])[1] || 0);
const digestLines = (digest.match(/^\s*\d+\s*·/gm) || []).length;
const indexLines = (index.match(/^\s*\d+\s*·/gm) || []).length;
const fenceN = Number((route.match(/THE\s+(\d+)-CHAPTER HONG KONG ARC/) || [])[1] || 0);

// D1534: the fence must be DERIVED, never literal. Two facts prove the derivation is live: the
// counter exists in the module, and the assembled sentence reads its value instead of a digit.
const fenceDerived =
  /def _atlas_chapter_count\(/.test(route) && /\+ "-CHAPTER HONG KONG ARC/.test(route);
const fenceState = fenceDerived ? 'derived' : fenceN ? `literal ${fenceN}` : 'missing';

const offenders = [];
if (digestN !== corpusN) offenders.push(`atlas_digest header ${digestN} != corpus ${corpusN}`);
if (digestLines !== corpusN) offenders.push(`atlas_digest has ${digestLines} chapter lines != corpus ${corpusN}`);
if (indexLines !== corpusN) offenders.push(`atlas_index has ${indexLines} chapter lines != corpus ${corpusN}`);
if (fenceState !== 'derived')
  offenders.push(`routes_chapter fence is ${fenceState}, not derived from the index (corpus ${corpusN})`);

if (offenders.length) {
  console.log(`RESULT: FAIL — ${offenders.length} atlas drift offender(s)`);
  for (const o of offenders) console.log('  - ' + o);
  console.log('  regenerate: cd apps/ai && uv run python gen_atlas_digest.py && uv run python gen_atlas_index.py');
  process.exit(1);
}
console.log(`RESULT: PASS — atlas lockstep at ${corpusN} chapters (digest ${digestLines} / index ${indexLines} / fence ${fenceState})`);
