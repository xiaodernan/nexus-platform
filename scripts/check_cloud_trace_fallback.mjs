#!/usr/bin/env node
/**
 * NEXUS D896 (Phase G / G2) — the wiring reader for "trace context survives degradation".
 *
 * D884's smoke measured W3C propagation on ONE path: a 200 from a healthy echo fixture.
 * `EdgeTracingFilter`'s javadoc claims more — a limiter's 429, a breaker's 503 and a route
 * miss also carry the id — because response headers are set BEFORE delegating. Until D896 that
 * sentence was a comment, not a measurement. `scripts/cloud_trace_fallback_smoke.sh` now sends
 * ONE inbound traceparent down all three answers; THIS reader is the cheap, always-runnable guard
 * against that proof quietly disappearing: a scenario deleted, a falsifier arm softened, the
 * filter order inverted (a 429 emitted BEFORE the tracing filter would have NO trace id), the
 * CI/ATLAS wiring dropped, or the honesty clause in CLOUD.md deleted.
 *
 * WHAT THIS DOES NOT SAY: that a gateway is running, that a span was exported, that a collector
 * received anything, or that the smoke ran today. It reads source; runtime belongs to the smoke.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory and
 * requires EACH to redden, plus an empty plane to be refused and the real plane to hold. A gate
 * that cannot be made red is not a gate.
 *
 * Exit: 0 every wiring claim holds · 1 an offender.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const JAVA_TRACE = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeTracingFilter.java';
const JAVA_LIMIT = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeRateLimitFilter.java';
const JAVA_FALLBACK = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeFallbackController.java';
const FIXTURE = 'scripts/fixture_trace_echo.py';
const SMOKE = 'scripts/cloud_trace_fallback_smoke.sh';
const FALSIFIER = 'scripts/falsify_cloud_trace_fallback_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD_DOC = 'docs/CLOUD.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_cloud_trace_fallback.mjs';

const FILES = [JAVA_TRACE, JAVA_LIMIT, JAVA_FALLBACK, FIXTURE, SMOKE, FALSIFIER, CI, ATLAS, CLOUD_DOC, STATUS, SELF];

function judge(plane) {
  const offenders = [];
  const notes = [];
  const text = (rel) => plane.get(rel) ?? '';
  const has = (rel, needle, label) => {
    const t = text(rel);
    if (!t) offenders.push(`UNREADABLE — ${rel} (${label})`);
    else if (!t.includes(needle)) offenders.push(`MISSING — ${rel}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };

  for (const rel of FILES) {
    if (!existsSync(join(ROOT, rel))) offenders.push(`ABSENT — ${rel}`);
    else notes.push(`held ${rel} exists`);
  }

  /* The three answers really are measured, with ONE inbound context shared by all of them. */
  has(SMOKE, 'INBOUND="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"',
    'the smoke declares one W3C inbound context');
  has(SMOKE, 'case A: a NORMAL 200 still carries the caller\'s trace (control)',
    'case A measures the healthy 200 control');
  has(SMOKE, "case B: a breaker's 503 FALLBACK still echoes the caller's trace",
    'case B measures the breaker 503 fallback');
  has(SMOKE, "case C: the limiter's 429 still echoes the caller's trace",
    'case C measures the limiter 429');
  has(SMOKE, "assert_trace_headers \"case B (503)\"",
    'the 503 answer is checked against the caller trace id');
  has(SMOKE, "assert_trace_headers \"case C (429)\"",
    'the 429 answer is checked against the caller trace id');
  has(SMOKE, 'edge_upstream_unavailable', 'the 503 envelope is asserted, not just the status code');
  has(SMOKE, 'edge_rate_limited', 'the 429 envelope is asserted, not just the status code');
  has(SMOKE, 'NEXUS_TRACE_FALLBACK_NO_DEGRADE', 'the smoke has a switch for the falsifier arm');
  has(SMOKE, 'expected an honest 503 fallback', 'the 503 assertion has an attributable failure message');
  has(SMOKE, 'scripts/fixture_trace_echo.py', 'the smoke reuses D884\'s echo fixture');

  /* The falsifier removes the CAUSE and requires the unchanged assertion to redden. */
  has(FALSIFIER, 'NEXUS_TRACE_FALLBACK_NO_DEGRADE=1', 'the falsifier removes the degradation');
  has(FALSIFIER, '[ "$rc" -ne 0 ]', 'the falsifier requires the smoke to exit non-zero');
  has(FALSIFIER, 'case A (200) kept trace=', 'the falsifier proves the healthy control still worked');
  has(FALSIFIER, 'expected an honest 503 fallback', 'the falsifier attributes the red to the missing 503');
  has(FALSIFIER, 'a 503-fallback trace claim green without any 503 proves nothing',
    'the falsifier states why a green no-degrade run would be worthless');

  /* The product wiring that makes all three answers carry the id. */
  has(JAVA_TRACE, 'Set before delegating: a limiter\'s 429, a breaker\'s 503 and a route miss all carry the id.',
    'the tracing filter states the D884 claim D896 measures');
  has(JAVA_TRACE, 'next.getResponse().getHeaders().set(TRACE_ID_HEADER, current.traceId())',
    'the trace header is set on the response before delegation');
  has(JAVA_FALLBACK, 'HttpStatus.SERVICE_UNAVAILABLE', 'the fallback really answers 503');
  has(FIXTURE, "self.headers.get('traceparent')", 'the echo fixture reports the injected context');

  const tracingOrder = Number(/return\s+Ordered\.HIGHEST_PRECEDENCE\s*\+\s*(\d+)/.exec(text(JAVA_TRACE))?.[1]);
  const limitOrder = Number(/ORDER\s*=\s*Ordered\.HIGHEST_PRECEDENCE\s*\+\s*(\d+)/.exec(text(JAVA_LIMIT))?.[1]);
  if (!Number.isFinite(tracingOrder) || !Number.isFinite(limitOrder)) {
    offenders.push('ORDER UNREADABLE — the tracing and limiter orders must be explicit HIGHEST_PRECEDENCE offsets');
  } else if (!(tracingOrder < limitOrder)) {
    offenders.push(`ORDER INVERTED — tracing (+${tracingOrder}) must run BEFORE the limiter (+${limitOrder}), or a 429 has no trace id`);
  } else {
    notes.push(`held tracing runs before the limiter (+${tracingOrder} < +${limitOrder})`);
  }

  /* A claim needs a runner, a map entry, a ledger section and a human-facing honesty clause. */
  has(CI, 'scripts/cloud_trace_fallback_smoke.sh', 'CI runs the degraded-trace smoke');
  has(CI, 'scripts/falsify_cloud_trace_fallback_smoke.sh', 'CI runs the no-degrade falsifier');
  has(CI, 'scripts/check_cloud_trace_fallback.mjs', 'CI runs this reader');
  has(ATLAS, 'scripts/cloud_trace_fallback_smoke.sh', 'the atlas lists the smoke');
  has(ATLAS, 'scripts/falsify_cloud_trace_fallback_smoke.sh', 'the atlas lists the falsifier');
  has(ATLAS, 'scripts/check_cloud_trace_fallback.mjs', 'the atlas lists this reader');
  has(CLOUD_DOC, 'D896', 'CLOUD.md names the unit');
  has(CLOUD_DOC, 'No trace collector', 'CLOUD.md keeps the no-exporter honesty clause');
  has(STATUS, '## 896.', 'the ledger has a numbered D896 section');
  has(SELF, '--self-test', 'this reader has a falsifiable self-test');

  return { offenders, notes };
}

