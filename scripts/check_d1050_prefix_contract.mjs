#!/usr/bin/env node
/**
 * NEXUS D1050 — the shared prefix contract freezes the stable head of every model call.
 *
 * Why: the provider's prefix cache is a prefix cache — the minimum cacheable run is ~1024
 * tokens on this provider family, and the match is byte-wise from position zero. The app's
 * stable head was 17 tokens (summary, no system message at all) and ~440 tokens (the tuned
 * intent schema under the floor). Diverse traffic measured 0% cached, forever.
 * `apps/ai/nexus_ai/models/prefix_contract.py` freezes a ~9.2k-char shared head (v1) under a
 * hash that travels to the cost ledger; every task's instructions ride AFTER it as the tail.
 * `NEXUS_PREFIX_CONTRACT=off` restores the pre-D1050 prompts exactly (falsifier arm).
 *
 * This reader pins:
 *   (a) the frozen head clears the cacheable floor with margin, is a literal, and is what
 *       every task contract is prefixed with;
 *   (b) the intent schema stays verbatim as the tail (D1017's tuned body was never rewritten);
 *   (c) both summary call sites send the contract (compose_summary + streamed answer);
 *   (d) the contract can be switched off and restores the exact pre-D1050 prompts;
 *   (e) CI runs this reader's self-test; ATLAS lists this reader and the contract module;
 *       the ledger holds the D1050 heading; the live probe A/Bs the same diverse queries
 *       behind the frozen head.
 *
 * SELF-TEST: 13 corruption arms + 1 GREEN control — floor constant loosened, head trimmed
 * under the floor, contract_for signature drifted, intent wire severed, JSON-summary wire
 * severed, stream wire severed, the pre-D1050 (system-less) shape restored silently,
 * prefix/tail order flipped, the version pin erased, the sha derivation erased, the probe
 * A/B label erased, CI invocation erased, the ATLAS reader row erased, the ledger heading
 * erased. Each must redden.
 *
 * Usage:  node scripts/check_d1050_prefix_contract.mjs [--self-test]
 * Exit:   0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const CONTRACT = 'apps/ai/nexus_ai/models/prefix_contract.py';
const PIPELINE = 'apps/ai/nexus_ai/api/pipeline.py';
const STREAM = 'apps/ai/nexus_ai/api/routes_stream.py';
const PROBE = 'apps/ai/cache_probe.py';
const PIN = 'apps/ai/tests/test_prefix_contract_is_byte_stable.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1050_prefix_contract.mjs';
const PATHS = [CONTRACT, PIPELINE, STREAM, PROBE, PIN, CI, ATLAS, STATUS, SELF];

const HEADING_RE = /^## 1050\. D1050(?=\s|$)/m;
const CI_READER = 'node scripts/check_d1050_prefix_contract.mjs --self-test';
const PREAMBLE_CUT = '_SHARED_PREAMBLE = (';
const PREAMBLE_PREFIX = 'return f"{_SHARED_PREAMBLE}\\n\\n{tail}" if tail else _SHARED_PREAMBLE';
const CONTRACT_FN = 'def contract_for(task_class: str, task_section: str = "") -> str:';
const INTENT_WIRE = 'INTENT_EXTRACT_SYSTEM = contract_for("intent_extract", _INTENT_SCHEMA_BODY)';
const SUMMARY_WIRE = 'system=contract_for("summary")';
const SUMMARY_BARE = 'payload={"records": slim_records, "locale": locale}), meter=meter)';

function preambleChars(text) {
  // Sum of the string literals that make up the frozen head — enough to prove the run.
  const start = text.indexOf(PREAMBLE_CUT);
  if (start < 0) return -1;
  const rest = text.slice(start);
  const end = rest.indexOf('\n)\n');
  const block = end < 0 ? rest : rest.slice(0, end);
  let chars = 0;
  for (const m of block.matchAll(/"([^"\\]|\\.)*"/g)) {
    // Strip the quotes; the body is our literal, escapes are rare (\\n are real newlines in source).
    const inner = m[0].slice(1, -1);
    chars += inner.replace(/\\n/g, '\n').replace(/\\\\/g, '\\').length;
  }
  return chars;
}

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1050 plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the frozen head clears the cacheable floor with margin; the module is a literal only. */
  has(CONTRACT, 'MIN_CACHEABLE_CHARS = 3_800', 'the cacheable floor constant is 3_800 chars', 'FLOOR-CONST');
  const chars = preambleChars(t(CONTRACT));
  if (chars < 0) {
    offenders.push(`MISSING — ${CONTRACT}: the frozen preamble literal was not found${tag('FLOOR-CHARS')}`);
  } else if (chars < Math.floor(3_800 * 1.5)) {
    offenders.push(`SHORT — ${CONTRACT}: the frozen preamble is ${chars} chars, under the 1.5x floor of 5_700 — a head under the provider's minimum is never cached${tag('FLOOR-CHARS')}`);
  } else {
    notes.push(`held the frozen preamble is ${chars} chars`);
  }

  /* 2 — the contract is version-stamped, hash-travelled, and puts the shared head FIRST. */
  has(CONTRACT, 'PREFIX_CONTRACT_VERSION = "v1"', 'the contract is version-stamped', 'VERSION');
  has(CONTRACT, 'PREFIX_CONTRACT_SHA256 = hashlib.sha256', 'the contract reports its own sha', 'SHA');
  has(CONTRACT, PREAMBLE_PREFIX, 'the preamble is always the prefix, the task only ever the tail', 'PREFIX-ORDER');
  has(CONTRACT, CONTRACT_FN, 'contract_for exists', 'PREFIX-FN');
  has(CONTRACT, 'def enabled()', 'the contract can be switched off', 'ENABLED');

  /* 3 — the intent schema stays verbatim as the tail (the D1017-tuned body was never rewritten). */
  has(PIPELINE, INTENT_WIRE, 'intent extraction prepends the shared contract to its tuned schema', 'INTENT-WIRE');
  has(PIPELINE, '_INTENT_SCHEMA_BODY = (', 'the tuned intent schema survives verbatim', 'INTENT-BODY');

  /* 4 — both summary call sites send the contract. */
  has(PIPELINE, SUMMARY_WIRE, 'the JSON summary call sends the contract', 'SUMMARY-WIRE');
  has(STREAM, SUMMARY_WIRE, 'the streamed answer sends the same contract', 'STREAM-WIRE');
  if (t(PIPELINE).includes(SUMMARY_BARE)) {
    offenders.push(`STALE — ${PIPELINE}: the JSON summary no longer sends a system-less request (found forbidden ${JSON.stringify(SUMMARY_BARE)})${tag('SUMMARY-BARE')}`);
  } else {
    notes.push('held the JSON summary no longer sends a system-less request');
  }

  /* 5 — the offline pin checks the invariants that make the upstream cache reachable. */
  has(PIN, 'MIN_CACHEABLE_CHARS', 'the offline pin checks the floor', 'PIN-FLOOR');
  has(PIN, 'subprocess', 'the offline pin checks cross-process stability', 'PIN-PROC');
  has(PIN, 'test_every_task_contract_starts_with_the_one_shared_preamble', 'the offline pin checks the shared prefix', 'PIN-PREFIX');
  has(PIN, 'NEXUS_PREFIX_CONTRACT', 'the offline pin checks the off-arm', 'PIN-OFF');

  /* 6 — the probe A/Bs the same diverse queries behind the frozen head; CI runs this reader. */
  has(PROBE, 'contract bursts (SAME diverse queries, frozen head — D1050)', 'the live probe A/Bs the same diverse queries', 'PROBE-AB');
  has(CI, CI_READER, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, CONTRACT, 'ATLAS lists the contract module', 'ATLAS-CONTRACT');

  /* 7 — the ledger holds the D1050 heading. */
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — ${STATUS}: no \`## 1050. D1050\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1050 heading line');

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
    ['the cacheable floor constant was loosened',
      mutate(real, CONTRACT, 'MIN_CACHEABLE_CHARS = 3_800', 'MIN_CACHEABLE_CHARS = 500'), 'FLOOR-CONST'],
    ['the frozen preamble was trimmed under the floor', (() => {
      const f = new Map(real);
      const text = f.get(CONTRACT);
      const idx = text.indexOf('_SHARED_PREAMBLE = (');
      const end = text.indexOf('\n)\n', idx);
      f.set(CONTRACT, text.slice(0, idx) + '_SHARED_PREAMBLE = (\n    "tiny head."\n)\n' + text.slice(end + 3));
      return { files: f };
    })(), 'FLOOR-CHARS'],
    ['contract_for signature drifted',
      mutate(real, CONTRACT, CONTRACT_FN, 'def contract_for(task_class):'), 'PREFIX-FN'],
    ['the intent wire was severed',
      mutate(real, PIPELINE, INTENT_WIRE, 'INTENT_EXTRACT_SYSTEM = ('), 'INTENT-WIRE'],
    ['the JSON-summary wire was severed',
      mutate(real, PIPELINE, SUMMARY_WIRE, 'system_erased=True'), 'SUMMARY-WIRE'],
    ['the stream wire was severed',
      mutate(real, STREAM, SUMMARY_WIRE, 'system_erased=True'), 'STREAM-WIRE'],
    ['the pre-D1050 system-less shape was silently restored',
      mutate(real, PIPELINE, 'system=contract_for("summary")), meter=meter)',
             'payload={"records": slim_records, "locale": locale}), meter=meter)'), 'SUMMARY-WIRE'],
    ['the prefix/tail order was flipped',
      mutate(real, CONTRACT, PREAMBLE_PREFIX, 'return f"{tail}\\n\\n{_SHARED_PREAMBLE}" if tail else _SHARED_PREAMBLE'), 'PREFIX-ORDER'],
    ['the version pin was erased',
      mutate(real, CONTRACT, 'PREFIX_CONTRACT_VERSION = "v1"', 'PREFIX_CONTRACT_VERSION = ""'), 'VERSION'],
    ['the sha derivation was erased',
      mutate(real, CONTRACT, 'PREFIX_CONTRACT_SHA256 = hashlib.sha256', 'PREFIX_CONTRACT_SHA256 = None'), 'SHA'],
    ['the probe A/B label was erased',
      mutate(real, PROBE, 'contract bursts (SAME diverse queries, frozen head — D1050)', 'contract bursts (erased)'), 'PROBE-AB'],
    ['CI invocation cut',
      mutate(real, CI, CI_READER, 'node scripts/check_d1050_prefix_contract_erased.mjs --self-test'), 'CI-READER'],
    ['the ATLAS reader row was erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1050_prefix_contract_erased.mjs'), 'ATLAS-READER'],
    ['ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(44)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(44)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  {
    const p = new Map(real);
    p.set(CONTRACT, p.get(CONTRACT) + '\n# (a benign trailing comment edit — judged GREEN)\n');
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN            ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
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
  console.log(`\nFALSE D1050 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1050 prefix-contract wiring complete, ${result.notes.length} holds`);
process.exit(0);
