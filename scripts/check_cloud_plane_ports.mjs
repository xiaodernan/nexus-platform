#!/usr/bin/env node
/**
 * NEXUS D847 — the cloud plane's host coordinates, and who owns each one.
 *
 * WHY THIS EXISTS (the class, not the three files). `scripts/check_plane_coordinates.mjs` already says that
 * a fallback URL is a COORDINATE and that on this machine a canonical port can belong to a different
 * product — and then names, in its own WHAT THIS DOES NOT SAY, the surfaces it does not read:
 * `infra/docker-compose.yml` and the scripts that carry their own copies. The Spring Cloud plane landed by
 * D845 is exactly such a surface. It declares three host ports and two upstream URLs, and nothing asked who
 * owns them. Measured at dc103e4 (`tmp/d847_measure.txt`, read-only): the registry the edge defaults to,
 * `http://127.0.0.1:8761/eureka/`, answers HTTP 200 and lists FOOTBALL-CORE (metadata `product=football-os`)
 * and NEXUS-API. The process holding :8761 runs `services\nexus-registry\target\nexus-registry-0.1.0-SNAPSHOT.jar`
 * — a path this repository does not contain; `services/` holds `cloud` and `platform` only. So the edge's
 * default zone is another project's registry: a gateway started with no overrides would register
 * NEXUS-GATEWAY into it and fetch a service list nobody here owns, and the `cloud` compose profile could not
 * bind its published registry port at all. This is the defect the platform's own `application.yml` already
 * describes for the AI port — "a default that points at a port another stack serves would post our query
 * text ... to a service that is not ours" — one plane over, where what leaks is the service topology.
 *
 * THE RULES, one sentence each:
 *   R1  Every host port a cloud module defaults to must be FREE, or answered by a service this repo declares
 *       (the registry lists only our names, the config server serves `nexus-gateway`, the edge says
 *       `service=nexus-gateway`). A bound port that answers as somebody else is an offender.
 *   R2  The registry the edge's default zone names must list no application this repo does not declare.
 *       Nothing answering is not an offence — it is the plane not running — but the population is printed so
 *       a vacuous pass cannot be read as a populated one.
 *   R3  The edge's default zone port must be the registry module's default port, and its default config port
 *       the config module's default port: one port map, not two copies that can drift apart.
 *   R4  The host port compose publishes for each cloud service must be that module's default host port, so
 *       `--profile cloud up` and a jar run on the host put the plane on the same three numbers.
 *   R5  The smoke must not retype a port literal of its own for the three modules. It reads each module's
 *       declared default (or leaves the port to the module), so a green smoke is a verdict about the plane a
 *       developer actually gets rather than about an offset plane nobody deploys.
 *
 * WHAT THIS DOES NOT SAY. It does not judge whether the three numbers are a *good* choice, only whether the
 * copies agree and whether anybody else is already there; a plane whose three ports are free, consistent and
 * useless passes. It reads the container-internal port only to compare it with the publish, not to census the
 * container network, where a canonical port cannot collide with the host's. It does not probe the platform/AI/
 * web upstream URLs: those are the monolith's and the AI service's own coordinates, owned by
 * `check_plane_coordinates.mjs` and the Makefile, and moving them is not this plane's decision. It says nothing
 * about whether the edge authenticates, rate-limits or breaks a circuit, and nothing about TLS. And a live
 * probe is a GET: this reader never registers, publishes, starts or stops anything, so proving a collision
 * cannot be the act that causes one.
 *
 * Usage:
 *   node scripts/check_cloud_plane_ports.mjs
 *   node scripts/check_cloud_plane_ports.mjs --dir=<repo-root-copy>   # census a planted plane (reverse control)
 *   node scripts/check_cloud_plane_ports.mjs --no-probe               # static rules only; live rules UNASKED
 *   node scripts/check_cloud_plane_ports.mjs --report                 # print, always exit 0
 *   node scripts/check_cloud_plane_ports.mjs --verbose                # name every coordinate and every probe
 *
 * Exit: 0 no offender · 1 an offender · 2 not checkable (a surface that cannot be read, a plane-name
 *       population of zero, or --no-probe on a tree with no static offender — half the rules were not asked,
 *       which is not a pass). The code is set on `process.exitCode` and the loop is left to drain: calling
 *       `process.exit()` while a probe socket is still closing aborts this Node on Windows with a libuv
 *       assertion (exit 127), which would report a crash as the verdict.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = {
  '--dir': { kind: 'value', unit: 'path' },
  '--no-probe': { kind: 'switch' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exitCode = 2; }
else { process.exitCode = await main(parsed.value, parsed.flag); }

async function main(value, flag) {
  const VERBOSE = Boolean(flag['--verbose']);
  const REPORT_ONLY = Boolean(flag['--report']);
  const NO_PROBE = Boolean(flag['--no-probe']);
  const BASE = value['--dir'] ? resolve(value['--dir']) : ROOT;

  const MODULES = [
    { name: 'eureka-server', env: 'NEXUS_EUREKA_PORT', hostEnv: 'NEXUS_EUREKA_HOST_PORT',
      smokeEnv: 'NEXUS_SMOKE_EUREKA_PORT', identity: '/eureka/apps' },
    { name: 'config-server', env: 'NEXUS_CONFIG_PORT', hostEnv: 'NEXUS_CONFIG_HOST_PORT',
      smokeEnv: 'NEXUS_SMOKE_CONFIG_PORT', identity: '/nexus-gateway/default' },
    { name: 'gateway', env: 'NEXUS_GATEWAY_PORT', hostEnv: 'NEXUS_GATEWAY_HOST_PORT',
      smokeEnv: 'NEXUS_SMOKE_GATEWAY_PORT', identity: '/cloud/info' },
  ];
  const SURFACES = [
    ...MODULES.map((m) => `services/cloud/${m.name}/src/main/resources/application.yaml`),
    'services/platform/src/main/resources/application.yml',
    'infra/docker-compose.yml',
    'scripts/cloud_smoke.sh',
  ];
  const GATEWAY_YAML = SURFACES[2];

  const offenders = [];
  const notes = [];
  const unreadable = [];
  const text = {};
  for (const rel of SURFACES) {
    try { text[rel] = readFileSync(join(BASE, rel), 'utf8'); }
    catch { unreadable.push(rel); }
  }

  /** The application names this repo declares, uppercased the way Eureka lists them. */
  const names = new Set();
  for (const rel of SURFACES.slice(0, 4)) {
    const m = /application:\s*\n\s*name:\s*([A-Za-z0-9._-]+)/.exec(text[rel] ?? '');
    if (m) names.add(m[1].toUpperCase());
  }
  const portOf = (rel) => {
    const m = /port:\s*\$\{[A-Z_]+:(\d+)\}/.exec(text[rel] ?? '');
    return m ? Number(m[1]) : null;
  };
  const uriOf = (key) => {
    const m = new RegExp(`\\$\\{${key}:([^}]*)\\}`).exec(text[GATEWAY_YAML] ?? '');
    return m ? m[1] : null;
  };
  const urlPort = (url) => { const m = url && /:(\d+)(?:\/|$)/.exec(url); return m ? Number(m[1]) : null; };

  const declared = MODULES.map((m) => ({
    ...m,
    yaml: `services/cloud/${m.name}/src/main/resources/application.yaml`,
    port: portOf(`services/cloud/${m.name}/src/main/resources/application.yaml`),
  }));
  const zone = uriOf('NEXUS_EUREKA_URI');
  const configUri = uriOf('NEXUS_CONFIG_URI');

  if (unreadable.length) {
    console.log(`RESULT: NOT CHECKED — ${unreadable.length} of ${SURFACES.length} surfaces cannot be read under `
      + `${BASE}: ${unreadable.join(', ')}. No rule was judged.`);
    return 2;
  }
  if (names.size === 0 || declared.some((m) => m.port === null) || !zone || !configUri) {
    console.log(`RESULT: NOT CHECKED — the plane declares ${names.size} application name(s), `
      + `${declared.filter((m) => m.port !== null).length}/3 env-backed ports, zone=${zone ?? 'ABSENT'}, `
      + `config=${configUri ?? 'ABSENT'}. A census with no coordinate to ask about has cleared nothing.`);
    return 2;
  }

  /* -------------------------------------------------------------- the live probes (GET only) */

  /** Is anything bound to this loopback port? A refused connect is the only honest "free". */
  const bound = (port) => new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(answer);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

  const get = async (url, accept) => {
    try {
      const res = await fetch(url, {
        headers: accept ? { Accept: accept } : {},
        signal: AbortSignal.timeout(4000),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return { status: 0, body: String(err?.cause?.code ?? err?.name ?? err) };
    }
  };

  const registryNames = (body) => {
    try {
      const apps = JSON.parse(body)?.applications?.application ?? [];
      return (Array.isArray(apps) ? apps : [apps]).map((a) => String(a?.name ?? '?').toUpperCase());
    } catch { return null; }
  };

  /** FREE · OURS · FOREIGN, decided by what answers rather than by who we hoped would. */
  const ownership = async (mod) => {
    if (!await bound(mod.port)) return { verdict: 'FREE', detail: 'nothing bound' };
    const url = `http://127.0.0.1:${mod.port}${mod.identity}`;
    const res = await get(url, mod.name === 'eureka-server' ? 'application/json' : undefined);
    if (mod.name === 'eureka-server') {
      const listed = registryNames(res.body);
      if (res.status === 200 && listed) {
        const foreign = listed.filter((n) => !names.has(n));
        return foreign.length
          ? { verdict: 'FOREIGN', detail: `registry lists ${foreign.join(', ')}`, url, names: listed }
          : { verdict: 'OURS', detail: `registry lists ${listed.join(', ') || '(nothing)'}`, url, names: listed };
      }
    }
    if (mod.name === 'config-server' && res.status === 200) {
      try {
        if (JSON.parse(res.body)?.name === 'nexus-gateway') return { verdict: 'OURS', detail: 'serves nexus-gateway', url };
      } catch { /* not a config server response */ }
    }
    if (mod.name === 'gateway' && res.status === 200) {
      try {
        if (JSON.parse(res.body)?.service === 'nexus-gateway') return { verdict: 'OURS', detail: 'edge identifies itself', url };
      } catch { /* not our edge */ }
    }
    return { verdict: 'FOREIGN', detail: `bound, answers HTTP ${res.status} at ${mod.identity} as something else`, url };
  };

  const probes = [];
  if (!NO_PROBE) {
    for (const mod of declared) {
      const own = await ownership(mod);
      probes.push({ ...mod, ...own });
      if (own.verdict === 'FOREIGN') {
        offenders.push(`R1 ${mod.name} defaults to host port ${mod.port}, which is somebody else's: ${own.detail}`);
      }
    }
    const zoneUrl = `${zone.replace(/\/$/, '')}/apps`;
    const res = await get(zoneUrl, 'application/json');
    const listed = registryNames(res.body);
    if (res.status === 200 && listed) {
      const foreign = listed.filter((n) => !names.has(n));
      probes.push({ name: 'default zone', port: urlPort(zone), verdict: foreign.length ? 'FOREIGN' : 'OURS',
        detail: `lists ${listed.join(', ') || '(nothing)'}`, url: zoneUrl, names: listed });
      if (foreign.length) {
        offenders.push(`R2 the edge's default zone ${zone} is a registry listing ${foreign.join(', ')} — `
          + `${names.size} name(s) declared here, ${foreign.length} of them not among them`);
      }
    } else {
      probes.push({ name: 'default zone', port: urlPort(zone), verdict: 'FREE',
        detail: `no registry answers (HTTP ${res.status})`, url: zoneUrl, names: [] });
      notes.push(`R2 asked ${zoneUrl} and nothing answered (HTTP ${res.status}): the plane is not running, so `
        + `the zone points at no foreign registry. The population is 0, not a cleared list.`);
    }
  }

  /* -------------------------------------------------------------- the static rules */

  const compose = text['infra/docker-compose.yml'];
  const smoke = text['scripts/cloud_smoke.sh'];
  const publishes = declared.map((m) => {
    const hit = new RegExp(`\\$\\{${m.hostEnv}:-(\\d+)\\}:(\\d+)`).exec(compose);
    return { ...m, host: hit ? Number(hit[1]) : null, internal: hit ? Number(hit[2]) : null };
  });
  const smokeLiterals = declared.map((m) => {
    const hit = new RegExp(`\\$\\{${m.smokeEnv}:-(\\d+)\\}`).exec(smoke);
    return { ...m, literal: hit ? Number(hit[1]) : null };
  });

  const zonePort = urlPort(zone);
  const configPort = urlPort(configUri);
  if (zonePort !== declared[0].port) {
    offenders.push(`R3 the edge's default zone port ${zonePort} is not the registry module's default ${declared[0].port}`);
  }
  if (configPort !== declared[1].port) {
    offenders.push(`R3 the edge's default config port ${configPort} is not the config module's default ${declared[1].port}`);
  }
  for (const p of publishes) {
    if (p.host === null) {
      offenders.push(`R4 compose publishes no \${${p.hostEnv}:-<port>} for ${p.name}: `
        + 'the cloud profile has no host coordinate to compare');
    } else if (p.host !== p.port) {
      offenders.push(`R4 compose publishes ${p.name} on host ${p.host} but the module defaults to ${p.port}: `
        + 'a jar run and --profile cloud up put the plane on different numbers');
    }
  }
  for (const s of smokeLiterals) {
    if (s.literal !== null) {
      offenders.push(`R5 the smoke retypes \${${s.smokeEnv}:-${s.literal}} for ${s.name}, whose own default is `
        + `${s.port}: a green smoke is a verdict about an offset plane nobody deploys`);
    }
  }

  /* -------------------------------------------------------------- the verdict */

  console.log('NEXUS cloud plane — host coordinates and their owners');
  console.log(`  plane read         ${BASE}`);
  console.log(`  surfaces           ${SURFACES.length} read, 0 unreadable`);
  console.log(`  names declared     ${names.size}: ${[...names].sort().join(', ')}`);
  console.log(`  module defaults    ${declared.map((m) => `${m.name}=${m.port}`).join(', ')}`);
  console.log(`  edge defaults      zone=${zone} config=${configUri}`);
  console.log(`  compose publishes  ${publishes.map((p) => `${p.name}=${p.host ?? '?'}:${p.internal ?? '?'}`).join(', ')}`);
  console.log(`  smoke literals     ${smokeLiterals.filter((s) => s.literal !== null).length} of 3 retyped`);
  console.log(`  live rules         ${NO_PROBE ? 'UNASKED (--no-probe)' : `asked, ${probes.length} probe(s)`}`);
  if (VERBOSE) {
    for (const m of declared) console.log(`    declares  ${m.yaml}  \${${m.env}:${m.port}}`);
    for (const p of probes) {
      console.log(`    probe     ${String(p.name).padEnd(14)} :${String(p.port).padEnd(6)} ${p.verdict.padEnd(8)} ${p.detail}`);
    }
    for (const p of publishes) console.log(`    publish   ${p.name.padEnd(14)} \${${p.hostEnv}:-${p.host}}:${p.internal}`);
    for (const s of smokeLiterals) {
      console.log(`    smoke     ${s.name.padEnd(14)} ${s.literal === null ? 'reads the module default' : `RETYPES ${s.literal}`}`);
    }
  }
  console.log('');
  for (const n of notes) console.log(`  note: ${n}`);
  if (offenders.length) {
    console.log(`OFFENDERS (${offenders.length}):`);
    for (const o of offenders) console.log(`  - ${o}`);
  } else {
    console.log('  every host port the plane defaults to is free or ours, the default zone lists no foreign');
    console.log('  application, and the module, compose and smoke copies of the map are one map');
  }
  console.log('');
  console.log('WHAT THIS DOES NOT SAY: that the three numbers are a good choice, only that the copies agree and');
  console.log('nobody else is already there; anything about the container-internal network, where a canonical');
  console.log("port cannot collide with the host's; anything about the platform/AI/web upstream URLs, which are");
  console.log("the monolith's and the AI service's coordinates and not this plane's to move; or that the edge");
  console.log('authenticates, rate-limits, breaks a circuit or terminates TLS. A probe is a GET — this reader');
  console.log('never registers, publishes, starts or stops anything.');
  console.log('');

  if (REPORT_ONLY) { console.log('RESULT: REPORT — printed, no verdict claimed'); return 0; }
  if (offenders.length) { console.log(`RESULT: FAIL — ${offenders.length} offender(s)`); return 1; }
  if (NO_PROBE) {
    console.log('RESULT: NOT CHECKED — the static rules hold, but R1/R2 were not asked (--no-probe).');
    return 2;
  }
  console.log(`RESULT: PASS — ${declared.length} host coordinates, ${probes.length} live probe(s), no offender`);
  return 0;
}