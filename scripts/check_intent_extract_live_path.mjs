#!/usr/bin/env node
/**
 * NEXUS D982 — the live intent path is reachable: the instruction is mandatory, the schema is refusable, and the floor is intact.
 *
 * The service pointed its intent extraction at a live provider and the model answered as a
 * helpful chatbot — because the request carried no instruction at all. The §7.1 validator
 * (correctly) refused the answer every time, so the "live" path produced `degraded: true`
 * forever, and everything that reads that flag read it as an outage, not as an integration
 * that had never spoken. This unit wires the task instruction and the structured-output
 * request into the request the model actually sees, and keeps the floor exactly where
 * it was: a model that cannot speak §7.1 is refused by the same validator, and the floor
 * answers — it always did, that is the shipped contract.
 *
 * THIS reader holds the structural claims tests cannot keep from rotating away: the
 * `INTENT_EXTRACT_SYSTEM` instruction exists, it reaches `LLMRequest` along with the JSON-mode
 * hint, the §7.1 refusal branch stays in `pipeline.understand()`, the floor fallback exists
 * for a provider that is absent or wrong-shaped, the offline probe pins the three runtime
 * arms (instruction carried, JSON mode carried, wrong-shaped answers refused), and CI /
 * ATLAS / the ledger still wire it so a later refactor cannot silence it.
 *
 * SELF-TEST: `--self-test` plants corruptions in memory — the instruction erased, the system
 * prompt delinked from the request, the JSON mode dropped, the §7.1 refusal cut, the floor
 * fallback removed, the offline probe arm deleted, the ATLAS row erased, the ledger heading
 * erased, the CI invocation cut — and requires EACH to redden while the real plane holds
 * (a GREEN control arms last).
 *
 * WHAT THIS DOES NOT SAY: that a live provider was called today, that any latency number
 * holds, that the provider's usage tokens are faithful (see D980's bound), or that the
 * §7.1 validator is the right schema. The falsifier is "did the code speak the shape it
 * claims?"
 *
 * Usage:  node scripts/check_intent_extract_live_path.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const PIPE = 'apps/ai/nexus_ai/api/pipeline.py';
const CONTRACT = 'apps/ai/nexus_ai/contract.py';
const TEST = 'apps/ai/tests/test_intent_extract_reaches_the_model_with_a_task_instruction.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_intent_extract_live_path.mjs';
const PATHS = [PIPE, CONTRACT, TEST, CI, ATLAS, STATUS, SELF];

const HEADING_RE = /^## 982\. D982(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the intent-live-path plane is empty or unreadable — a census that found nothing cleared nothing' };
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
  const count = (p, needle, n, label, expect) => {
    const got = t(p).split(needle).length - 1;
    if (got !== n) offenders.push(`WRONG-COUNT — ${p}: ${label} (found ${got}, need exactly ${n})${tag(expect)}`);
    else notes.push(`held ${label} (${got})`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the instruction is a constant, not a shrug. */
  // D1050: the instruction is now the TAIL of a frozen shared prefix, so the literal is
  // named `_INTENT_SCHEMA_BODY` and `INTENT_EXTRACT_SYSTEM` is composed from it. The claim
  // this reader makes is unchanged: the §9 instruction exists in this module and reaches
  // the request. Pin both halves so neither the literal nor the composition can vanish.
  has(PIPE, '_INTENT_SCHEMA_BODY = (', 'the §9 intent_extract instruction exists', 'PIPE-SYS-DEF');
  has(PIPE, 'INTENT_EXTRACT_SYSTEM = contract_for("intent_extract", _INTENT_SCHEMA_BODY)',
      'the instruction is composed into the system message', 'PIPE-SYS-COMPOSE');
  /* 2 — every atom of §7.1 the model needs to answer in schema is in it. */
  for (const atom of ['raw_query', 'intent', 'discover_merchant', 'category', 'location',
                      'time', 'budget', 'party_size', 'preferences', 'constraints',
                      'sort_preference', 'urgency', 'language', 'unknowns',
                      'mentioned_entities', 'excluded_ids']) {
    has(PIPE, atom, `INTENT_EXTRACT_SYSTEM names ${atom}`, `PIPE-ATOM-${atom}`);
  }
  /* 3 — the understand() call carries the instruction and asks for JSON mode. */
  has(PIPE, 'system=INTENT_EXTRACT_SYSTEM, json_hint="json_object"',
      'the model request carries system + json_hint', 'PIPE-DELIVER');
  /* 4 — the §7.1 refusal branch is intact. */
  has(PIPE, 'raise ValueError("model returned an Intent outside the §7.1 schema")',
      'a wrong-shaped answer is refused', 'REFUSAL');
  /* 5 — the floor is intact: an absent/unusable provider answers degraded, never 5xx. */
  has(PIPE, 'floor("model_unavailable")', 'the rule floor answers an absent provider', 'FLOOR');
  has(PIPE, 'provider="rules", degraded=True', 'the degraded flag on the floor arm', 'FLOOR-DEGRADED');

  /* 6 — the offline probe pins the three runtime arms. */
  has(TEST, 'def test_the_model_sees_instruction_and_json_mode_are_carried',
      'the offline probe pins instruction + JSON mode', 'TEST-CARRIED');
  has(TEST, 'def test_a_valid_live_answer_names_the_live_provider',
      'the offline probe pins the live label', 'TEST-LIVE');
  has(TEST, 'def test_an_invalid_live_answer_is_refused_and_the_floor_answers_degraded',
      'the offline probe pins the refusal arm', 'TEST-REFUSE');

  /* 7 — the contract module names the enum the model answers into. */
  has(CONTRACT, 'IntentKind = Literal[', 'the §7.1 intent enum lives in the contract module',
      'CONTRACT-KIND');
  has(CONTRACT, '"discover_merchant",', 'the enum names discover_merchant', 'CONTRACT-LITERAL');

  /* 8 — wiring: CI runs this reader in the self-test chain, ATLAS lists it, ledger holds it. */
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 982. D982\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D982 heading line');

  return { offenders, notes, paths: PATHS };
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
  if (text === undefined || !text.includes(from)) {
    return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  }
  f.set(p, text.split(from).join(to));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['instruction erased',
      mutate(real, PIPE, '_INTENT_SCHEMA_BODY = (', '_INTENT_SCHEMA_BODY_X = ('), 'PIPE-SYS-DEF'],
    ['the instruction stops being composed into the system message',
      mutate(real, PIPE, 'INTENT_EXTRACT_SYSTEM = contract_for("intent_extract", _INTENT_SCHEMA_BODY)',
             'INTENT_EXTRACT_SYSTEM = _INTENT_SCHEMA_BODY_X'), 'PIPE-SYS-COMPOSE'],
    ['understand() delinks the instruction',
      mutate(real, PIPE, 'system=INTENT_EXTRACT_SYSTEM, json_hint="json_object"',
             'json_hint="json_object"'), 'PIPE-DELIVER'],
    ['JSON mode dropped',
      mutate(real, PIPE, 'json_hint="json_object"', 'json_hint=None'), 'PIPE-DELIVER'],
    ['§7.1 refusal cut',
      mutate(real, PIPE, 'raise ValueError("model returned an Intent outside the §7.1 schema")',
             'pass  # refusal erased'), 'REFUSAL'],
    ['floor fallback removed',
      mutate(real, PIPE, 'floor("model_unavailable")', 'floor("gone")'), 'FLOOR'],
    ['offline probe arm 1 deleted',
      mutate(real, TEST, 'def test_the_model_sees_instruction_and_json_mode_are_carried',
             'def test_the_model_sees_instruction_and_json_mode_erased'), 'TEST-CARRIED'],
    ['offline probe arm 2 deleted',
      mutate(real, TEST, 'def test_a_valid_live_answer_names_the_live_provider',
             'def test_the_live_answer_provider_arm_erased'), 'TEST-LIVE'],
    ['offline probe arm 3 deleted',
      mutate(real, TEST, 'def test_an_invalid_live_answer_is_refused_and_the_floor_answers_degraded',
             'def test_the_refusal_arm_erased'), 'TEST-REFUSE'],
    ['one schema atom laundered',
      mutate(real, PIPE, 'discover_merchant', 'discover_merchand'), 'PIPE-ATOM-discover_merchant'],
    ['ATLAS row erased',
      mutate(real, ATLAS, '`scripts/check_intent_extract_live_path.mjs`',
             '`scripts/check_intent_extract_live_path_erased.mjs`'), 'ATLAS-READER'],
    ['CI invocation cut',
      mutate(real, CI, CI_SELFTEST, 'node scripts/a_reader_that_does_not_exist.mjs --self-test'), 'CI-READER'],
    ['the ledger heading erased', (() => {
      const f = new Map(real);
      const t = (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n');
      f.set(STATUS, t);
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(40)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(40)} ${redOk ? 'red impl' : 'GREEN (defect!)'} offenders=${out.offenders.length} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  /* GREEN control — a legitimate comment edit must stay green. */
  {
    const p = new Map(real);
    p.set(PIPE, p.get(PIPE).replace('# --------------------------------------------------------------------------- intent',
                                   '# --------------------------------------------------------------- intent (comment tweak)'));
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN          ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!ok) allReddened = false;
  }
  console.log(`  self-test  all arms redden for cause + control green: ${allReddened} (${arms.length} arms)`);
  process.exit(allReddened ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE INTENT-LIVE-PATH WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D982 intent live path wired, ${result.notes.length} holds`);
process.exit(0);
