#!/usr/bin/env node
/**
 * NEXUS D992 — Flyway's migration superuser password must CASCADE to the runtime datasource
 * password, so a fresh CI checkout (which has no root `.env`) can still boot the monolith.
 *
 * THE BUG (cloud required-gate red, CI run 43230067799 / head 0823d69): the `cloud_lb_smoke.sh`
 * step starts the platform with `dev,cloud`; Flyway runs as the `postgres` SUPERUSER against the
 * scram-sha-256 `pgvector/pgvector:pg16` service container. Its password came from a TWO-term chain
 * in `application-dev.yml`:
 *     password: ${NEXUS_MIGRATION_DB_PASSWORD:${NEXUS_DB_ROOT_PASSWORD:}}
 * The CI job sets NEITHER variable (it sets `NEXUS_DB_PASSWORD=ci_secret` for the runtime
 * DataSource). So the chain resolved to an EMPTY string and Flyway died at context init:
 *     "The server requested SCRAM-based authentication, but the password is an empty string"
 *       at flywayInitializer -> Flyway.migrate -> PSQLException
 * Tomcat never bound :8091, and `wait_for platform` polled a dead port until its budget expired
 * (240s). D989/D989-follow kept widening that budget and fixing a grep — neither can help a
 * process that exits in 7 seconds. Local DEBUG was green ONLY because the developer's untracked
 * root `.env` defines `NEXUS_DB_ROOT_PASSWORD`, which silently fed the second term; CI's fresh
 * checkout has no such file. That env-plane asymmetry is why the defect hid until the first full
 * cloud push after the D981-D990 batch.
 *
 * THE FIX (one line of product config, `application-dev.yml`): the Flyway password now cascades
 * through the runtime datasource password's OWN chain as its last resort:
 *     password: ${NEXUS_MIGRATION_DB_PASSWORD:${NEXUS_DB_ROOT_PASSWORD:${NEXUS_PLATFORM_DB_PASSWORD:${NEXUS_DB_PASSWORD:}}}}
 * Priority: an explicit migration superuser secret (split-role production) > the infra root secret
 * (developer `.env`) > whichever name the caller used for the runtime DataSource secret
 * (`NEXUS_PLATFORM_DB_PASSWORD` from the launcher, or `NEXUS_DB_PASSWORD` from CI's service job).
 * The last two terms are BYTE-FOR-BYTE the datasource password chain in application.yml:31 and
 * application-dev.yml:14, so Flyway and the app's DataSource can never drift to different values.
 * Nothing else moves: the migration user stays `postgres`, baseline-on-migrate/locations/clean-
 * disabled stay as they were, no secret is ever printed, no CI env is added, and the fail-fast
 * behaviour is preserved (a genuinely absent password still stops the boot).
 *
 * WHAT THIS SOURCE GATE HOLDS: the four-term cascade shape and its exact last-two-term identity
 * with the datasource chain; the removed two-term empty chain cannot return; the migration user,
 * baseline/locations and clean-disabled are intact; both datasource password chains are unchanged;
 * the CI cloud lb-smoke step still supplies `NEXUS_DB_PASSWORD` (the cascade's input) and still
 * does NOT hard-code a migration secret (which would mask a future regression of this chain); and
 * CI / ATLAS / ledger wiring is intact. It is a SOURCE gate — it starts no container and asserts
 * no live SCRAM handshake. The one-variable RED/GREEN proof (old 2-term chain -> 7s SCRAM exit;
 * new 4-term chain with ONLY `NEXUS_DB_PASSWORD` -> 30s health-ok, baseline v2 + 10 migrations to
 * v12, no SCRAM) is an opt-in, key-env-only, git-ignored probe, NOT run by CI and recorded in the
 * ledger; a green result here means "the shipped config says the right thing", not "a cloud boot
 * passed today" — the CI cloud job remains the verifier of record for the wire behaviour.
 *
 * SELF-TEST: --self-test plants corruptions in memory — collapse the cascade back to the empty
 * 2-term chain, drop either datasource term (so a caller using only that name gets an empty
 * password), break the byte-identity with the datasource chain, hard-code a literal secret, demote
 * the explicit migration secret from first priority, restore the migration user, disable fail-fast
 * via clean-disabled/baseline, mutate the datasource chain, inject a CI migration secret (masks the
 * regression), cut CI/ATLAS/ledger wiring — and requires EACH to redden for its RIGHT expect tag
 * while the real plane holds. D954 no-op guard, D959 line-anchored `## 992.` heading, and a GREEN
 * control (a legitimate comment rewording) keep the judge honest.
 *
 * Usage:  node scripts/check_flyway_password_cascade.mjs [--self-test] [--report] [--ci=<path>]
 * Exit:   0 every claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const CI_OVERRIDE = argv.find((a) => a.startsWith('--ci='))?.slice('--ci='.length);

const DEV = 'services/platform/src/main/resources/application-dev.yml';
const BASE = 'services/platform/src/main/resources/application.yml';
const LB_SMOKE = 'scripts/cloud_lb_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_flyway_password_cascade.mjs';
const PATHS = [DEV, BASE, LB_SMOKE, CI, ATLAS, STATUS, SELF];

const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 992\. D992(?=\s|$)/m;

// The exact shipped chains. Kept as constants so a judged plane can be mutated away from them.
const DS_TAIL = '${NEXUS_PLATFORM_DB_PASSWORD:${NEXUS_DB_PASSWORD:}}';
const FLYWAY_CHAIN = `\${NEXUS_MIGRATION_DB_PASSWORD:\${NEXUS_DB_ROOT_PASSWORD:${DS_TAIL}}}`;
const FLYWAY_LINE = `    password: ${FLYWAY_CHAIN}`;
const DS_LINE = `    password: ${DS_TAIL}`;
const OLD_FLYWAY_LINE = '    password: ${NEXUS_MIGRATION_DB_PASSWORD:${NEXUS_DB_ROOT_PASSWORD:}}';

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the flyway-cascade plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the four-term cascade is EXACT, with the datasource chain as its last two terms. */
  has(DEV, FLYWAY_LINE, 'the flyway password is the four-term cascade', 'CASCADE-SHAPE');
  absent(DEV, OLD_FLYWAY_LINE, 'the empty two-term chain is gone', 'NO-EMPTY-CHAIN');
  // The last two terms of the Flyway chain must be byte-identical to the datasource chain, so the
  // two connections can never drift. Extract each chain from its line and compare.
  const flyLine = t(DEV).split(/\r?\n/).find((l) => l.trim().startsWith('password: ${NEXUS_MIGRATION_DB_PASSWORD:'));
  const dsLineDev = t(DEV).split(/\r?\n/).find((l) => l.trim() === `password: ${DS_TAIL}`);
  const dsLineBase = t(BASE).split(/\r?\n/).find((l) => l.trim() === `password: ${DS_TAIL}`);
  // The datasource tail must appear verbatim AND terminate the chain: four nested `${...}` levels
  // close with exactly four `}`. Dropping either datasource term (or adding a trailing fallback)
  // breaks one of these two independent conditions.
  if (!flyLine || !flyLine.includes(DS_TAIL) || !flyLine.endsWith('}}}}')) {
    offenders.push(`MISSING — ${DEV}: the flyway chain's last two terms are not the datasource chain ${DS_TAIL}${tag('CASCADE-TAIL')}`);
  } else notes.push('held the flyway chain ends in the datasource chain');
  if (!dsLineDev) offenders.push(`MISSING — ${DEV}: the dev datasource password chain changed${tag('DS-DEV')}`);
  else notes.push('held the dev datasource password chain');
  if (!dsLineBase) offenders.push(`MISSING — ${BASE}: the base datasource password chain changed${tag('DS-BASE')}`);
  else notes.push('held the base datasource password chain');
  // No hard-coded literal may sit in the flyway password line (a "fix" that bakes ci_secret in).
  if (flyLine && /\bci_secret\b|postgres\s*\}\}/.test(flyLine.replace(FLYWAY_LINE, ''))) {
    offenders.push(`STALE — ${DEV}: the flyway password line carries a hard-coded literal${tag('NO-LITERAL')}`);
  } else notes.push('held no hard-coded password literal');

  /* 2 — explicit migration secret keeps FIRST priority; fail-fast semantics are untouched.
        Read the order from the PLANE's shipped flyway line, not from a reader constant, so a
        demotion corruption reddens THIS tag for the right reason (D954/D976 discipline). */
  const orderLine = flyLine ?? '';
  const iMig = orderLine.indexOf('NEXUS_MIGRATION_DB_PASSWORD');
  const iRoot = orderLine.indexOf('NEXUS_DB_ROOT_PASSWORD');
  const iTail = orderLine.indexOf('NEXUS_PLATFORM_DB_PASSWORD');
  const chainOrder = iMig >= 0 && iRoot > iMig && iTail > iRoot;
  if (!chainOrder) offenders.push(`MISSING — ${DEV}: the cascade priority is not migration > root > datasource${tag('PRIORITY')}`);
  else notes.push('held the cascade priority migration > root > datasource');
  has(DEV, '    user: ${NEXUS_MIGRATION_DB_USER:postgres}', 'the migration superuser is still postgres', 'MIGRATION-USER');
  has(BASE, '    baseline-on-migrate: true', 'baseline-on-migrate is intact', 'BASELINE');
  has(BASE, '    locations: classpath:db/migration', 'the migration locations are intact', 'LOCATIONS');
  has(BASE, '    clean-disabled: true', 'clean-disabled is intact', 'CLEAN-DISABLED');

  /* 3 — the smoke still exports the cascade's CI input, without baking in a migration secret. */
  has(LB_SMOKE, 'export NEXUS_PLATFORM_DB_PASSWORD="${NEXUS_PLATFORM_DB_PASSWORD:-${NEXUS_DB_PASSWORD:-ci_secret}}"',
      'the smoke derives the runtime datasource password from the CI env', 'SMOKE-DS-PW');
  absent(LB_SMOKE, 'NEXUS_MIGRATION_DB_PASSWORD=', 'the smoke does not hard-code a migration password', 'SMOKE-NO-MIG-PW');

  /* 4 — CI cloud job premise: it supplies the DataSource secret only (the bug's trigger). */
  // Scope to the lb-smoke step segment so an identical env in a sibling step can't satisfy this.
  const ciText = t(ciPath);
  const lbIdx = ciText.indexOf('run: bash scripts/cloud_lb_smoke.sh');
  const ciSegment = lbIdx >= 0 ? ciText.slice(Math.max(0, lbIdx - 600), lbIdx) : '';
  has(ciPath, 'NEXUS_DB_PASSWORD: ci_secret', 'CI supplies the runtime datasource password', 'CI-DS-PW');
  if (lbIdx < 0 || !ciSegment.includes('NEXUS_DB_PASSWORD: ci_secret')) {
    offenders.push(`MISSING — ${ciPath}: the lb-smoke step does not supply NEXUS_DB_PASSWORD${tag('CI-LB-DS-PW')}`);
  } else notes.push('held the lb-smoke step supplies NEXUS_DB_PASSWORD');
  absent(ciPath, 'NEXUS_MIGRATION_DB_PASSWORD:', 'CI does not inject a migration password (would mask a cascade regression)', 'CI-NO-MIG-PW');

  /* 5 — wiring: CI runs this reader; ATLAS lists it + the fixed config; ledger line-anchored. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, DEV, 'ATLAS lists the fixed dev config', 'ATLAS-DEV');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 992. D992\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D992 heading line');
  has(STATUS, 'The server requested SCRAM-based authentication', 'the ledger records the real failure signature', 'LEDGER-SIGNATURE');

  return { offenders, notes, unchecked: null, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');
const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  f.set(p, text.split(from).join(to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const ciPath = CI_OVERRIDE ?? CI;
  const base = judge(real, present, ciPath);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['cascade collapsed to empty 2-term chain', mutate(real, DEV, FLYWAY_LINE, OLD_FLYWAY_LINE), 'CASCADE-SHAPE'],
    ['datasource tail dropped (launcher name empty)', mutate(real, DEV, FLYWAY_LINE, '    password: ${NEXUS_MIGRATION_DB_PASSWORD:${NEXUS_DB_ROOT_PASSWORD:${NEXUS_DB_PASSWORD:}}}'), 'CASCADE-TAIL'],
    ['datasource tail dropped (CI name empty)', mutate(real, DEV, FLYWAY_LINE, '    password: ${NEXUS_MIGRATION_DB_PASSWORD:${NEXUS_DB_ROOT_PASSWORD:${NEXUS_PLATFORM_DB_PASSWORD:}}}'), 'CASCADE-TAIL'],
    ['explicit migration secret demoted from first', mutate(real, DEV, FLYWAY_CHAIN, '${NEXUS_DB_ROOT_PASSWORD:${NEXUS_MIGRATION_DB_PASSWORD:${DS_TAIL}}}'), 'PRIORITY'],
    ['hard-coded literal baked in', mutate(real, DEV, FLYWAY_LINE, '    password: ci_secret'), 'CASCADE-SHAPE'],
    ['migration user changed off postgres', mutate(real, DEV, '    user: ${NEXUS_MIGRATION_DB_USER:postgres}', '    user: ${NEXUS_MIGRATION_DB_USER:nexus_app}'), 'MIGRATION-USER'],
    ['baseline-on-migrate disabled', mutate(real, BASE, '    baseline-on-migrate: true', '    baseline-on-migrate: false'), 'BASELINE'],
    ['locations emptied', mutate(real, BASE, '    locations: classpath:db/migration', '    locations: classpath:db/none'), 'LOCATIONS'],
    ['clean-disabled removed', mutate(real, BASE, '    clean-disabled: true', '    clean-disabled: false'), 'CLEAN-DISABLED'],
    ['dev datasource chain mutated', mutate(real, DEV, DS_LINE, '    password: ${NEXUS_DB_PASSWORD}'), 'DS-DEV'],
    ['base datasource chain mutated', mutate(real, BASE, DS_LINE, '    password: ${NEXUS_DB_PASSWORD}'), 'DS-BASE'],
    ['smoke datasource derivation cut', mutate(real, LB_SMOKE, 'export NEXUS_PLATFORM_DB_PASSWORD="${NEXUS_PLATFORM_DB_PASSWORD:-${NEXUS_DB_PASSWORD:-ci_secret}}"', 'export NEXUS_PLATFORM_DB_PASSWORD="ci_secret"'), 'SMOKE-DS-PW'],
    ['smoke bakes a migration password', mutate(real, LB_SMOKE, '# D992', 'export NEXUS_MIGRATION_DB_PASSWORD=ci_secret\n# D992'), 'SMOKE-NO-MIG-PW'],
    ['CI stops supplying datasource password', mutate(real, ciPath, '          NEXUS_DB_PASSWORD: ci_secret', '          NEXUS_DB_PASSWORD: wrong'), 'CI-LB-DS-PW'],
    ['CI injects a migration password', mutate(real, ciPath, '        run: bash scripts/cloud_lb_smoke.sh', '        env: { NEXUS_MIGRATION_DB_PASSWORD: ci_secret }\n        run: bash scripts/cloud_lb_smoke.sh'), 'CI-NO-MIG-PW'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, 'node scripts/_absent.mjs --self-test'), 'CI-READER'],
    ['ATLAS reader row erased', mutate(real, ATLAS, `\`${SELF}\``, '`scripts/_removed.mjs`'), 'ATLAS-READER'],
    ['ATLAS dev-config row erased', mutate(real, ATLAS, DEV, 'services/platform/src/main/resources/_removed.yml'), 'ATLAS-DEV'],
    ['ledger D992 heading removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
    ['ledger failure signature erased', mutate(real, STATUS, 'The server requested SCRAM-based authentication', 'the boot failed'), 'LEDGER-SIGNATURE'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [label, arm, tagName] of arms) {
    const expect = arm.expect ?? tagName;
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(46)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) { console.log(`  self-test  ${label.padEnd(46)} NO-OP (defect!)`); allCaught = false; continue; }
    const out = judge(arm.files, arm.present ?? present, ciPath);
    const red = out.offenders.length > 0 || out.unchecked;
    const rightReason = out.offenders.some((o) => o.includes(expect));
    const pass = red && rightReason;
    console.log(`  self-test  ${label.padEnd(46)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expect}"`);
    if (!pass) { allCaught = false; for (const o of out.offenders.slice(0, 3)) console.log('      got: ' + o); }
  }
  // GREEN control: a legitimate comment rewording must NOT redden (guards an overfit judge).
  {
    const f = new Map(real);
    f.set(DEV, (f.get(DEV) ?? '').replace(
        'The value is never printed here',
        'No value is ever echoed by this file'));
    const out = judge(f, present, ciPath);
    const controlGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate comment rewording stays GREEN'.padEnd(46)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!controlGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  // Real plane still holds.
  {
    const out = judge(real, present, ciPath);
    const realGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate plane stays GREEN'.padEnd(46)} green offenders=${out.offenders.length}`);
    if (!realGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  console.log(`  self-test  all arms redden for cause + guards green: ${allCaught} (${arms.length} corruption arms)`);
  process.exit(allCaught ? 0 : 1);
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk();
const result = judge(files, present, ciPath);
if (result.unchecked) { console.log('RESULT: NOT CHECKED — ' + result.unchecked); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log('  ' + n);
if (result.offenders.length) {
  console.log(`FALSE FLYWAY-CASCADE (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D992 flyway password cascades to the datasource secret, ${result.notes.length} holds`);
