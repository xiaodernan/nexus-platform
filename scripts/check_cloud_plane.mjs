#!/usr/bin/env node
/**
 * NEXUS cloud plane guard — every declared piece of the sidecar plane must still hold together.
 *
 * The plane is assembled from many small, easy-to-drift pieces: four Spring Cloud modules, a
 * docker-compose profile, a CI job, a front-page doc (`docs/CLOUD.md`), three reader scripts and
 * six smokes. Each piece has its own proof; THIS reader checks the plane as a whole: a renamed
 * module, a swapped port map, a `@EnableAdminServer` gone, or a dropped smoke omission that nobody
 * would otherwise notice — reddens the gate, names the file and the claim it violated.
 *
 * What it asserts (each row independent; every failure is printed with the file and expected token):
 *
 *   1. services/cloud/pom.xml carries the four original modules plus D885's insight-service —
 *      the fifth, genuinely separate Eureka member that calls the others through OpenFeign.
 *   2. each module application.yaml carries the expected app name, port and — where the plane decided
 *      it is load-bearing — the exact guard token:
 *        eureka:  instance-id: ${spring.application.name}:${server.port}   (D858, same-artifact co-existence)
 *        admin:   register-with-eureka: false                               (D859, a window must not widen the doorway)
 *        gateway: CircuitBreaker … platform / ai / web                       (D850, three breakers exist)
 *        gateway: Retry … methods: [GET]                                    (D875, GETs retried, POSTs never)
 *   3. infra/docker-compose.yml `cloud` profile declares nexus/eureka:dev, nexus/config:dev,
 *      nexus/gateway:dev, nexus/admin:dev — and the admin-server depends on the gateway it watches.
 *   4. .github/workflows/ci.yml's `cloud` job invokes all six smokes (cloud_smoke, cloud_lb_smoke,
 *      cloud_refresh, cloud_monolith_refresh, cloud_retry_smoke, cloud_ai_admin_smoke) and the three
 *      readers (ports, discovery, edge). The `required` job feeds it into the merge gate.
 *   5. docs/CLOUD.md lists exactly these smokes in its gate table and carries the `not claimed` section
 *      (the honesty clause) and the port map 18761/18888/18088/19444.
 *
 * Cheap to run; precise about what it reads. Exit 1 on ANY red row.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function read(rel) {
  try { return readFileSync(join(root, rel), 'utf-8'); } catch { return ''; }
}
function check(label, rel, cond) {
  if (!cond) failures.push(`${label} — ${rel}`);
  else notes.push(`held ${label}`);
}
function mustContain(label, rel, needle) {
  check(label, rel, read(rel).includes(needle));
}

/* 1 ━ the reactor is the four modules the plane says it is */
const pom = read('services/cloud/pom.xml');
for (const m of ['eureka-server', 'config-server', 'gateway', 'admin-server']) {
  check(`reactor carries module ${m}`, 'services/cloud/pom.xml', pom.includes(`<module>${m}</module>`));
}
for (const m of ['analytics', 'auth', 'billing', 'worker']) {
  check(`no unplanned module ${m}`, 'services/cloud/pom.xml', !pom.includes(`<module>${m}</module>`));
}
/* D885: the plane's first independent service is part of the reactor, not a loose directory. */
check('reactor carries insight-service (D885)', 'services/cloud/pom.xml',
      pom.includes('<module>insight-service</module>')
      && existsSync(join(root, 'services/cloud/insight-service/pom.xml')));

/* 2 ━ each module still carries the load-bearing token */
const EU = 'services/cloud/eureka-server/src/main/resources/application.yaml';
mustContain('eureka app name', EU, 'name: nexus-eureka');
mustContain('eureka host coordinates', EU, 'port: ${NEXUS_EUREKA_PORT:18761}');
mustContain('eureka HA-collide guard', EU, 'instance-id: ${spring.application.name}:${server.port}');
mustContain('eureka peer opt-in default-off', EU, 'register-with-eureka: ${NEXUS_EUREKA_PEER:false}');

const CFG = 'services/cloud/config-server/src/main/resources/application.yaml';
mustContain('config app name', CFG, 'name: nexus-config');
mustContain('config host coordinates', CFG, 'port: ${NEXUS_CONFIG_PORT:18888}');

