#!/usr/bin/env node
/**
 * NEXUS — the coordinates the browser harness reads, and who is allowed to own each one.
 *
 * WHY THIS EXISTS (the class, not the one file): `tests/e2e` reaches its three services through
 * `process.env.<NAME> ?? 'http://127.0.0.1:<port>'`. That fallback is a COORDINATE — it says where a service
 * lives — and this repository has three planes that put the same three services on different ports: CI boots
 * them on the framework defaults, `make dev-*` boots them on its own `*_PORT` knobs, and
 * `infra/docker-compose.yml` carries a third pair of defaults. Nothing made the harness's copy agree with any
 * of them. Measured on the tree that prompted this reader: `make e2e` — the entry `docs/DEPLOYMENT.md` names
 * for a local run — exported none of the three URLs, so a developer who followed the documented path tested
 * `:3000`, and on the machine that prompted this that port belongs to a different product's frontend. The
 * suite still ran, still passed things, and reported a verdict about a stack nobody had started.
 *
 * THE RULES, one sentence each:
 *   R1  Every env var the harness reads with a fallback must be EXPORTED by the Makefile's `e2e` recipe, and
 *       exported DERIVED (`$(WEB_PORT)`), not retyped — a hard-coded port in the recipe would be a second copy.
 *   R2  Where the CI job that runs the harness exports no URL for a var, the harness's fallback port must be
 *       one the job actually boots or waits on, and every port the job names must be one the harness carries.
 *       CI therefore runs on the fallback plane by agreement, not by accident.
 *   R3  No coordinate may appear in the harness without either a guard or the var it documents on the same line.
 *       A naked `http://localhost:3000` in `package.json` is unreachable by any knob; a README row that quotes
 *       `NEXUS_WEB_URL` and `http://127.0.0.1:3000` on one line is documentation, and is held to that default.
 *   R4  A `make <target>` named in the harness's own prose or comments must be a target the Makefile declares.
 *       The sentence that sent a reader to `make dev-stack` — a target that has never existed — is the shape.
 *   R5  An env token the harness names must be a token the harness READS, on a line that mentions
 *       `process.env`. This is R4's rule one plane over: the same config docstring promised that
 *       "webServer is opt-in via NEXUS_E2E_AUTOSTART=1", and the config declares no webServer and reads no
 *       such variable — a knob a reader can set and the harness can never see.
 *
 * WHAT THIS DOES NOT SAY. It does not judge the ports themselves, only who owns which copy: mapping a var to
 * the service CI boots it against is done by port SET equality, because nothing in the workflow text declares
 * which of :3000/:8080/:8000 is the web app, so a CI plane that booted the right three numbers on the wrong
 * three services would agree with this census. It does not read `infra/docker-compose.yml`, `scripts/e2e_fresh.sh`
 * or any `verify_*` script, so those planes' copies of the same coordinates are uncensused. It charges a
 * `make <target>` mention only inside backticks or a fenced block, because "make sure the seed is loaded" is
 * prose, not a coordinate; an unbackticked phantom therefore escapes R4. And it says nothing about whether the
 * suite the coordinates point at is any good.
 *
 * Usage:
 *   node scripts/check_plane_coordinates.mjs
 *   node scripts/check_plane_coordinates.mjs --dir=<repo-root-copy>   # census a plane instead (reverse control)
 *   node scripts/check_plane_coordinates.mjs --make=<path>|--ci=<path>|--e2e=<dir>   # re-aim one surface
 *   node scripts/check_plane_coordinates.mjs --report    # print, always exit 0
 *   node scripts/check_plane_coordinates.mjs --verbose   # name every file scanned and every URL classified
 *
 * Exit: 0 no offender · 1 an offender · 2 not checkable (a surface that cannot be read, or a population of
 *       zero — a census that found no fallback to ask about has not cleared anything).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = {
  '--dir': { kind: 'value', unit: 'path' },
  '--make': { kind: 'value', unit: 'path' },
  '--ci': { kind: 'value', unit: 'path' },
  '--e2e': { kind: 'value', unit: 'path' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exit(2); }
const value = parsed.value;
const VERBOSE = Boolean(parsed.flag['--verbose']);
const REPORT_ONLY = Boolean(parsed.flag['--report']);

const BASE = value['--dir'] ? resolve(value['--dir']) : ROOT;
const notChecked = (why) => { console.log(`RESULT: NOT CHECKED — ${why}`); process.exit(2); };
// Every surface is read into LF-normalised text. `core.autocrlf=true` checks this tree out with CRLF on
// Windows while the tracked blobs are LF, so a parser that anchors on '\n' would find no `jobs:` block on
// one plane and a full one on the other — the same class of blind spot this reader is about.
const norm = (t) => t.replace(/\r\n/g, '\n');

const surfaces = [
  { key: 'make', label: 'Makefile', path: value['--make'] ?? join(BASE, 'Makefile') },
  { key: 'ci', label: '.github/workflows/ci.yml', path: value['--ci'] ?? join(BASE, '.github', 'workflows', 'ci.yml') },
  { key: 'e2e', label: 'tests/e2e', path: value['--e2e'] ?? join(BASE, 'tests', 'e2e') },
];
for (const s of surfaces) {
  try {
    s.text = s.key === 'e2e' ? '' : norm(readFileSync(s.path, 'utf8'));
  } catch (e) {
    notChecked(`cannot read ${s.path} for the ${s.key} surface (${e.code ?? e.message}). A surface nobody can `
      + `open is not a surface that names no coordinate — re-aim it with --${s.key}=<path>`);
  }
}

/* ------------------------------------------------------------------ the harness population, by scan */
// node_modules is third-party; report/ and .artifacts/ are what a run writes, and the HTML report embeds the
// very URLs this census is about, so reading them would charge the harness for its own output. The skipped
// count is printed: a skip list with no reading of it is a hiding place.
const SKIP_DIRS = new Set(['node_modules', 'report', '.artifacts', 'test-results', 'results', '__snapshots__']);
const IN_SCOPE = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md']);
function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'package-lock.json') continue;
    const isDir = statSync(full).isDirectory();
    if (isDir) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
      continue;
    }
    if (IN_SCOPE.has(extname(entry))) out.push(full);
  }
  return out;
}
let files;
try {
  files = walk(surfaces[2].path, []).sort();
} catch (e) {
  notChecked(`cannot list ${surfaces[2].path} (${e.code ?? e.message}) — the harness tree is the population `
    + 'this census reads, and a directory nobody can open names no coordinate');
}
if (files.length === 0) notChecked(`${surfaces[2].path} holds no in-scope file at all`);
const skipped = [...SKIP_DIRS].filter((d) => {
  try { return statSync(join(surfaces[2].path, d)).isDirectory(); } catch { return false; }
});

