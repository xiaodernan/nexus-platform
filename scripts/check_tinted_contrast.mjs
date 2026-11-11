#!/usr/bin/env node
/**
 * NEXUS D956 — the tinted-ground contrast seam that `check_console_a11y.mjs` names as its blind spot.
 *
 * THE BLIND SPOT, IN ITS OWN WORDS. The a11y reader's contrast axis recomputes every PRINTED ratio
 * and measures every body-text ink against every NEUTRAL ground (surface/canvas/neutral-chip). Its
 * header says out loud what it does not do: a tinted ground (`accent-soft`, `positive-soft`,
 * `warning-soft`, `danger-soft`) "is outside it, because those pair with their own semantic ink and
 * the census would be guessing which token a component meant to put there." So a tinted badge whose
 * ink drifts under 4.5:1 would pass the whole console accessibility census.
 *
 * WHY THIS IS NOT GUESSING. The pairing is not inferred — it is DECLARED, in
 * `packages/ui/src/primitives/Badge.tsx`'s cva tone table, the product's authoritative tinted-badge
 * map, mirrored by `Floating.tsx`:
 *     accent   -> bg-accent-soft   text-accent-soft-ink
 *     positive -> bg-positive-soft text-positive
 *     warning  -> bg-warning-soft  text-warning
 *     danger   -> bg-danger-soft   text-danger
 * This reader READS that table (a missing tone pairing is an offender, so the map cannot silently
 * shrink), resolves both class tokens to their `--nexus-*` values in BOTH theme blocks of
 * `packages/ui/src/styles/tokens.css`, and recomputes the WCAG contrast with the SAME luminance /
 * ratio formula `check_console_a11y.mjs` uses. Every one of the 4 tones x 2 themes must clear 4.5:1.
 *
 * THE MEASURED PLANE (this file quotes no ratio that it cannot re-derive): the tightest pair is
 * light `positive` on `positive-soft` at 4.75:1 — a 0.25 margin over AA. Drop that ink toward the
 * soft ground by a shade and it goes under; that is exactly the drift this gate catches. The
 * falsifier arm swaps a tone's ink for `ink-disabled` (~2.3:1 on a soft) and requires RED.
 *
 * WHAT IT DOES NOT SAY. It is a SOURCE reader, not a browser: it measures the token hex values, not
 * the composited pixel of an alpha variant (`bg-accent-soft/40`) or of a className assembled across
 * elements. It judges the 4 opaque tinted-badge pairs from the Badge tone table and nothing else;
 * other soft-ground usages in the tree are enumerated but not asserted. It does not say a page ran,
 * that a screen reader agreed, or that a printed hex is the colour a GPU produced. Those remain the
 * live visual test's verdict. It does not touch the a11y reader's own axes; it closes the one the
 * a11y reader declared out of scope.
 *
 * SELF-TEST: `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in memory —
 * a tone's ink swapped for a low-contrast token, a soft ground recoloured toward its ink, a tone
 * pairing erased from the Badge table, a whole theme block removed, a soft token deleted, and the
 * CI / ATLAS / ledger wiring cut — and requires EACH to redden while the real plane holds. A no-op
 * snapshot guard (D954's invariant) fails any arm whose corruption did not change a single byte.
 *
 * Usage:  node scripts/check_tinted_contrast.mjs [--self-test] [--report]
 * Exit:   0 every tinted pair clears AA and the wiring holds · 1 an offender · 2 plane unreadable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const BADGE = 'packages/ui/src/primitives/Badge.tsx';
const TOKENS = 'packages/ui/src/styles/tokens.css';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const A11Y = 'scripts/check_console_a11y.mjs';
const SELF = 'scripts/check_tinted_contrast.mjs';
const PATHS = [BADGE, TOKENS, CI, ATLAS, STATUS, A11Y, SELF];

/** The 4 tinted tones whose ground+ink pairing the Badge tone table declares. */
const TONES = ['accent', 'positive', 'warning', 'danger'];
const AA = 4.5;

