#!/usr/bin/env node
/**
 * NEXUS D847 — both sides of scripts/check_cloud_plane_ports.mjs, shown rather than asserted.
 *
 * A validator whose first run is also its first test has not been tested, so every arm below states the
 * verdict it expects BEFORE the shipped reader is called, and the harness exits non-zero if a prediction
 * misses. The arms come in pairs: each "the reader must catch this" arm has a "the reader must NOT catch
 * this" twin that differs in exactly one property, so neither can pass by luck.
 *
 * THE FIXTURE IS A LIVE PORT, NOT A MOCKED PROBE. R1/R2 ask the machine who owns a port, so an arm that
 * only planted text would test the static half and leave the half that found the real defect unasked.
 * This harness starts four loopback HTTP servers on EPHEMERAL ports — a registry, a config server, an
 * edge, and a port that answers 404 to everything — plants a copy of the six surfaces pointing at them,
 * and then changes one property of what those servers answer. Nothing here touches the machine's real
 * :8761, and no arm depends on whether another project's registry happens to be running today: the
 * defect is reproduced by fixture, not by luck. The fourth server is where a drifted coordinate lands:
 * "the wrong port" must mean a port this harness controls, not whatever the machine happens to have
 * listening one number above a fixture port.
 *
 * THE ARMS, AND WHAT EACH PAIR IS ABOUT.
 *
 *   THE DEFECT          a registry answering on the plane's default port with an application this repo
 *                       does not declare is caught (R1 and R2, the reader's whole subject) — and the SAME
 *                       fixture listing only declared names is not. One property differs: the app list.
 *
 *   THE BOUND PORT      a port that is bound but answers 404 at the identity path is somebody else's too
 *                       (R1) — and the twin that answers 200 with our names is not. "Free" and "ours" are
 *                       different answers and a reader that conflated them would pass a squatted port.
 *
 *   THE SECOND COPY     a zone port that is not the registry module's default (R3), a compose publish that
 *                       is not the module's default (R4), and a smoke that retypes a port literal (R5) are
 *                       each caught — against the same plant with the copies agreeing, which is not.
 *
 *   THE LIMITS          the platform/AI/web upstream URLs are NOT this plane's coordinates: planting a
 *                       foreign-looking upstream must not offend. And the container-internal port is not
 *                       the host port: publishing <host>:8761 where host != 8761 must not offend either.
 *                       Both limits are pinned here so widening them is a decision, not a drift.
 *
 *   THE REFUSALS        a missing surface, an empty name population, an unknown flag and --no-probe on a
 *                       clean tree are refusals (exit 2), not verdicts — "did not run" and "found nothing"
 *                       are different answers. --report prints and claims nothing (exit 0).
 *
 * Every arm gets its own copy of the six surfaces under a per-process temp root, so no arm can borrow
 * another arm's redness and the working tree is never the fixture. Every mutation asserts that the text it
 * rewrites is present exactly once in the copy, so an arm cannot pass by silently running an unmutated tree.
 *
 * Usage: node scripts/falsify_cloud_plane_ports.mjs
 * Exit:  0 every prediction held · 1 an arm missed · 2 the harness could not run (a surface absent, a
 *        fixture server that would not listen, a child that never started)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpreterDeath, safeRemove } from './spawn_guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_cloud_plane_ports.mjs');
const FIX = join(tmpdir(), `nexus-d847-falsify-${process.pid}`);

const SURFACES = [
  'services/cloud/eureka-server/src/main/resources/application.yaml',
  'services/cloud/config-server/src/main/resources/application.yaml',
  'services/cloud/gateway/src/main/resources/application.yaml',
  'services/platform/src/main/resources/application.yml',
  'infra/docker-compose.yml',
  'scripts/cloud_smoke.sh',
];
const [EUREKA_YAML, CONFIG_YAML, GATEWAY_YAML, PLATFORM_YAML, COMPOSE, SMOKE] = SURFACES;

const missing = SURFACES.filter((rel) => !existsSync(join(ROOT, rel)));
if (missing.length) {
  console.log(`RESULT: NOT CHECKED — ${missing.length} of ${SURFACES.length} surfaces this harness copies are `
    + `absent: ${missing.join(', ')}. No arm was run.`);
  process.exit(2);
}
if (!existsSync(CHECKER)) {
  console.log(`RESULT: NOT CHECKED — the reader under test is absent: ${CHECKER}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ the three fixture services */

