#!/usr/bin/env node
/**
 * NEXUS D885 — the independent service's wiring and its host coordinate.
 *
 * The behaviour is proved by `insight_smoke.sh` (a live process with no registry, asserting that
 * both upstreams are reported `unavailable` and none is faked as UP) and by `PlaneControllerTest`.
 * THIS reader holds the parts that could silently disappear: the reactor module, the declarative
 * clients, the honest fallbacks, the registry shape, the compose profile, the CI step, the two docs,
 * and the unit-test population. It also asks the one live question a new host coordinate must
 * answer: is :19555 free, or answered by a service THIS repository declares?
 *
 * WHAT THIS DOES NOT SAY: that the registry had any instance, that a real platform/AI service
 * answered, that Docker was exercised, or that this service is a decomposition of the monolith. It
 * is a read-only source census plus one GET; it registers, starts and stops nothing.
 *
 * Usage:  node scripts/check_cloud_insight.mjs [--no-probe] [--report]
 * Exit:   0 every claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = !process.argv.includes('--no-probe');
const REPORT_ONLY = process.argv.includes('--report');
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

const REACTOR = 'services/cloud/pom.xml';
const POM = 'services/cloud/insight-service/pom.xml';
const APP = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/InsightServiceApplication.java';
const PLATFORM_CLIENT = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/PlatformHealthClient.java';
const AI_CLIENT = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/AiHealthClient.java';
const PLATFORM_FB = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/PlatformHealthFallback.java';
const AI_FB = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/AiHealthFallback.java';
const CONTROLLER = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/PlaneController.java';
const YAML = 'services/cloud/insight-service/src/main/resources/application.yaml';
const TEST = 'services/cloud/insight-service/src/test/java/com/nexus/cloud/insight/PlaneControllerTest.java';
const COMPOSE = 'infra/docker-compose.yml';
const CI = '.github/workflows/ci.yml';
const CLOUD_DOC = 'docs/CLOUD.md';
const ATLAS = 'docs/ATLAS.md';
const SMOKE = 'scripts/insight_smoke.sh';

for (const [rel, label] of [
  [POM, 'the module pom'], [APP, 'the application class'],
  [PLATFORM_CLIENT, 'the platform Feign client'], [AI_CLIENT, 'the AI Feign client'],
  [PLATFORM_FB, 'the platform fallback'], [AI_FB, 'the AI fallback'],
  [CONTROLLER, 'the plane controller'], [YAML, 'the module application.yaml'],
  [TEST, 'the controller unit tests'], [SMOKE, 'the insight smoke'],
]) exists(rel, label);

has(REACTOR, '<module>insight-service</module>', 'the reactor builds the fifth module');
for (const dep of ['spring-boot-starter-web', 'spring-cloud-starter-netflix-eureka-client',
  'spring-cloud-starter-openfeign', 'spring-cloud-starter-loadbalancer',
  'spring-cloud-starter-circuitbreaker-resilience4j', 'spring-boot-starter-actuator']) {
  has(POM, `<artifactId>${dep}</artifactId>`, `pom declares ${dep}`);
}
has(APP, '@EnableFeignClients', 'declarative clients are enabled');
has(APP, '@EnableDiscoveryClient', 'registry membership is enabled');

has(PLATFORM_CLIENT, '@FeignClient(name = "NEXUS-PLATFORM"', 'the platform is called BY NAME');
has(PLATFORM_CLIENT, '@GetMapping("/api/v1/health")', 'the platform health path is the contract path');
has(PLATFORM_CLIENT, 'fallback = PlatformHealthFallback.class', 'the platform client has a fallback');
has(AI_CLIENT, '@FeignClient(name = "NEXUS-AI"', 'the AI service is called BY NAME');
has(AI_CLIENT, '@GetMapping("/ai/v1/health")', 'the AI health path is the contract path');
has(AI_CLIENT, 'fallback = AiHealthFallback.class', 'the AI client has a fallback');

/* the fallbacks must never impersonate a healthy upstream */
for (const [rel, label] of [[PLATFORM_FB, 'platform fallback'], [AI_FB, 'AI fallback']]) {
  has(rel, 'insight_fallback', `${label} marks itself as a fallback`);
  has(rel, '"unavailable"', `${label} reports unavailable`);
  // Judge CODE, not prose: the fallback's javadoc quotes {"status":"UP"} precisely to say it must
  // never be returned. Comment lines are stripped before asking whether the implementation lies.
  const code = read(rel).split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
  if (/"status",\s*"UP"/.test(code) || code.includes('"status":"UP"')) {
    offenders.push(`LIAR — ${rel}: a fallback claims status UP`);
  } else notes.push(`held ${label} never claims UP`);
}
has(CONTROLLER, 'Boolean.TRUE.equals(body.get("insight_fallback"))', 'the controller recognises fallbacks');
has(CONTROLLER, 'row.put("status", "unavailable")', 'the controller reports unavailable');
has(CONTROLLER, 'row.put("status", "unknown")', 'a status-less answer is unknown, not UP');
has(CONTROLLER, '"UP".equals(row.get("status"))', 'all_up requires a real UP');
has(CONTROLLER, 'cannot become a back door', 'the payload is not forwarded wholesale');

