#!/usr/bin/env node
/**
 * NEXUS D979 — every arbitrary animation in @nexus/ui must stop under prefers-reduced-motion, and
 * reduced motion must never branch the RENDERED ELEMENT (only timing), or SSR strands opacity:0.
 *
 * tokens.css cancels animation under `prefers-reduced-motion: reduce` only for a named whitelist
 * (`.nexus-pulse`, `.nexus-shimmer`, `[data-reveal]`). Any Tailwind arbitrary animation
 * (`animate-[...]` / `[animation:...]`) lacking one of those names or a `motion-reduce:animate-none`
 * variant keeps running for a user who asked the OS to stop motion. Pre-D979 that was the loading
 * spinner on EVERY loading Button (infinite 900ms rotation), the ProgressBar (infinite shimmer),
 * Dialog/Sheet scrim + panel, Toast and Select dropdown — while Skeleton's dots, which carry
 * `.nexus-shimmer`/`.nexus-pulse`, correctly stopped. Same library, inconsistent honouring.
 *
 * The second axis is a hydration trap documented in `Motion.tsx` itself (Reveal's docblock: "the
 * markup must not branch on useReducedMotion()") and then violated two functions below: the server
 * pass (always `false`) emits `<motion.div initial="hidden">` with inline `opacity:0`; a reduced
 * client first frame emits a bare `<div>`; React keeps the server's inline `opacity:0` with nothing
 * to clear it, so reduced-motion users see permanently invisible content plus a hydration mismatch.
 *
 * THIS reader holds the structural claims a jsdom unit test cannot: it censuses ALL
 * `.tsx` files under `packages/ui/src` (recursively) for unguarded arbitrary animations, asserts `Motion.tsx` has no
 * `if (reduced) return <...>` element swap, and keeps the `theme.test.ts` / `reduced-motion.test.ts`
 * offline probes and CI/ATLAS/ledger wiring. The vitest probe `apps/web/src/lib/reduced-motion.test.ts`
 * carries the same two axes as runnable runtime-independent tests.
 *
 * SELF-TEST: --self-test plants corruptions in memory — drop a spinner guard, add a fresh
 * unguarded `animate-[...]` line, restore the `StaggerItem` markup branch, remove the `motion.div`
 * from StaggerGroup, weaken the docblock rule, erase a probe arm, cut CI/ATLAS/ledger wiring — and
 * requires EACH to redden for the RIGHT reason while the real plane holds. D954 no-op guard, D959
 * line-anchored heading, and a GREEN control (a legitimate comment edit) keep the judge honest.
 *
 * WHAT THIS DOES NOT SAY: that any browser animated anything, that a specific WCAG number holds, or
 * that the components render. The falsifier is "did the CSS/markup SPEAK the reduced-motion shape?"
 *
 * Usage:  node scripts/check_reduced_motion_coverage.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const UI = 'packages/ui/src';
const MOTION = `${UI}/motion/Motion.tsx`;
const ICON = `${UI}/icons/Icon.tsx`;
const TOKENS = `${UI}/styles/tokens.css`;
const THEME_TEST = 'apps/web/src/lib/theme.test.ts';
const RM_TEST = 'apps/web/src/lib/reduced-motion.test.ts';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_reduced_motion_coverage.mjs';
const PATHS = [MOTION, ICON, TOKENS, THEME_TEST, RM_TEST, CI, ATLAS, STATUS, SELF];

const ANIMATION_RE = /animate-\[|\[animation:/;
const REDUCED_GUARD_RE = /motion-reduce:animate-none|nexus-shimmer|nexus-pulse|data-reveal/;

/** Pure over a (path -> text) map; existence passed as a Set. Enumerated .tsx files passed in. */
export function judge(files, present, tsxPaths) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the reduced-motion plane is empty or unreadable — a census that found nothing cleared nothing' };
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
  const absentRe = (p, re, label, expect) => {
    const m = re.exec(t(p));
    if (m) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(m[0])})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };
  const hasHeading = (p, re, label, expect) => {
    if (!re.test(t(p))) offenders.push(`MISSING — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* R1 — census ALL design-system .tsx: no arbitrary animation without a reduced-motion stop. */
  const scanned = (tsxPaths && tsxPaths.length ? tsxPaths : [MOTION, ICON]).filter((p) => present.has(p));
  let animated = 0;
  const unguarded = [];
  for (const p of scanned) {
    t(p).split('\n').forEach((line, i) => {
      if (ANIMATION_RE.test(line)) {
        animated += 1;
        if (!REDUCED_GUARD_RE.test(line)) unguarded.push(`${p}:${i + 1}`);
      }
    });
  }
  if (animated === 0) offenders.push(`MISSING — no arbitrary animation found in ${scanned.length} .tsx file(s); a census that found nothing cleared nothing [CENSUS-NONEMPTY]`);
  else notes.push(`held arbitrary-animation census (${animated} animated line(s))`);
  if (unguarded.length) offenders.push(`MISSING — arbitrary animation(s) with no reduced-motion stop at ${unguarded.join(', ')} [NO-GUARD]`);
  else notes.push('held every arbitrary animation carries a reduced-motion stop');

  /* R2 — the loading spinner specifically (runs on every loading Button). */
  const spinnerLine = t(ICON).split('\n').find((l) => l.includes('animate-[nexus-spin_'));
  if (!spinnerLine || !spinnerLine.includes('motion-reduce:animate-none')) {
    offenders.push(`MISSING — ${ICON}: loading spinner must stop under reduced motion [SPINNER-GUARD]`);
  } else notes.push('held loading spinner stops under reduced motion');

  /* R3 — reduced motion must never branch the rendered element (hydration trap). */
  has(MOTION, 'markup must not branch on `useReducedMotion()`',
      'documented hydration rule survives', 'RULE-DOC');
  absentRe(MOTION, /if\s*\(\s*reduced\s*\)\s*return\s*</g,
      'no `if (reduced) return <...>` markup swap', 'NO-MARKUP-BRANCH');
  for (const name of ['StaggerGroup', 'StaggerItem']) {
    const start = t(MOTION).indexOf(`export function ${name}(`);
    if (start === -1) { offenders.push(`MISSING — ${MOTION}: ${name} gone [${name.toUpperCase()}]`); continue; }
    const rest = t(MOTION).slice(start + 1);
    const next = rest.indexOf('export function ');
    const body = next === -1 ? rest : rest.slice(0, next);
    if (!body.includes('<motion.div')) offenders.push(`MISSING — ${MOTION}: ${name} lost its motion.div [${name.toUpperCase()}]`);
    else notes.push(`held ${name} renders a motion.div`);
    if (/return\s*<div\b/.test(body)) offenders.push(`STALE — ${MOTION}: ${name} returns a bare <div> [${name.toUpperCase()}]`);
    else notes.push(`held ${name} has no bare-div branch`);
  }
  has(MOTION, 'const staggerItemVisible: Variants',
      'reduced timing-collapse variant exists', 'TIMING-COLLAPSE');
  has(MOTION, 'staggerChildren: reduced ? 0 : 0.055',
      'parent stagger collapses to 0 under reduced motion', 'STAGGER-COLLAPSE');

  /* R4 — the CSS whitelist and its D812 regression test still stand (do not regress the base). */
  has(TOKENS, '@media (prefers-reduced-motion: reduce)', 'CSS reduced-motion media block', 'CSS-BLOCK');
  has(TOKENS, '.nexus-shimmer,', 'whitelist still names bare .nexus-shimmer', 'CSS-WHITELIST');
  has(TOKENS, '[data-reveal]', 'whitelist still names [data-reveal]', 'CSS-REVEAL');
  has(THEME_TEST, 'cancels the skeleton shimmer itself under reduced motion',
      'D812 shimmer-bare-class regression test retained', 'D812-TEST');

  /* R5 — the offline vitest probe carries both axes. */
  has(RM_TEST, 'every arbitrary animation in @nexus/ui honours prefers-reduced-motion',
      'vitest animation-coverage axis', 'TEST-ANIM');
  has(RM_TEST, 'reduced motion never branches the rendered markup',
      'vitest hydration axis', 'TEST-HYDRATE');
  has(RM_TEST, 'if\\s*\\(\\s*reduced\\s*\\)\\s*return\\s*<',
      'vitest pins the markup-swap anti-pattern', 'TEST-SWAP-RE');
  has(RM_TEST, 'REDUCED_GUARD', 'vitest guard whitelist', 'TEST-GUARD-RE');

  /* R6 — CI reader chain, ATLAS reverse census, ledger heading. */
  has(CI, 'check_reduced_motion_coverage.mjs --self-test', 'cloud job self-test wiring', 'CI-READER');
  has(ATLAS, 'scripts/check_reduced_motion_coverage.mjs', 'ATLAS reader row', 'ATLAS-READER');
  has(ATLAS, 'reduced-motion.test.ts', 'ATLAS probe row', 'ATLAS-PROBE');
  hasHeading(STATUS, /^## 979\. D979(?=\s|$)/m, 'ledger heading for D979', 'LEDGER-HEADING');

  return { offenders, notes };
}

function livePlane() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    if (existsSync(join(ROOT, p))) {
      files.set(p, readFileSync(join(ROOT, p), 'utf8'));
      present.add(p);
    }
  }
  // Enumerate every .tsx under packages/ui/src for the R1 census.
  const tsxPaths = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.tsx')) tsxPaths.push(full.slice(ROOT.length + 1).replace(/\\/g, '/'));
    }
  };
  walk(join(ROOT, UI));
  return { files, present, tsxPaths };
}

const judgeLocal = (files, present, tsxPaths) => judge(files, present, tsxPaths);
const ran = livePlane();
const verdict = judgeLocal(ran.files, ran.present, ran.tsxPaths);

if (verdict.unchecked) {
  console.log('RESULT: NOT CHECKED — ' + verdict.unchecked);
  process.exit(2);
}
if (!SELF_TEST) {
  if (verdict.offenders.length) {
    for (const off of verdict.offenders) console.log('  offender: ' + off);
    console.log('RESULT: FAIL — ' + verdict.offenders.length + ' structural offender(s)');
    process.exit(1);
  }
  console.log('RESULT: PASS — D979 reduced-motion coverage plane wired, ' + verdict.notes.length + ' holds');
  process.exit(0);
}

const live = ran;
const t = (p) => live.files.get(p) ?? '';
const cases = [
  ['spinner reduced-motion guard removed', (p) => p.set(ICON, t(ICON).replace(
      'animate-[nexus-spin_900ms_linear_infinite] motion-reduce:animate-none',
      'animate-[nexus-spin_900ms_linear_infinite]')), 'SPINNER-GUARD'],
  ['a fresh unguarded arbitrary animation added', (p) => p.set(ICON, t(ICON) +
      '\n// D979 self-test plant\nconst unguarded = "animate-[nexus-pop_1s_ease-in-out_infinite]";\n'), 'NO-GUARD'],
  ['StaggerItem markup branch restored', (p) => p.set(MOTION, t(MOTION).replace(
      '  const reduced = useReducedMotion();\n  return (\n    <motion.div className={className} variants={reduced ? staggerItemVisible : staggerItem}>',
      '  const reduced = useReducedMotion();\n  if (reduced) return <div className={className}>{children}</div>;\n  return (\n    <motion.div className={className} variants={reduced ? staggerItemVisible : staggerItem}>')), 'NO-MARKUP-BRANCH'],
  ['StaggerGroup motion.div replaced by bare div', (p) => p.set(MOTION, t(MOTION).replace(
      '    <motion.div\n      className={className}\n      variants={{\n        hidden: {},',
      '    <div\n      className={className}\n      data-variants={{\n        hidden: {},')), 'STAGGERGROUP'],
  ['stagger timing-collapse removed', (p) => p.set(MOTION, t(MOTION).replace(
      'staggerChildren: reduced ? 0 : 0.055', 'staggerChildren: 0.055')), 'STAGGER-COLLAPSE'],
  ['reduced timing variant removed', (p) => p.set(MOTION, t(MOTION).replace(
      'const staggerItemVisible: Variants', 'const staggerItemVisibleX: Variants')), 'TIMING-COLLAPSE'],
  ['documented hydration rule erased', (p) => p.set(MOTION, t(MOTION).replace(
      'markup must not branch on `useReducedMotion()`', 'reduced motion is honoured')), 'RULE-DOC'],
  ['CSS bare .nexus-shimmer whitelist dropped', (p) => p.set(TOKENS, t(TOKENS).replace(
      '  .nexus-shimmer,\n', '')), 'CSS-WHITELIST'],
  ['CSS [data-reveal] whitelist dropped', (p) => p.set(TOKENS, t(TOKENS).replaceAll(
      '[data-reveal]', '[data-hidden]')), 'CSS-REVEAL'],
  ['D812 shimmer regression test erased', (p) => p.set(THEME_TEST, t(THEME_TEST).replace(
      'cancels the skeleton shimmer itself under reduced motion', 'a reduced-motion test')), 'D812-TEST'],
  ['vitest animation axis removed', (p) => p.set(RM_TEST, t(RM_TEST).replace(
      'every arbitrary animation in @nexus/ui honours prefers-reduced-motion', 'an animation axis')), 'TEST-ANIM'],
  ['vitest hydration axis removed', (p) => p.set(RM_TEST, t(RM_TEST).replace(
      'reduced motion never branches the rendered markup', 'a hydration axis')), 'TEST-HYDRATE'],
  ['vitest markup-swap regex weakened', (p) => p.set(RM_TEST, t(RM_TEST).replace(
      "if\\s*\\(\\s*reduced\\s*\\)\\s*return\\s*<", "if\\s*\\(\\s*reduced\\s*\\)\\s*return\\s*null")), 'TEST-SWAP-RE'],
  ['CI self-test wiring cut', (p) => p.set(CI, t(CI).replace(
      'check_reduced_motion_coverage.mjs --self-test', '')), 'CI-READER'],
  ['ATLAS reader row erased', (p) => p.set(ATLAS, t(ATLAS).replaceAll(
      'scripts/check_reduced_motion_coverage.mjs', '')), 'ATLAS-READER'],
  ['ATLAS probe row erased', (p) => p.set(ATLAS, t(ATLAS).replaceAll(
      'reduced-motion.test.ts', '')), 'ATLAS-PROBE'],
  ['the ledger claim removed', (p) => p.set(STATUS, t(STATUS).replace(
      /^## 979\. D979.*$/m, '## 979. D979-superseded')), 'LEDGER-HEADING'],
];

let allReddened = true;
for (const [label, plant, expectNeedle] of cases) {
  const p = new Map(live.files);
  if (typeof plant === 'function') plant(p);
  // D954 no-op guard: a corruption that changes no byte is a defect, not a pass.
  let changed = false;
  for (const [path, text] of p) if (text !== live.files.get(path)) { changed = true; break; }
  const out = judgeLocal(p, live.present, live.tsxPaths);
  const joined = out.offenders.join(' | ');
  const redOk = (out.offenders.length > 0 || out.unchecked);
  const rightReason = joined.includes(expectNeedle);
  const pass = changed && redOk && rightReason;
  console.log(`  self-test  ${label.padEnd(48)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expectNeedle}"${changed ? '' : ' NO-OP'}`);
  if (!pass) allReddened = false;
  if (redOk && !rightReason) for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o);
}
// GREEN control: a legitimate comment edit must NOT redden (guards against an overfit judge).
{
  const p = new Map(live.files);
  const realComment = ' * D979: the markup must NOT branch on `useReducedMotion()` (see Reveal\'s docblock above) — the';
  const p0 = t(MOTION);
  if (!p0.includes(realComment)) {
    console.log('  self-test  GREEN control source comment missing            DEFECT');
    allReddened = false;
  } else {
    p.set(MOTION, p0.replace(realComment, ' * D979: keep the same element on both render passes; collapse only the animation timing.'));
    const out = judgeLocal(p, live.present, live.tsxPaths);
    const greenOk = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN              ${greenOk ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!greenOk) allReddened = false;
  }
}
// Guard: the real plane still holds.
{
  const out = judgeLocal(live.files, live.present, live.tsxPaths);
  const realGreen = out.offenders.length === 0;
  console.log(`  self-test  legitimate plane stays GREEN                      green offenders=${out.offenders.length}`);
  if (!realGreen) { for (const o of out.offenders) console.log('      got: ' + o); allReddened = false; }
}
console.log(`  self-test  all arms redden for cause + guards green: ${allReddened} (${cases.length} arms)`);
process.exit(allReddened ? 0 : 1);
