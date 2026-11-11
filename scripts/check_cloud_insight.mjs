#!/usr/bin/env node
/**
 * NEXUS D885 — the independent service's wiring and its host coordinate.
 *
 * The behaviour is proved by FIVE live smokes: `insight_smoke.sh` (no registry -> both rows
 * honestly `unavailable`), `insight_registry_smoke.sh` (the member registers), `insight_feign_smoke.sh`
 * (D887: two registered fixtures really ANSWER through `lb://`, and a non-UP status is copied),
 * `insight_config_smoke.sh` (D889: a config-repo edit lands without a restart),
 * `insight_admin_smoke.sh` (D892: Spring Boot Admin lists THAT instance as UP), and
 * `insight_circuit_smoke.sh` (D895: a Feign breaker's REAL actuator state opens) — plus the unit
 * tests and the absence/no-drive/no-peer falsifiers that keep those smokes falsifiable.
 * THIS reader holds the parts that could silently disappear: the reactor module, the declarative
 * clients, the honest fallbacks, the registry/config shape, the compose profile, the CI steps, the
 * docs, and the unit-test population. It also asks the one live question a new host coordinate must
 * answer: is :19555 free, or answered by a service THIS repository declares?
 *
 * WHAT THIS DOES NOT SAY: that the REAL platform or AI product answered (D887's upstreams are
 * throwaway fixtures registering under the product names), that a SECOND insight instance was ever
 * listed, that Eureka HA replication works in the DEPLOYED plane (D894 proved it only in a throwaway
 * pair this service never joined), that Docker was exercised (D853), or that the monolith was
 * decomposed. It is a read-only source census plus one GET; it registers, starts and
 * stops nothing — the smokes are the ones that boot JVMs.
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
const REGISTRY_SMOKE = 'scripts/insight_registry_smoke.sh';
const FEIGN_SMOKE = 'scripts/insight_feign_smoke.sh';
const FIXTURE = 'scripts/fixture_insight_upstream.py';
const CONFIG_SMOKE = 'scripts/insight_config_smoke.sh';
const CONFIG_VIEW = 'services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/ConfigViewController.java';
const CONFIG_VIEW_TEST = 'services/cloud/insight-service/src/test/java/com/nexus/cloud/insight/ConfigViewControllerTest.java';
const CONFIG_REPO = 'services/cloud/config-server/src/main/resources/config-repo/nexus-insight.yml';
const ADMIN_SMOKE = 'scripts/insight_admin_smoke.sh';
const ADMIN_FALSIFIER = 'scripts/falsify_insight_admin_smoke.sh';
const CIRCUIT_SMOKE = 'scripts/insight_circuit_smoke.sh';
const CIRCUIT_FALSIFIER = 'scripts/falsify_insight_circuit_smoke.sh';
const BREAKER_CONFIG_SMOKE = 'scripts/insight_breaker_config_smoke.sh';
const BREAKER_CONFIG_FALSIFIER = 'scripts/falsify_insight_breaker_config_smoke.sh';
const METRICS_SMOKE = 'scripts/insight_metrics_smoke.sh';
const METRICS_FALSIFIER = 'scripts/falsify_insight_metrics_smoke.sh';

for (const [rel, label] of [
  [POM, 'the module pom'], [APP, 'the application class'],
  [PLATFORM_CLIENT, 'the platform Feign client'], [AI_CLIENT, 'the AI Feign client'],
  [PLATFORM_FB, 'the platform fallback'], [AI_FB, 'the AI fallback'],
  [CONTROLLER, 'the plane controller'], [YAML, 'the module application.yaml'],
  [TEST, 'the controller unit tests'], [SMOKE, 'the insight smoke'],
  [REGISTRY_SMOKE, 'the registry-membership smoke (D886)'],
  [FEIGN_SMOKE, 'the live-upstream Feign smoke (D887)'],
  [FIXTURE, 'the registered-upstream fixture (D887)'],
  [CONFIG_SMOKE, 'the config hot-refresh smoke (D889)'],
  [CONFIG_VIEW, 'the @RefreshScope config view (D889)'],
  [CONFIG_VIEW_TEST, 'the config view unit tests (D889)'],
  [CONFIG_REPO, 'the insight config-repo entry (D889)'],
  [ADMIN_SMOKE, 'the Spring Boot Admin visibility smoke (D892)'],
  [ADMIN_FALSIFIER, 'the admin smoke absence-arm falsifier (D892)'],
  [METRICS_SMOKE, 'the metrics smoke (D918)'],
  [METRICS_FALSIFIER, 'the metrics absence-arm falsifier (D918)'],
  [CIRCUIT_SMOKE, 'the breaker-state smoke (D895)'],
  [CIRCUIT_FALSIFIER, 'the breaker smoke no-drive falsifier (D895)'],
  [BREAKER_CONFIG_SMOKE, 'the tuned-threshold breaker smoke (D899)'],
  [BREAKER_CONFIG_FALSIFIER, 'the raised-threshold breaker falsifier (D899)'],
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
has(CI, 'scripts/insight_registry_smoke.sh', 'CI runs the registry-membership smoke (D886)');
has(CI, 'scripts/insight_feign_smoke.sh', 'CI runs the live-upstream Feign smoke (D887)');
has(CI, 'scripts/insight_config_smoke.sh', 'CI runs the config hot-refresh smoke (D889)');
has(CI, 'scripts/insight_admin_smoke.sh', 'CI runs the admin visibility smoke (D892)');
has(CI, 'scripts/falsify_insight_admin_smoke.sh', 'CI runs the admin absence-arm falsifier (D892)');
has(CI, 'scripts/insight_circuit_smoke.sh', 'CI runs the breaker-state smoke (D895)');
has(CI, 'scripts/falsify_insight_circuit_smoke.sh', 'CI runs the breaker no-drive falsifier (D895)');
has(CI, 'scripts/verify_citation_engine_parity.mjs', 'CI runs the D888 engine-parity gate');

/* D887 — the smoke must prove MORE than "both rows are UP", or a cached/faked answer would pass. */
has(FEIGN_SMOKE, 'phase B: switch the AI instance to a non-UP status', 'the smoke flips an upstream at runtime');
has(FEIGN_SMOKE, 'a["status"]=="DEGRADED"', 'the view must copy the non-UP value verbatim');
has(FEIGN_SMOKE, 'SERVE /api/v1/health', 'the fixture access log proves the platform call arrived');
has(FEIGN_SMOKE, 'SERVE /ai/v1/health', 'the fixture access log proves the AI call arrived');
has(FIXTURE, "'status': 'UP'", 'the fixture registers UP');
has(FIXTURE, 'dataCenterInfo', 'the fixture uses Eureka\'s registration shape');
has(FIXTURE, 'def heartbeat()', 'the fixture keeps its lease alive');

