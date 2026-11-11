#!/usr/bin/env node
/**
 * NEXUS D952 — the e2e job's database coordinates belong to the COMPOSE plane, not the
 * service-container plane it was silently copy-pasted from.
 *
 * THE BUG (found on the first full CI run's tail): the `e2e` job is the only CI job that boots its
 * data stores with `docker compose -f infra/docker-compose.yml up -d postgres redis`. That compose
 * postgres has NO env_file and NO password/database overrides in this job, so its credentials are the
 * compose DEFAULTS from infra/docker-compose.yml:
 *     database   = ${NEXUS_DB_NAME:-nexus}              -> nexus
 *     superuser  = postgres / ${NEXUS_DB_ROOT_PASSWORD:-postgres}  -> postgres / postgres
 *     AI role    = nexus_ai / ${NEXUS_DB_AI_PASSWORD:-nexus_dev_ai_only} -> nexus_ai / nexus_dev_ai_only
 *     host port  = ${NEXUS_PG_HOST_PORT:-5433} (CI env pins 5433)
 * The `platform`, `ai` and `cloud` jobs, by contrast, use a GitHub *service container* with
 *     database = nexus_test, superuser = postgres/ci_secret, AI role = ci_nexus_ai.
 * A hand-edit copied the service-container coordinates into the e2e job's "Boot services" run block:
 * platform was launched with NO explicit DB env (so it inherited whatever default), and the AI uvicorn
 * line used `nexus_ai:ci_nexus_ai@127.0.0.1:5433/nexus_test`. Both would fail to authenticate / find the
 * database against the compose plane — the e2e job could never reach its own assertions.
 *
 * D952 repairs the three load-bearing coordinates in the e2e "Boot services" block to the compose-plane
 * values and adds THIS reader so the two planes cannot be crossed again without a red gate. It is a
 * SIBLING of `check_plane_coordinates.mjs` (the same class of coordinate-census reader): it reads source
 * text only, starts no service, needs no Docker/Postgres, and is honest that a green result means "the
 * two planes' coordinates are derivably consistent", NOT "the e2e suite passed" — CI's e2e job remains
 * the verifier of record for the actual wire behaviour.
 *
 * THE RULES:
 *   R1  The e2e job must still boot its data stores with the compose invocation (the fact that makes the
 *       compose plane the right one). If it moved to a service container, this reader's premise is void.
 *   R2  The compose plane's own defaults must still be the four values this job relies on — database
 *       `nexus`, superuser password `postgres`, AI password `nexus_dev_ai_only`, host port `5433` — read
 *       from infra/docker-compose.yml, so a compose-side rename that leaves ci.yml stale reddens here.
 *   R3  Inside the e2e job's segment ONLY, the platform boot must pin the compose superuser coordinates
 *       (URL .../nexus, USERNAME postgres, PASSWORD postgres) and the AI uvicorn line must use
 *       nexus_ai:nexus_dev_ai_only@.../nexus. (Scoped to e2e: the SAME ci_secret/nexus_test tokens are
 *       CORRECT in the platform/ai/cloud jobs and must not be flagged there.)
 *   R4  The three service-container-only tokens (ci_secret, ci_nexus_ai, nexus_test) must be ABSENT from
 *       the e2e segment — the falsifier's needles, one flipped coordinate each.
 *   R5  The wiring: CI runs this reader with --self-test, ATLAS lists it, the ledger holds §952, and the
 *       line-cite-stable discipline (535 lines) is preserved — the e2e segment still has its two boot
 *       lines and the fixed service URLs CI and the harness agree on.
 *
 * SELF-TEST: `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in memory —
 * the platform password back to ci_secret, the AI password back to ci_nexus_ai, the AI database back to
 * nexus_test, the explicit platform coordinates erased, the compose invocation swapped for a service
 * container, a compose default renamed, the reader unhooked from CI, its ATLAS row erased, the ledger
 * entry removed, and a line added past 535 — and requires EACH to redden while the real plane holds.
 * `--ci=<path>` censuses an alternate workflow copy (reverse control, like the coordinates reader's
 * --dir), so a corrupted ci.yml can be judged without touching the shipped one.
 *
 * WHAT THIS DOES NOT SAY: that the e2e suite ran or passed, that the compose container was verified
 * reachable on this host (this is source text, not a wire probe), that 5433 is free, or that any password
 * is a real secret (these are published dev-plane defaults). It asserts source-level consistency between
 * the two credential planes and nothing beyond it.
 *
 * Usage:
 *   node scripts/check_d952.mjs                 # judge the shipped plane
 *   node scripts/check_d952.mjs --self-test     # plant corruptions, require each to redden
 *   node scripts/check_d952.mjs --ci=<path>     # census an alternate workflow copy
 *   node scripts/check_d952.mjs --report        # print verdict, always exit 0
 * Exit: 0 every claim holds · 1 an offender · 2 the plane could not be read / self-test not clean.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const ciArg = argv.find((a) => a.startsWith('--ci='));

const CI = '.github/workflows/ci.yml';
const COMPOSE = 'infra/docker-compose.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d952.mjs';
const PATHS = [CI, COMPOSE, ATLAS, STATUS, SELF];

/** Lines that delimit the e2e job's own segment (inclusive start, exclusive end). */
const E2E_START = '# ------------------------------------------------------------------ end to end';
const E2E_END = '# ------------------------------------------------------------------ contract';

