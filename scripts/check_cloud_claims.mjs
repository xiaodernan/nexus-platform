#!/usr/bin/env node
/**
 * NEXUS D898 (Phase G / G5) — the machine-readable cloud CLAIM census reader.
 *
 * `docs/CLOUD.md` is the human-facing page, but its honesty boundaries were prose: nothing
 * mechanically stopped a claim from gaining a smoke-less "proved" sentence, a gate that no longer
 * exists, or a not-claimed clause that quietly vanished. `docs/cloud_claims.yaml` names every
 * claim together with its smoke, its gate, its not-claimed boundary and an EXACT anchor phrase in
 * CLOUD.md's honesty section. THIS reader judges that census:
 *
 *   1. restricted YAML grammar (no dependency, a malformed line reddens);
 *   2. every record has claim + smoke + gate + not_claimed + honesty_anchor, unique `D###` id;
 *   3. every named script/reader EXISTS on disk and is invoked by CI, listed in CLOUD.md and ATLAS;
 *   4. every honesty_anchor really appears in CLOUD.md, and the honesty section still exists;
 *   5. REVERSE census: every `check_*.mjs` and every cloud `*.sh` named in CLOUD.md appears in
 *      the census, so the prose page cannot gain a proof the machine index does not know about.
 *
 * WHAT THIS DOES NOT SAY: that any smoke ran today, that a claim is TRUE, that CLOUD.md's prose
 * is exhaustive, or that the census is a substitute for the human page. It is a wiring census.
 *
 * SELF-TEST: `judge` is pure over (path -> text) plus file existence; `--self-test` plants
 * corruptions in memory — a missing smoke/gate/boundary, a broken anchor, a nonexistent script,
 * a duplicated id, a malformed line, a deleted CI/ATLAS/CLOUD entry, an empty census — and
 * requires EACH to redden while the real plane holds.
 *
 * D954 — the self-test's own falsifiability was quietly broken. The three line-removal arms (missing
 * smoke / gate / not_claimed) matched a hard-coded LF needle, but docs/cloud_claims.yaml is CRLF on
 * a Windows worktree (LF on a Linux CI checkout), so on CRLF the `replace` was a NO-OP: the arm
 * reported `caught: false` without the plane ever changing, and `check_cloud_claims --self-test`
 * exited 1 while the reader's header still promised "a missing smoke reddens". Two repairs, neither
 * touching `judge`'s census semantics: (1) line-removal needles are EOL-agnostic (`/^...\r?$/m`), so
 * they bite on both CRLF and LF planes; (2) EVERY arm must demonstrably change the plane (a snapshot
 * of all six files before vs after), otherwise it is a FAIL labelled `NO-OP (defect!)`, never a shrug.
 * This is the meta-invariant: a gate whose own falsifier can silently no-op is not a falsifier.
 *
 * Exit: 0 every census claim holds · 1 an offender.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CLAIMS = 'docs/cloud_claims.yaml';
const CLOUD_DOC = 'docs/CLOUD.md';
const ATLAS = 'docs/ATLAS.md';
const CI = '.github/workflows/ci.yml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_cloud_claims.mjs';
const FILES = [CLAIMS, CLOUD_DOC, ATLAS, CI, STATUS, SELF];

const KEYS = new Set(['claim', 'smoke', 'falsifier', 'gate', 'not_claimed', 'honesty_anchor']);
const REQUIRED = ['claim', 'smoke', 'gate', 'not_claimed', 'honesty_anchor'];

/** Restricted YAML: one "- id:" record start, then two-space "key: value" lines. No dependency. */
function parseClaims(text) {
  const claims = [];
  const errors = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const numbered = i + 1;
    if (line.startsWith('- ')) {
      const m = /^- id:\s*(\S+)\s*$/.exec(line);
      if (!m) { errors.push(`line ${numbered}: a record must start with "- id: D###"`); continue; }
      cur = { id: m[1], keyOrder: new Set() };
      claims.push(cur);
      continue;
    }
    const m = /^([a-z_]+):\s+(.+)$/.exec(line);
    if (!cur || !m) { errors.push(`line ${numbered}: malformed census line (${JSON.stringify(line)})`); continue; }
    const [, key, value] = m;
    if (!KEYS.has(key)) { errors.push(`line ${numbered}: unknown key ${key}`); continue; }
    if (cur.keyOrder.has(key)) { errors.push(`line ${numbered}: duplicate key ${key}`); continue; }
    cur.keyOrder.add(key);
    cur[key] = value.trim();
  }
  return { claims, errors };
}

