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
 *
 *       D996 — the E3 thresholds are read from the `circuitbreaker:` SUBTREE's `instances:` only,
 *       never from the first `platform:`/`ai:`/`web:` anywhere under `resilience4j:`. D995 added a
 *       sibling `timelimiter:` with instances of the SAME three names (each carrying nothing but
 *       `timeoutDuration: 3s`), placed BEFORE `circuitbreaker:`. The old reader sliced from the
 *       `resilience4j:` root and matched each id's first occurrence — the empty timelimiter block —
 *       so it reported all five thresholds missing on correct YAML (CI run 43252673446, line 169,
 *       "E3 resilience4j platform/ai/web: missing registerHealthIndicator, …"). Anchoring to the
 *       breaker subtree makes the gate immune to sibling-block order while still reddening on a
 *       genuinely missing threshold (the --self-test corruption arms prove both directions).
 *   E4  EdgeFallbackController.java serves all three fallbacks (platform/ai/web) as 503 with the
 *       contract error shape `edge_upstream_unavailable` and the request id from the edge filter.
 *       Since D875 each door is an @RequestMapping accepting GET/POST/PUT/PATCH/DELETE, so a
 *       circuit-broken write lands on the honest 503 instead of a 405; all five methods are asserted.
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
 *   node scripts/check_cloud_edge.mjs --self-test              # E3 subtree judge: corruption arms
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
  '--self-test': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exitCode = 2; }
else if (parsed.flag['--self-test']) { process.exitCode = selfTest(); }
else { process.exitCode = main(parsed.value, parsed.flag); }

/* D996 — pure E3 threshold judge over a gateway YAML string.
 *
 * The three thresholds blocks live at `resilience4j: > circuitbreaker: > instances: > <id>:` with
 * a specific indentation depth (resilience4j at col 0, circuitbreaker at 2, instances at 4, each
 * id at 6). We find the `circuitbreaker:` key by its exact indentation, then the `instances:` key
 * directly under it, then each id block under THAT — so a sibling `timelimiter:` (D995) with
 * identically-named instances can never be mistaken for the breaker thresholds regardless of the
 * order the two siblings are written in. A bare `platform:` occurrence elsewhere is not enough.
 *
 * Returns `{ gaps, held, cbFound, instFound }`: `gaps[id]` is the list of missing threshold keys for
 * that id ([] = all five held); `cbFound`/`instFound` guard against a vacuous match. No I/O, no
 * regex over the whole file, so it is trivially falsifiable in memory. */