function realPlane() {
  const plane = new Map();
  for (const rel of FILES) {
    try { plane.set(rel, readFileSync(join(ROOT, rel), 'utf8')); } catch { plane.set(rel, ''); }
  }
  return plane;
}

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  const live = judge(realPlane());
  const cases = [
    ['case B assertion erased', (p) => p.set(SMOKE, p.get(SMOKE).replace("case B: a breaker's 503 FALLBACK still echoes the caller's trace", 'case B: whatever'))],
    ['no-degrade switch erased', (p) => p.set(SMOKE, p.get(SMOKE).replaceAll('NEXUS_TRACE_FALLBACK_NO_DEGRADE', 'DISABLED'))],
    ['falsifier no longer requires red', (p) => p.set(FALSIFIER, p.get(FALSIFIER).replace('[ "$rc" -ne 0 ]', '[ "$rc" -eq 0 ]'))],
    ['tracing order moved after the limiter', (p) => p.set(JAVA_TRACE, p.get(JAVA_TRACE).replace('return Ordered.HIGHEST_PRECEDENCE + 1', 'return Ordered.HIGHEST_PRECEDENCE + 20'))],
    ['CI smoke step dropped', (p) => p.set(CI, p.get(CI).replaceAll('scripts/cloud_trace_fallback_smoke.sh', 'scripts/retired_smoke.sh'))],
    ['atlas falsifier entry dropped', (p) => p.set(ATLAS, p.get(ATLAS).replaceAll('scripts/falsify_cloud_trace_fallback_smoke.sh', 'scripts/retired_falsifier.sh'))],
    ['CLOUD.md D896 clause deleted', (p) => p.set(CLOUD_DOC, p.get(CLOUD_DOC).replaceAll('D896', 'D000'))],
    ['ledger section deleted', (p) => p.set(STATUS, p.get(STATUS).replace('## 896.', '## 000.'))],
  ];
  let allCaught = true;
  for (const [label, corrupt] of cases) {
    const plane = realPlane();
    corrupt(plane);
    const caught = judge(plane).offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(38)} caught: ${caught}`);
    if (!caught) allCaught = false;
  }
  const empty = new Map();
  const emptyCaught = judge(empty).offenders.length > 0;
  console.log(`  self-test  ${'empty scripts plane refused'.padEnd(38)} caught: ${emptyCaught}`);
  console.log(`  self-test  real plane offenders: ${live.offenders.length}`);
  const ok = allCaught && emptyCaught && live.offenders.length === 0 && live.notes.length > 20;
  console.log(ok
    ? '\nRESULT: PASS — every planted corruption reddens and the real plane holds'
    : '\nRESULT: FAIL — a corruption was not caught, or the real plane is red');
  if (live.offenders.length) for (const o of live.offenders) console.log(`  - ${o}`);
  process.exit(ok ? 0 : 1);
}

const { offenders, notes } = judge(realPlane());
if (offenders.length) {
  console.log('CLOUD DEGRADED-TRACE WIRING — FAIL');
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`${offenders.length} offender(s), ${notes.length} claim(s) held`);
  process.exit(1);
}
console.log('CLOUD DEGRADED-TRACE WIRING — PASS');
console.log(`${notes.length} claim(s) held`);
console.log('\nWHAT THIS DOES NOT SAY: a gateway is running, a span was exported, or the smoke ran today.');
process.exit(0);
