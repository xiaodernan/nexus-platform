#!/usr/bin/env node
/**
 * NEXUS D969 — the AI→platform HTTP adapter must REUSE one pooled AsyncClient across relays.
 *
 * THE HOLE. `apps/ai/nexus_ai/adapters/platform.py::HttpPlatformClient._request` used to do
 * `async with httpx.AsyncClient(timeout=...) as client:` on EVERY call, so each relay
 * (get_merchant / create_cart / ... / the per-turn dialogue write in routes_stream._persist_turn)
 * opened a fresh TCP (and TLS) connection with no keep-alive, paying a full handshake, inflating
 * RTT and TIME_WAIT/fd pressure, and thrashing the peer's accept pool. The factory
 * `get_platform_client` is a per-process singleton, so there is exactly ONE adapter to pool on.
 * This is the D904 candidate the project's own `docs/PLAN.md` registered, whose stated door is
 * "a counting transport proving one connection serves N relays". The sibling model adapters
 * (`models/base.py::HttpLLMAdapter._http`) already pool a client; the platform adapter did not.
 *
 * THE FIX (D969). The adapter owns one lazily-created `httpx.AsyncClient` (`_http()`), injected
 * via a `client=` constructor argument (tests/offline transports), and `_request` calls
 * `await self._http().request(...)`. `async def aclose()` releases it; the factory exposes
 * `aclose_platform_client()` (a no-op for the stub / an unset factory), and the FastAPI lifespan
 * calls it on shutdown next to `stop_eureka` / `db_pool.dispose`. Nothing else changes: the
 * timeout contract, HTTPError→PlatformUnavailable mapping, status→PlatformRejectedRequest
 * envelope, `_safe_json`, headers (Authorization/X-Tenant/Idempotency-Key/X-Internal-Token),
 * default-stub mode and factory-singleton shape all survive byte-for-byte.
 *
 * WHAT THIS DOES NOT CLAIM. That a live platform connection was observed, that any test ran
 * today, or any latency/throughput/TIME_WAIT number. The behavioural proof is the offline pytest
 * probe `apps/ai/tests/test_platform_client_reuses_connection.py` (positive: N relays through
 * ONE injected client + one aclose; falsifier: monkeypatch `_http` back to per-call construction
 * and require the construction count to become N; plus concurrency, lazy-timeout, shutdown-hook,
 * contract-survival and factory-singleton arms) run on the CI `ai` job's `uv run pytest -q`.
 * This reader judges only source text and wiring.
 *
 * SELF-TEST. `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in
 * memory: revert `_request` to per-call new, drop the `_http()` reuse, remove the injection point,
 * erase `aclose()` / the factory shutdown hook / the lifespan call, break the retained contract,
 * cut the probe arms, cut CI/ATLAS/ledger bindings, and remove the reader. Every arm carries an
 * `expect` substring the offender MUST contain (red-for-the-wrong-reason still fails), a D954
 * no-op snapshot guard (a corruption that changes no byte is a defect), and a D959 line-anchored
 * ledger-heading match (this reader's own prose quotes the heading, so a plain `.includes` would
 * be a vacuous needle). One GREEN control (a harmless docstring change must NOT redden the
 * reader) guards the other side. The `expect` tag is read from either tuple shape from the start
 * — D962's first self-test run bound only `arm.expect` while the tags lived in a third tuple slot
 * and silently scored thirteen arms GREEN/WRONG; that lesson is baked in here.
 *
 * Usage:  node scripts/check_platform_client_reuse.mjs [--self-test] [--report] [--ci=<path>]
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

const PLATFORM = 'apps/ai/nexus_ai/adapters/platform.py';
const APP = 'apps/ai/nexus_ai/api/app.py';
const STREAM = 'apps/ai/nexus_ai/api/routes_stream.py';
const PROBE = 'apps/ai/tests/test_platform_client_reuses_connection.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_platform_client_reuse.mjs';
const PATHS = [PLATFORM, APP, STREAM, PROBE, CI, ATLAS, STATUS, SELF];

/* Exact source needles. */
const REUSE = 'resp = await self._http().request(method, url, json=json_body,';
const PER_CALL = 'async with httpx.AsyncClient(timeout=self.timeout_s) as client:';
const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 969\. D969(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the platform-client-reuse plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — _request reuses the pooled client; no per-call construction remains. */
  has(PLATFORM, REUSE, '_request sends through the reused _http() client', 'REUSE');
  // Per-call construction is a bare statement line; line-anchored so the fix's own docstring
  // (which explains the old behaviour without the full construct) cannot create a false stale.
  const perCallLine = /^[ \t]*async with httpx\.AsyncClient\([^)]*\) as client:[ \t]*$/m.test(t(PLATFORM));
  if (perCallLine) offenders.push('STALE — platform.py: a per-call `async with httpx.AsyncClient(...) as client:` line remains — no keep-alive [NO-PER-CALL]');
  else notes.push('held no per-call AsyncClient line remains');
  absent(PLATFORM, PER_CALL, 'the exact pre-D969 per-call construct is gone', 'NO-PER-CALL');

  /* 2 — a single lazily-built client, injectable, with a release path. */
  has(PLATFORM, 'client: Any = None', 'the client injection point exists', 'INJECT');
  has(PLATFORM, 'self._client = client', 'the injected/lazy client is stored on the instance', 'STORE');
  has(PLATFORM, 'def _http(self):', 'the lazy accessor exists', 'ACCESSOR');
  has(PLATFORM, 'if self._client is None:', 'the lazy-build guard exists', 'LAZY-GUARD');
  has(PLATFORM, 'self._client = httpx.AsyncClient(timeout=self.timeout_s)', 'one AsyncClient is built carrying the timeout contract', 'BUILD-ONCE');
  has(PLATFORM, 'return self._client', 'the same client is returned on subsequent calls', 'RETURN-SAME');
  has(PLATFORM, 'async def aclose(self) -> None:', 'the adapter exposes aclose', 'ACLOSE');
  has(PLATFORM, 'await self._client.aclose()', 'aclose releases the pooled client', 'ACLOSE-CALL');

  /* 3 — the shutdown lifecycle reaches the pool, without disturbing the offline stub. */
  has(PLATFORM, 'async def aclose_platform_client() -> None:', 'the factory shutdown hook exists', 'FACTORY-HOOK');
  has(PLATFORM, 'aclose = getattr(_CLIENT, "aclose", None)', 'the hook is a duck-typed no-op for the stub', 'DUCK-TYPE');
  has(PLATFORM, 'await aclose()', 'the hook awaits the adapter aclose', 'HOOK-AWAIT');
  has(PLATFORM, '"aclose_platform_client"]', 'the hook is exported in __all__', 'EXPORT');
  has(APP, 'from nexus_ai.adapters.platform import aclose_platform_client', 'the lifespan imports the shutdown hook', 'LIFESPAN-IMPORT');
  has(APP, 'await aclose_platform_client()', 'the lifespan calls the shutdown hook', 'LIFESPAN-CALL');
  has(STREAM, 'get_platform_client(deps.settings).append_conversation_message', 'the per-turn hot path still drives the pooled factory', 'HOT-PATH');

  /* 4 — the preserved contract (the fix must not change observable behaviour). */
  has(PLATFORM, 'except httpx.HTTPError as exc:', 'the HTTPError guard survives', 'HTTPERR');
  has(PLATFORM, 'raise PlatformUnavailable(f"platform {method} {path} unreachable: {exc}") from exc', 'the unreachable mapping survives', 'UNAVAILABLE');
  has(PLATFORM, 'PlatformRejectedRequest(', 'the rejected-request envelope survives', 'REJECTED');
  has(PLATFORM, 'return _safe_json(resp)', 'the response envelope survives', 'SAFE-JSON');
  has(PLATFORM, 'headers["Idempotency-Key"] = idempotency_key', 'the idempotency header survives', 'IDEM-HEADER');
  has(PLATFORM, 'headers["X-Internal-Token"] = internal_token', 'the internal-token header survives', 'INTERNAL-HEADER');
  has(PLATFORM, 'NEXUS_PLATFORM_MODE=stub|http', 'the default-stub mode selector survives', 'STUB-MODE');
  has(PLATFORM, 'if _CLIENT is not None and not force_new:', 'the factory-singleton shape survives', 'SINGLETON');

  /* 5 — the runnable behavioural proof + its one-flipped-variable falsifier ship. */
  has(PROBE, 'async def test_one_client_serves_n_relays():', 'the positive arm exists', 'PROBE-POSITIVE');
  has(PROBE, 'async def test_per_call_client_falsifier(monkeypatch):', 'the falsifier arm exists', 'PROBE-FALSIFIER');
  has(PROBE, 'async def test_lazy_http_builds_one_client_with_the_timeout_contract():', 'the lazy-timeout arm exists', 'PROBE-TIMEOUT');
  has(PROBE, 'async def test_shutdown_hook_closes_http_client_and_is_a_stub_noop():', 'the shutdown-lifecycle arm exists', 'PROBE-LIFECYCLE');
  has(PROBE, 'monkeypatch.setattr(HttpPlatformClient, "_http", per_call, raising=True)', 'the falsifier flips exactly one variable (_http -> per-call)', 'FLIP-VARIABLE');
  has(PROBE, 'assert len(counting.requests) == RELAYS', 'the positive arm asserts N relays on ONE client', 'POSITIVE-ASSERT');
  has(PROBE, 'assert len(constructed) == RELAYS', 'the falsifier asserts per-call construction count', 'FALSIFIER-ASSERT');
  has(PROBE, 'httpx.MockTransport(handler)', 'the counting transport is offline (no live platform)', 'MOCK-TRANSPORT');

  /* 6 — wiring: CI runs this reader AND the ai-job pytest probe; docs + ledger. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ciPath, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  // EOL-agnostic, line-ANCHORED heading: this reader's own prose quotes the heading inline.
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push('MISSING — docs/STATUS.md: no `## 969. D969` heading line [LEDGER-HEADING]');
  } else notes.push('held the ledger holds a D969 heading line');

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
  const arms = [
    ['_request reverted to per-call new', mutate(real, PLATFORM, REUSE, 'async with httpx.AsyncClient(timeout=self.timeout_s) as client:\n                resp = await client.request(method, url, json=json_body)'), 'NO-PER-CALL'],
    ['reuse accessor erased', mutate(real, PLATFORM, 'def _http(self):', 'def _unused(self):'), 'ACCESSOR'],
    ['lazy-build guard removed', mutate(real, PLATFORM, 'if self._client is None:', 'if True:'), 'LAZY-GUARD'],
    ['build-once dropped', mutate(real, PLATFORM, 'self._client = httpx.AsyncClient(timeout=self.timeout_s)', 'self._client = None'), 'BUILD-ONCE'],
    ['return-same removed', mutate(real, PLATFORM, 'return self._client', 'return httpx.AsyncClient(timeout=self.timeout_s)'), 'RETURN-SAME'],
    ['injection point removed', mutate(real, PLATFORM, 'client: Any = None', 'verbose: Any = None'), 'INJECT'],
    ['stored client removed', mutate(real, PLATFORM, 'self._client = client', 'self._client = None'), 'STORE'],
    ['adapter aclose erased', mutate(real, PLATFORM, 'async def aclose(self) -> None:', 'async def _no_close(self) -> None:'), 'ACLOSE'],
    ['adapter aclose call erased', mutate(real, PLATFORM, 'await self._client.aclose()', 'pass  # leaked'), 'ACLOSE-CALL'],
    ['factory shutdown hook erased', mutate(real, PLATFORM, 'async def aclose_platform_client() -> None:', 'async def _no_hook() -> None:'), 'FACTORY-HOOK'],
    ['stub duck-typing removed', mutate(real, PLATFORM, 'aclose = getattr(_CLIENT, "aclose", None)', '_CLIENT.aclose()'), 'DUCK-TYPE'],
    ['lifespan call cut', mutate(real, APP, 'await aclose_platform_client()', 'pass  # D969 noop'), 'LIFESPAN-CALL'],
    ['hot-path caller cut', mutate(real, STREAM, 'get_platform_client(deps.settings).append_conversation_message', '_unused_append_conversation_message'), 'HOT-PATH'],
    ['timeout contract broken', mutate(real, PLATFORM, 'self._client = httpx.AsyncClient(timeout=self.timeout_s)', 'self._client = httpx.AsyncClient()'), 'BUILD-ONCE'],
    ['probe positive arm erased', mutate(real, PROBE, 'async def test_one_client_serves_n_relays():', 'async def _positive_removed():'), 'PROBE-POSITIVE'],
    ['probe falsifier arm erased', mutate(real, PROBE, 'async def test_per_call_client_falsifier(monkeypatch):', 'async def _falsifier_removed(monkeypatch):'), 'PROBE-FALSIFIER'],
    ['falsifier flip-variable weakened', mutate(real, PROBE, 'monkeypatch.setattr(HttpPlatformClient, "_http", per_call, raising=True)', 'monkeypatch.setattr(HttpPlatformClient, "_http", HttpPlatformClient._http, raising=True)'), 'FLIP-VARIABLE'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, ciPath, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ledger D969 heading line removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [labelText, arm, tag] of arms) {
    const expect = arm.expect ?? tag;
    if (arm.skipped) { console.log(`  self-test  ${labelText.padEnd(48)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) {
      console.log(`  self-test  ${labelText.padEnd(48)} NO-OP (defect!)`);
      allCaught = false;
      continue;
    }
    const j = judge(arm.files, arm.present ?? present, ciPath);
    const joined = j.offenders.join(' | ');
    const red = j.unchecked !== null || j.offenders.length > 0;
    const rightReason = joined.includes(expect);
    const pass = red && rightReason;
    if (!pass) allCaught = false;
    console.log(`  self-test  ${labelText.padEnd(48)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${j.offenders.length} expect=${JSON.stringify(expect)}`);
    if (red && !rightReason) for (const o of j.offenders.slice(0, 2)) console.log('      got: ' + o);
  }

  // GREEN control: a harmless docstring wording change must NOT redden the reader.
  const control = mutate(real, PLATFORM, 'the same client is returned on subsequent calls', 'the identical client is handed back on later calls');
  const controlJudge = judge(control.files ?? real, present, ciPath);
  const controlGreen = controlJudge.offenders.length === 0 && controlJudge.unchecked === null;
  if (!controlGreen) allCaught = false;
  console.log(`  self-test  ${'harmless _http docstring rewording stays GREEN'.padEnd(48)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${controlJudge.offenders.length}`);
  if (!controlGreen) for (const o of controlJudge.offenders.slice(0, 4)) console.log('      ' + o);

  console.log(`  self-test  all arms redden for cause + control green: ${allCaught} (${arms.length} corruption arms + 1 control)`);
  process.exit(allCaught ? 0 : 1);
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk();
const result = judge(files, present, ciPath);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`FALSE PLATFORM-CLIENT-REUSE WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D969 platform adapter reuses one pooled AsyncClient, ${result.notes.length} holds`);
process.exit(0);