/* D889 — the fifth member imports the Config Server and can rebind without a restart. */
has(POM, '<artifactId>spring-cloud-starter-config</artifactId>', 'the module imports the Config Server client');
has(YAML, 'optional:configserver:', 'the config import is optional, so the observer still boots');
has(YAML, 'include: health,info,metrics,refresh', 'POST /actuator/refresh is exposed');
has(CONFIG_VIEW, '@RefreshScope', 'the config view is refresh-scoped');
has(CONFIG_VIEW, '@Value("${nexus.insight.label:local}")', 'the label has an honest local default');
has(CONFIG_VIEW, '@GetMapping("/insight/config")', 'the resolved label has a read-only view');
has(CONFIG_VIEW, "'local' means no Config Server answered", 'the view says what local means');
has(CONFIG_VIEW_TEST, 'theLocalDefaultIsNamedHonestly', 'unit test: the local default');
has(CONFIG_VIEW_TEST, 'aResolvedLabelIsCopiedVerbatim', 'unit test: the resolved label is copied');
has(CONFIG_REPO, 'label: cloud-smoke', 'the config repo carries the smoke marker');
has(CONFIG_SMOKE, 'nexus.insight.label', 'the refresh smoke checks the changed key');
has(CONFIG_SMOKE, 'same pid', 'the refresh smoke asserts no restart happened');
has(CLOUD_DOC, 'D887', 'CLOUD.md records the live-upstream proof');
has(CLOUD_DOC, 'D889', 'CLOUD.md records the config-plane unit');
has(ATLAS, 'scripts/insight_feign_smoke.sh', 'the atlas lists the Feign smoke');
has(ATLAS, 'scripts/insight_config_smoke.sh', 'the atlas lists the config smoke');
has(CLOUD_DOC, 'nexus-insight', 'CLOUD.md documents the service');
has(CLOUD_DOC, 'OpenFeign', 'CLOUD.md names the declarative client');
has(CLOUD_DOC, '19555', 'CLOUD.md port map carries the coordinate');
has(ATLAS, 'scripts/check_cloud_insight.mjs', 'the atlas lists the reader');
has(ATLAS, 'scripts/insight_smoke.sh', 'the atlas lists the smoke');
has(ATLAS, 'services/cloud/insight-service/pom.xml', 'the atlas lists the module');
has(SMOKE, 'all_up must be false', 'the smoke asserts the aggregated verdict');
has(SMOKE, 'never a faked UP', 'the smoke states what it proves');

