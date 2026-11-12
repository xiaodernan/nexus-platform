#!/usr/bin/env node
/**
 * NEXUS D972 — the AI tool-result cache's expiry heap must stay bounded by the cap, not by write count.
 *
 * THE HOLE. `apps/ai/nexus_ai/tools/registry.py::_Cache` is a bounded LRU (`_store`, cap
 * `max_entries`) with an expiry min-heap (`_expiry_heap`) for amortized O(log n) sweeping (D903
 * bounded the store; D913 added the heap). `set` pushed one `(expires, ck)` tuple per write, but
 * LRU eviction (`popitem`) and overwrites left those tuples inside the heap — heapq has no
 * O(log n) arbitrary delete — so stale tuples only left via `_sweep_expired` when their TTL came
 * due, which never happens while the clock is frozen. Measured: cap=8, 2000 distinct-arg writes
 * -> store=8 but heap=2000 (250x); overwrite one key 500x -> heap=500. Every tuple retains
 * `(spec.name, canonicalized-args-json)`, so high-cardinality argument traffic grows memory and
 * sweep cost with the number of distinct args seen — contradicting D903's own docstring promise
 * that "both memory and the sweep cost are bounded by the cap rather than by the number of
 * distinct args seen". The shipped D903 door only asserted `len(cache._store) <= 8`; it never
 * inspected the heap, so the leak was invisible to CI.
 *
 * THE FIX (D972). The heap tuple carries a generation `seq`; `_heap_token[ck]` records the one
 * LIVE tuple's seq per stored key (a store-only filter cannot dedupe repeated writes of one key
 * with identical expires — only a generation can). Each `set` increments `_seq`, supersedes the
 * key's token, pushes `(expires, seq, ck)`, and drops the LRU-evicted key's token; an expired
 * `get` drops its token too, so the token index cannot leak. `_sweep_expired` deletes the store
 * entry only when `token.get(ck) == seq` and the store still holds that exact expires, else it
 * discards a stale tuple. Once `len(heap) > factor * max_entries + 1`, `_compact_heap()` rebuilds
 * from live tuples + `heapify`; that is O(len(heap)) once per O(cap) writes, so the amortized
 * per-write cost stays O(log n) (D913) while the heap is now O(cap) (D903). No TTL, LRU,
 * overwrite or expired-sweep semantics change; the D903/D913 ledgers are untouched.
 *
 * WHAT THIS DOES NOT CLAIM. That any live-traffic memory profile was measured, that any test ran
 * today, or any latency/throughput/footprint number. The behavioural proof is the offline pytest
 * probe `apps/ai/tests/test_d972_cache_heap_is_bounded.py` (fake clock, no Redis/DB/network/JVM):
 * a churn arm bounds the heap after 2000 writes; a one-flipped-variable falsifier monkeypatches
 * `_compact_heap` to a no-op and requires the heap to return to write-count growth; plus overwrite,
 * generation-guard, expired-read-token and D903-semantic arms. This reader judges only source
 * text and wiring.
 *
 * SELF-TEST. `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in
 * memory: revert the heap to the old 2-tuple shape, drop the generation / token / compaction, cut
 * the eviction / expired-read token cleanup, weaken the sweep gate, erase each probe arm, cut the
 * CI/ATLAS/ledger bindings, and remove the reader. Every arm carries an `expect` substring the
 * offender MUST contain (red-for-the-wrong-reason still fails), a D954 no-op snapshot guard (a
 * corruption that changes no byte is a defect), and a D959 line-anchored ledger-heading match
 * (this reader's own prose quotes the heading, so a plain `.includes` would be a vacuous needle).
 * Revert arms use the EXACT forbidden token the judge asserts absent/present, so a mutant cannot
 * be vacuous because its shape slipped past the assertion (a trap D969's first self-test run hit).
 * One GREEN control (a harmless docstring change must NOT redden the reader) guards the other side.
 * The `expect` tag is read from either tuple shape from the start — D962's first self-test run
 * bound only `arm.expect` while the tags lived in a third tuple slot and silently scored thirteen
 * arms GREEN/WRONG; that lesson is baked in here.
 *
 * Usage:  node scripts/check_cache_heap_bounded.mjs [--self-test] [--report] [--ci=<path>]
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

const REGISTRY = 'apps/ai/nexus_ai/tools/registry.py';
const D903_DOOR = 'apps/ai/tests/test_d903_cache_is_bounded.py';
const PROBE = 'apps/ai/tests/test_d972_cache_heap_is_bounded.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_cache_heap_bounded.mjs';
const PATHS = [REGISTRY, D903_DOOR, PROBE, CI, ATLAS, STATUS, SELF];

/* Exact source needles. */
const TUPLE_DECL = 'self._expiry_heap: list[tuple[float, int, tuple[str, str]]] = []';
const OLD_TUPLE_DECL = 'self._expiry_heap: list[tuple[float, tuple[str, str]]] = []';
const OLD_PUSH = 'heapq.heappush(self._expiry_heap, (expires, ck))';
const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 972\. D972(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the cache-heap plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the old unbounded shapes are gone. */
  absent(REGISTRY, OLD_TUPLE_DECL, 'the old 2-tuple heap declaration is gone', 'NO-OLD-TUPLE');
  absent(REGISTRY, OLD_PUSH, 'the old 2-tuple push is gone', 'NO-OLD-PUSH');

  /* 2 — generation + live-token index bound the heap. */
  has(REGISTRY, TUPLE_DECL, 'the heap tuple carries a generation seq', 'TUPLE-SEQ');
  has(REGISTRY, 'self._heap_token: dict[tuple[str, str], int] = {}', 'the live-token index exists', 'TOKEN-INDEX');
  has(REGISTRY, 'self._seq = 0', 'the generation counter is seeded', 'SEQ-SEED');
  has(REGISTRY, 'self._compact_factor = 2', 'the compaction factor is declared', 'FACTOR');
  has(REGISTRY, 'heapq.heappush(self._expiry_heap, (expires, seq, ck))', 'writes push a seq-bearing tuple', 'SEQ-PUSH');
  has(REGISTRY, 'self._seq += 1', 'each write advances the generation', 'SEQ-INC');
  has(REGISTRY, 'self._heap_token[ck] = seq', 'a write supersedes the key live token', 'TOKEN-SET');

  /* 3 — every store-deletion path releases its token, so the index cannot leak. */
  has(REGISTRY, 'self._heap_token.pop(evicted_ck, None)', 'LRU eviction drops the evicted key token', 'TOKEN-EVICT');
  has(REGISTRY, 'self._heap_token.pop(ck, None)', 'an expired read drops the key token', 'TOKEN-GET');
  has(REGISTRY, 'del self._heap_token[ck]', 'a swept expiry drops the key token', 'TOKEN-SWEEP');
  has(REGISTRY, 'expires_at, seq, ck = heapq.heappop(self._expiry_heap)', 'the sweep reads the tuple seq', 'SWEEP-SEQ');
  // Anchored to the SWEEP's full condition: `self._heap_token.get(ck) == seq` ALSO appears in
  // _compact_heap's comprehension, so a shorter needle would let one mutation leave the other
  // occurrence intact and score a vacuous GREEN (the D969 trap). Only the sweep checks `entry`.
  has(REGISTRY, 'if (self._heap_token.get(ck) == seq and entry is not None', 'the sweep is generation-gated', 'SWEEP-GATE');

  /* 4 — amortized compaction keeps the heap O(cap). */
  has(REGISTRY, 'if len(self._expiry_heap) > self._compact_factor * self._max + 1:', 'the compaction threshold is present', 'COMPACT-GATE');
  has(REGISTRY, 'self._compact_heap()', 'set triggers compaction', 'COMPACT-CALL');
  has(REGISTRY, 'def _compact_heap(self) -> None:', 'the compaction method exists', 'COMPACT-DEF');
  has(REGISTRY, 'heapq.heapify(live)', 'compaction rebuilds a valid heap', 'COMPACT-HEAPIFY');
  has(REGISTRY, 'self._expiry_heap = live', 'compaction replaces the heap with live tuples', 'COMPACT-REPLACE');

  /* 5 — D903 / D913 semantics survive (this is explicitly NOT a rewrite). */
  has(REGISTRY, 'while len(self._store) > self._max:', 'the bounded LRU eviction loop survives', 'LRU-LOOP');
  has(REGISTRY, 'self._store.popitem(last=False)', 'least-recently-used eviction survives', 'LRU-POP');
  has(REGISTRY, 'return _MISS', 'the miss sentinel contract survives', 'MISS-SENTINEL');
  has(D903_DOOR, 'def test_r1_store_never_exceeds_the_bound(self):', 'the shipped D903 door still ships', 'D903-DOOR');

  /* 6 — the runnable behavioural proof + its one-flipped-variable falsifier ship. */
  has(PROBE, 'def test_heap_stays_bounded_under_distinct_arg_churn():', 'the positive arm exists', 'PROBE-POSITIVE');
  has(PROBE, 'def test_compaction_disabled_is_the_one_variable_falsifier(monkeypatch):', 'the falsifier arm exists', 'PROBE-FALSIFIER');
  has(PROBE, 'def test_overwrite_same_key_keeps_heap_bounded_and_value_fresh():', 'the same-expires overwrite arm exists', 'PROBE-OVERWRITE');
  has(PROBE, 'def test_generation_guards_a_fresh_value_when_a_stale_tuple_expires():', 'the generation-guard arm exists', 'PROBE-GEN');
  has(PROBE, 'def test_expired_read_drops_the_live_token():', 'the token-cleanup arm exists', 'PROBE-TOKEN');
  has(PROBE, 'def test_ttl_and_lru_semantics_are_unchanged():', 'the D903-semantic regression arm exists', 'PROBE-SEMANTICS');
  has(PROBE, 'monkeypatch.setattr(_Cache, "_compact_heap", lambda self: None, raising=True)', 'the falsifier flips exactly one variable (compaction)', 'FLIP-VARIABLE');
  has(PROBE, 'len(cache._expiry_heap) <= BOUND', 'the positive arm asserts the heap bound', 'POSITIVE-ASSERT');
  has(PROBE, 'len(cache._expiry_heap) == WRITES', 'the falsifier asserts write-count growth returns', 'FALSIFIER-ASSERT');

  /* 7 — wiring: CI runs this reader AND the ai-job pytest probe; docs + ledger. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ciPath, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push('MISSING — docs/STATUS.md: no `## 972. D972` heading line [LEDGER-HEADING]');
  } else notes.push('held the ledger holds a D972 heading line');

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
  f.set(p, text.replace(from, to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present, CI_OVERRIDE ?? CI);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const ciPath = CI_OVERRIDE ?? CI;
  // Each revert arm plants the EXACT forbidden token `judge` asserts, so it cannot be vacuous
  // by slipping past the assertion in a different source shape (D969's first-run trap).
  const arms = [
    ['heap reverted to old 2-tuple decl', mutate(real, REGISTRY, TUPLE_DECL, OLD_TUPLE_DECL), 'NO-OLD-TUPLE'],
    ['push reverted to old 2-tuple', mutate(real, REGISTRY, 'heapq.heappush(self._expiry_heap, (expires, seq, ck))', OLD_PUSH), 'NO-OLD-PUSH'],
    ['generation tuple dropped', mutate(real, REGISTRY, TUPLE_DECL, OLD_TUPLE_DECL), 'TUPLE-SEQ'],
    ['live-token index erased', mutate(real, REGISTRY, 'self._heap_token: dict[tuple[str, str], int] = {}', 'self._heap_token = None  # removed'), 'TOKEN-INDEX'],
    ['seq counter erased', mutate(real, REGISTRY, 'self._seq = 0', 'self._seq = None'), 'SEQ-SEED'],
    ['compaction factor erased', mutate(real, REGISTRY, 'self._compact_factor = 2', 'self._compact_factor = 0'), 'FACTOR'],
    ['seq-bearing push weakened', mutate(real, REGISTRY, 'heapq.heappush(self._expiry_heap, (expires, seq, ck))', OLD_PUSH), 'SEQ-PUSH'],
    ['seq increment removed', mutate(real, REGISTRY, 'self._seq += 1', 'self._seq += 0'), 'SEQ-INC'],
    ['live-token set removed', mutate(real, REGISTRY, 'self._heap_token[ck] = seq', 'pass  # no token'), 'TOKEN-SET'],
    ['eviction token cleanup cut', mutate(real, REGISTRY, 'self._heap_token.pop(evicted_ck, None)', 'pass  # eviction leak'), 'TOKEN-EVICT'],
    ['expired-read token cleanup cut', mutate(real, REGISTRY, 'self._heap_token.pop(ck, None)', 'pass  # get leak'), 'TOKEN-GET'],
    ['sweep token cleanup cut', mutate(real, REGISTRY, 'del self._heap_token[ck]', 'pass  # sweep leak'), 'TOKEN-SWEEP'],
    ['sweep seq read dropped', mutate(real, REGISTRY, 'expires_at, seq, ck = heapq.heappop(self._expiry_heap)', 'expires_at, ck = heapq.heappop(self._expiry_heap)'), 'SWEEP-SEQ'],
    ['sweep generation gate removed', mutate(real, REGISTRY, 'if (self._heap_token.get(ck) == seq and entry is not None', 'if (entry is not None'), 'SWEEP-GATE'],
    ['compaction threshold removed', mutate(real, REGISTRY, 'if len(self._expiry_heap) > self._compact_factor * self._max + 1:', 'if False:  # no compaction'), 'COMPACT-GATE'],
    ['compaction call cut', mutate(real, REGISTRY, 'self._compact_heap()', 'pass  # no compaction'), 'COMPACT-CALL'],
    ['compaction method erased', mutate(real, REGISTRY, 'def _compact_heap(self) -> None:', 'def _unused_compact(self) -> None:'), 'COMPACT-DEF'],
    ['compaction heapify removed', mutate(real, REGISTRY, 'heapq.heapify(live)', 'pass  # invalid heap'), 'COMPACT-HEAPIFY'],
    ['compaction replace removed', mutate(real, REGISTRY, 'self._expiry_heap = live', 'pass  # stale heap kept'), 'COMPACT-REPLACE'],
    ['LRU eviction loop cut', mutate(real, REGISTRY, 'while len(self._store) > self._max:', 'while False:'), 'LRU-LOOP'],
    ['probe positive arm erased', mutate(real, PROBE, 'def test_heap_stays_bounded_under_distinct_arg_churn():', 'def _positive_removed():'), 'PROBE-POSITIVE'],
    ['probe falsifier arm erased', mutate(real, PROBE, 'def test_compaction_disabled_is_the_one_variable_falsifier(monkeypatch):', 'def _falsifier_removed(monkeypatch):'), 'PROBE-FALSIFIER'],
    ['falsifier flip-variable weakened', mutate(real, PROBE, 'monkeypatch.setattr(_Cache, "_compact_heap", lambda self: None, raising=True)', 'monkeypatch.setattr(_Cache, "_compact_heap", _Cache._compact_heap, raising=True)'), 'FLIP-VARIABLE'],
    ['probe generation-guard arm erased', mutate(real, PROBE, 'def test_generation_guards_a_fresh_value_when_a_stale_tuple_expires():', 'def _gen_removed():'), 'PROBE-GEN'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, ciPath, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ATLAS probe row erased', mutate(real, ATLAS, PROBE, 'apps/ai/tests/_removed.py'), 'ATLAS-PROBE'],
    ['ledger D972 heading line removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [labelText, arm, tag] of arms) {
    const expect = arm.expect ?? tag;
    if (arm.skipped) { console.log(`  self-test  ${labelText.padEnd(50)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) {
      console.log(`  self-test  ${labelText.padEnd(50)} NO-OP (defect!)`);
      allCaught = false;
      continue;
    }
    const j = judge(arm.files, arm.present ?? present, ciPath);
    const joined = j.offenders.join(' | ');
    const red = j.unchecked !== null || j.offenders.length > 0;
    const rightReason = joined.includes(expect);
    const pass = red && rightReason;
    if (!pass) allCaught = false;
    console.log(`  self-test  ${labelText.padEnd(50)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${j.offenders.length} expect=${JSON.stringify(expect)}`);
    if (red && !rightReason) for (const o of j.offenders.slice(0, 2)) console.log('      got: ' + o);
  }

  // GREEN control: a harmless COMMENT wording change must NOT redden the reader. The from-string
  // must exist verbatim in the source — otherwise mutate() skips it and the control is a vacuous
  // GREEN (it judged the unchanged base). Guard that explicitly (a D954-class lesson).
  const control = mutate(real, REGISTRY,
    '# D972: only the generation still recorded in _heap_token may delete the store',
    '# D972: only the still-recorded generation in _heap_token may delete the store');
  let controlGreen = false;
  if (control.skipped) {
    console.log(`  self-test  ${'harmless comment rewording stays GREEN'.padEnd(50)} NO-OP/SKIP (defect!) ${control.skipped}`);
    allCaught = false;
  } else {
    const controlJudge = judge(control.files, present, ciPath);
    controlGreen = controlJudge.offenders.length === 0 && controlJudge.unchecked === null;
    if (!controlGreen) allCaught = false;
    console.log(`  self-test  ${'harmless comment rewording stays GREEN'.padEnd(50)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${controlJudge.offenders.length}`);
    if (!controlGreen) for (const o of controlJudge.offenders.slice(0, 4)) console.log('      ' + o);
  }

  console.log(`  self-test  all arms redden for cause + control green: ${allCaught} (${arms.length} corruption arms + 1 control)`);
  process.exit(allCaught ? 0 : 1);
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk();
const result = judge(files, present, ciPath);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`FALSE CACHE-HEAP-BOUNDED WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D972 cache expiry heap bounded by the cap, ${result.notes.length} holds`);
process.exit(0);