const URL_RE = /https?:\/\/[A-Za-z0-9_.-]+:\d{2,5}\b/g;
const PORT_IN_URL = /^(https?:\/\/[A-Za-z0-9_.-]+:)(\d{2,5}\b)/;
// Both spellings a default can take — `??` and `||` — because the harness uses the first and a reader that
// recognised only one would call the other a naked coordinate.
const GUARD_RE = /process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\?\?|\|\|)\s*['"`]([^'"`]*?)['"`]/g;
const guarded = new Map();   // ENV NAME -> { url, port, file, line }
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(GUARD_RE)) {
      const pm = PORT_IN_URL.exec(m[2]);
      if (!pm) continue; // a guard whose default is not a URL is not a coordinate
      if (!guarded.has(m[1])) guarded.set(m[1], { url: m[2], port: pm[2], file, line: i + 1 });
    }
  });
}
if (guarded.size === 0) {
  notChecked(`${surfaces[2].path} has no \`process.env.X ?? 'http://host:port'\` fallback at all: either the `
    + 'harness stopped reading its coordinates from guards or this reader stopped recognising them, and the '
    + 'two are not the same thing');
}

/* ------------------------------------------------------------------ R3/R5: every other URL literal */
const offenders = [];
const quoted = [];
const naked = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const guardSpans = [...line.matchAll(GUARD_RE)].map((m) => [m.index, m.index + m[0].length]);
    const where = `${file.slice(BASE.length + 1)}:${i + 1}`;
    for (const m of line.matchAll(URL_RE)) {
      if (guardSpans.some(([a, b]) => m.index >= a && m.index < b)) continue; // the default itself
      const named = [...guarded.keys()].filter((v) => new RegExp(`\\b${v}\\b`).test(line));
      if (named.length === 0) { naked.push(where); continue; }
      if (named.length > 1) {
        offenders.push(`${where} carries the coordinate ${m[0]} while naming ${named.join(', ')} on the same `
          + 'line, so no single variable owns it and no knob can retarget it');
        continue;
      }
      const d = guarded.get(named[0]);
      if (m[0] === d.url) { quoted.push({ where, name: named[0] }); continue; }
      offenders.push(`${where} documents ${named[0]} as ${m[0]}, but the harness's fallback for that variable `
        + `is ${d.url} (${d.file.slice(BASE.length + 1)}:${d.line}) — one of the two is a stale copy of the other`);
    }
  });
}
for (const where of naked) {
  offenders.push(`${where} hard-codes a service URL with no env guard and no variable named beside it — `
    + 'nothing on any plane can move it, which is how a fourth copy of the web port reached package.json');
}

