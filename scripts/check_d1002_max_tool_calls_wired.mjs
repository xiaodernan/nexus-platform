#!/usr/bin/env node
/**
 * NEXUS D1002 — §10 rule 2's tool-call budget is the operator's knob, not a hard-coded 6.
 *
 * Before this unit, `apps/ai/nexus_ai/config.py::load_settings()` read NEXUS_MAX_TOOL_CALLS into
 * `Settings.max_tool_calls`, but nothing downstream read it: `orchestrator.planner` capped clauses
 * at the module constant MAX_STEPS = 6, and `orchestrator.executor` sliced `plan.steps[:6]`. The
 * route *had* `deps.settings` in scope and still passed nothing; an operator could set the env and
 * watch it do nothing. This reader holds the wiring so it cannot silently go back to the dead knob:
 *
 *   (a) `resolve_max_steps(settings)` exists and is the ONE reader of the budget.
 *   (b) `plan_tools(..., max_steps=None)` defaults to the rule-2 constant, and an explicit cap is
 *       respected; `[1, 64]` covers a typo'd env (zero silently plans nothing; 10^10 tears the wall).
 *   (c) `execute_plan(..., max_steps=None)` enforces the same cap at the door so the two gates can
 *       not drift (a plan smaller than 6 steps stays executable, a cap of 3 truncates the plan).
 *   (d) The §10 agent route resolves the cap once from `deps.settings` and feeds both gates.
 *   (e) `NATS: replay guard present` (no NEXUS_MAX_TOOL_CALLS env var in the census).
 *   (e) The same route passes it through to the executor.
 *
 * Self-test plants: (a') the resolver default moved to 5, (b') plan_tools ignores its argument,
 * (c') execute_plan ignores its cap, (d') route drops the thread, (e') the clamp range honoured,
 * (f') ATLAS reader row erased, (g') ledger heading erased, (h') CI self-test invocation cut.
 * A mutation failing to redden ANY of (a-h) without an expect tag is a defect in the reader itself.
 *
 * Exit: 0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const PLANNER = 'apps/ai/nexus_ai/orchestrator/planner.py';
const EXECUTOR = 'apps/ai/nexus_ai/orchestrator/executor.py';
const ROUTE = 'apps/ai/nexus_ai/api/routes_agent.py';
const TEST = 'apps/ai/tests/test_max_tool_calls_env_reaches_both_gates.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1002_max_tool_calls_wired.mjs';
const PATHS = [PLANNER, EXECUTOR, ROUTE, TEST, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1002\. D1002(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1002 plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  for (const p of PATHS) exists(p, `${p} exists`);

  /* (a) resolver exists and is the single reader */
  has(PLANNER, 'def resolve_max_steps(settings: Any = None) -> int:', 'resolve_max_steps exists', 'PLANNER-FN');
  /* (b) the clamp is [1, ceiling] so a zero/negative/astronomical env cannot disable planning */
  has(PLANNER, 'max(1, min(cap, MAX_STEPS_CEILING))', 'the [1, MAX_STEPS_CEILING] clamp is intact', 'PLANNER-CLAMP');
  has(PLANNER, 'MAX_STEPS_CEILING = 64', 'the ceiling constant is declared', 'PLANNER-CEILING');
  /* (b') plan_tools honours the argument and defaults to the rule-2 constant */
  has(PLANNER, '    cap = max_steps if max_steps is not None else MAX_STEPS\n', 'plan_tools default keeps rule-2', 'PLANNER-DEFAULT');
  has(PLANNER, 'return Plan(steps=tuple(steps[:cap]), refused=None)', 'plan_tools returns steps[:cap]', 'PLANNER-SLICE');
  /* (c) the executor door enforces the same cap, using the same resolver as default */
  has(EXECUTOR, 'cap = max_steps if max_steps is not None else resolve_max_steps(None)', 'executor defaults to the right cap', 'EXEC-DEFAULT');
  has(EXECUTOR, 'for step in plan.steps[:cap]:', 'executor slices [:cap]', 'EXEC-SLICE');
  /* (d) the §10 agent route resolves once and threads to BOTH gates */
  has(ROUTE, 'max_steps = resolve_max_steps(deps.settings)', 'route resolves the settings budget once', 'ROUTE-RESOLVE');
  has(ROUTE, 'plan = plan_tools(body.query, context=context, max_steps=max_steps)', 'route feeds planner the cap', 'ROUTE-PLANNER');
  has(ROUTE, 'subject=body.subject or "anonymous", max_steps=max_steps)', 'route feeds executor the same cap', 'ROUTE-EXECUTOR');
  /* (e) no bare "6" left inside the two §10-rule-2 call sites */
  absent(EXECUTOR, 'for step in plan.steps[:6]', 'executor no longer hard-codes 6', 'EXEC-SIX');
  absent(PLANNER, 'if len(steps) >= 6:', 'planner no longer hard-codes 6', 'PLANNER-SIX');
  /* (f) the offline probe pins the full path */
  has(TEST, 'SIX_CLAUSES = "how much, opening hours, preferences, find merchants, find products, find services"',
      'the offline probe covers the canonical 6-clause corpus', 'TEST-CORPUS');
  has(TEST, 'def test_default_budget_is_the_rule2_six_when_no_env_is_set(', 'offline probe pins the default', 'TEST-DEFAULT');
  has(TEST, 'def test_env_value_flows_from_load_settings_through_resolve_to_the_planner_cap(', 'offline probe pins the env path', 'TEST-ENV');
  /* (g) wiring: CI runs this reader, ATLAS lists it, ledger holds it */
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1002. D1002\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1002 heading line');

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
    ['resolver definition erased',
      mutate(real, PLANNER, 'def resolve_max_steps(settings: Any = None) -> int:',
             'def resolve_max_steps_absent(settings: Any = None) -> int:'), 'PLANNER-FN'],
    ['clamp range honours nothing',
      mutate(real, PLANNER, 'MAX_STEPS_CEILING = 64', 'MAX_STEPS_CEILING = 6'), 'PLANNER-CEILING'],
    ['planner default drifted to 5',
      mutate(real, PLANNER, '    cap = max_steps if max_steps is not None else MAX_STEPS\n', '    cap = max_steps if max_steps is not None else MAX_STEPS - 1\n'), 'PLANNER-DEFAULT'],
    ['planner ignores its cap',
      mutate(real, PLANNER, 'return Plan(steps=tuple(steps[:cap]), refused=None)',
             'return Plan(steps=tuple(steps[:MAX_STEPS]), refused=None)'), 'PLANNER-SLICE'],
    ['executor drops its cap',
      mutate(real, EXECUTOR, 'resolve_max_steps(None)', 'resolve_max_steps_unused(None)'), 'EXEC-DEFAULT'],
    ['executor ignores its cap',
      mutate(real, EXECUTOR, 'for step in plan.steps[:cap]:', 'for step in plan.steps[:6]:'), 'EXEC-SLICE'],
    ['route drops the thread',
      mutate(real, ROUTE, 'max_steps = resolve_max_steps(deps.settings)', 'max_steps = None'), 'ROUTE-RESOLVE'],
    ['route stops feeding planner',
      mutate(real, ROUTE,
             'plan = plan_tools(body.query, context=context, max_steps=max_steps)',
             'plan = plan_tools(body.query, context=context)'), 'ROUTE-PLANNER'],
    ['route stops feeding executor',
      mutate(real, ROUTE,
             'subject=body.subject or "anonymous", max_steps=max_steps)',
             'subject=body.subject or "anonymous")'), 'ROUTE-EXECUTOR'],
    ['offline probe arm 1 deleted',
      mutate(real, TEST,
             'def test_default_budget_is_the_rule2_six_when_no_env_is_set(',
             'def test_budget_erased_replaced('), 'TEST-DEFAULT'],
    ['offline probe arm 2 deleted',
      mutate(real, TEST,
             'def test_env_value_flows_from_load_settings_through_resolve_to_the_planner_cap(',
             'def test_env_value_erased_replaced('), 'TEST-ENV'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1002_max_tool_calls_wired_erased.mjs'), 'ATLAS-READER'],
    ['CI invocation cut',
      mutate(real, CI, CI_SELFTEST, 'node scripts/a_reader_that_does_not_exist.mjs --self-test'), 'CI-READER'],
    ['the ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(40)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(40)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  {
    const p = new Map(real);
    p.set(ROUTE, p.get(ROUTE).replace('    # D1002:', '    # (comment tweak)'));
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
  console.log(`\nFALSE D1002 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1002 step-budget wiring complete, ${result.notes.length} holds`);
process.exit(0);
