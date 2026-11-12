import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D979 — the reduced-motion promise is a WHITELIST, and the whitelist had holes.
 *
 * `packages/ui/src/styles/tokens.css` cancels animation under `prefers-reduced-motion: reduce`
 * only for a named set (`.nexus-pulse`, `.nexus-shimmer`, `[data-reveal]`). Any Tailwind arbitrary
 * animation (`animate-[...]` / `[animation:...]`) that does NOT also carry one of those class names
 * or a `motion-reduce:animate-none` variant keeps running for a user who explicitly asked the OS to
 * stop motion. Before D979 that included the loading-spinner on every `loading` Button (an infinite
 * 900ms rotation), the ProgressBar (infinite shimmer), Dialog/Sheet scrim + panel, Toast and Select
 * dropdown — while Skeleton and the LoadingStage dots, which DO carry `.nexus-shimmer`/`.nexus-pulse`,
 * correctly stopped. Same library, one group honoured the preference and one did not.
 *
 * The second axis is a hydration trap the design system already documented in `Motion.tsx:63-68`
 * and then violated in the same file: branching the RENDERED ELEMENT on `useReducedMotion()` makes
 * the server pass (always `false`) emit `<motion.div initial="hidden">` with inline `opacity:0`,
 * while a reduced client first frame emits a bare `<div>`; React keeps the server's `opacity:0` and
 * nothing clears it, so the content is permanently invisible to reduced-motion users (plus a
 * hydration mismatch). `Reveal` does it right by collapsing timing only; `StaggerGroup`/`StaggerItem`
 * did it wrong by branching markup.
 *
 * This reads the components as TEXT — importing them would let a broken component satisfy its own
 * assertion, and jsdom has no real CSS cascade anyway. It is the runtime-independent half of the
 * D979 door; `scripts/check_reduced_motion_coverage.mjs` carries the same claims into CI's reader
 * chain with a self-test.
 */

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (existsSync(join(dir, 'packages', 'ui', 'src', 'styles', 'tokens.css'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const uiSrc = join(repoRoot, 'packages', 'ui', 'src');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** A source line declaring an arbitrary animation, with its file-relative path and 1-based line. */
function arbitraryAnimationLines(): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  for (const full of tsxFiles(uiSrc)) {
    const file = full.slice(repoRoot.length + 1).replace(/\\/g, '/');
    readFileSync(full, 'utf8').split('\n').forEach((text, index) => {
      if (/animate-\[|\[animation:/.test(text)) found.push({ file, line: index + 1, text });
    });
  }
  return found;
}

// A named reduced-motion class the tokens.css whitelist cancels, or an explicit Tailwind variant.
const REDUCED_GUARD = /motion-reduce:animate-none|nexus-shimmer|nexus-pulse|data-reveal/;

describe('every arbitrary animation in @nexus/ui honours prefers-reduced-motion', () => {
  it('found the animated components (a census that found nothing cleared nothing)', () => {
    expect(arbitraryAnimationLines().length, 'no arbitrary animation found — the census is blind').toBeGreaterThan(0);
  });

  it('carries a reduced-motion guard on the SAME line as each arbitrary animation', () => {
    const unguarded = arbitraryAnimationLines()
      .filter(({ text }) => !REDUCED_GUARD.test(text))
      .map(({ file, line, text }) => `${file}:${line} ${text.trim()}`);
    expect(unguarded, `arbitrary animation(s) with no reduced-motion stop:\n${unguarded.join('\n')}`).toEqual([]);
  });

  it('the loading spinner specifically stops (it runs on every loading Button)', () => {
    const icon = readFileSync(join(uiSrc, 'icons', 'Icon.tsx'), 'utf8');
    const spinnerLine = icon.split('\n').find((l) => l.includes('animate-[nexus-spin_'));
    expect(spinnerLine, 'spinner animation line missing').toBeTruthy();
    expect(spinnerLine, 'spinner must carry motion-reduce:animate-none').toContain('motion-reduce:animate-none');
  });
});

describe('reduced motion never branches the rendered markup (no stranded opacity:0 on hydration)', () => {
  const motion = readFileSync(join(uiSrc, 'motion', 'Motion.tsx'), 'utf8');

  it('kept the documented rule in writing', () => {
    expect(motion).toContain('markup must not branch on `useReducedMotion()`');
  });

  it('has no `if (reduced) return <...>` element swap anywhere in the file', () => {
    // The exact anti-pattern: server emits motion.div(initial=hidden, opacity:0 inline), reduced
    // client emits a plain div, React cannot clear the server's inline style -> invisible content.
    const swaps = [...motion.matchAll(/if\s*\(\s*reduced\s*\)\s*return\s*</g)];
    expect(swaps.length, `StaggerGroup/StaggerItem still swap markup on useReducedMotion() (${swaps.length} site(s))`).toBe(0);
  });

  it('StaggerGroup and StaggerItem always render a motion.div (same element on both passes)', () => {
    for (const name of ['StaggerGroup', 'StaggerItem']) {
      const start = motion.indexOf(`export function ${name}(`);
      expect(start, `${name} missing`).toBeGreaterThan(-1);
      // Cut at the NEXT exported function so one component's window cannot catch its neighbour's
      // `return <div>` (which would mis-report a StaggerItem defect as a StaggerGroup one).
      const rest = motion.slice(start + 1);
      const next = rest.indexOf('export function ');
      const body = next === -1 ? rest : rest.slice(0, next);
      expect(body, `${name} lost its motion.div`).toContain('<motion.div');
      expect(body, `${name} must not return a bare <div>`).not.toMatch(/return\s*<div\b/);
    }
  });
});
