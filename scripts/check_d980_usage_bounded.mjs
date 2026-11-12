#!/usr/bin/env node
/**
 * NEXUS D980 — a live provider's `usage` is untrusted external input; a physically impossible
 * token count must never reach the §9 `llm_calls.cost_usd` ledger unbounded.
 *
 * THE HOLE (measured against a REAL OpenAI-compatible proxy, 2026-11, model `gpt-6-sol`):
 * `models/openai.py::complete` and `models/anthropic.py::complete` trusted the provider's `usage`
 * verbatim and fed it straight into `cost_usd()`. The live proxy returned `completion_tokens=533`
 * for a request with `max_tokens=32` (16x the request's own ceiling — physically impossible), and
 * its counts varied non-deterministically between calls. Left unbounded, ONE implausible response
 * inflates the cost/budget ledger by an arbitrary factor — the D972/D974 "unbounded trust in
 * external input" class, on the billing plane.
 *
 * THE FIX: `models/base.py::sanitize_usage(raw_pt, raw_ct, text, max_tokens)` bounds usage before
 * it reaches `cost_usd` / `LLMResponse`: completion clamped to `[0, max_tokens]`, prompt to `>= 0`,
 * and a negative / non-numeric / over-cap / missing-but-text value falls back to a local
 * `estimate_tokens` bound with `usage_flagged=True`. Both live adapters call it (symmetric).
 * Honest in-range values pass through byte-for-byte. The rendered text, parsed `data`,
 * `finish_reason` and the §105 degrade ladder are untouched.
 *
 * WHAT THIS reader HOLDS (a jsdom/pytest-only door cannot): the product shape — that BOTH adapters
 * route usage through the bound and the bare `int(usage...)` meters are gone; that the cost ledger
 * plumbing (`cost_usd`, `estimate_tokens`, `LLMResponse`) still stands; that the offline probe
 * `apps/ai/tests/test_d980_usage_is_bounded.py` ships its positive, falsifier, symmetry and
 * zero-regression arms; and that CI / ATLAS / ledger wiring is complete.
 *
 * SELF-TEST: --self-test plants corruptions in memory — restore the unbounded meter on either
 * adapter, drop the base helper, remove the `usage_flagged` field, weaken the clamp, erase a probe
 * arm, cut CI/ATLAS/ledger wiring — and requires EACH to redden for the RIGHT expect tag while the
 * real plane holds. D954 no-op guard, D959 line-anchored `## 980.` heading, and a GREEN control
 * (a legitimate docstring edit) keep the judge honest.
 *
 * WHAT THIS DOES NOT SAY: that any provider actually billed anything, that PRICE_PER_1K is an
 * invoice, that prompt_tokens is bounded (a prompt has no natural per-request ceiling), or that
 * any live request ran. The falsifier is "did the product SPEAK the bounded-usage shape?" — the
 * live evidence itself is a separate, opt-in, key-env-only smoke that is NOT a CI test.
 *
 * Usage:  node scripts/check_d980_usage_bounded.mjs [--self-test] [--report] [--ci=<path>]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const CI_OVERRIDE = argv.find((a) => a.startsWith('--ci='))?.slice('--ci='.length);

const BASE = 'apps/ai/nexus_ai/models/base.py';
const OPENAI = 'apps/ai/nexus_ai/models/openai.py';
const ANTH = 'apps/ai/nexus_ai/models/anthropic.py';
const PROBE = 'apps/ai/tests/test_d980_usage_is_bounded.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d980_usage_bounded.mjs';
const PATHS = [BASE, OPENAI, ANTH, PROBE, CI, ATLAS, STATUS, SELF];

/* Exact source needles. The two OLD meters are what a corruption restores. */
const OLD_OAI_METER = 'pt = int(usage.get("prompt_tokens") or 0)';
const OLD_ANTH_METER = 'pt = int(usage.get("input_tokens") or 0)';
const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 980\. D980(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the usage-bound plane is empty or unreadable — a census that found nothing cleared nothing' };
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
  const countAtLeast = (p, needle, min, label, expect) => {
    const got = t(p).split(needle).length - 1;
    if (got < min) offenders.push(`MISSING — ${p}: ${label} (found ${got}, need >= ${min})${tag(expect)}`);
    else notes.push(`held ${label} (${got} occurrences)`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the base helper exists and is the single source of the bound. */
  has(BASE, 'def sanitize_usage(raw_pt: Any, raw_ct: Any, text: str, max_tokens: int) -> tuple[int, int, bool]:',
      'the sanitize_usage helper exists', 'HELPER');
  has(BASE, 'cap = max(1, int(max_tokens))', 'the completion cap is derived from the request ceiling', 'CAP');
  has(BASE, 'over_cap = ct > cap', 'the physical-impossibility check is present', 'OVER-CAP');
  has(BASE, 'return estimate_tokens(text), min(estimate_tokens(text), cap), True',
      'implausible usage falls back to a bounded local estimate', 'FALLBACK');
  has(BASE, 'return pt, ct, False', 'honest in-range usage passes through unflagged', 'PASSTHROUGH');
  has(BASE, 'if pt < 0 or ct < 0:', 'negative usage is detected', 'NEGATIVE');
  has(BASE, 'missing = (not raw_pt and not raw_ct) and bool(text)', 'missing-usage-with-text is detected', 'MISSING');
  has(BASE, 'usage_flagged: bool = False', 'the LLMResponse carries a usage_flagged field', 'FLAG-FIELD');

  /* 2 — BOTH live adapters route usage through the bound (a single adapter is not enough). */
  has(OPENAI, '    sanitize_usage,', 'openai.py imports sanitize_usage', 'OAI-IMPORT');
  has(ANTH, '    sanitize_usage,', 'anthropic.py imports sanitize_usage', 'ANTH-IMPORT');
  countAtLeast(OPENAI, 'sanitize_usage(', 1, 'openai.py calls sanitize_usage', 'OAI-BOUND');
  countAtLeast(ANTH, 'sanitize_usage(', 1, 'anthropic.py calls sanitize_usage', 'ANTH-BOUND');
  has(OPENAI, 'pt, ct, flagged = sanitize_usage(', 'openai parses usage through the bound', 'OAI-PARSE');
  has(ANTH, 'pt, ct, flagged = sanitize_usage(', 'anthropic parses usage through the bound', 'ANTH-PARSE');
  has(OPENAI, 'usage_flagged=flagged,', 'openai stamps the flag onto its response', 'OAI-FLAG');
  has(ANTH, 'usage_flagged=flagged,', 'anthropic stamps the flag onto its response', 'ANTH-FLAG');
  absent(OPENAI, OLD_OAI_METER, 'the old unbounded openai meter is gone', 'NO-OLD-OAI');
  absent(ANTH, OLD_ANTH_METER, 'the old unbounded anthropic meter is gone', 'NO-OLD-ANTH');

  /* 3 — the cost-pipeline and degrade contracts survive (explicitly NOT a rewrite). */
  has(OPENAI, 'cost_usd=cost_usd(meta["tier"], pt, ct)', 'openai cost still flows from the bounded meters', 'OAI-COST');
  has(ANTH, 'cost_usd=cost_usd(meta["tier"], pt, ct)', 'anthropic cost still flows from the bounded meters', 'ANTH-COST');
  has(BASE, 'maybe_json', 'maybe_json is still imported for structured parsing', 'JSON');
  has(OPENAI, 'resp.raise_for_status()', 'openai status enforcement survives', 'OAI-RAISE');
  has(ANTH, 'resp.raise_for_status()', 'anthropic status enforcement survives', 'ANTH-RAISE');
  has(OPENAI, 'degraded=False, finish_reason=choice.get("finish_reason") or "stop"',
      'openai honest-response shape survives', 'OAI-HONEST');
  has(ANTH, 'degraded=False, finish_reason=raw.get("stop_reason") or "stop"',
      'anthropic honest-response shape survives', 'ANTH-HONEST');
  has(OPENAI, 'raise LLMError(f"openai HTTP {code}:', 'openai error mapping (§105 ladder input) survives', 'OAI-ERR');
  has(ANTH, 'raise LLMError(f"anthropic HTTP {code}:', 'anthropic error mapping survives', 'ANTH-ERR');

  /* 4 — the offline falsifiable probe ships its arms. */
  has(PROBE, 'def test_honest_in_range_usage_passes_through_unflagged(self):', 'zero-regression arm exists', 'P-HONEST');
  has(PROBE, 'def test_live_proxy_over_cap_completion_is_bounded_and_flagged(self):', 'live-shape bound arm exists', 'P-OVERCAP');
  has(PROBE, 'def test_negative_and_nonnumeric_usage_are_bounded(self):', 'malformed-usage arm exists', 'P-MALFORMED');
  has(PROBE, 'def test_missing_usage_with_text_falls_back_to_local_estimate(self):', 'missing-usage arm exists', 'P-MISSING');
  has(PROBE, 'def test_openai_bills_a_bounded_cost_on_absurd_usage(self):', 'openai ledger-bound arm exists', 'P-OAI-COST');
  has(PROBE, 'def test_anthropic_is_symmetric(self):', 'provider symmetry arm exists', 'P-SYMMETRY');
  has(PROBE, 'def test_honest_wire_usage_is_unchanged(self):', 'honest-wire zero-regression arm exists', 'P-WIRE');
  has(PROBE, 'def test_falsifier_unbounded_meter_would_inflate_cost(self):', 'one-variable falsifier arm exists', 'P-FALSIFIER');
  has(PROBE, 'assert 0 <= ct <= 32', 'the bound arm asserts the physical ceiling', 'P-ASSERT');
  has(PROBE, 'assert unbounded_cost > r.cost_usd * 5', 'the falsifier asserts unbounded cost is materially larger', 'P-FALSIFIER-ASSERT');

  /* 5 — wiring: CI runs this reader AND the ai-job pytest suite; docs + ledger line-anchored. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ciPath, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 980. D980\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D980 heading line');

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
  f.set(p, text.replace(from, to));
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
    ['sanitize_usage helper erased', mutate(real, BASE,
        'def sanitize_usage(raw_pt: Any, raw_ct: Any, text: str, max_tokens: int) -> tuple[int, int, bool]:',
        'def sanitize_usage_disabled(raw_pt, raw_ct, text, max_tokens):'), 'HELPER'],
    ['completion cap derivation cut', mutate(real, BASE, 'cap = max(1, int(max_tokens))', 'cap = 10 ** 12'), 'CAP'],
    ['over-cap detection cut', mutate(real, BASE, 'over_cap = ct > cap', 'over_cap = False'), 'OVER-CAP'],
    ['bounded fallback removed', mutate(real, BASE,
        'return estimate_tokens(text), min(estimate_tokens(text), cap), True',
        'return pt, ct, True  # no bound'), 'FALLBACK'],
    ['honest passthrough removed', mutate(real, BASE, 'return pt, ct, False', 'return 0, 0, False'), 'PASSTHROUGH'],
    ['negative detection cut', mutate(real, BASE, 'if pt < 0 or ct < 0:', 'if False:'), 'NEGATIVE'],
    ['missing-usage detection cut', mutate(real, BASE,
        'missing = (not raw_pt and not raw_ct) and bool(text)', 'missing = False'), 'MISSING'],
    ['usage_flagged field erased', mutate(real, BASE, 'usage_flagged: bool = False', 'usage_flagged_x: bool = False'), 'FLAG-FIELD'],
    ['openai unbounded meter restored', mutate(real, OPENAI,
        'pt, ct, flagged = sanitize_usage(',
        OLD_OAI_METER + '  # restored'), 'NO-OLD-OAI'],
    ['anthropic unbounded meter restored', mutate(real, ANTH,
        'pt, ct, flagged = sanitize_usage(',
        OLD_ANTH_METER + '  # restored'), 'NO-OLD-ANTH'],
    ['openai helper import dropped', mutate(real, OPENAI, '    sanitize_usage,', '    # sanitize_usage removed'), 'OAI-IMPORT'],
    ['anthropic helper import dropped', mutate(real, ANTH, '    sanitize_usage,', '    # sanitize_usage removed'), 'ANTH-IMPORT'],
    ['openai flag stamp cut', mutate(real, OPENAI, 'usage_flagged=flagged,', 'usage_flagged=False,'), 'OAI-FLAG'],
    ['anthropic flag stamp cut', mutate(real, ANTH, 'usage_flagged=flagged,', 'usage_flagged=False,'), 'ANTH-FLAG'],
    ['openai helper call removed', mutate(real, OPENAI, 'pt, ct, flagged = sanitize_usage(', 'pt, ct, flagged = (0, 0, False)  #'), 'OAI-PARSE'],
    ['anthropic helper call removed', mutate(real, ANTH, 'pt, ct, flagged = sanitize_usage(', 'pt, ct, flagged = (0, 0, False)  #'), 'ANTH-PARSE'],
    ['openai cost plumbing cut', mutate(real, OPENAI,
        'cost_usd=cost_usd(meta["tier"], pt, ct)', 'cost_usd=0.0  # cost decoupled'), 'OAI-COST'],
    ['anthropic cost plumbing cut', mutate(real, ANTH,
        'cost_usd=cost_usd(meta["tier"], pt, ct)', 'cost_usd=0.0  # cost decoupled'), 'ANTH-COST'],
    ['openai error mapping cut', mutate(real, OPENAI,
        'raise LLMError(f"openai HTTP {code}:', 'raise ValueError(f"openai HTTP {code}:'), 'OAI-ERR'],
    ['probe honest arm erased', mutate(real, PROBE,
        'def test_honest_in_range_usage_passes_through_unflagged(self):', 'def _honest_removed(self):'), 'P-HONEST'],
    ['probe over-cap arm erased', mutate(real, PROBE,
        'def test_live_proxy_over_cap_completion_is_bounded_and_flagged(self):', 'def _overcap_removed(self):'), 'P-OVERCAP'],
    ['probe symmetry arm erased', mutate(real, PROBE,
        'def test_anthropic_is_symmetric(self):', 'def _symmetry_removed(self):'), 'P-SYMMETRY'],
    ['probe falsifier arm erased', mutate(real, PROBE,
        'def test_falsifier_unbounded_meter_would_inflate_cost(self):', 'def _falsifier_removed(self):'), 'P-FALSIFIER'],
    ['probe bound assertion weakened', mutate(real, PROBE, 'assert 0 <= ct <= 32', 'assert ct >= 0'), 'P-ASSERT'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, ciPath, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ATLAS probe row erased', mutate(real, ATLAS, PROBE, 'apps/ai/tests/_removed.py'), 'ATLAS-PROBE'],
    ['ledger D980 heading removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [labelText, arm, tagName] of arms) {
    const expect = arm.expect ?? tagName;
    if (arm.skipped) {
      console.log(`  self-test  ${labelText.padEnd(48)} SKIP (${arm.skipped})`);
      allCaught = false; continue;
    }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) {  // D954: a plant that changes no byte is a defect, not a pass.
      console.log(`  self-test  ${labelText.padEnd(48)} NO-OP (defect!)`);
      allCaught = false; continue;
    }
    const out = judge(arm.files, arm.present ?? present, ciPath);
    const red = out.offenders.length > 0 || out.unchecked;
    const rightReason = out.offenders.some((o) => o.includes(expect));
    const pass = red && rightReason;
    console.log(`  self-test  ${labelText.padEnd(48)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expect}"`);
    if (!pass) {
      allCaught = false;
      for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o);
    }
  }
  // GREEN control: a legitimate docstring rewording must NOT redden (guards an overfit judge).
  {
    const f = new Map(real);
    f.set(BASE, (f.get(BASE) ?? '').replace(
        'a prompt has no natural per-request ceiling to clamp against',
        'prompts have no intrinsic per-request upper bound to clamp against'));
    const out = judge(f, present, ciPath);
    const controlGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate docstring rewording stays GREEN'.padEnd(48)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!controlGreen) allCaught = false;
  }
  // Real plane still holds.
  {
    const out = judge(real, present, ciPath);
    const realGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate plane stays GREEN'.padEnd(48)} green offenders=${out.offenders.length}`);
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
  console.log(`FALSE USAGE-BOUNDED WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D980 live-provider usage bounded, ${result.notes.length} holds`);