/** The three service-container-only coordinates that must NOT leak into the e2e segment. */
const DRIFT_TOKENS = ['ci_secret', 'ci_nexus_ai', 'nexus_test'];

/** Slice out just the e2e job's text; the service-container tokens are legal everywhere else. */
function e2eSegment(ciText) {
  const start = ciText.indexOf(E2E_START);
  const end = ciText.indexOf(E2E_END);
  if (start < 0 || end < 0 || end <= start) return null;
  return ciText.slice(start, end);
}

/** Pure over (path -> text) plus a Set of physically present paths. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the credential-plane map is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const absent = (text, needle, label) => {
    if (text.includes(needle)) offenders.push(`DRIFT — the e2e segment: ${label} (forbidden ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };

  /* R1 — the e2e job really boots the compose plane. */
  has(CI, 'docker compose -f infra/docker-compose.yml up -d postgres redis', 'R1 e2e boots data stores via the compose invocation');
  has(CI, 'NEXUS_PLATFORM_URL: http://127.0.0.1:8080', 'R5 the e2e segment still pins the platform URL CI and the harness agree on');

  /* R2 — the compose plane's defaults, read from compose itself (a rename here must redden). */
  has(COMPOSE, 'POSTGRES_DB: ${NEXUS_DB_NAME:-nexus}', 'R2 compose default database is nexus');
  has(COMPOSE, 'POSTGRES_PASSWORD: ${NEXUS_DB_ROOT_PASSWORD:-postgres}', 'R2 compose default superuser password is postgres');
  has(COMPOSE, 'NEXUS_DB_AI_PASSWORD: ${NEXUS_DB_AI_PASSWORD:-nexus_dev_ai_only}', 'R2 compose default AI password is nexus_dev_ai_only');
  has(COMPOSE, 'POSTGRES_USER: postgres', 'R2 compose superuser is postgres');
  has(CI, 'NEXUS_PG_HOST_PORT: "5433"', 'R2 CI pins the compose host port at 5433');

  /* R3/R4 — scoped to the e2e segment; the service-container tokens stay legal in the other jobs. */
  const seg = e2eSegment(t(CI));
  if (seg === null) {
    offenders.push('MISSING — the e2e job segment could not be delimited by its section headers');
  } else {
    has(CI, "NEXUS_PLATFORM_DB_URL='jdbc:postgresql://127.0.0.1:5433/nexus'", 'R3 platform boot pins the compose URL (.../nexus on 5433)');
    has(CI, 'NEXUS_PLATFORM_DB_USERNAME=postgres', 'R3 platform boot pins the compose superuser name');
    has(CI, 'NEXUS_PLATFORM_DB_PASSWORD=postgres ', 'R3 platform boot pins the compose superuser password (NOT ci_secret)');
    has(CI, "NEXUS_DATABASE_URL='postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus'", 'R3 AI uvicorn line uses the compose AI role + password + database');
    // The segment-scoped guards: re-read the SAME needles inside seg so erasing the boot lines cannot
    // be masked by an identical coordinate that legitimately lives in the platform/ai/cloud jobs.
    for (const [needle, label] of [
      ["NEXUS_PLATFORM_DB_PASSWORD=postgres", 'R3 the e2e segment itself carries the compose platform password'],
      ["nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus'", 'R3 the e2e segment itself carries the compose AI coordinate'],
    ]) {
      if (!seg.includes(needle)) offenders.push(`MISSING — e2e segment: ${label}`);
      else notes.push(`held ${label}`);
    }
    for (const tok of DRIFT_TOKENS) {
      absent(seg, tok, `R4 the service-container token ${JSON.stringify(tok)} does not leak into e2e`);
    }
    // The two boot lines must both be present inside the segment (not merely elsewhere in the file).
    if (!seg.includes('spring-boot:run &')) offenders.push('MISSING — e2e segment lost the platform spring-boot:run boot line');
    else notes.push('held R5 e2e segment boots the platform');
    if (!seg.includes('uvicorn app.main:app --port 8000')) offenders.push('MISSING — e2e segment lost the AI uvicorn boot line');
    else notes.push('held R5 e2e segment boots the AI service');
  }

  /* R5 — line-cite-stable discipline: the workflow keeps its 535 lines. */
  const ciLines = t(CI).split(/\r?\n/).length - (t(CI).endsWith('\n') ? 1 : 0);
  if (ciLines !== 535) offenders.push(`DRIFT — .github/workflows/ci.yml has ${ciLines} lines, expected 535 (cited line numbers must not move)`);
  else notes.push('held R5 ci.yml keeps its 535 cited-line-stable lines');

  /* Wiring — CI / ATLAS / ledger / this reader. */
  has(CI, 'node scripts/check_d952.mjs --self-test', 'CI runs this reader with its self-test');
  has(ATLAS, 'scripts/check_d952.mjs', 'ATLAS lists this reader');
  has(STATUS, '## 952. D952', 'the ledger holds §952');
  exists(SELF, 'this reader ships on disk');

  return { offenders, notes, unchecked: null, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) {
      present.add(p);
      files.set(p, readFileSync(abs, 'utf8'));
    }
  }
  if (ciArg) {
    const alt = resolve(ROOT, ciArg.slice('--ci='.length));
    if (!existsSync(alt)) return { files, present, error: `--ci path not found: ${alt}` };
    files.set(CI, readFileSync(alt, 'utf8'));
  }
  return { files, present, error: null };
}