const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none');

/**
 * A plain `includes(name)` is WRONG here: `falsify_cloud_ha_failover_smoke.sh` contains the
 * substring `cloud_ha_failover_smoke.sh`, so deleting the main smoke from CI would still look
 * wired. D898's own self-test found that hole. Require a non-identifier character on BOTH sides
 * of the name so a longer sibling script cannot stand in for the one a claim actually names.
 */
const mentions = (t, name) => new RegExp(
  `(?<![a-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_-])`,
).test(t);

function judge(plane) {
  const offenders = [];
  const notes = [];
  const text = (rel) => plane.get(rel) ?? '';
  const cloud = text(CLOUD_DOC);
  const atlas = text(ATLAS);
  const ci = text(CI);
  const status = text(STATUS);

  for (const rel of FILES) {
    if (!existsSync(join(ROOT, rel))) offenders.push(`ABSENT — ${rel}`);
    else notes.push(`held ${rel} exists`);
  }

  const { claims, errors } = parseClaims(text(CLAIMS));
  for (const e of errors) offenders.push(`CENSUS GRAMMAR — ${e}`);
  if (!claims.length) offenders.push('CENSUS EMPTY — no claims declared');
  if (claims.length < 12) offenders.push(`CENSUS THIN — only ${claims.length} claims; the cloud plane has more than twelve measured seams`);

  const ids = new Set();
  const censusScripts = new Set();
  const censusGates = new Set();

  for (const c of claims) {
    const tag = c.id || '<no id>';
    if (!/^D\d{3}$/.test(c.id ?? '')) offenders.push(`${tag}: id must look like D###`);
    if (ids.has(c.id)) offenders.push(`${tag}: duplicate claim id`);
    ids.add(c.id);
    for (const key of REQUIRED) {
      if (!c[key]) offenders.push(`${tag}: MISSING the ${key} element`);
    }
    if (!c.claim || c.claim.length < 20) offenders.push(`${tag}: claim text is too short to be a claim`);
    if (!c.not_claimed || c.not_claimed.length < 25) offenders.push(`${tag}: not_claimed boundary is missing or too thin`);
    if (!c.honesty_anchor || c.honesty_anchor.length < 8) offenders.push(`${tag}: honesty_anchor is missing`);
    else if (!cloud.includes(c.honesty_anchor)) {
      offenders.push(`${tag}: honesty_anchor ${JSON.stringify(c.honesty_anchor)} is NOT in CLOUD.md`);
    } else notes.push(`held ${tag} anchor resolves in CLOUD.md`);
    if (!cloud.includes(c.id ?? '~~~')) offenders.push(`${tag}: CLOUD.md never names this claim id`);
    else notes.push(`held ${tag} appears in CLOUD.md`);

    const smokes = list(c.smoke);
    const falsifiers = list(c.falsifier);
    if (!smokes.length) offenders.push(`${tag}: no smoke named`);
    for (const name of [...smokes, ...falsifiers]) {
      censusScripts.add(name);
      if (!existsSync(join(ROOT, 'scripts', name))) offenders.push(`${tag}: ABSENT script scripts/${name}`);
      if (!mentions(ci, name)) offenders.push(`${tag}: CI never invokes ${name}`);
      if (!mentions(cloud, name)) offenders.push(`${tag}: CLOUD.md never lists ${name}`);
      if (!mentions(atlas, name)) offenders.push(`${tag}: ATLAS never lists ${name}`);
    }
    const gate = c.gate;
    if (!gate) offenders.push(`${tag}: no gate named`);
    else {
      censusGates.add(gate);
      if (!existsSync(join(ROOT, 'scripts', gate))) offenders.push(`${tag}: ABSENT reader scripts/${gate}`);
      if (!mentions(ci, gate)) offenders.push(`${tag}: CI never invokes ${gate}`);
      if (!mentions(cloud, gate)) offenders.push(`${tag}: CLOUD.md never lists ${gate}`);
      if (!mentions(atlas, gate)) offenders.push(`${tag}: ATLAS never lists ${gate}`);
    }
  }

  /* The prose page stays the human-facing one, but it must keep its honesty section. */
  if (!cloud.includes('## What this plane does NOT claim (read this)')) {
    offenders.push('CLOUD.md lost its "What this plane does NOT claim" section');
  } else notes.push('held CLOUD.md keeps the honesty section');

  /* REVERSE census: a gate or smoke named on the prose page must exist in the machine index. */
  // The census reader is SELF-REFERENTIAL: it guards the index, it is not one of the indexed
  // claim gates, so its own name is excluded from the reverse census (CI/ATLAS still bind it).
  const docGates = [...new Set([...cloud.matchAll(/check_[a-z0-9_-]+\.mjs/g)].map((m) => m[0]))]
    .filter((g) => g !== 'check_cloud_claims.mjs');
  for (const g of docGates) {
    if (!censusGates.has(g)) offenders.push(`REVERSE — CLOUD.md names gate ${g} but no claim binds it`);
  }
  const docScripts = [...new Set([...cloud.matchAll(/[a-z0-9_-]+\.sh/g)].map((m) => m[0]))]
    .filter((s) => s !== 'db_gate_fresh.sh');
  for (const s of docScripts) {
    if (!censusScripts.has(s)) offenders.push(`REVERSE — CLOUD.md names smoke ${s} but no claim binds it`);
  }
  if (docGates.length < 8) offenders.push(`REVERSE — only ${docGates.length} gates named in CLOUD.md; the census expects at least 8`);
  if (docScripts.length < 20) offenders.push(`REVERSE — only ${docScripts.length} smokes named in CLOUD.md; the census expects at least 20`);
  notes.push(`held reverse census: ${docGates.length} gates / ${docScripts.length} smokes reviewed`);

  if (!ci.includes('scripts/check_cloud_claims.mjs')) offenders.push('CI never runs this census reader');
  if (!atlas.includes('docs/cloud_claims.yaml')) offenders.push('ATLAS never lists the census file');
  if (!atlas.includes('scripts/check_cloud_claims.mjs')) offenders.push('ATLAS never lists this census reader');
  if (!cloud.includes('D898')) offenders.push('CLOUD.md never names D898');
  if (!status.includes('## 898.')) offenders.push('the ledger has no numbered D898 section');
  if (!text(SELF).includes('--self-test')) offenders.push('this reader has no self-test');
  notes.push(`held ${claims.length} claim(s), ${censusScripts.size} script(s), ${censusGates.size} gate(s)`);

  return { offenders, notes };
}

