#!/usr/bin/env node
/**
 * NEXUS D884 — the W3C trace plane's wiring reader.
 *
 * The behaviour is proved by `cloud_trace_smoke.sh` (a real request through the gateway against a
 * fixture that echoes what it received) and by the Java/Python unit tests. THIS reader is the cheap,
 * always-runnable guard against the wiring quietly disappearing: a filter renamed, a middleware
 * removed, an actuator declaration edited, a smoke dropped from CI, or the honesty clause deleted
 * from the plane's one page. It reads source; it runs no service and claims nothing about runtime.
 *
 * WHAT THIS DOES NOT SAY: that the gateway is running, that a trace id was actually propagated on
 * this host today, that any collector receives spans, or that a sampled flag means anything is
 * exported. Those are runtime questions for the smoke, and the "not claimed" paragraph in CLOUD.md.
 *
 * Exit: 0 every wiring claim holds · 1 an offender.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offenders = [];
const notes = [];

const read = (rel) => {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
};
const has = (rel, needle, label) => {
  const t = read(rel);
  if (!t) offenders.push(`UNREADABLE — ${rel} (${label})`);
  else if (!t.includes(needle)) offenders.push(`MISSING — ${rel}: ${label} (expected ${JSON.stringify(needle)})`);
  else notes.push(`held ${label}`);
};
const exists = (rel, label) => {
  if (!existsSync(join(ROOT, rel))) offenders.push(`ABSENT — ${rel}: ${label}`);
  else notes.push(`held ${label}`);
};

const JAVA = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeTracingFilter.java';
const JAVA_TEST = 'services/cloud/gateway/src/test/java/com/nexus/cloud/gateway/EdgeTracingFilterTest.java';
const PY = 'apps/ai/nexus_ai/api/tracing.py';
const APP = 'apps/ai/nexus_ai/api/app.py';
const ACTUATOR = 'apps/ai/nexus_ai/api/routes_actuator.py';
const PY_TEST = 'apps/ai/tests/test_tracing.py';
const FIXTURE = 'scripts/fixture_trace_echo.py';
const SMOKE = 'scripts/cloud_trace_smoke.sh';
const CI = '.github/workflows/ci.yml';
const CLOUD_DOC = 'docs/CLOUD.md';
const ATLAS = 'docs/ATLAS.md';

for (const [rel, label] of [
  [JAVA, 'the gateway trace filter source'],
  [JAVA_TEST, 'the Java filter unit tests'],
  [PY, 'the AI trace parser'],
  [PY_TEST, 'the AI trace unit tests'],
  [FIXTURE, 'the trace-echo fixture'],
  [SMOKE, 'the trace smoke'],
]) exists(rel, label);

/* the edge is the sole origin, and it is strict about the W3C grammar */
has(JAVA, 'implements GlobalFilter, Ordered', 'trace filter is a global gateway filter');
has(JAVA, 'TRACEPARENT = "traceparent"', 'W3C header name is declared');
has(JAVA, 'TRACE_ID_HEADER = "X-Trace-Id"', 'X-Trace-Id response header is declared');
has(JAVA, 'SPAN_ID_HEADER = "X-Trace-Span-Id"', 'X-Trace-Span-Id response header is declared');
has(JAVA, '^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$', 'strict lowercase W3C grammar');
has(JAVA, 'ZERO_TRACE.equals(trace)', 'all-zero trace ids are rejected');
has(JAVA, 'public TraceContext child()', 'a continued context gets a child span');
has(JAVA, 'HIGHEST_PRECEDENCE + 1', 'filter order is immediately after the request-id filter');
has(JAVA, 'public static TraceContext fresh()', 'the edge mints root contexts');
has(JAVA, 'does NOT echo', 'the response does not pretend to propagate traceparent');

has(JAVA_TEST, 'malformedOrAllZeroContextsAreReplacedNotPropagated', 'Java: malformed contexts are rejected');
has(JAVA_TEST, 'anInboundContextIsContinuedNotRestarted', 'Java: inbound contexts are continued');

/* the Python service is a participant: parse + echo, never mint */
has(PY, 'def parse_traceparent', 'the AI parses W3C traceparent');
has(PY, '^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$', 'the AI uses the same strict grammar');
has(PY, 'invent a trace id when the caller brought none', 'the AI states it does not mint trace ids');
has(APP, 'parse_traceparent(request.headers.get("traceparent"))', 'the AI middleware reads the header');
has(APP, 'response.headers["x-trace-id"]', 'the AI echoes the edge-minted trace id');
has(APP, 'never invent one of our own', 'the middleware keeps the honesty comment');
has(ACTUATOR, '"role": "participant"', 'the actuator window declares participant, not origin');
has(ACTUATOR, '"mints_trace_ids": False', 'the actuator window denies minting');
has(ACTUATOR, '"exports_spans": False', 'the actuator window denies exporting');

has(PY_TEST, 'test_a_request_without_a_trace_gets_no_invented_id', 'Python: no header means no invented id');
has(PY_TEST, 'test_a_propagated_trace_is_echoed_on_the_response', 'Python: propagated trace is echoed');
has(PY_TEST, 'test_a_malformed_trace_is_not_laundered_into_a_response_header', 'Python: malformed context refused');

/* the behaviour has a real proof and a runner */
has(FIXTURE, "self.headers.get('traceparent')", 'the fixture echoes the received traceparent');
has(SMOKE, 'case 1: no inbound traceparent', 'smoke case 1: mint');
has(SMOKE, 'case 2: a valid inbound context is continued', 'smoke case 2: continue');
has(SMOKE, 'case 3: a malformed context is replaced', 'smoke case 3: reject');
has(SMOKE, 'fixture_trace_echo.py', 'smoke boots the echo fixture');
has(CI, 'scripts/cloud_trace_smoke.sh', 'CI runs the trace smoke');
has(CI, 'scripts/check_cloud_trace.mjs', 'CI runs this reader');
has(CLOUD_DOC, 'traceparent', 'CLOUD.md documents the trace plane');
has(CLOUD_DOC, 'No trace collector', 'CLOUD.md states the no-exporter honesty clause');
has(ATLAS, 'scripts/check_cloud_trace.mjs', 'the atlas lists the reader');
has(ATLAS, 'scripts/cloud_trace_smoke.sh', 'the atlas lists the smoke');

if (offenders.length) {
  console.log('CLOUD TRACE WIRING — FAIL');
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`${offenders.length} offender(s), ${notes.length} claim(s) held`);
  process.exit(1);
}
console.log('CLOUD TRACE WIRING — PASS');
console.log(`${notes.length} claim(s) held`);
console.log('\nWHAT THIS DOES NOT SAY: a service is running, a span was exported, or the smoke ran today.');
process.exit(0);