has(YAML, '${NEXUS_INSIGHT_PORT:19555}', 'the host coordinate is the documented default');
has(YAML, 'instance-id: ${spring.application.name}:${server.port}', 'the plane instance-id shape');
has(YAML, 'lease-renewal-interval-in-seconds: 5', 'the plane lease shape (5s)');
has(YAML, 'lease-expiration-duration-in-seconds: 10', 'the plane lease shape (10s)');
has(YAML, 'enabled: ${NEXUS_INSIGHT_EUREKA_ENABLED:true}', 'registration is opt-out, default on');
has(YAML, 'circuitbreaker:', 'Feign circuit breaking is configured');
has(YAML, 'baseConfig: default', 'resilience4j instances are configured');

for (const t of ['twoRealUpAnswersAreTheOnlyWayAllUpBecomesTrue',
  'aFallbackIsReportedUnavailableAndNeverImpersonatesHealth',
  'anExceptionIsNamedButNeverTurnedIntoAnUpAnswer',
  'aResponseWithoutAStatusIsUnknownNotAssumedHealthy']) {
  has(TEST, t, `unit test: ${t}`);
}

has(COMPOSE, 'MODULE: insight-service', 'compose packages the fifth module');
has(COMPOSE, '${NEXUS_INSIGHT_HOST_PORT:-19555}:8080', 'compose publishes the same host coordinate');
has(COMPOSE, 'depends_on: [eureka]', 'compose orders the registry before the member');
has(CI, 'scripts/check_cloud_insight.mjs', 'CI runs this reader');
has(CI, 'scripts/insight_smoke.sh', 'CI runs the honesty smoke');
has(CLOUD_DOC, 'nexus-insight', 'CLOUD.md documents the service');
has(CLOUD_DOC, 'OpenFeign', 'CLOUD.md names the declarative client');
has(CLOUD_DOC, '19555', 'CLOUD.md port map carries the coordinate');
has(ATLAS, 'scripts/check_cloud_insight.mjs', 'the atlas lists the reader');
has(ATLAS, 'scripts/insight_smoke.sh', 'the atlas lists the smoke');
has(ATLAS, 'services/cloud/insight-service/pom.xml', 'the atlas lists the module');
has(SMOKE, 'all_up must be false', 'the smoke asserts the aggregated verdict');
has(SMOKE, 'never a faked UP', 'the smoke states what it proves');

/* R1-shaped live question: a new host coordinate must be free or answered by OUR service only. */
const bound = (port) => new Promise((done) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; socket.destroy(); done(v); } };
  socket.setTimeout(1500, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

const main = async () => {
  console.log('NEXUS INSIGHT SERVICE — wiring and host coordinate');
  console.log(`  plane read   ${ROOT}`);
  if (PROBE) {
    if (await bound(19555)) {
      try {
        const res = await fetch('http://127.0.0.1:19555/insight/plane', { signal: AbortSignal.timeout(3000) });
        const body = await res.text();
        if (res.status === 200 && body.includes('"nexus-insight"')) {
          notes.push('live :19555 — OURS (a running nexus-insight answers)');
        } else {
          offenders.push('R1 :19555 is bound by something that is not nexus-insight');
        }
      } catch {
        offenders.push('R1 :19555 is bound but did not identify itself as nexus-insight');
      }
    } else {
      notes.push('live :19555 — FREE (nothing bound)');
    }
  } else {
    notes.push('live :19555 — UNASKED (--no-probe)');
  }
  console.log(`  live probe   ${PROBE ? 'asked' : 'UNASKED'}`);
  console.log(`  claims held  ${notes.length}`);
  if (offenders.length) {
    console.log(`\nOFFENDERS (${offenders.length}):`);
    for (const o of offenders) console.log(`  - ${o}`);
    console.log('\nWHAT THIS DOES NOT SAY: a registry had instances, a real upstream answered, or Docker ran.');
    console.log(`\nRESULT: ${REPORT_ONLY ? 'REPORT' : 'FAIL'} — ${offenders.length} offender(s)`);
    process.exitCode = REPORT_ONLY ? 0 : 1;
    return;
  }
  console.log('\nWHAT THIS DOES NOT SAY: a registry had instances, a real upstream answered, or Docker ran.');
  console.log('\nRESULT: PASS — the fifth module is wired, honest, and its host coordinate is free or ours');
  process.exitCode = 0;
};

await main();