export function judgeE3(yaml) {
  const NEED = ['registerHealthIndicator', 'slidingWindowSize', 'minimumNumberOfCalls', 'failureRateThreshold', 'waitDurationInOpenState'];
  const IDS = ['platform', 'ai', 'web'];
  const lines = String(yaml).split(/\r?\n/);
  const col = (l) => (l.match(/^ */) || [''])[0].length;
  const eff = (l) => l.trim() !== '' && !/^\s*#/.test(l); // ignore blank + comment lines when walking the tree

  // Walk the INDENTATION TREE, not "first occurrence anywhere". A key is a direct child only if it
  // is the first effective line after its parent at the expected column, before the parent's region
  // ends (the next effective line at column <= parent's column). This is what makes the judge immune
  // to a sibling `timelimiter:` — wherever it sits — without ever borrowing its `platform:` block.
  const r4 = lines.findIndex((l) => /^resilience4j:\s*(?:#.*)?$/.test(l));
  const regionEnd = (from, parentCol) => {
    for (let i = from; i < lines.length; i += 1) if (eff(lines[i]) && col(lines[i]) <= parentCol) return i;
    return lines.length;
  };
  const r4End = r4 < 0 ? -1 : regionEnd(r4 + 1, 0);

  // circuitbreaker: is a col-2 direct child of resilience4j:. Scan ALL col-2 effective children in
  // the region and match the KEY — never assume it is first (a sibling timelimiter: may precede it,
  // which is precisely the CI 43252673446 layout this judge must survive).
  let cb = -1;
  if (r4 >= 0) for (let i = r4 + 1; i < r4End; i += 1) {
    if (eff(lines[i]) && col(lines[i]) === 2 && /^ {2}circuitbreaker:\s*(?:#.*)?$/.test(lines[i])) { cb = i; break; }
  }
  const cbEnd = cb < 0 ? -1 : regionEnd(cb + 1, 2);

  // instances: must be a col-4 direct child of the circuitbreaker: subtree — NOT the timelimiter's
  // one. `cbEnd` stops at the next col-2 sibling, so the two siblings' instances: are disjoint.
  let inst = -1;
  if (cb >= 0) for (let i = cb + 1; i < cbEnd; i += 1) {
    if (eff(lines[i]) && col(lines[i]) === 4 && /^ {4}instances:\s*(?:#.*)?$/.test(lines[i])) { inst = i; break; }
  }
  const instEnd = inst < 0 ? -1 : regionEnd(inst + 1, 4);

  const gaps = {};
  const held = {};
  for (const id of IDS) {
    // Each id: is a col-6 direct child of instances:, scoped strictly inside [inst+1, instEnd) —
    // a second block with the same name in the timelimiter sibling is beyond instEnd and invisible.
    let idStart = -1;
    if (inst >= 0) for (let i = inst + 1; i < instEnd; i += 1) {
      if (eff(lines[i]) && col(lines[i]) === 6 && new RegExp(`^ {6}${id}:\\s*(?:#.*)?$`).test(lines[i])) { idStart = i; break; }
    }
    let body = '';
    if (idStart >= 0) {
      const bodyLines = [];
      for (let i = idStart + 1; i < instEnd; i += 1) {
        if (!eff(lines[i])) { bodyLines.push(lines[i]); continue; }
        if (col(lines[i]) <= 6) break; // next sibling id or the end of instances:
        bodyLines.push(lines[i]);
      }
      body = bodyLines.join('\n');
    }
    const missing = NEED.filter((k) => !body.includes(k));
    gaps[id] = missing;
    held[id] = missing.length === 0;
  }
  return { gaps, held, cbFound: cb >= 0, instFound: inst >= 0, need: NEED, ids: IDS };
}

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

  /* E3 — the trip thresholds (D996: scoped to the circuitbreaker.instances subtree) and the limiter knobs */
  const e3 = judgeE3(yaml);
  if (!e3.cbFound || !e3.instFound) {
    // A missing subtree is one structural defect, not three per-id ones.
    charge('E3', `no ${e3.cbFound ? 'instances:' : 'circuitbreaker:'} subtree under resilience4j: — the breaker thresholds cannot be read`);
    for (const id of e3.ids) note(`E3 resilience4j ${id} thresholds`, false, e3.cbFound ? 'instances-missing' : 'circuitbreaker-missing');
  } else for (const id of e3.ids) {
    const missing = e3.gaps[id];
    if (missing.length) {
      charge('E3', `resilience4j ${id}: missing ${missing.join(', ')}`);
      note(`E3 resilience4j ${id} thresholds`, false, `missing:${missing.join(',')}`);
    } else {
      note(`E3 resilience4j ${id} thresholds`, true, 'all five');
    }
  }
  const burst = /rate-limit-burst:\s*\$\{NEXUS_GATEWAY_RATE_BURST:10\}/.test(yaml);
  const replenish = /rate-limit-replenish:\s*\$\{NEXUS_GATEWAY_RATE_REPLENISH:5\}/.test(yaml);
  if (!burst) charge('E3', 'the base YAML does not wire nexus.edge.rate-limit-burst to NEXUS_GATEWAY_RATE_BURST with default 10');
  if (!replenish) charge('E3', 'the base YAML does not wire nexus.edge.rate-limit-replenish to NEXUS_GATEWAY_RATE_REPLENISH with default 5');

  /* E4 — the fallback body is the contract shape, with the id.
   *
   * D875 replaced the three @GetMapping mappings with @RequestMapping(path=…, method={GET,POST,PUT,
   * PATCH,DELETE}) so a POST that the breaker refuses no longer 405s at the fallback door. This reader
   * used to grep the old annotation and went red against correct code. It now asserts the STRONGER
   * property: all three doors exist and each one accepts all five methods, plus the 503/shape/id.
   * A mapping that silently drops POST would redden here even though the old @GetMapping grep passed. */
  const fb = text[FALLBACK_JAVA];
  const fbChecks = [
    ['SERVICE_UNAVAILABLE', 'the 503 status'],
    ['edge_upstream_unavailable', 'the contract error code'],
    ['request_id', 'the request id in the body'],
  ];
  const FALLBACK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => `RequestMethod.${m}`);
  let mappingsHeld = 0;
  for (const upstream of ['platform', 'ai', 'web']) {
    const hit = new RegExp(
      `@RequestMapping\\(path\\s*=\\s*"/fallback/${upstream}"\\s*,\\s*method\\s*=\\s*\\{([^}]*)\\}`).exec(fb);
    if (!hit) {
      charge('E4', `EdgeFallbackController.java: the ${upstream} fallback mapping not found`);
      continue;
    }
    const missing = FALLBACK_METHODS.filter((m) => !hit[1].includes(m));
    if (missing.length) {
      charge('E4', `EdgeFallbackController.java: the ${upstream} fallback does not accept ${missing.join(', ')}`);
    } else {
      mappingsHeld += 1;
    }
  }
  for (const [needle, label] of fbChecks) {
    if (!fb.includes(needle)) charge('E4', `EdgeFallbackController.java: ${label} not found`);
  }
  note('E4 fallback contract shape',
       mappingsHeld === 3 && fbChecks.every(([n]) => fb.includes(n)),
       'three mappings x five methods + 503 + edge_upstream_unavailable + request_id');

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

  /* E7 — the edge tells the truth about the budget: the IETF RateLimit triple rides the
     admitted path AND the refused answer, so a client paces itself without probing the 429. */
  const e7 = [
    ['X-RateLimit-Limit', 'X-RateLimit-Limit wired'],
    ['X-RateLimit-Remaining', 'X-RateLimit-Remaining wired'],
    ['X-RateLimit-Reset', 'X-RateLimit-Reset wired'],
  ];
  for (const [needle, label] of e7) {
    if (!rl.includes(needle)) charge('E7', `EdgeRateLimitFilter.java: ${label} not found`);
  }
  const e7Note = e7.every(([n]) => rl.includes(n));
  if (BUCKET_JAVA !== undefined) {
    const bkt = text[BUCKET_JAVA];
    for (const needle of ['remainingTokens()', 'secondsUntilFull()']) {
      if (!bkt.includes(needle)) charge('E7', `TokenBucket.java: ${needle} accessor missing`);
    }
    note('E7 admitted and refused answers carry the RateLimit triple',
         e7Note && bkt.includes('remainingTokens()') && bkt.includes('secondsUntilFull()'),
         'X-RateLimit-Limit/Remaining/Reset on admitted and refused answers; TokenBucket exposes remainingTokens + secondsUntilFull');
  } else {
    console.log('  note  E7 RateLimit triple wiring — TokenBucket.java missing (optional surface, claims unmeasured)');
  }

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

/* D996 self-test — the E3 subtree judge must be order-immune AND still falsifiable.
 * Every corruption arm mutates an in-memory YAML string (no JVM, no file writes) and must redden
 * the RIGHT id for the RIGHT reason; the real plane and a benign reorder must stay green. This is
 * the regression guard for CI run 43252673446: before D996, the sibling `timelimiter:` block stole
 * the threshold match and 3 ids went red on correct YAML. */
function selfTest() {
  const GATEWAY_YAML = 'services/cloud/gateway/src/main/resources/application.yaml';
  const real = readFileSync(join(ROOT, GATEWAY_YAML), 'utf8');
  const base = judgeE3(real);
  const allHeld = (j) => j.cbFound && j.instFound && j.ids.every((id) => j.held[id]);
  const sig = (j) => `${j.cbFound}|${j.instFound}|${j.ids.map((id) => `${id}:${j.gaps[id].join(',')}`).join(';')}`;
  const baseSig = sig(base);
  const NEED = base.need;

  // Helpers over the raw lines. `timelimiterFirst` reconstructs the EXACT layout that reddened CI
  // run 43252673446: the sibling timelimiter: (same platform/ai/web names, only timeoutDuration)
  // placed ABOVE circuitbreaker:. It works from whichever order the shipped YAML currently uses.
  const linesOf = (y) => y.split(/\r?\n/);
  const colOf = (l) => (l.match(/^ */) || [''])[0].length;
  const effOf = (l) => l.trim() !== '' && !/^\s*#/.test(l);
  const siblingBlock = (y, key) => {
    const lines = linesOf(y);
    const start = lines.findIndex((l) => new RegExp(`^ {2}${key}:\\s*(?:#.*)?$`).test(l));
    if (start < 0) return null;
    let end = start + 1;
    for (; end < lines.length; end += 1) if (effOf(lines[end]) && colOf(lines[end]) <= 2) break;
    return { start, end, body: lines.slice(start, end) };
  };
  const timelimiterFirst = (y) => {
    const tl = siblingBlock(y, 'timelimiter');
    const cb = siblingBlock(y, 'circuitbreaker');
    if (!tl || !cb || tl.start < cb.start) return y; // already first (or absent) — caller checks change
    const lines = linesOf(y);
    const out = lines.slice(0, cb.start).concat(tl.body, lines.slice(cb.start, tl.start), lines.slice(tl.end));
    return out.join('\n');
  };

  // Each arm: [label, yaml, expectTag, predicate(j) -> bool, wantChange]. A RED arm must both
  // CHANGE the judged plane (D954 no-op guard) AND redden for its RIGHT reason (for-cause).
  const arms = [];

  // 1 — GREEN control: the shipped plane holds all five thresholds on all three ids.
  arms.push(['real plane holds all thresholds', real, 'GREEN', allHeld, false]);

  // 2 — the CI 43252673446 repro made GREEN by D996: timelimiter ABOVE the breaker, identical
  //     names, empty threshold bodies. The OLD reader ("first platform: under resilience4j:") would
  //     report 3 ids missing; the subtree judge must stay green. This is THE regression pin.
  const tlFirst = timelimiterFirst(real);
  arms.push(['timelimiter ABOVE breaker stays green (CI 43252673446 repro)', tlFirst, 'GREEN-ORDER', allHeld, true]);

  // 3 — a missing threshold on each id must redden THAT id, for cause (not a sibling).
  for (const id of base.ids) {
    const lines = linesOf(real);
    const cb = siblingBlock(real, 'circuitbreaker');
    const inst = lines.findIndex((l, i) => i > cb.start && /^ {4}instances:/.test(l));
    const start = lines.findIndex((l, i) => i > inst && new RegExp(`^ {6}${id}:`).test(l));
    if (start >= 0) for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i].includes('slidingWindowSize:')) { lines[i] = lines[i].replace('slidingWindowSize:', 'windowSizeErased:'); break; }
      if (lines[i].trim() && colOf(lines[i]) <= 6) break;
    }
    arms.push([`${id} slidingWindowSize erased reddens ${id} for cause`, lines.join('\n'), `RED:${id}`,
      (j) => j.gaps[id].includes('slidingWindowSize') && base.ids.every((o) => o === id || j.held[o]), true]);
  }

  // 4 — structural: drop circuitbreaker's own `instances:` -> NOT vacuously green. A weaker judge
  //     that fell through to the timelimiter's `instances:` (which is exactly what an earlier D996
  //     draft did) would pass here; the subtree-scoped one must go uncheckable.
  {
    const lines = linesOf(real);
    const cb = siblingBlock(real, 'circuitbreaker');
    const drop = lines.findIndex((l, i) => i > cb.start && /^ {4}instances:/.test(l));
    if (drop >= 0) lines.splice(drop, 1);
    arms.push(['breaker instances: erased is not vacuously green', lines.join('\n'), 'RED-NOINST',
      (j) => j.cbFound && !j.instFound && base.ids.every((id) => !j.held[id]), true]);
  }

  // 5 — the wrong-block trap, on the CI repro layout: all five thresholds moved OUT of the breaker
  //     and INTO the timelimiter platform block (so a whole-file grep WOULD pass). The subtree judge
  //     must read only the breaker and stay red for all three ids.
  {
    const lines = linesOf(tlFirst);
    const cb = lines.findIndex((l) => /^ {2}circuitbreaker:/.test(l));
    const tl = lines.findIndex((l) => /^ {2}timelimiter:/.test(l));
    // strip the five keys from every breaker id block
    for (let i = cb + 1; i < lines.length; i += 1) {
      if (/^ {6}(platform|ai|web):/.test(lines[i])) for (let k = i + 1; k < lines.length; k += 1) {
        if (lines[k].trim() && colOf(lines[k]) <= 6) break;
        if (NEED.some((n) => lines[k].includes(n + ':'))) lines[k] = '        # erased-from-breaker';
      }
    }
    // seed the five keys into the timelimiter platform block (whole-file grep sees them)
    let seeded = false;
    for (let i = tl + 1; i < cb; i += 1) if (/^ {6}platform:/.test(lines[i])) {
      lines.splice(i + 1, 0, ...NEED.map((k) => `        ${k}: 999`)); seeded = true; break;
    }
    arms.push(['thresholds seeded only into timelimiter stay red', lines.join('\n'), 'RED-WRONGBLOCK',
      (j) => seeded && j.instFound && base.ids.every((id) => !j.held[id]), true]);
  }

  // 6 — D954 no-op guard is enforced per-arm below: an arm that did not change the plane is a defect.
  let allCaught = true;
  for (const [label, armYaml, expect, ok, wantChange] of arms) {
    const j = judgeE3(armYaml);
    const changed = armYaml !== real;
    const noop = changed !== wantChange;
    const pass = !noop && ok(j);
    console.log(`  self-test  ${label.padEnd(62)} ${pass ? 'as-expected' : 'DEFECT'} [${expect}] sig=${sig(j)}${noop ? ' NOOP!' : ''}`);
    if (!pass) allCaught = false;
  }
  if (!allHeld(base)) {
    console.log(`  self-test  ${'real plane must hold before any arm'.padEnd(62)} DEFECT sig=${baseSig}`);
    allCaught = false;
  } else {
    console.log(`  self-test  ${'real plane must hold before any arm'.padEnd(62)} as-expected`);
  }
  console.log(`  self-test  E3 subtree judge all arms as-expected: ${allCaught} (${arms.length} arms)`);
  return allCaught ? 0 : 1;
}
