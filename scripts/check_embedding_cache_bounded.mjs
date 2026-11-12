#!/usr/bin/env node
/**
 * NEXUS D974 — the module-level embedding cache must be bounded by the cap, and the HTTP
 * embed path must reuse one pooled client, not open a TCP(+TLS) connection per embed call.
 *
 * THE HOLE. `apps/ai/nexus_ai/models/embeddings.py::_CACHE` is a plain module-level dict
 * keyed by `(name/model, RAW TEXT)`; the text is external input (a RAG query from
 * `api/routes_rag.py`, a document chunk from `rag/embed.py`), high-cardinality and
 * caller-controlled. Each value is a 1024-d float tuple (~32 KB). The DEV-DEFAULT
 * `HashingEmbedding.embed_one` wrote it unconditionally, so with NO infra configured every
 * distinct query/chunk was retained forever. Measured before the fix: 2000 distinct queries
 * -> 2000 entries -> ~62 MiB. This is D903/D972's hole on a module those units never touched;
 * their doors inspected `registry.py`, not this dict, so CI never saw it. The same module's
 * `HttpEmbedding.embed` also did `client = self._client or httpx.AsyncClient(...)` + a
 * `finally: await client.aclose()` on EVERY call, paying a full handshake per embed — D969's
 * hole, still open on a second adapter.
 *
 * THE FIX (D974). `_CACHE` is an `OrderedDict` capped at `_CACHE_MAX` (default 4096):
 * `_cache_get` promotes a hit (`move_to_end`), `_cache_put` drops the coldest entry
 * (`popitem(last=False)`) once the cap is crossed — O(1) per op, so the amortized hot-set hit
 * cost is unchanged (matching D913's discipline) while memory is now O(cap). Both write paths
 * (`embed_one` and `HttpEmbedding.embed`) route through the helpers. Client reuse: a
 * module-level `_HTTP_CLIENT`, lazily built by `_shared_client`, released by
 * `aclose_embedding_client()` in the lifespan; an injected client is used verbatim and never
 * closed by a call. The factory still returns a FRESH adapter per call — only the connection
 * is shared. No returned vector, DIM=1024, D507 index placement, D705 semantic verdict or
 * factory-degrade contract changes.
 *
 * WHAT THIS DOES NOT CLAIM. No live-traffic memory/latency number was measured; no
 * throughput or footprint figure. The cap is a structural bound proven by an offline probe,
 * not a benchmark. This reader judges only source text and wiring.
 *
 * SELF-TEST. `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in
 * memory: revert the LRU to a plain unbounded dict, drop the cap/helpers/eviction, cut one of
 * the two write paths back to a raw `_CACHE[...]`, weaken the LRU promotion, undo the pooled
 * client to a per-call construct, close the injected client, erase each probe arm, cut the
 * CI/ATLAS/ledger bindings, and remove the reader. Every arm carries an `expect` substring
 * the offender MUST contain (red-for-the-wrong-reason still fails), a D954 no-op snapshot
 * guard (a corruption that changes no byte is a defect), and a D959 line-anchored ledger
 * heading (this reader's own prose quotes the heading, so a plain `.includes` is vacuous).
 * Revert arms use the EXACT forbidden token `judge` asserts, so a mutant cannot be vacuous by
 * slipping past the assertion in a different source shape (D969's first-run trap). One GREEN
 * control (a harmless comment rewording must NOT redden the reader) guards the other side, and
 * its from-string is explicitly guarded against a skipped/vacuous mutation. The `expect` tag
 * is read from either tuple shape from the start — D962's first run bound only `arm.expect`
 * while the tags lived in a third slot and silently scored thirteen arms GREEN/WRONG.
 *
 * Usage:  node scripts/check_embedding_cache_bounded.mjs [--self-test] [--report] [--ci=<path>]
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

const EMB = 'apps/ai/nexus_ai/models/embeddings.py';
const APP = 'apps/ai/nexus_ai/api/app.py';
const PROBE = 'apps/ai/tests/test_d974_embedding_cache_is_bounded.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_embedding_cache_bounded.mjs';
const PATHS = [EMB, APP, PROBE, CI, ATLAS, STATUS, SELF];

/* Exact source needles. */
const OLD_DECL = '_CACHE: dict[tuple[str, str], tuple[float, ...]] = {}';
const NEW_DECL = '_CACHE: OrderedDict[tuple[str, str], tuple[float, ...]] = OrderedDict()';
const OLD_HASH_READ = 'cached = _CACHE.get((self.name, text))';
const OLD_HTTP_READ = 'hit = _CACHE.get((self.model, t or ""))';
const OLD_HTTP_CLIENT = 'client = self._client or httpx.AsyncClient(timeout=self.timeout_s)';
const OLD_FINALLY = 'await client.aclose()';
const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 974\. D974(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the embedding-cache plane is empty or unreadable — a census that found nothing cleared nothing' };
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
  // A needle that legitimately appears N times must be checked by COUNT, not `.includes`:
  // otherwise mutating one occurrence leaves the others and the corruption scores a vacuous
  // GREEN (D962/D969's trap). `_CACHE.move_to_end(key)` appears in BOTH _cache_get (promote)
  // and _cache_put (insert); losing either must redden the reader.
  const countAtLeast = (p, needle, min, label, expect) => {
    const got = t(p).split(needle).length - 1;
    if (got < min) offenders.push(`MISSING — ${p}: ${label} (found ${got}, need >= ${min})${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label} (${got} occurrences)`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the old unbounded shape and its raw accesses are gone. */
  absent(EMB, OLD_DECL, 'the old plain-dict declaration is gone', 'NO-OLD-DECL');
  absent(EMB, OLD_HASH_READ, 'the hashing write-path no longer reads the raw dict', 'NO-OLD-HASH-READ');
  absent(EMB, OLD_HTTP_READ, 'the http write-path no longer reads the raw dict', 'NO-OLD-HTTP-READ');

  /* 2 — a bounded LRU guards the cache. */
  has(EMB, NEW_DECL, 'the cache is an OrderedDict', 'LRU-DECL');
  has(EMB, 'from collections import OrderedDict', 'OrderedDict is imported', 'LRU-IMPORT');
  has(EMB, '_CACHE_MAX = 4096', 'the cap constant is declared', 'CAP-CONST');
  has(EMB, 'def _cache_get(key: tuple[str, str]) -> tuple[float, ...] | None:', 'the LRU read helper exists', 'GET-HELPER');
  has(EMB, 'def _cache_put(key: tuple[str, str], vec: tuple[float, ...]) -> None:', 'the LRU write helper exists', 'PUT-HELPER');
  // Both the read-promotion AND the write-insert must promote; a single occurrence is not enough.
  countAtLeast(EMB, '_CACHE.move_to_end(key)', 2, 'both the hit-promotion and the insert promote to most-recent', 'PROMOTE');
  has(EMB, 'while len(_CACHE) > _CACHE_MAX:', 'the eviction threshold is present', 'EVICT-GATE');
  has(EMB, '_CACHE.popitem(last=False)', 'the coldest entry is evicted', 'EVICT-POP');

  /* 3 — BOTH write paths route through the bounded helper (a single path is not enough). */
  has(EMB, '_cache_get((self.name, text))', 'hashing reads through the LRU helper', 'HASH-GET');
  has(EMB, '_cache_put((self.name, text), tuple(out))', 'hashing writes through the bounded helper', 'HASH-PUT');
  has(EMB, '_cache_get((self.model, t or ""))', 'http reads through the LRU helper', 'HTTP-GET');
  has(EMB, '_cache_put((self.model, text), tuple(vec))', 'http writes through the bounded helper', 'HTTP-PUT');

  /* 4 — the HTTP client is pooled, not built/closed per embed call. */
  has(EMB, '_HTTP_CLIENT: Any = None', 'the module-level client handle exists', 'POOL-HANDLE');
  has(EMB, 'def _shared_client(timeout_s: float):', 'the lazy builder exists', 'POOL-BUILDER');
  has(EMB, 'client = self._client or _shared_client(self.timeout_s)', 'embed uses the pooled client', 'POOL-USE');
  has(EMB, 'async def aclose_embedding_client() -> None:', 'the shutdown hook exists', 'POOL-CLOSE');
  absent(EMB, OLD_HTTP_CLIENT, 'no per-call AsyncClient construction remains', 'NO-PER-CALL');
  absent(EMB, OLD_FINALLY, 'no per-call client close remains', 'NO-PER-CALL-CLOSE');

  /* 5 — factory / dimension / D507 / D705 contracts survive (explicitly NOT a rewrite). */
  has(EMB, 'DIM = 1024', 'the fixed dimension survives', 'DIM');
  has(EMB, 'semantic = False', 'the hashing non-semantic verdict survives', 'SEM-HASH');
  has(EMB, 'semantic = True', 'the http semantic verdict survives', 'SEM-HTTP');
  has(EMB, 'resp.raise_for_status()', 'http status enforcement survives', 'RAISE-STATUS');
  has(EMB, 'index = item["index"]', 'D507 endpoint-index placement survives', 'D507-INDEX');
  has(EMB, 'return HttpEmbedding(base_url=settings.embedding_base_url,', 'the factory still builds a fresh adapter', 'FACTORY-FRESH');
  has(APP, 'await aclose_embedding_client()', 'the lifespan calls the shutdown hook', 'LIFESPAN-HOOK');

  /* 6 — the runnable behavioural proof + its one-flipped-variable falsifier ship. */
  has(PROBE, 'def test_cache_stays_bounded_under_distinct_query_churn():', 'the positive arm exists', 'PROBE-POSITIVE');
  has(PROBE, 'def test_eviction_disabled_is_the_one_variable_falsifier(monkeypatch):', 'the falsifier arm exists', 'PROBE-FALSIFIER');
  has(PROBE, 'def test_lru_promotes_a_hit_and_evicts_the_coldest_not_fifo(monkeypatch):', 'the LRU-not-FIFO arm exists', 'PROBE-LRU');
  has(PROBE, 'def test_eviction_never_changes_a_vector_value():', 'the value-invariance arm exists', 'PROBE-VALUE');
  has(PROBE, 'def test_http_embed_builds_one_shared_client_for_n_calls(monkeypatch):', 'the client-reuse arm exists', 'PROBE-POOL');
  has(PROBE, 'def test_per_call_client_is_the_falsifier_and_injected_client_survives(monkeypatch):', 'the client falsifier arm exists', 'PROBE-POOL-FALSIFIER');
  has(PROBE, 'assert len(E._CACHE) <= E._CACHE_MAX', 'the positive arm asserts the cap', 'POSITIVE-ASSERT');
  has(PROBE, 'assert len(E._CACHE) == 2000', 'the cache falsifier asserts write-count growth returns', 'FALSIFIER-ASSERT');
  // The falsifier's no-evict shim must be visibly FREE of the eviction loop — that missing
  // `popitem(last=False)` is the one flipped variable. Anchor it to the shim's own comment so a
  // mutant that quietly restores eviction reddens (a plain assert-needle would stay vacuous).
  has(PROBE, 'deliberately no popitem(last=False): the pre-fix behaviour', 'the falsifier shim omits eviction (one flipped variable)', 'FALSIFIER-NO-EVICT');
  has(PROBE, 'assert len(built) == 1', 'the client-reuse arm asserts one construction', 'POOL-ASSERT');

  /* 7 — wiring: CI runs this reader AND the ai-job pytest probe; docs + ledger. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ciPath, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push('MISSING — docs/STATUS.md: no `## 974. D974` heading line [LEDGER-HEADING]');
  } else notes.push('held the ledger holds a D974 heading line');

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
    ['cache reverted to plain unbounded dict', mutate(real, EMB, NEW_DECL, OLD_DECL), 'NO-OLD-DECL'],
    ['OrderedDict import dropped', mutate(real, EMB, 'from collections import OrderedDict', 'from collections import dict  # no OrderedDict'), 'LRU-IMPORT'],
    ['cap constant dropped', mutate(real, EMB, '_CACHE_MAX = 4096', '_CACHE_MAX = float("inf")'), 'CAP-CONST'],
    ['read helper erased', mutate(real, EMB, 'def _cache_get(key: tuple[str, str]) -> tuple[float, ...] | None:', 'def _cache_get_removed(key):'), 'GET-HELPER'],
    ['write helper erased', mutate(real, EMB, 'def _cache_put(key: tuple[str, str], vec: tuple[float, ...]) -> None:', 'def _cache_put_removed(key, vec):'), 'PUT-HELPER'],
    ['read-path LRU promotion cut (count drops to 1)', mutate(real, EMB, '    if hit is not None:\n        _CACHE.move_to_end(key)\n    return hit', '    if hit is not None:\n        pass  # no promotion\n    return hit'), 'PROMOTE'],
    ['eviction threshold cut', mutate(real, EMB, 'while len(_CACHE) > _CACHE_MAX:', 'while False:  # D974 falsifier: eviction disabled'), 'EVICT-GATE'],
    ['eviction pop cut', mutate(real, EMB, '_CACHE.popitem(last=False)', 'pass  # no eviction'), 'EVICT-POP'],
    ['hashing read reverted to raw dict', mutate(real, EMB, '_cache_get((self.name, text))', OLD_HASH_READ.replace('cached = ', '')), 'HASH-GET'],
    ['hashing write reverted to raw dict', mutate(real, EMB, '_cache_put((self.name, text), tuple(out))', '_CACHE[(self.name, text)] = tuple(out)'), 'HASH-PUT'],
    ['http read reverted to raw dict', mutate(real, EMB, '_cache_get((self.model, t or ""))', OLD_HTTP_READ.replace('hit = ', '')), 'HTTP-GET'],
    ['http write reverted to raw dict', mutate(real, EMB, '_cache_put((self.model, text), tuple(vec))', '_CACHE[(self.model, text)] = tuple(vec)'), 'HTTP-PUT'],
    ['pool handle erased', mutate(real, EMB, '_HTTP_CLIENT: Any = None', '_HTTP_CLIENT = None  # handle removed'), 'POOL-HANDLE'],
    ['lazy builder erased', mutate(real, EMB, 'def _shared_client(timeout_s: float):', 'def _shared_client_removed(timeout_s):'), 'POOL-BUILDER'],
    ['pooled use reverted to per-call', mutate(real, EMB, 'client = self._client or _shared_client(self.timeout_s)', OLD_HTTP_CLIENT), 'NO-PER-CALL'],
    ['shutdown hook erased', mutate(real, EMB, 'async def aclose_embedding_client() -> None:', 'async def _aclose_removed() -> None:'), 'POOL-CLOSE'],
    ['per-call close restored', mutate(real, EMB, '            # D974: no per-call close — the pooled client outlives this request and is released\n            # by aclose_embedding_client() at shutdown; an injected client is the caller\'s to own.', '            await client.aclose()  # per-call close restored'), 'NO-PER-CALL-CLOSE'],
    ['dimension contract dropped', mutate(real, EMB, 'DIM = 1024', 'DIM = 768'), 'DIM'],
    ['hashing semantic verdict flipped', mutate(real, EMB, 'semantic = False', 'semantic = True'), 'SEM-HASH'],
    ['http status enforcement cut', mutate(real, EMB, 'resp.raise_for_status()', 'pass  # no status check'), 'RAISE-STATUS'],
    ['D507 index placement cut', mutate(real, EMB, 'index = item["index"]', 'index = 0'), 'D507-INDEX'],
    ['factory no longer fresh', mutate(real, EMB, 'return HttpEmbedding(base_url=settings.embedding_base_url,', 'return _CACHED_HTTP_ADAPTER  # stale singleton'), 'FACTORY-FRESH'],
    ['lifespan shutdown hook cut', mutate(real, APP, 'await aclose_embedding_client()', 'pass  # no embedding client close'), 'LIFESPAN-HOOK'],
    ['probe positive arm erased', mutate(real, PROBE, 'def test_cache_stays_bounded_under_distinct_query_churn():', 'def _positive_removed():'), 'PROBE-POSITIVE'],
    ['probe falsifier arm erased', mutate(real, PROBE, 'def test_eviction_disabled_is_the_one_variable_falsifier(monkeypatch):', 'def _falsifier_removed(monkeypatch):'), 'PROBE-FALSIFIER'],
    ['probe LRU arm erased', mutate(real, PROBE, 'def test_lru_promotes_a_hit_and_evicts_the_coldest_not_fifo(monkeypatch):', 'def _lru_removed(monkeypatch):'), 'PROBE-LRU'],
    ['probe client-reuse arm erased', mutate(real, PROBE, 'def test_http_embed_builds_one_shared_client_for_n_calls(monkeypatch):', 'def _pool_removed(monkeypatch):'), 'PROBE-POOL'],
    ['falsifier shim silently restores eviction', mutate(real, PROBE, '# deliberately no popitem(last=False): the pre-fix behaviour', 'while len(E._CACHE) > E._CACHE_MAX: E._CACHE.popitem(last=False)'), 'FALSIFIER-NO-EVICT'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, ciPath, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ATLAS probe row erased', mutate(real, ATLAS, PROBE, 'apps/ai/tests/_removed.py'), 'ATLAS-PROBE'],
    ['ledger D974 heading line removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
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
  const control = mutate(real, EMB,
    '# D903/D972 bounded the tool-result cache; this is the SAME class of hole on a different,',
    '# D903/D972 bounded the tool-result cache; this is the very same class of hole, on a different,');
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
  console.log(`FALSE EMBEDDING-CACHE-BOUNDED WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D974 embedding cache bounded by the cap, ${result.notes.length} holds`);