/* D892 — registration is not visibility. The admin claim is about ONE instance's own status, and
 * the smoke must be falsifiable when that instance is deliberately not booted. */
has(ADMIN_SMOKE, 'REQUIRE_UP', "the admin smoke reads the NEXUS-INSIGHT instance's own status");
has(ADMIN_SMOKE, 'REQUIRE_ABSENT', 'the admin smoke asserts a clean baseline before booting the member');
has(ADMIN_SMOKE, 'ABSENCE ARM', 'the smoke can be run with its subject deliberately absent');
has(ADMIN_SMOKE, 'statusInfo', "the status comes from Spring Boot Admin's statusInfo, not a body-wide grep");
has(ADMIN_FALSIFIER, 'never surfaced NEXUS-INSIGHT as UP', 'the falsifier requires the absence arm to fail');
has(ADMIN_FALSIFIER, 'NEXUS_INSIGHT_ADMIN_ABSENT=1', 'the falsifier actually runs the absence arm');
has(CLOUD_DOC, 'D892', 'CLOUD.md records the admin-window unit');
has(ATLAS, 'scripts/insight_admin_smoke.sh', 'the atlas lists the admin smoke');
has(ATLAS, 'scripts/falsify_insight_admin_smoke.sh', 'the atlas lists the absence-arm falsifier');
if (read(CLOUD_DOC).includes('was not booted against this member')) {
  offenders.push('STALE CLAIM — CLOUD.md still says SBA was never booted against the member; D892 proved otherwise');
} else notes.push('held CLOUD.md no longer claims SBA was never booted against the member');

/* D895 — an honest fallback ANSWER is not proof a breaker opened. The state must be readable from
 * the actuator, and the smoke must still be falsifiable when the failures that open it are removed. */
has(YAML, 'include: health,info,metrics,refresh,circuitbreakers', 'the breaker actuator endpoint is exposed');
has(CIRCUIT_SMOKE, 'REQUIRE_OPEN', 'the smoke reads a real OPEN state from the actuator');
has(CIRCUIT_SMOKE, 'NEXUS_CIRCUIT_SKIP_DRIVE', 'the smoke has a no-drive arm');
has(CIRCUIT_SMOKE, 'a fallback impersonated health', 'the degraded view is still judged honest');
has(CIRCUIT_FALSIFIER, 'NEXUS_CIRCUIT_SKIP_DRIVE=1', 'the falsifier actually removes the driving calls');
has(CLOUD_DOC, 'D895', 'CLOUD.md records the breaker-state unit');
has(ATLAS, 'scripts/insight_circuit_smoke.sh', 'the atlas lists the breaker smoke');
has(ATLAS, 'scripts/falsify_insight_circuit_smoke.sh', 'the atlas lists the no-drive falsifier');

/* D918 — the counters, not just the state: resilience4j-micrometer's meters must be real,
 * tag-readable, and count only after the driving sequence. The falsifier's red is the point. */
has(METRICS_SMOKE, 'resilience4j.circuitbreaker.calls?tag=name:', 'the smoke reads the per-breaker counter with a tag');
has(METRICS_SMOKE, 'NEXUS_METRICS_SKIP_DRIVE', 'the smoke has a no-drive arm');
has(METRICS_SMOKE, 'state meter lists both breakers', 'the state meter must list both breakers');
has(METRICS_SMOKE, 'combined COUNT', 'the smoke asserts the combined count moved after driving');
has(METRICS_FALSIFIER, 'NEXUS_METRICS_SKIP_DRIVE=1', 'the falsifier actually removes the driving calls');
has(CI, 'scripts/insight_metrics_smoke.sh', 'CI runs the metrics smoke (D918)');
has(CI, 'scripts/falsify_insight_metrics_smoke.sh', 'CI runs the metrics absence-arm falsifier (D918)');
has(CLOUD_DOC, 'D918', 'CLOUD.md records the metrics unit');
has(ATLAS, 'scripts/insight_metrics_smoke.sh', 'the atlas lists the metrics smoke');
has(ATLAS, 'scripts/falsify_insight_metrics_smoke.sh', 'the atlas lists the metrics falsifier');