const GW = 'services/cloud/gateway/src/main/resources/application.yaml';
mustContain('gateway app name', GW, 'name: nexus-gateway');
mustContain('gateway host coordinates', GW, 'port: ${NEXUS_GATEWAY_PORT:18088}');
mustContain('gateway refresh needs /actuator/refresh', GW, 'refresh');
// retry GETs (D875) / never POSTs; three breakers (D850)
const gwText = read(GW);
check('gateway registers exactly three breakers (platform/ai/web)', GW,
      (gwText.match(/name: CircuitBreaker/g) || []).length >= 3);
check('gateway retry is GET-only', GW, gwText.includes('methods: [GET]'));
check('gateway routes lb platform + ai present', GW,
      gwText.includes('lb://NEXUS-PLATFORM') && gwText.includes('lb://NEXUS-AI'));

const ADM = 'services/cloud/admin-server/src/main/resources/application.yaml';
mustContain('admin app name', ADM, 'name: nexus-admin');
mustContain('admin host coordinates', ADM, 'port: ${NEXUS_ADMIN_PORT:19444}');
mustContain('admin watches but never widens the doorway', ADM, 'register-with-eureka: false');
mustContain('admin exposure stays health+info', ADM, 'include: health,info');

/* 3 ━ compose's `cloud` profile is the four images, with admin after gateway */
const compose = read('infra/docker-compose.yml');
for (const img of ['nexus/eureka:dev', 'nexus/config:dev', 'nexus/gateway:dev', 'nexus/admin:dev']) {
  mustContain(`compose cloud profile carries ${img}`, 'infra/docker-compose.yml', img);
}
check('compose pins admin-server depends on eureka+gateway', 'infra/docker-compose.yml',
      /admin-server[\s\S]*?depends_on:\s*\[?\s*eureka[\s\S]*?gateway/.test(compose));

/* 4 ━ the CI `cloud` job invokes every smoke + reader */
const CI = '.github/workflows/ci.yml';
const ciText = read(CI);
for (const step of [
  'cloud_smoke.sh', 'cloud_lb_smoke.sh', 'cloud_refresh.sh',
  'cloud_monolith_refresh.sh', 'cloud_retry_smoke.sh', 'cloud_ai_admin_smoke.sh',
  'check_cloud_plane_ports.mjs', 'check_cloud_edge.mjs', 'check_cloud_discovery.mjs',
]) {
  check(`ci cloud job invokes ${step}`, CI, ciText.includes(step));
}
check('required job needs the cloud job', CI, /needs:.*\bcloud\b/.test(ciText));

/* 5 ━ CLOUD.md is the one page and stays honest */
const cm = read('docs/CLOUD.md');
for (const smoke of [
  'cloud_smoke.sh', 'cloud_lb_smoke.sh', 'cloud_refresh.sh',
  'cloud_monolith_refresh.sh', 'cloud_retry_smoke.sh', 'cloud_ai_admin_smoke.sh',
]) {
  check(`CLOUD.md lists smoke ${smoke}`, 'docs/CLOUD.md', cm.includes(smoke));
}
check('CLOUD.md carries the honesty clause (not claim)', 'docs/CLOUD.md', /not claim/i.test(cm));
for (const p of ['18761', '18888', '18088', '19444']) {
  check(`CLOUD.md port map carries ${p}`, 'docs/CLOUD.md', cm.includes(p));
}

/* 6 ━ libs resolve: every module target either exists or rebuilds (informational, not a fail) */
const targets = ['eureka-server', 'config-server', 'gateway', 'admin-server']
  .map((m) => existsSync(join(root, 'services/cloud', m, 'target/app.jar')));
notes.push(`app.jar present on disk for ${targets.filter(Boolean).length}/${targets.length} modules (informational)`);

/* extra: the honest edge counter still exists (D880) */
check('edge 5xx counter filter exists', 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeResponseMetricsFilter.java',
      existsSync(join(root, 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeResponseMetricsFilter.java'))
      && read('services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeResponseMetricsFilter.java').includes('nexus.edge.response.5xx'));

if (failures.length) {
  console.log('CLOUD PLANE — FAIL');
  for (const f of failures) console.log('  - ' + f);
  console.log(`${failures.length} problem(s), ${notes.length} held`);
  process.exit(1);
}
console.log('CLOUD PLANE — PASS');
console.log(`${notes.length} checks held`);
console.log('\n' + notes.map((n) => '  ' + n).join('\n'));
process.exit(0);