const state = { apps: ['NEXUS-GATEWAY'], registryStatus: 200 };
const registryBody = () => JSON.stringify({
  applications: {
    versions__delta: '1',
    apps__hashcode: `UP_${state.apps.length}_`,
    application: state.apps.map((name) => ({
      name,
      instance: [{ instanceId: `127.0.0.1:${name.toLowerCase()}:1`, hostName: '127.0.0.1', app: name,
        status: 'UP', port: { $: 1, '@enabled': 'true' },
        dataCenterInfo: { '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo', name: 'MyOwn' } }],
    })),
  },
});

const listen = (handler) => new Promise((done, refuse) => {
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); };
    handler(req, send);
  });
  server.once('error', refuse);
  server.listen(0, '127.0.0.1', () => done(server));
});

let servers;
try {
  servers = {
    registry: await listen((req, send) => {
      if (req.url === '/eureka/apps') send(state.registryStatus, state.registryStatus === 200 ? registryBody() : '{}');
      else send(404, '{}');
    }),
    config: await listen((req, send) => {
      if (req.url === '/nexus-gateway/default') {
        send(200, JSON.stringify({ name: 'nexus-gateway', profiles: ['default'], label: null, propertySources: [] }));
      } else send(404, '{}');
    }),
    edge: await listen((req, send) => {
      if (req.url === '/cloud/info') {
        send(200, JSON.stringify({ service: 'nexus-gateway', label: 'local', routes: [] }));
      } else send(404, '{}');
    }),
    dead: await listen((_req, send) => send(404, '{}')),
  };
} catch (err) {
  console.log(`RESULT: NOT CHECKED — a fixture server would not listen: ${err?.message ?? err}. No arm was run.`);
  process.exit(2);
}
const PORT = {
  registry: servers.registry.address().port,
  config: servers.config.address().port,
  edge: servers.edge.address().port,
  dead: servers.dead.address().port,
};

/* ------------------------------------------------------------------ the plant */

safeRemove(FIX);
mkdirSync(FIX, { recursive: true });

/** Replace exactly one match, or refuse: an arm that silently mutated nothing is not an arm. */
function sub1(text, re, replacement, what) {
  const hits = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? [];
  if (hits.length !== 1) throw new Error(`plant anchor expected exactly 1 site, got ${hits.length}: ${what}`);
  return text.replace(re, replacement);
}

let armNo = 0;
function plant(name, mutate = () => {}) {
  const dir = join(FIX, `${String(armNo += 1).padStart(2, '0')}-${name}`);
  const files = {};
  for (const rel of SURFACES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    let text = readFileSync(join(ROOT, rel), 'utf8');
    // Point the copy at the fixture ports. The shipped numbers are read, never retyped here, so a later
    // unit that moves the plane's defaults does not silently un-arm this harness.
    if (rel === EUREKA_YAML) {
      text = sub1(text, /(\$\{NEXUS_EUREKA_PORT:)\d+(\})/, `$1${PORT.registry}$2`, 'eureka port');
    } else if (rel === CONFIG_YAML) {
      text = sub1(text, /(\$\{NEXUS_CONFIG_PORT:)\d+(\})/, `$1${PORT.config}$2`, 'config port');
    } else if (rel === GATEWAY_YAML) {
      text = sub1(text, /(\$\{NEXUS_GATEWAY_PORT:)\d+(\})/, `$1${PORT.edge}$2`, 'gateway port');
      text = sub1(text, /(\$\{NEXUS_EUREKA_URI:http:\/\/127\.0\.0\.1:)\d+(\/eureka\/\})/,
        `$1${PORT.registry}$2`, 'zone port');
      text = sub1(text, /(\$\{NEXUS_CONFIG_URI:http:\/\/127\.0\.0\.1:)\d+(\})/, `$1${PORT.config}$2`, 'config uri');
    } else if (rel === COMPOSE) {
      for (const [env, port] of [['NEXUS_EUREKA_HOST_PORT', PORT.registry], ['NEXUS_CONFIG_HOST_PORT', PORT.config],
        ['NEXUS_GATEWAY_HOST_PORT', PORT.edge]]) {
        text = sub1(text, new RegExp(`(\\$\\{${env}:-)\\d+(\\}:\\d+)`), `$1${port}$2`, `${env} publish`);
      }
    }
    files[rel] = text;
  }
  mutate(files, dir);
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;  // an arm that wants a surface absent deletes it after the plant
    writeFileSync(join(dir, rel), body, 'utf8');
  }
  return dir;
}

/** Put a retyped smoke literal back: the R5 defect, planted from the reader's own words. */
const retypeSmoke = (files) => {
  files[SMOKE] = sub1(files[SMOKE], /(EUREKA_PORT="\$\{NEXUS_SMOKE_EUREKA_PORT:-)[^}]*(\}")/,
    (_m, head, tail) => `${head}18761${tail}`, 'smoke eureka default');
};