/* ------------------------------------------------------------------ R1: the Makefile must EXPORT, derived */
const makeText = surfaces[0].text;
const targets = new Set([...makeText.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]));
const makeVars = new Map([...makeText.matchAll(/^([A-Z][A-Z0-9_]*)\s*[?+:]?=\s*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const e2eRecipe = (() => {
  const lines = makeText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('e2e:'));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!/^\s*$/.test(lines[i]) && !/^\t/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
})();
if (e2eRecipe === null) {
  offenders.push('the Makefile declares no `e2e:` target: the harness\'s fallback ports are then the only '
    + 'coordinates any local surface sets, and the documented local entry point has gone missing');
} else {
  for (const [name, d] of guarded) {
    const assign = e2eRecipe.match(new RegExp(`\\b${name}=([^\\s]+)`));
    if (!assign) {
      offenders.push(`make e2e exports no ${name}, so a run through the documented local entry point reads `
        + `the fallback ${d.url} (${d.file.slice(BASE.length + 1)}:${d.line}) while the Makefile itself boots `
        + `that service on $(...) — the harness and the plan agree on nothing`);
      continue;
    }
    const val = assign[1];
    const refs = [...val.matchAll(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g)].map((m) => m[1]);
    if (!refs.some((r) => /_PORT$/.test(r))) {
      offenders.push(`make e2e exports ${name}=${val} with no $(*_PORT) reference: that is a retyped `
        + 'coordinate, and the Makefile already owns the port this value must follow');
    }
    for (const r of refs) {
      if (!makeVars.has(r)) {
        offenders.push(`make e2e derives ${name} from $( ${r} ) which the Makefile never declares — make `
          + `expands an undefined variable to the empty string, so ${name} ships as "${val.replace(/\$\([^)]*\)/, '')}"`);
      }
    }
  }
}

/* ------------------------------------------------------------------ R2: the CI plane, by agreement */
const jobsStart = surfaces[1].text.indexOf('\njobs:\n');
if (jobsStart < 0) notChecked(`${surfaces[1].path} has no \`jobs:\` block — the census cannot find the job that boots the stack`);
const jobs = surfaces[1].text.slice(jobsStart).split(/\n(?= {2}[A-Za-z0-9_-]+:(?:\s*\n|$))/).slice(1);
const e2eJobs = jobs.filter((j) => /tests\/e2e/.test(j));
if (e2eJobs.length === 0) {
  notChecked(`no CI job mentions tests/e2e, so there is no booted stack to compare the harness's fallbacks `
    + 'against — R2 has no subject on this plane');
}
const ciText = e2eJobs.join('\n');
const ciCode = ciText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const ciPorts = new Map();
for (const m of ciCode.matchAll(/--port[\s=](\d{2,5})\b/g)) ciPorts.set(m[1], (ciPorts.get(m[1]) ?? 0) + 1);
for (const m of ciCode.matchAll(URL_RE)) {
  const port = m[0].replace(PORT_IN_URL, '$2');
  ciPorts.set(port, (ciPorts.get(port) ?? 0) + 1);
}
const fallbackPorts = new Set([...guarded.values()].map((d) => d.port));
for (const [name, d] of guarded) {
  if (new RegExp(`\\b${name}\\s*[=:]`).test(ciCode)) continue; // CI states its own coordinate
  if (!ciPorts.has(d.port)) {
    offenders.push(`the CI e2e job sets no ${name}, so the harness reads ${d.url} there, but the job boots and `
      + `waits on ${[...ciPorts.keys()].sort().join('/')} — no service of that plane lives on :${d.port}`);
  }
}
for (const port of ciPorts.keys()) {
  if (fallbackPorts.has(port)) continue;
  if ([...guarded.keys()].some((n) => new RegExp(`\\b${n}\\s*=`).test(ciCode))) continue;
  offenders.push(`the CI e2e job names port :${port}, which no harness fallback carries and no URL variable it `
    + 'exports reaches — CI would test a coordinate that exists only in the workflow'
  );
}

/* ------------------------------------------------------------------ R4: make targets the harness names */
const mentioned = new Map(); // target -> [where]
let inFence = false;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    const spans = inFence ? [line] : [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
    for (const span of spans) {
      for (const m of span.matchAll(/\bmake\s+([a-z][a-z0-9_-]*)/g)) {
        const where = `${file.slice(BASE.length + 1)}:${i + 1}`;
        if (!mentioned.has(m[1])) mentioned.set(m[1], []);
        mentioned.get(m[1]).push(where);
      }
    }
  });
}
for (const [target, where] of mentioned) {
  if (!targets.has(target)) {
    offenders.push(`${where.join(', ')} sends a reader to \`make ${target}\`, a target the Makefile does not `
      + `declare (${targets.size} \`^target:\` lines of ${surfaces[0].label} read) `
      + '— the path named does not exist');
  }
}

