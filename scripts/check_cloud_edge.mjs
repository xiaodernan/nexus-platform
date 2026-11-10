#!/usr/bin/env node
/**
 * NEXUS D850 — the edge earns its keep: a breaker that opens on a dead upstream, an honest fallback,
 * a per-client rate limit, and a request id that survives both hops.
 *
 * WHY THIS EXISTS. D849 gave the gateway a registered platform to route to; D845 gave it a route
 * table; nothing made the edge survivable. A proxy that forwards to a dead upstream without a
 * breaker turns one sick service into an edge that hangs or 503s forever; a limiter that exists only
 * in a javadoc is a 429 nobody can observe; a correlation id that dies at the second hop is a log
 * nobody can join. This reader asks the wiring those claims need, of the files CI actually sees.
 *
 * THE RULES, one sentence each:
 *   E1  The gateway pom declares the resilience4j reactor circuit breaker (without it the fallback
 *       URIs in the route filters are decoration).
 *   E2  The base application.yaml: the platform, ai and web routes each carry a CircuitBreaker
 *       filter whose args are `{ name: <id>, fallbackUri: forward:/fallback/<id> }` — three routes,
 *       three breakers, three fallbacks, one copy of each.
 *   E3  resilience4j.circuitbreaker declares the same three instances with the trip thresholds
 *       (slidingWindowSize, minimumNumberOfCalls, failureRateThreshold, waitDurationInOpenState)
 *       and registerHealthIndicator, and the rate-limit knobs NEXUS_GATEWAY_RATE_BURST /
 *       NEXUS_GATEWAY_RATE_REPLENISH are wired with the documented defaults (10 / 5).
 *   E4  EdgeFallbackController.java serves all three fallbacks as 503 with the contract error shape
 *       `edge_upstream_unavailable` and the request id from the edge filter.
 *   E5  EdgeRateLimitFilter.java runs ordered after EdgeRequestIdFilter, reads the two env knobs,
 *       and answers over-limit with 429 + Retry-After: 1 + `edge_rate_limited`.
 *   E6  The smokes carry the behavioural proofs, so a gutted assertion cannot read as green:
 *       cloud_smoke.sh trips the platform breaker on the dead port and greps the transition AND the
 *       fallback body; cloud_lb_smoke.sh asserts the end-to-end X-Request-Id echo and a 429 with
 *       Retry-After in a burst.
 *
 * WHAT THIS DOES NOT SAY: that the breaker actually opens (run cloud_smoke.sh for that — it greps
 *   the DEBUG transition on the dead-port fixture), that the limiter refuses in anger (cloud_lb_smoke.sh
 *   hammers the gateway live), anything about TLS, auth, or a shared rate-limit store across multiple
 *   gateway instances — the limiter is per process by design (DECISIONS D850).
 *
 * Usage:
 *   node scripts/check_cloud_edge.mjs
 *   node scripts/check_cloud_edge.mjs --dir=<repo-root-copy>   # census a planted plane
 *   node scripts/check_cloud_edge.mjs --report                 # print, always exit 0
 *   node scripts/check_cloud_edge.mjs --verbose                # name every check
 *
 * Exit: 0 no offender · 1 an offender · 2 not checkable (a core surface unreadable).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = {
  '--dir': { kind: 'value', unit: 'path' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exitCode = 2; }
else { process.exitCode = main(parsed.value, parsed.flag); }

function main(value, flag) {
  const VERBOSE = Boolean(flag['--verbose']);
  const REPORT_ONLY = Boolean(flag['--report']);
  const BASE = value['--dir'] ? resolve(value['--dir']) : ROOT;

  const CORE = [
    'services/cloud/gateway/pom.xml',
    'services/cloud/gateway/src/main/resources/application.yaml',
    'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeFallbackController.java',
    'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeRateLimitFilter.java',
  ];
  const OPTIONAL = [
    'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/TokenBucket.java',
    'scripts/cloud_smoke.sh',
    'scripts/cloud_lb_smoke.sh',
  ];
  const [POM, GATEWAY_YAML, FALLBACK_JAVA, RATE_JAVA] = CORE;
  const [BUCKET_JAVA, SMOKE, LB_SMOKE] = OPTIONAL;

  const text = {};
  const unreadable = [];
  for (const rel of [...CORE, ...OPTIONAL]) {
    try { text[rel] = readFileSync(join(BASE, rel), 'utf8'); }
    catch { if (CORE.includes(rel)) unreadable.push(rel); }
  }
  if (unreadable.length) {
    console.log(`RESULT: NOT CHECKED — ${unreadable.length} of ${CORE.length} core surfaces cannot be read `
      + `under ${BASE}: ${unreadable.join(', ')}. No rule was judged.`);
    return 2;
  }

  const offenders = [];
  const checks = [];
  const charge = (rule, detail) => offenders.push(`${rule} ${detail}`);
  const note = (label, ok, detail) => checks.push({ label, ok, detail });

  /* E1 — the breaker library */
  const cbStarter = text[POM].includes('<artifactId>spring-cloud-starter-circuitbreaker-reactor-resilience4j</artifactId>');
  if (!cbStarter) charge('E1', 'the gateway pom declares no spring-cloud-starter-circuitbreaker-reactor-resilience4j: '
    + 'the route filters would depend on a starter that is not on the classpath');
  note('E1 resilience4j on the classpath', cbStarter, `cb-starter=${cbStarter}`);

  /* E2 — three routes, three breakers, three fallbacks */
  const yaml = text[GATEWAY_YAML];
  const routeBlock = (id) => {
    const start = yaml.search(new RegExp(`- id: ${id}\\b`));
    if (start < 0) return '';
    const rest = yaml.slice(start);
    const next = rest.search(/\n\s+- id: (platform|ai|web)\b/);
    const end = next < 0 ? rest.search(/\n[A-Za-z][A-Za-z0-9_-]*:/) : next;
    return end < 0 ? rest : rest.slice(0, end);
  };
  for (const id of ['platform', 'ai', 'web']) {
    const block = routeBlock(id);
    const ok = block.length > 0
      && new RegExp(`CircuitBreaker[\\s\\S]*name:\\s*${id}`).test(block)
      && block.includes(`forward:/fallback/${id}`);
    if (!ok) charge('E2', `route ${id}: no CircuitBreaker filter with fallbackUri forward:/fallback/${id}`);
    note(`E2 route ${id} carries a breaker + fallback`, ok, `block-read:${block.length > 0}`);
  }

  /* E3 — the trip thresholds and the limiter knobs */
  for (const id of ['platform', 'ai', 'web']) {
    const section = yaml.slice(yaml.search(/resilience4j:\s*\n/));
    const inst = new RegExp(`${id}:\\s*\\n([\\s\\S]*?)(\\n\\s{6}[A-Za-z][A-Za-z0-9_-]*:|$)`).exec(section);
    const body = inst ? inst[1] : '';
    const need = ['registerHealthIndicator', 'slidingWindowSize', 'minimumNumberOfCalls', 'failureRateThreshold', 'waitDurationInOpenState'];
    const missing = need.filter((k) => !body.includes(k));
    if (missing.length) charge('E3', `resilience4j ${id}: missing ${missing.join(', ')}`);
    note(`E3 resilience4j ${id} thresholds`, missing.length === 0, missing.length ? `missing:${missing.join(',')}` : 'all five');
  }
  const burst = /rate-limit-burst:\s*\$\{NEXUS_GATEWAY_RATE_BURST:10\}/.test(yaml);
  const replenish = /rate-limit-replenish:\s*\$\{NEXUS_GATEWAY_RATE_REPLENISH:5\}/.test(yaml);
  if (!burst) charge('E3', 'the base YAML does not wire nexus.edge.rate-limit-burst to NEXUS_GATEWAY_RATE_BURST with default 10');
  if (!replenish) charge('E3', 'the base YAML does not wire nexus.edge.rate-limit-replenish to NEXUS_GATEWAY_RATE_REPLENISH with default 5');

  /* E4 — the fallback body is the contract shape, with the id */
  const fb = text[FALLBACK_JAVA];
  const fbChecks = [
    ['@GetMapping("/fallback/platform")', 'the platform fallback mapping'],
    ['@GetMapping("/fallback/ai")', 'the ai fallback mapping'],
    ['@GetMapping("/fallback/web")', 'the web fallback mapping'],
    ['SERVICE_UNAVAILABLE', 'the 503 status'],
    ['edge_upstream_unavailable', 'the contract error code'],
    ['request_id', 'the request id in the body'],
  ];
  for (const [needle, label] of fbChecks) {
    if (!fb.includes(needle)) charge('E4', `EdgeFallbackController.java: ${label} not found`);
  }
  note('E4 fallback contract shape', fbChecks.every(([n]) => fb.includes(n)), 'three mappings + 503 + edge_upstream_unavailable + request_id');

  /* E5 — the limiter is ordered, env-configured, and answers with 429 + Retry-After */
  const rl = text[RATE_JAVA];
  const rlChecks = [
    ['GlobalFilter', 'implements GlobalFilter'],
    ['Ordered.HIGHEST_PRECEDENCE + 10', 'ordered after EdgeRequestIdFilter so a 429 carries the id'],
    ['NEXUS_GATEWAY_RATE_BURST', 'burst env knob'],
    ['NEXUS_GATEWAY_RATE_REPLENISH', 'replenish env knob'],
    ['edge_rate_limited', 'the contract error code'],
    ['Retry-After', 'the Retry-After header'],
    ['TOO_MANY_REQUESTS', 'the 429 status'],
  ];
  for (const [needle, label] of rlChecks) {
    if (!rl.includes(needle)) charge('E5', `EdgeRateLimitFilter.java: ${label} not found`);
  }
  note('E5 limiter behaviour contract', rlChecks.every(([n]) => rl.includes(n)), 'GlobalFilter + order + env knobs + 429/Retry-After/edge_rate_limited');

  /* E6 — the smokes carry the proofs, so a gutted assertion cannot read as green */
  if (text[SMOKE] !== undefined) {
    const proofs = ['STATE_TRANSITION', 'edge_upstream_unavailable', "CircuitBreaker 'platform'"];
    for (const needle of proofs) {
      if (!text[SMOKE].includes(needle)) charge('E6', `cloud_smoke.sh no longer trips the breaker: '${needle}' is gone`);
    }
    note('E6 cloud_smoke.sh carries the breaker-trip proof', proofs.every((n) => text[SMOKE].includes(n)), 'dead-port fixture hammers the route, greps the transition and the fallback body');
  }
  if (text[LB_SMOKE] !== undefined) {
    const proofs = ['lbcorr', 'x-request-id:', '429', 'retry-after'];
    const missing = proofs.filter((n) => !text[LB_SMOKE].toLowerCase().includes(n.toLowerCase()));
    if (missing.length) charge('E6', `cloud_lb_smoke.sh no longer asserts: ${missing.join(', ')}`);
    note('E6 cloud_lb_smoke.sh carries the correlation + 429 proof', missing.length === 0, 'X-Request-Id echo and a burst of 429s with Retry-After');
  }

  if (VERBOSE) {
    for (const check of checks) {
      console.log(`  ${check.ok ? 'ok ' : 'BAD'} ${check.label}  (${check.detail})`);
    }
  }

  if (REPORT_ONLY) { console.log('RESULT: REPORT — printed, no verdict claimed'); return 0; }
  if (offenders.length) {
    console.log(`RESULT: FAIL — ${offenders.length} offender(s)\n`);
    for (const offender of offenders) console.log(`  - ${offender}`);
    return 1;
  }
  console.log(`RESULT: PASS — ${checks.length} checks, no offender`);
  return 0;
}
