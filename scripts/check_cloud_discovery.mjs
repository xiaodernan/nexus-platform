#!/usr/bin/env node
/**
 * NEXUS D848 — the monolith registers by opt-in, and the edge routes it BY NAME.
 *
 * WHY THIS EXISTS (the class, not the five files). D845 landed the registry, the config server and the
 * edge, and said out loud what it did not do: "The monolith is not a Eureka client and no route uses
 * lb://; that is the next step." D847 then measured the consequence on the machine: the platform jar
 * carried 0 eureka/spring-cloud/actuator libraries, so the edge could only route by a hardcoded
 * host:port — a address that dies with the process, cannot move, and cannot be load-balanced. Service
 * discovery is the element that makes the plane a microservice plane rather than three decorators and
 * a proxy. This reader asks the wiring that claim needs, and asks it of the DEFAULT boot too: the
 * monolith must register only when a profile says so, because the normal single-process boot is the
 * product today and a registry call on every startup is a change nobody asked for.
 *
 * THE RULES, one sentence each:
 *   R1  The platform pom imports the spring-cloud BOM and declares the eureka-client and actuator
 *       starters — the libraries without which registration is a comment, not a capability.
 *   R2  With the client on the classpath, the BASE application.yml keeps it disabled by default
 *       (`enabled: ${NEXUS_EUREKA_ENABLED:false}`): the normal boot registers nothing.
 *   R3  An application-cloud.yml exists, enables the client, and its defaultZone port is the eureka
 *       module's own default host port — one port map with D847's plane, not a second copy.
 *   R4  The gateway carries a cloud-profile document that points the platform route at
 *       `lb://<THE PLATFORM'S DECLARED NAME>`, and the base route actually reads that property
 *       (env override still wins): routing by name is a profile decision, not a retyped address.
 *   R5  The lb smoke exists, reads the eureka and gateway module ports instead of retyping literals,
 *   R6  The AI service registers by opt-in too (apps/ai/nexus_ai/discovery.py + py-eureka-client),
 *       findable but never a client, and the gateway's cloud document routes the ai route
 *       lb://NEXUS-AI the same way it routes the platform — the edge discovers both names it owns.
 *       so its green is a verdict about the plane a developer actually gets.
 *
 * WHAT THIS DOES NOT SAY. It does not run anything: the PROOF that a registered instance answers a
 * proxied request is `scripts/cloud_lb_smoke.sh` run live, and this reader only asks that the smoke
 * exists and keeps one port map. It does not judge the web route — it stays URI by design (the
 * browser's entry is not a service the edge needs to balance), and that is a decision per service,
 * not a drift. It does not read the
 * compose file (the cloud profile's deployment shape is D847's R4 population), and it says nothing
 * about whether the edge authenticates, rate-limits or breaks a circuit. The lb:// name is compared
 * with the platform's own spring.application.name uppercased the way Eureka lists it, so a rename
 * on one side reddens here instead of 503-ing at the edge.
 *
 * Usage:
 *   node scripts/check_cloud_discovery.mjs
 *   node scripts/check_cloud_discovery.mjs --dir=<repo-root-copy>   # census a planted plane
 *   node scripts/check_cloud_discovery.mjs --report                 # print, always exit 0
 *   node scripts/check_cloud_discovery.mjs --verbose                # name every check
 *
 * Exit: 0 no offender · 1 an offender · 2 not checkable (a core surface unreadable, or a plane with
 *       no application name / registry port to compare against — a census of zero has cleared nothing).
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
    'services/platform/pom.xml',
    'services/platform/src/main/resources/application.yml',
    'services/cloud/gateway/src/main/resources/application.yaml',
    'services/cloud/eureka-server/src/main/resources/application.yaml',
  ];
  const OPTIONAL = [
    'services/platform/src/main/resources/application-cloud.yml',
    'scripts/cloud_lb_smoke.sh',
    'apps/ai/nexus_ai/discovery.py',
    'apps/ai/pyproject.toml',
  ];
  const [POM, PLATFORM_YML, GATEWAY_YAML, EUREKA_YAML] = CORE;
  const [CLOUD_YML, LB_SMOKE, DISCOVERY_PY, AI_PYPROJECT] = OPTIONAL;

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

  const nameMatch = /application:\s*\n\s*name:\s*([A-Za-z0-9._-]+)/.exec(text[PLATFORM_YML]);
  const portMatch = /port:\s*\$\{[A-Z_]+:(\d+)\}/.exec(text[EUREKA_YAML]);
  if (!nameMatch || !portMatch) {
    console.log(`RESULT: NOT CHECKED — the plane declares ${nameMatch ? `name ${nameMatch[1]}` : 'no platform name'}, `
      + `${portMatch ? `registry port ${portMatch[1]}` : 'no registry port'}. Nothing to compare against.`);
    return 2;
  }
  const appName = nameMatch[1].toUpperCase();
  const registryPort = Number(portMatch[1]);

  const offenders = [];
  const checks = [];
  const charge = (rule, detail) => offenders.push(`${rule} ${detail}`);
  const note = (label, ok, detail) => checks.push({ label, ok, detail });

  /* R1 — the libraries */
  const has = (artifact) => text[POM].includes(`<artifactId>${artifact}</artifactId>`);
  const bom = has('spring-cloud-dependencies');
  const client = has('spring-cloud-starter-netflix-eureka-client');
  const actuator = has('spring-boot-starter-actuator');
  if (!bom) charge('R1', 'the platform pom imports no spring-cloud-dependencies BOM: the client version would be a guess');
  if (!client) charge('R1', 'the platform pom declares no spring-cloud-starter-netflix-eureka-client: the monolith cannot register');
  if (!actuator) charge('R1', 'the platform pom declares no spring-boot-starter-actuator: the registry has no health to ask');
  note('R1 pom libraries', bom && client && actuator, `bom=${bom} eureka-client=${client} actuator=${actuator}`);

  /* R2 — the default boot registers nothing (asked only when the client is present) */
  if (client) {
    const off = /eureka:\s*\n\s*client:\s*\n\s*enabled:\s*\$\{NEXUS_EUREKA_ENABLED:false\}/.test(text[PLATFORM_YML]);
    if (!off) {
      charge('R2', 'the base application.yml does not keep the eureka client disabled by default '
        + '(\\${NEXUS_EUREKA_ENABLED:false}): the normal monolith boot would register on every startup');
    }
    note('R2 default-off', off, off ? 'enabled: ${NEXUS_EUREKA_ENABLED:false}' : 'no env-backed false default');
  } else {
    note('R2 default-off', true, 'UNASKED — no client on the classpath to disable (R1 carries that)');
  }

  /* R3 — the opt-in profile, on the plane's own registry port */
  if (text[CLOUD_YML] === undefined) {
    charge('R3', 'no application-cloud.yml: registration has no opt-in profile to live in');
    note('R3 cloud profile', false, 'absent');
  } else {
    const cloud = text[CLOUD_YML];
    const enabled = /enabled:\s*true/.test(cloud);
    const zone = /defaultZone:\s*\$\{NEXUS_EUREKA_URI:http:\/\/127\.0\.0\.1:(\d+)\/eureka\/\}/.exec(cloud);
    if (!enabled) charge('R3', 'application-cloud.yml does not enable the eureka client: the profile registers nothing');
    if (!zone) {
      charge('R3', 'application-cloud.yml names no env-backed defaultZone on the plane\'s registry: where it registers is a guess');
    } else if (Number(zone[1]) !== registryPort) {
      charge('R3', `application-cloud.yml registers on :${zone[1]} but the eureka module defaults to :${registryPort}: `
        + 'two copies of one port map (D847\'s rule, one service over)');
    }
    note('R3 cloud profile', enabled && Boolean(zone) && Number(zone?.[1]) === registryPort,
      `enabled=${enabled} zone=${zone ? zone[1] : 'ABSENT'} registry-module=${registryPort}`);
  }

  /* R4 — the edge routes by name, by profile, and the route reads the property */
  const documents = text[GATEWAY_YAML].split(/^---\s*$/m);
  const cloudDoc = documents.find((d) => /on-profile:\s*cloud/.test(d));
  const lb = cloudDoc && /platform-uri:\s*lb:\/\/([A-Za-z0-9._-]+)/.exec(cloudDoc);
  const reads = /\$\{NEXUS_PLATFORM_URI:\$\{nexus\.edge\.platform-uri:http:\/\/127\.0\.0\.1:\d+\}\}/.test(text[GATEWAY_YAML]);
  if (!cloudDoc) charge('R4', 'the gateway yaml has no cloud-profile document: the edge cannot choose discovery by profile');
  else if (!lb) charge('R4', 'the gateway cloud document sets no platform-uri: lb:// route: the profile changes nothing');
  else if (lb[1].toUpperCase() !== appName) {
    charge('R4', `the cloud document routes lb://${lb[1]} but the platform declares ${nameMatch[1]}: `
      + 'the edge would discover a name nobody registers');
  }
  if (!reads) {
    charge('R4', 'the base platform route does not read ${NEXUS_PLATFORM_URI:${nexus.edge.platform-uri:...}}: '
      + 'the profile property lands nowhere, or the address is a second hardcoded copy');
  }
  note('R4 lb by profile', Boolean(cloudDoc && lb && lb[1].toUpperCase() === appName && reads),
    `cloud-doc=${Boolean(cloudDoc)} lb=${lb ? lb[1] : 'ABSENT'} declared=${appName} route-reads-property=${reads}`);

  /* R5 — the smoke keeps one port map */
  if (text[LB_SMOKE] === undefined) {
    charge('R5', 'no scripts/cloud_lb_smoke.sh: the proxied-request proof has no home');
    note('R5 lb smoke', false, 'absent');
  } else {
    const smoke = text[LB_SMOKE];
    const retyped = ['NEXUS_SMOKE_EUREKA_PORT', 'NEXUS_SMOKE_GATEWAY_PORT']
      .filter((env) => new RegExp(`\\$\\{${env}:-\\d+\\}`).test(smoke));
    const readsEureka = /module_port eureka-server/.test(smoke);
    const readsGateway = /module_port gateway/.test(smoke);
    for (const env of retyped) {
      charge('R5', `the lb smoke retypes \${${env}:-<port>}: a green proof is about an offset plane nobody deploys`);
    }
    if (!readsEureka || !readsGateway) {
      charge('R5', `the lb smoke does not read the module ports (eureka=${readsEureka} gateway=${readsGateway}): `
        + 'the proof runs on coordinates of its own');
    }
    note('R5 lb smoke', retyped.length === 0 && readsEureka && readsGateway,
      `retyped=${retyped.length} reads-eureka=${readsEureka} reads-gateway=${readsGateway}`);
  }

  /* R6 — the AI service registers by opt-in, the edge routes it by name too (D856) */
  let aiName = 'NEXUS-AI';
  if (text[DISCOVERY_PY] === undefined) {
    charge('R6', 'no apps/ai/nexus_ai/discovery.py: the AI service has nothing that can register it');
    note('R6 ai discovery', false, 'absent');
  } else {
    const py = text[DISCOVERY_PY];
    const optIn = /NEXUS_AI_EUREKA_ENABLED/.test(py) && /eureka_enabled/.test(py);
    const offByDefault = /strip\(\)\.lower\(\) in \{"true", "1", "yes"\}/.test(py);
    const findableNotClient = /should_discover=False/.test(py);
    const fastLeases = /renewal_interval_in_secs=5/.test(py);
    const nameMatch2 = /NEXUS_AI_APP_NAME", "([A-Za-z0-9._-]+)"/.exec(py);
    if (nameMatch2) aiName = nameMatch2[1].toUpperCase();
    const readsHostPort = /NEXUS_AI_HOST_PORT/.test(py);
    const declaresLib = text[AI_PYPROJECT] !== undefined && /py-eureka-client/.test(text[AI_PYPROJECT]);
    if (!optIn) charge('R6', 'discovery.py does not read NEXUS_AI_EUREKA_ENABLED: registration is not opt-in');
    if (!offByDefault) charge('R6', 'discovery.py does not gate on an explicit true/1/yes: the default boot would register');
    if (!findableNotClient) charge('R6', 'discovery.py keeps should_discover: the AI would fetch the registry — it must be findable, not a client');
    if (!fastLeases) charge('R6', 'discovery.py declares no 5s lease: a killed instance would linger in the registry');
    if (!nameMatch2) charge('R6', 'discovery.py names no NEXUS_AI_APP_NAME default: the edge has nothing stable to look up');
    if (!readsHostPort) charge('R6', 'discovery.py does not read NEXUS_AI_HOST_PORT: the registration would advertise a port nobody binds');
    if (!declaresLib) charge('R6', 'apps/ai/pyproject.toml does not declare py-eureka-client: the opt-in is decoration');
    note('R6 ai opt-in',
      optIn && offByDefault && findableNotClient && fastLeases && Boolean(nameMatch2) && readsHostPort && declaresLib,
      `opt-in=${optIn} off-default=${offByDefault} findable=${findableNotClient} 5s=${fastLeases} name=${nameMatch2 ? nameMatch2[1] : 'ABSENT'} host-port=${readsHostPort} lib=${declaresLib}`);
  }

  const aiReads = /\$\{NEXUS_AI_URI:\$\{nexus\.edge\.ai-uri:http:\/\/127\.0\.0\.1:\d+\}\}/.test(text[GATEWAY_YAML]);
  const aiLb = cloudDoc && /ai-uri:\s*lb:\/\/([A-Za-z0-9._-]+)/.exec(cloudDoc);
  if (!aiReads) charge('R6', 'the base ai route does not read ${NEXUS_AI_URI:${nexus.edge.ai-uri:...}}: the profile property lands nowhere');
  if (cloudDoc && !aiLb) charge('R6', 'the gateway cloud document sets no ai-uri: lb:// route: the profile changes nothing for the AI');
  else if (aiLb && aiLb[1].toUpperCase() !== aiName) {
    charge('R6', `the cloud document routes lb://${aiLb[1]} but the AI registers as ${aiName}: the edge would look up a name nobody answers`);
  }
  note('R6 ai lb by profile', Boolean(aiReads && aiLb && aiLb[1].toUpperCase() === aiName),
    `ai-route-reads-property=${aiReads} ai-lb=${aiLb ? aiLb[1] : 'ABSENT'} declared=${aiName}`);

  /* the verdict */
  console.log('NEXUS cloud discovery — the monolith and the AI service both register by opt-in; the edge routes both by name');
  console.log(`  plane read         ${BASE}`);
  console.log(`  surfaces           ${CORE.length} core + ${OPTIONAL.length} optional read`);
  console.log(`  platform name      ${nameMatch[1]} (Eureka lists ${appName})`);
  console.log(`  registry default   :${registryPort}`);
  if (VERBOSE) for (const c of checks) console.log(`    ${c.ok ? 'ok  ' : 'RED '} ${c.label.padEnd(18)} ${c.detail}`);
  console.log('');
  if (offenders.length) {
    console.log(`OFFENDERS (${offenders.length}):`);
    for (const o of offenders) console.log(`  - ${o}`);
  } else {
    console.log('  the monolith and the AI can register, do not unless their profiles say so, register on the');
    console.log('  plane\'s own registry port and name, and the edge routes both by their declared names under the cloud profile');
  }
  console.log('');
  console.log('WHAT THIS DOES NOT SAY: that a registered instance answers a proxied request (run the lb smoke');
  console.log('live for that); anything about the web route (it stays URI by design — the browser entry);');
  console.log('anything about compose, TLS, auth, rate limits or circuit breakers.');
  console.log('');

  if (REPORT_ONLY) { console.log('RESULT: REPORT — printed, no verdict claimed'); return 0; }
  if (offenders.length) { console.log(`RESULT: FAIL — ${offenders.length} offender(s)`); return 1; }
  console.log(`RESULT: PASS — ${checks.length} checks, no offender`);
  return 0;
}