const ARMS = [
  { name: 'THE DEFECT: the default port answers as a registry listing an application this repo does not declare',
    state: { apps: ['NEXUS-GATEWAY', 'FOOTBALL-CORE'], registryStatus: 200 },
    dir: plant('foreign-registry'), expect: 1,
    must: [/RESULT: FAIL/, /- R1 eureka-server defaults to host port/, /- R2 the edge's default zone/,
      /FOOTBALL-CORE/, /FOREIGN/],
    absent: [/RESULT: PASS/] },

  { name: 'its twin: the SAME fixture listing only declared names is not an offender',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('our-registry'), expect: 0,
    must: [/RESULT: PASS/, /names declared\s+4:/, /probe\s+eureka-server\s+:\d+\s+OURS/,
      /probe\s+config-server\s+:\d+\s+OURS/, /probe\s+gateway\s+:\d+\s+OURS/, /no offender/],
    absent: [/FOOTBALL-CORE/, /OFFENDERS/] },

  { name: 'THE BOUND PORT: bound but answering 404 at the identity path is somebody else\'s too',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 404 },
    dir: plant('squatted'), expect: 1,
    must: [/RESULT: FAIL/, /- R1 eureka-server/, /answers HTTP 404/, /OFFENDERS \(1\)/],
    absent: [/- R2/] },

  { name: 'THE SECOND COPY (R3): the edge\'s zone port is not the registry module\'s default',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('zone-drift', (files) => {
      files[GATEWAY_YAML] = sub1(files[GATEWAY_YAML],
        /(\$\{NEXUS_EUREKA_URI:http:\/\/127\.0\.0\.1:)\d+(\/eureka\/\})/,
        `$1${PORT.dead}$2`, 'zone drift');
    }), expect: 1,
    must: [/RESULT: FAIL/, /- R3 the edge's default zone port/, /OFFENDERS \(1\)/],
    absent: [/- R1/, /- R4/, /- R5/] },

  { name: 'THE SECOND COPY (R4): compose publishes a host port the module does not default to',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('publish-drift', (files) => {
      files[COMPOSE] = sub1(files[COMPOSE], /(\$\{NEXUS_CONFIG_HOST_PORT:-)\d+(\}:\d+)/,
        `$1${PORT.dead}$2`, 'publish drift');
    }), expect: 1,
    must: [/RESULT: FAIL/, /- R4 compose publishes config-server on host/, /OFFENDERS \(1\)/],
    absent: [/- R1/, /- R3/, /- R5/] },

  { name: 'THE SECOND COPY (R5): the smoke retypes a port literal instead of reading the module',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('smoke-retyped', retypeSmoke), expect: 1,
    must: [/RESULT: FAIL/, /- R5 the smoke retypes/, /smoke literals\s+1 of 3 retyped/, /OFFENDERS \(1\)/],
    absent: [/- R1/, /- R3/, /- R4/] },

  { name: 'THE LIMIT: the platform upstream is the monolith\'s coordinate, not this plane\'s to judge',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('upstream-foreign', (files) => {
      files[GATEWAY_YAML] = sub1(files[GATEWAY_YAML],
        /(\$\{NEXUS_PLATFORM_URI:http:\/\/127\.0\.0\.1:)\d+(\})/, '$19$2', 'upstream port');
    }), expect: 0,
    must: [/RESULT: PASS/, /no offender/],
    absent: [/OFFENDERS/, /NEXUS_PLATFORM_URI/] },

  { name: 'THE LIMIT: the container-internal port is not the host port, so <host>:8761 is not a drift',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('internal-canonical'), expect: 0,
    must: [/RESULT: PASS/, /compose publishes\s+eureka-server=\d+:8761/, /no offender/],
    absent: [/OFFENDERS/, /- R4/] },

  { name: 'THE REFUSAL: a surface the reader cannot read is not a clean plane',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('missing-surface', (files) => { files[PLATFORM_YAML] = null; }), expect: 2,
    must: [/RESULT: NOT CHECKED/, /cannot be read under/],
    absent: [/RESULT: PASS/, /RESULT: FAIL/] },

  { name: 'THE REFUSAL: a plane that declares no application name has no population to ask about',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('no-names', (files) => {
      for (const rel of [EUREKA_YAML, CONFIG_YAML, GATEWAY_YAML, PLATFORM_YAML]) {
        files[rel] = files[rel].replace(/application:\s*\n\s*name:\s*[A-Za-z0-9._-]+/g, 'application:\n    label: x');
      }
    }), expect: 2,
    must: [/RESULT: NOT CHECKED/, /0 application name/],
    absent: [/RESULT: PASS/] },

  { name: 'THE REFUSAL: --no-probe on a clean tree is half the rules unasked, not a pass',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('no-probe'), flags: ['--no-probe'], expect: 2,
    must: [/RESULT: NOT CHECKED/, /UNASKED \(--no-probe\)/, /R1\/R2 were not asked/],
    absent: [/RESULT: PASS/] },

  { name: 'THE REFUSAL: --report prints the defect and claims no verdict',
    state: { apps: ['NEXUS-GATEWAY', 'FOOTBALL-CORE'], registryStatus: 200 },
    dir: plant('report-only'), flags: ['--report'], expect: 0,
    must: [/RESULT: REPORT/, /OFFENDERS \(2\)/, /FOOTBALL-CORE/],
    absent: [/RESULT: PASS/, /RESULT: FAIL/] },

  { name: 'THE REFUSAL: a flag this reader does not take is refused, not dropped',
    state: { apps: ['NEXUS-GATEWAY'], registryStatus: 200 },
    dir: plant('unknown-flag'), flags: ['--ports=18761'], expect: 2,
    must: [/RESULT: NOT CHECKED/, /unknown option --ports/],
    absent: [/RESULT: PASS/] },
];