/* ------------------------------------------------------------------ R5: knobs the harness names must be knobs it reads */
const TOKEN_RE = /\bNEXUS_[A-Z][A-Z0-9_]+\b/g;
const namedTokens = new Map(); // token -> [where]
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(TOKEN_RE)) {
      if (!namedTokens.has(m[0])) namedTokens.set(m[0], []);
      namedTokens.get(m[0]).push({ where: `${file.slice(BASE.length + 1)}:${i + 1}`, read: /\bprocess\.env\b/.test(line) });
    }
  });
}
for (const [token, sites] of namedTokens) {
  if (sites.some((s) => s.read)) continue;
  offenders.push(`${sites.map((s) => s.where).join(', ')} names ${token}, which no line of the harness reads `
    + 'from `process.env` — a knob a reader can set and the harness can never see, so the behaviour the '
    + 'sentence promises does not exist');
}

/* ------------------------------------------------------------------ verdict */
console.log('NEXUS — the coordinates the browser harness reads, and who is allowed to own each one');
console.log(`  plane read         ${BASE}`);
console.log(`  surfaces           ${surfaces.map((s) => s.label).join(', ')}`);
console.log(`  harness files      ${files.length} scanned`
  + `${skipped.length ? ` (${skipped.join(', ')} skipped: what a run writes, or third-party)` : ''}`);
console.log(`  guarded fallbacks  ${guarded.size}: `
  + [...guarded.entries()].map(([n, d]) => `${n}=${d.url}`).join(', '));
console.log(`  make e2e recipe    ${e2eRecipe === null ? 'ABSENT' : e2eRecipe.trim().split('\n').length + ' line(s)'}`);
console.log(`  CI e2e jobs        ${e2eJobs.length}, booting/waiting on ports ${[...ciPorts.keys()].sort().join('/')}`);
console.log(`  URL literals       ${guarded.size} define defaults, ${quoted.length} quote one, `
  + `${naked.length} naked, ${offenders.filter((o) => /documents|while naming/.test(o)).length} contradicting`);
console.log(`  make targets named ${mentioned.size} (${[...mentioned.keys()].sort().join(', ')}) `
  + `against ${targets.size} declared`);
const readTokens = [...namedTokens.keys()].filter((t) => namedTokens.get(t).some((s) => s.read));
console.log(`  env tokens named   ${namedTokens.size} (${[...namedTokens.keys()].sort().join(', ')}), `
  + `read on a process.env line: ${readTokens.length}`);
if (VERBOSE) {
  for (const [name, d] of guarded) {
    console.log(`    guard     ${name.padEnd(20)} ${d.url}  ${d.file.slice(BASE.length + 1)}:${d.line}`);
  }
  for (const q of quoted) console.log(`    quotes    ${q.name.padEnd(20)} at ${q.where}`);
  for (const n of naked) console.log(`    NAKED     url at ${n}`);
  for (const [t, where] of mentioned) {
    console.log(`    make      ${t.padEnd(20)} ${where.join(', ')} ${targets.has(t) ? '' : 'UNDECLARED'}`);
  }
  for (const t of [...namedTokens.keys()].sort()) {
    console.log(`    knob      ${t.padEnd(20)} ${namedTokens.get(t).map((s) => s.where).join(', ')} `
      + `${namedTokens.get(t).some((s) => s.read) ? '' : 'NEVER READ'}`);
  }
}
console.log('');
if (offenders.length > 0) {
  console.log(`OFFENDERS (${offenders.length}):`);
  for (const o of offenders) console.log(`  - ${o}`);
} else {
  console.log('  every fallback is exported by make e2e from a declared port, agrees with the CI plane, and no');
  console.log('  coordinate in the harness is naked, stale or aimed at a target that does not exist');
}
console.log('');
console.log('WHAT THIS DOES NOT SAY: that the three ports are matched to the right SERVICES (the workflow text');
console.log('declares no role for :3000/:8080/:8000, so R2 compares port sets, not pairs); anything about');
console.log('infra/docker-compose.yml, scripts/e2e_fresh.sh or the verify_* scripts, which carry their own');
console.log('copies of these coordinates and are outside this population; or that an unbackticked `make target`');
console.log('in prose is real — R4 reads backticks and fenced blocks only, because a sentence about making sure');
console.log('is not a coordinate.');
process.exit(offenders.length > 0 && !REPORT_ONLY ? 1 : 0);