function realPlane() {
  const plane = new Map();
  for (const rel of FILES) {
    try { plane.set(rel, readFileSync(join(ROOT, rel), 'utf8')); } catch { plane.set(rel, ''); }
  }
  return plane;
}

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  const live = judge(realPlane());
  // D954 — a corruption that does not actually CHANGE the plane is not a test; it is a no-op dressed
  // as `caught: false`. The first three arms below used to carry a hard-coded LF needle, but this
  // census file is CRLF on a Windows worktree (and LF on a Linux CI checkout), so `...sh\n` matched
  // nothing, `replace` returned the text unchanged, and the arm silently reported `caught: false` —
  // the README's "a missing smoke reddens" claim was false. Two fixes, both EOL-agnostic:
  //   (1) line-removal needles use `/^... \r?$/m` so they bite on CRLF AND LF planes;
  //   (2) EVERY arm must demonstrably change at least one plane file, or it is a FAIL, never a shrug.
  const cases = [
    ['a claim loses its smoke', (p) => p.set(CLAIMS, p.get(CLAIMS).replace(/^  smoke: cloud_trace_smoke\.sh\r?$/m, ''))],
    ['a claim loses its gate', (p) => p.set(CLAIMS, p.get(CLAIMS).replace(/^  gate: check_cloud_trace_fallback\.mjs\r?$/m, ''))],
    ['a claim loses its not_claimed boundary', (p) => p.set(CLAIMS, p.get(CLAIMS).replace(/^  not_claimed: No collector, no span into a downstream, no real product failure, no route-miss case, no log correlation\r?$/m, ''))],
    ['an anchor no longer exists in CLOUD.md', (p) => p.set(CLAIMS, p.get(CLAIMS).replace('  honesty_anchor: No trace collector', '  honesty_anchor: this phrase is nowhere on the page'))],
    ['a smoke points at a nonexistent script', (p) => p.set(CLAIMS, p.get(CLAIMS).replace('  smoke: cloud_ha_failover_smoke.sh', '  smoke: missing_failover_smoke.sh'))],
    ['a duplicate claim id', (p) => p.set(CLAIMS, p.get(CLAIMS).replace('- id: D897', '- id: D896'))],
    ['a malformed census line', (p) => p.set(CLAIMS, p.get(CLAIMS).replace('- id: D853', 'this line is not yaml'))],
    ['CLOUD.md loses an honesty anchor', (p) => p.set(CLOUD_DOC, p.get(CLOUD_DOC).replaceAll('No trace collector', 'a collector exists'))],
    ['CI drops a claim\'s smoke', (p) => p.set(CI, p.get(CI).replaceAll('scripts/cloud_ha_failover_smoke.sh', 'scripts/retired_smoke.sh'))],
    ['ATLAS drops a claim\'s gate', (p) => p.set(ATLAS, p.get(ATLAS).replaceAll('scripts/check_cloud_ha_failover.mjs', 'scripts/retired_reader.mjs'))],
    ['CLOUD.md drops a gate', (p) => p.set(CLOUD_DOC, p.get(CLOUD_DOC).replaceAll('check_cloud_insight.mjs', 'retired_insight_reader.mjs'))],
    ['CLOUD.md gains an unbound smoke', (p) => p.set(CLOUD_DOC, `${p.get(CLOUD_DOC)}\n| \`unbound_smoke.sh\` | a proof no claim knows about |\n`)],
    ['the census is emptied', (p) => p.set(CLAIMS, '# nothing here\n')],
  ];
  const snapshot = (plane) => FILES.map((rel) => `${rel}=${plane.get(rel) ?? ''}`).join('\u0000');
  let allCaught = true;
  for (const [label, corrupt] of cases) {
    const plane = realPlane();
    const before = snapshot(plane);
    corrupt(plane);
    // D954 — a needle that misses changes nothing; that is a broken arm, not a caught one. Refuse it.
    if (snapshot(plane) === before) {
      console.log(`  self-test  ${label.padEnd(44)} NO-OP (defect!) — the corruption never changed the plane`);
      allCaught = false;
      continue;
    }
    const caught = judge(plane).offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(44)} caught: ${caught}`);
    if (!caught) allCaught = false;
  }
  const emptyCaught = judge(new Map()).offenders.length > 0;
  console.log(`  self-test  ${'empty plane refused'.padEnd(44)} caught: ${emptyCaught}`);
  console.log(`  self-test  real plane offenders: ${live.offenders.length}`);
  const ok = allCaught && emptyCaught && live.offenders.length === 0 && live.notes.length > 20;
  console.log(ok
    ? '\nRESULT: PASS — every planted corruption reddens and the real census holds'
    : '\nRESULT: FAIL — a corruption was not caught,was a no-op, or the real census is red');
  if (live.offenders.length) for (const o of live.offenders.slice(0, 25)) console.log(`  - ${o}`);
  process.exit(ok ? 0 : 1);
}

const { offenders, notes } = judge(realPlane());
if (offenders.length) {
  console.log('CLOUD CLAIM CENSUS — FAIL');
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`${offenders.length} offender(s), ${notes.length} claim(s) held`);
  process.exit(1);
}
console.log('CLOUD CLAIM CENSUS — PASS');
console.log(`${notes.length} claim(s) held`);
console.log('\nWHAT THIS DOES NOT SAY: a smoke ran today, a claim is true, or CLOUD.md is exhaustive.');
process.exit(0);