/* ------------------------------------------------------------------ run the arms */

// The fixture servers live in THIS process, so the reader must be spawned asynchronously: spawnSync
// blocks the parent's event loop, the servers cannot answer the child's probes, and every live arm
// sees a fetch timeout dressed up as a FOREIGN verdict. Measured, then fixed — the arms must ask the
// fixture, not the absence of one.
function runChild(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
    let out = '';
    let err = '';
    let error = null;
    let settled = false;
    let timer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ status, out, err, error });
    };
    timer = setTimeout(() => {
      error = new Error('the reader did not finish within 60s');
      child.kill();
    }, 60000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', (e) => { error = e; finish(null); });
    child.once('close', (code) => finish(code));
  });
}

let fails = 0;
let ran = 0;
for (const arm of ARMS) {
  Object.assign(state, arm.state);
  const args = [CHECKER, '--dir', arm.dir, '--verbose', ...(arm.flags ?? [])];
  const child = await runChild(args);
  const death = interpreterDeath({ stdout: child.out, stderr: child.err, message: child.error?.message });
  if (child.error || death) {
    console.log(`MISSED  ${arm.name}\n        the child never ran: ${death ?? child.error?.message ?? 'no reason given'}`);
    fails += 1;
    continue;
  }
  ran += 1;
  const out = `${child.out}${child.err}`;
  const code = child.status === null ? -1 : child.status;
  const missed = arm.must.filter((re) => !re.test(out));
  const found = (arm.absent ?? []).filter((re) => re.test(out));
  const ok = code === arm.expect && missed.length === 0 && found.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${arm.expect} expected, ${code} printed   ${arm.name}`);
  if (code !== arm.expect) {
    console.log(`        verdict differs — printed: ${(out.match(/RESULT.*/) ?? ['<no RESULT line>']).join(' | ')}`);
  }
  for (const m of missed) {
    console.log(`        expected text missing: ${m}\n${out.split('\n').slice(0, 10).map((l) => `        | ${l}`).join('\n')}`);
  }
  for (const m of found) console.log(`        text that must not appear was found: ${m}`);
}

// Close the fixtures and let the loop drain before naming a code: process.exit() while a handle is
// still closing aborts this Node on Windows with a libuv assertion (the reader's Exit paragraph
// documents the same crash), which would report a harness crash as an arm's verdict.
await Promise.all(Object.values(servers).map((s) => new Promise((done) => s.close(() => done()))));
safeRemove(FIX);

console.log('');
console.log(`  ${ARMS.length} arms · ${ran} ran · ${ARMS.length - fails} held · ${fails} missed`);
console.log(`  fixture ports: registry=${PORT.registry} config=${PORT.config} edge=${PORT.edge} dead=${PORT.dead} (ephemeral, loopback)`);
console.log('  grammar: a host coordinate is an env-backed port default; it must be free or answered by a service');
console.log('           this repo declares, the registry on the default zone must list no foreign application,');
console.log('           and the module, compose and smoke copies of the map must be one map. The upstream URLs');
console.log('           and the container-internal ports are outside this population, and two arms pin that.');
if (ran !== ARMS.length) {
  console.log(`\nRESULT: NOT CHECKED — ${ARMS.length - ran} arm(s) never started, so no verdict is claimed`);
  process.exitCode = 2;
} else if (fails) {
  console.log('\nRESULT: FAIL — the cloud-port reader does not do what its arms claim');
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS — reddens on a foreign registry, a squatted port and each second copy of the map;');
  console.log('             stays green on the twin, on the two stated limits, and refuses what it cannot ask');
  process.exitCode = 0;
}