/* ---- pure helpers (the same WCAG math check_console_a11y.mjs uses) ---- */
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const blockAt = (text, selector) => {
  const i = text.indexOf(selector);
  if (i < 0) return null;
  const open = text.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') { depth -= 1; if (depth === 0) return text.slice(open + 1, j); }
  }
  return null;
};
const hexTokens = (block) => {
  const hex = {};
  for (const m of block.matchAll(/--nexus-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) hex[m[1]] = m[2];
  return hex;
};

/** Read the Badge cva tone table; return { tone -> { ground, ink } } for the 4 tinted tones. */
function badgePairs(badgeText) {
  const out = {};
  for (const tone of TONES) {
    // e.g. "accent: 'bg-accent-soft text-accent-soft-ink'," inside the tone variants block.
    const re = new RegExp(`\\b${tone}:\\s*'([^']*\\bbg-${tone}-soft\\b[^']*\\btext-[a-z0-9-]+\\b[^']*)'`);
    const m = re.exec(badgeText);
    if (!m) { out[tone] = null; continue; }
    const klass = m[1];
    const ground = /bg-([a-z0-9-]+)/.exec(klass)?.[1] ?? null;
    const ink = /text-([a-z0-9-]+)/.exec(klass)?.[1] ?? null;
    out[tone] = ground && ink ? { ground, ink } : null;
  }
  return out;
}

/** Pure over a path->text map + a Set of physically present paths. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the tinted-contrast plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };

  /* 1 — the pairing contract comes from the component source, not from this reader's guess. */
  const pairs = badgePairs(t(BADGE));
  for (const tone of TONES) {
    if (!pairs[tone]) {
      offenders.push(`CONTRACT — Badge.tsx declares no opaque bg-${tone}-soft + text-* pairing for tone '${tone}'`);
    } else {
      if (pairs[tone].ground !== `${tone}-soft`) {
        offenders.push(`CONTRACT — tone '${tone}' ground is bg-${pairs[tone].ground}, expected bg-${tone}-soft`);
      }
      notes.push(`held contract: ${tone} -> bg-${pairs[tone].ground} + text-${pairs[tone].ink}`);
    }
  }

  /* 2 — resolve both class tokens in both themes and recompute WCAG contrast. */
  const themes = [
    { name: 'light', block: blockAt(t(TOKENS), ':root') },
    { name: 'dark', block: blockAt(t(TOKENS), '.dark') },
  ];
  const measured = [];
  for (const theme of themes) {
    if (!theme.block) { offenders.push(`TOKENS — ${TOKENS} has no ${theme.name} block; its tinted pairs cannot be measured`); continue; }
    const hex = hexTokens(theme.block);
    for (const tone of TONES) {
      const pair = pairs[tone];
      if (!pair) continue; // already charged in (1)
      const inkKey = pair.ink.replace(/^nexus-/, '');
      const groundKey = pair.ground.replace(/^nexus-/, '');
      if (!hex[groundKey]) { offenders.push(`TOKENS — ${theme.name} block declares no --nexus-${groundKey} (the tinted ground would be unmeasurable)`); continue; }
      if (!hex[inkKey]) { offenders.push(`TOKENS — ${theme.name} block declares no --nexus-${inkKey} (the tinted ink would be unmeasurable)`); continue; }
      const r = contrast(hex[inkKey], hex[groundKey]);
      measured.push({ theme: theme.name, tone, ink: inkKey, ground: groundKey, r });
      if (r < AA) {
        offenders.push(`CONTRAST — ${theme.name} text-${pair.ink} on bg-${pair.ground} measures ${r.toFixed(2)}:1, under the ${AA}:1 AA the palette holds body text to`);
      } else {
        notes.push(`held ${theme.name} ${tone}: --nexus-${inkKey} on --nexus-${groundKey} = ${r.toFixed(2)}:1`);
      }
    }
  }
  if (measured.length < TONES.length * 2) {
    offenders.push(`COVERAGE — measured only ${measured.length} tinted pair(s); expected ${TONES.length * 2} (4 tones x 2 themes), so a theme or tone escaped judgement`);
  }

  /* 3 — the a11y reader must still declare this exact seam as its blind spot (the reason this exists). */
  has(A11Y, 'tinted ground', 'the a11y reader still names the tinted-ground blind spot this gate closes');

  /* 4 — wiring: CI command, ATLAS, ledger, this reader. */
  has(CI, 'node scripts/check_tinted_contrast.mjs', 'CI runs this reader');
  has(ATLAS, 'scripts/check_tinted_contrast.mjs', 'ATLAS lists this reader');
  has(STATUS, '## 956. D956', 'the ledger holds §956');
  exists(SELF, 'this reader ships on disk');

  return { offenders, notes, unchecked: null, paths: PATHS, measured };
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

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must hold before self-test (${base.offenders[0] ?? base.unchecked})`);
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
    ['an ink swapped for a low-contrast token', mutate(BADGE, "positive: 'bg-positive-soft text-positive'", "positive: 'bg-positive-soft text-ink-disabled'")],
    // Measured: ink #8a5a00 on #fbe7c0 is still 4.88:1 — a corruption that stays over AA is a
    // GREEN arm, not a gate defect. #e8c878 drops to 3.66:1, a real sub-AA drift (D950/D954 lesson:
    // when an arm stays green, check the mutation's strength before blaming the reader's needle).
    ['a soft ground recoloured toward its ink', mutate(TOKENS, '--nexus-warning-soft: #fdf3e2;', '--nexus-warning-soft: #e8c878;')],
    ['a tone pairing erased from the Badge table', (() => {
      // EOL-agnostic (D954): the Badge cva table is LF here, LF/CRLF on other planes.
      const f = new Map(real);
      const next = f.get(BADGE).replace(/^\s*danger: 'bg-danger-soft text-danger',\s*\r?$/m, '');
      if (next === f.get(BADGE)) return { skipped: 'danger tone pairing regex matched nothing' };
      f.set(BADGE, next);
      return { files: f };
    })()],
    ['a dark soft-ink deleted', mutate(TOKENS, '--nexus-accent-soft-ink: #c3cbff;', '--nexus-accent-soft-ink-unused: #c3cbff;')],
    ['a whole theme block removed', mutate(TOKENS, '.dark {', '.dArk {')],
    ['the a11y blind-spot note erased', mutate(A11Y, 'tinted ground', 'tinted  ground')],
    ['CI entry deleted', (() => { const f = new Map(real); f.set(CI, f.get(CI).replace('node scripts/check_tinted_contrast.mjs && ', '').replace('node scripts/check_tinted_contrast.mjs', '')); return { files: f }; })()],
    ['ATLAS row erased', (() => { const f = new Map(real); f.set(ATLAS, f.get(ATLAS).replace(/^\| `scripts\/check_tinted_contrast\.mjs` \| .*$/m, '')); return { files: f }; })()],
    ['ledger §956 removed', mutate(STATUS, '## 956. D956', '## 956. (removed)')],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(44)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    if (snapshot(arm.files) === snapshot(real)) { console.log(`  self-test  ${label.padEnd(44)} NO-OP (defect!)`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(44)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught} (${arms.length} arms)`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const m of result.measured) console.log(`  ${m.theme.padEnd(5)} ${m.tone.padEnd(9)} --nexus-${m.ink} on --nexus-${m.ground} = ${m.r.toFixed(2)}:1`);
for (const n of result.notes) if (!n.startsWith('held ' + (result.measured[0]?.theme ?? '~~~'))) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE TINTED-CONTRAST WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(REPORT ? 0 : 1);
}
console.log(`RESULT: PASS — D956 tinted-ground contrast seam wired, ${result.measured.length} pair(s) clear AA, ${result.notes.length} holds`);
process.exit(0);