/* D899 — the per-instance tuning must reach the SAME breakers Feign actually opens. D895 measured
 * that the registry-name instances were never used; a yaml edit that merely renames them is not
 * enough, so the smoke's call-by-call state sequence and its raised-threshold arm are wired here. */
if (!/PlatformHealthClienthealth:\s*\n\s+baseConfig: default\s*\n\s+minimumNumberOfCalls: 5\s*\n\s+failureRateThreshold: 60/.test(read(YAML))) {
  offenders.push('D899 — the platform instance is not declared under its REAL Feign name with 5 / 60 tuning');
} else notes.push('held D899 platform breaker bound with 5 / 60');
if (!/AiHealthClienthealth:\s*\n\s+baseConfig: default\s*\n\s+minimumNumberOfCalls: 3\s*\n\s+failureRateThreshold: 40/.test(read(YAML))) {
  offenders.push('D899 — the AI instance is not declared under its REAL Feign name with 3 / 40 tuning');
} else notes.push('held D899 AI breaker bound with 3 / 40');
if (/^\s+NEXUS-PLATFORM:\s*$/m.test(read(YAML)) || /^\s+NEXUS-AI:\s*$/m.test(read(YAML))) {
  offenders.push('STALE CONFIG — yaml still declares instances under the registry names D895 measured as unused');
} else notes.push('held yaml no longer declares the unused registry-name instances');
has(BREAKER_CONFIG_SMOKE, 'actuator: aligned names', 'the smoke reads the tuned thresholds from the actuator');
has(BREAKER_CONFIG_SMOKE, 'AI breaker did not open at its tuned minimumNumberOfCalls=3', 'the smoke requires AI to open on call 3');
has(BREAKER_CONFIG_SMOKE, 'platform breaker did not open at its tuned minimumNumberOfCalls=5', 'the smoke requires platform to open on call 5');
has(BREAKER_CONFIG_SMOKE, 'NEXUS_BREAKER_FALSIFY', 'the smoke has a raised-threshold arm');
has(BREAKER_CONFIG_SMOKE, 'both rows still non-UP', 'the degraded view stays honest after both breakers open');
has(BREAKER_CONFIG_FALSIFIER, 'NEXUS_BREAKER_FALSIFY=1', 'the falsifier raises both thresholds');
has(BREAKER_CONFIG_FALSIFIER, 'AI breaker did not open at its tuned minimumNumberOfCalls=3', 'the falsifier attributes the red to the raised threshold');
has(CI, 'scripts/insight_breaker_config_smoke.sh', 'CI runs the tuned-threshold smoke (D899)');
has(CI, 'scripts/falsify_insight_breaker_config_smoke.sh', 'CI runs the raised-threshold falsifier (D899)');
has(CLOUD_DOC, 'D899', 'CLOUD.md records the breaker-name reconciliation');
has(ATLAS, 'scripts/insight_breaker_config_smoke.sh', 'the atlas lists the tuned-threshold smoke');
has(ATLAS, 'scripts/falsify_insight_breaker_config_smoke.sh', 'the atlas lists the raised-threshold falsifier');
if (read(CLOUD_DOC).includes('the per-name instances are unused declarative config on this plane')) {
  offenders.push('STALE CLAIM — CLOUD.md still says the per-name instances are unused; D899 aligned them');
} else notes.push('held CLOUD.md no longer calls the per-name instances unused');

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
    console.log('\nWHAT THIS DOES NOT SAY: the REAL platform/AI products answered (D887 used fixtures), a SECOND insight instance was listed, HA ran in the DEPLOYED plane, Docker ran, or the monolith was split.');
    console.log(`\nRESULT: ${REPORT_ONLY ? 'REPORT' : 'FAIL'} — ${offenders.length} offender(s)`);
    process.exitCode = REPORT_ONLY ? 0 : 1;
    return;
  }
  console.log('\nWHAT THIS DOES NOT SAY: the REAL platform/AI products answered (D887 used fixtures), a SECOND insight instance was listed, HA ran in the DEPLOYED plane, Docker ran, or the monolith was split.');
  console.log('\nRESULT: PASS — the fifth module is wired, honest, and its host coordinate is free or ours');
  process.exitCode = 0;
};

await main();
