#!/usr/bin/env node
/**
 * NEXUS D900 (Phase H / H1) — wiring reader for the fifth service's W3C participation.
 *
 * D884 made the edge the only trace-id origin and FastAPI a participant; D900 adds the missing
 * hop: `nexus-insight`'s strict participant filter and its Feign RequestInterceptor propagate ONE
 * inbound context to BOTH `lb://` upstreams and echo it even on a fallback. The behaviour is
 * proved by `scripts/insight_trace_smoke.sh` (two live fixtures log the header they received),
 * `scripts/falsify_insight_trace_smoke.sh` (participation off -> the same assertion reddens) and
 * the JUnit tests. THIS reader guards the wiring that could silently disappear: the strict
 * grammar, the no-minting rule, the ThreadLocal cleanup, the interceptor, the fixture's log line,
 * the CI/ATLAS/CLOUD/ledger registration and CLOUD.md's no-collector honesty clause.
 *
 * WHAT THIS DOES NOT SAY: that a service is running, that a span was exported, or that the smoke
 * ran today. Runtime belongs to the two live arms.
 *
 * SELF-TEST: `judge` is pure over (path -> text); `--self-test` plants corruptions in memory and
 * requires EACH to redden, plus an empty plane to be refused and the real plane to hold.
 *
 * Exit: 0 every wiring claim holds · 1 an offender.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const JAVA = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/InsightTraceConfig.java';
const JAVA_TEST = 'services/cloud/insight-service/src/test/java/com/nexus/cloud/insight/InsightTraceConfigTest.java';
const FIXTURE = 'scripts/fixture_insight_upstream.py';
const SMOKE = 'scripts/insight_trace_smoke.sh';
const FALSIFIER = 'scripts/falsify_insight_trace_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD_DOC = 'docs/CLOUD.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_cloud_insight_trace.mjs';
const FILES = [JAVA, JAVA_TEST, FIXTURE, SMOKE, FALSIFIER, CI, ATLAS, CLOUD_DOC, STATUS, SELF];

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

  /* A PARTICIPANT, not an origin: strict grammar, no minting, child span, thread-local cleanup. */
  has(JAVA, '^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$', 'the strict lowercase W3C grammar');
  has(JAVA, 'ZERO_TRACE.equals(m.group(1))', 'all-zero trace ids are refused');
  has(JAVA, 'ZERO_SPAN.equals(m.group(2))', 'all-zero span ids are refused');
  has(JAVA, 'static String childOf(String header)', 'a continued context gets a child span');
  has(JAVA, 'PARTICIPANT', 'the class states it is a participant, not an origin');
  has(JAVA, '{@link RequestInterceptor}', 'the javadoc names the Feign interceptor');
  has(JAVA, 'RequestInterceptor insightTraceInterceptor()', 'Feign requests are intercepted');
  has(JAVA, 'template.header(TRACEPARENT, child)', 'the child context is put on every Feign call');
  has(JAVA, 'FilterRegistrationBean<Filter> insightTraceFilter()', 'participation is a registered servlet filter');
  has(JAVA, 'setOrder(Ordered.HIGHEST_PRECEDENCE)', 'the filter runs before the fallback can answer');
  has(JAVA, 'request.removeAttribute(TRACE_ATTRIBUTE)', 'the attribute is always cleared after the chain');
  has(JAVA, 'nexus.insight.trace.enabled', 'participation has a switch the falsifier can turn off');
  has(JAVA, 'TRACE_ATTRIBUTE', 'the attribute uses a key the servlet and Feign boundary both see');

  for (const t of ['aValidContextIsContinuedNotRestarted',
    'malformedOrAllZeroContextsAreRefusedNotLaundered',
    'noValidContextMeansNoInventedHeaders',
    'aValidContextIsEchoedAndClearedAfterTheChain',
    'theDisabledConfigNeitherEchoesNorPropagates',
    'theFeignInterceptorCopiesTheChildContextToTheUpstream',
    'theFeignInterceptorAddsNothingWithoutACurrentContext']) {
    has(JAVA_TEST, t, `unit test: ${t}`);
  }

  /* The wire proof: fixtures log what they received; both live and degraded arms are asserted. */
  has(FIXTURE, 'self.headers.get("traceparent")', 'the fixture logs the header it received');
  has(SMOKE, 'traceparent=00-$TRACE-', 'the smoke greps the fixture logs for a propagated child context');
  has(SMOKE, 'plane A: all_up=true', 'phase A proves both live upstreams answered');
  has(SMOKE, 'plane B: all_up=false', 'phase B proves the fallback degraded honestly');
  has(SMOKE, 'the response did not echo the caller\'s X-Trace-Id', 'the trace echo assertion has an attributable failure message');
  has(SMOKE, 'NEXUS_INSIGHT_TRACE_DISABLE', 'the smoke has a switch for the falsifier arm');
  has(SMOKE, 'nexus.insight.trace.enabled=false', 'the switch really disables participation');
  has(FALSIFIER, 'NEXUS_INSIGHT_TRACE_DISABLE=1', 'the falsifier turns participation off');
  has(FALSIFIER, '[ "$rc" -ne 0 ]', 'the falsifier requires the smoke to exit non-zero');
  has(FALSIFIER, 'plane A: all_up=true, both rows UP', 'the falsifier proves the healthy 200 control');
  has(FALSIFIER, 'the response did not echo the caller\'s X-Trace-Id', 'the falsifier attributes the red to the missing trace echo');

  /* A claim needs a runner, a map entry, a ledger section and an unchanged honesty clause. */
  has(CI, 'scripts/insight_trace_smoke.sh', 'CI runs the participation smoke');
  has(CI, 'scripts/falsify_insight_trace_smoke.sh', 'CI runs the disabled-participation falsifier');
  has(CI, 'scripts/check_cloud_insight_trace.mjs', 'CI runs this reader');
  has(ATLAS, 'scripts/insight_trace_smoke.sh', 'the atlas lists the smoke');
  has(ATLAS, 'scripts/falsify_insight_trace_smoke.sh', 'the atlas lists the falsifier');
  has(ATLAS, 'scripts/check_cloud_insight_trace.mjs', 'the atlas lists this reader');
  has(CLOUD_DOC, 'D900', 'CLOUD.md names the unit');
  has(CLOUD_DOC, 'No trace collector', 'CLOUD.md keeps the no-exporter honesty clause');
  has(STATUS, '## 900.', 'the ledger has a numbered D900 section');
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
    ['strict grammar removed', (p) => p.set(JAVA, p.get(JAVA).replace('^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$', '^00-(.*)$'))],
    ['Feign interceptor erased', (p) => p.set(JAVA, p.get(JAVA).replaceAll('template.header(TRACEPARENT, child)', '// no propagation'))],
    ['attribute cleanup erased', (p) => p.set(JAVA, p.get(JAVA).replace('request.removeAttribute(TRACE_ATTRIBUTE)', '// no cleanup'))],
    ['fixture stops logging the header', (p) => p.set(FIXTURE, p.get(FIXTURE).replace('self.headers.get("traceparent")', '"redacted"'))],
    ['smoke loses the fixture-log assertion', (p) => p.set(SMOKE, p.get(SMOKE).replace('traceparent=00-$TRACE-', 'traceparent=anything'))],
    ['falsifier no longer requires red', (p) => p.set(FALSIFIER, p.get(FALSIFIER).replace('[ "$rc" -ne 0 ]', '[ "$rc" -eq 0 ]'))],
    ['CI smoke step dropped', (p) => p.set(CI, p.get(CI).replaceAll('scripts/insight_trace_smoke.sh', 'scripts/retired_smoke.sh'))],
    ['atlas reader entry dropped', (p) => p.set(ATLAS, p.get(ATLAS).replaceAll('scripts/check_cloud_insight_trace.mjs', 'scripts/retired_reader.mjs'))],
    ['CLOUD.md no-collector clause deleted', (p) => p.set(CLOUD_DOC, p.get(CLOUD_DOC).replaceAll('No trace collector', 'spans are exported everywhere'))],
    ['ledger section deleted', (p) => p.set(STATUS, p.get(STATUS).replace('## 900.', '## 000.'))],
  ];
  let allCaught = true;
  for (const [label, corrupt] of cases) {
    const plane = realPlane();
    corrupt(plane);
    const caught = judge(plane).offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(42)} caught: ${caught}`);
    if (!caught) allCaught = false;
  }
  const emptyCaught = judge(new Map()).offenders.length > 0;
  console.log(`  self-test  ${'empty scripts plane refused'.padEnd(42)} caught: ${emptyCaught}`);
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
  console.log('INSIGHT TRACE WIRING — FAIL');
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`${offenders.length} offender(s), ${notes.length} claim(s) held`);
  process.exit(1);
}
console.log('INSIGHT TRACE WIRING — PASS');
console.log(`${notes.length} claim(s) held`);
console.log('\nWHAT THIS DOES NOT SAY: a service is running, a span was exported, or the smoke ran today.');
process.exit(0);