function printResult(result) {
  for (const n of result.notes) console.log(`  ${n}`);
  if (result.offenders.length) {
    console.log(`\nFALSE CREDENTIAL-PLANE WIRING (${result.offenders.length}):`);
    for (const o of result.offenders) console.log('  - ' + o);
    console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
    return 1;
  }
  console.log(`RESULT: PASS — D952 e2e credential-plane seam wired, ${result.notes.length} holds`);
  return 0;
}

if (SELF_TEST) {
  const { files: real, present, error } = fromDisk();
  if (error) { console.log(`RESULT: NOT CHECKED — ${error}`); process.exit(2); }
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const mutate = (path, from, to) => {
    const f = new Map(real);
    const text = f.get(path);
    if (!text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${path}` };
    f.set(path, text.replace(from, to));
    return { files: f };
  };
  const arms = [
    ['platform password -> ci_secret', mutate(CI, 'NEXUS_PLATFORM_DB_PASSWORD=postgres ', 'NEXUS_PLATFORM_DB_PASSWORD=ci_secret ')],
    ['AI password -> ci_nexus_ai', mutate(CI, 'nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus', 'nexus_ai:ci_nexus_ai@127.0.0.1:5433/nexus')],
    ['AI database -> nexus_test', mutate(CI, "nexus_dev_ai_only@127.0.0.1:5433/nexus'", "nexus_dev_ai_only@127.0.0.1:5433/nexus_test'")],
    ['explicit platform coords erased', mutate(CI, "NEXUS_PLATFORM_DB_URL='jdbc:postgresql://127.0.0.1:5433/nexus' NEXUS_PLATFORM_DB_USERNAME=postgres NEXUS_PLATFORM_DB_PASSWORD=postgres ", '')],
    ['compose invocation -> service container', mutate(CI, 'docker compose -f infra/docker-compose.yml up -d postgres redis', 'echo services: # compose removed')],
    ['compose AI default renamed', mutate(COMPOSE, 'NEXUS_DB_AI_PASSWORD: ${NEXUS_DB_AI_PASSWORD:-nexus_dev_ai_only}', 'NEXUS_DB_AI_PASSWORD: ${NEXUS_DB_AI_PASSWORD:-ci_nexus_ai}')],
    ['compose superuser default renamed', mutate(COMPOSE, 'POSTGRES_PASSWORD: ${NEXUS_DB_ROOT_PASSWORD:-postgres}', 'POSTGRES_PASSWORD: ${NEXUS_DB_ROOT_PASSWORD:-ci_secret}')],
    ['CI entry deleted', (() => {
      const f = new Map(real);
      f.set(CI, f.get(CI).replace('node scripts/check_d952.mjs --self-test && ', '').replace('node scripts/check_d952.mjs --self-test', ''));
      return { files: f };
    })()],
    ['ATLAS row erased', (() => {
      const f = new Map(real);
      f.set(ATLAS, f.get(ATLAS).replace(/^\| `scripts\/check_d952\.mjs` \| .*$/m, ''));
      return { files: f };
    })()],
    ['ledger §952 removed', mutate(STATUS, '## 952. D952', '## 952. (removed)')],
    ['a line added past 535', (() => {
      // CRLF/ LF-agnostic: insert one extra physical line after the first line, whatever its EOL.
      const f = new Map(real);
      const text = f.get(CI);
      const m = /^([^\r\n]*)(\r?\n)/.exec(text);
      if (!m) return { skipped: 'no first line to insert after' };
      f.set(CI, text.slice(0, m[0].length) + '# planted' + m[2] + text.slice(m[0].length));
      return { files: f };
    })()],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(38)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(38)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught} (${arms.length} arms)`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present, error } = fromDisk();
if (error) { console.log(`RESULT: NOT CHECKED — ${error}`); process.exit(2); }
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
const code = printResult(result);
if (REPORT) process.exit(0);
process.exit(code);
