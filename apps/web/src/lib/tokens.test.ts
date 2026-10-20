import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard test for the token contract between `packages/ui/src/styles/tokens.css` and
 * `packages/ui/tailwind-preset.ts` (see the naming-contract note at the top of the preset).
 *
 * Both sides are parsed as *text*, never imported: the preset is a Tailwind config whose
 * values are only meaningful to Tailwind, and importing a broken preset into a test that
 * checks that same preset would let the defect satisfy its own assertion.
 *
 * It exists because two silent defects shipped:
 *  (a) a preset key no component used (`ink.strongest` vs. the real `ink-strong`), and
 *  (b) hex-valued CSS variables cannot carry a Tailwind alpha modifier — `bg-ink-strong/85`
 *      compiled to NOTHING, at build time, with no warning. The fix is an `-rgb` channel
 *      triplet variable per alpha-capable token, which this file keeps honest.
 */

/* ------------------------------------------------------------------ file loading */

/**
 * Walk up from this test file to the monorepo root (the directory holding both the token
 * sheet and the preset). No cwd assumption and no absolute paths.
 */
function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let step = 0; step < 8; step += 1) {
    if (
      existsSync(join(dir, 'packages', 'ui', 'src', 'styles', 'tokens.css')) &&
      existsSync(join(dir, 'packages', 'ui', 'tailwind-preset.ts'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root above ${fromFile}`);
}

const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
const tokensCssPath = join(repoRoot, 'packages', 'ui', 'src', 'styles', 'tokens.css');
const presetPath = join(repoRoot, 'packages', 'ui', 'tailwind-preset.ts');
const tokensCss = readFileSync(tokensCssPath, 'utf8');
const presetSource = readFileSync(presetPath, 'utf8');

/* ------------------------------------------------------------------ css parsing */

/** Block comments hold prose, never declarations, and must not be parsed as either. */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Declarations of a selector block (`:root`, `.dark`) as name → raw value. Brace depth is
 * tracked so a nested rule inside the block cannot end it early.
 */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const source = stripCssComments(css);
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`tokens.css has no ${selector} block`);
  const open = source.indexOf('{', start);
  if (open === -1) throw new Error(`tokens.css ${selector} block is missing its "{"`);
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) {
      close = index;
      break;
    }
  }
  if (close === -1) throw new Error(`tokens.css ${selector} block is never closed`);
  const declarations = new Map<string, string>();
  for (const match of source.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1] as string, (match[2] as string).trim());
  }
  return declarations;
}

const rootDeclarations = declarationsOf(tokensCss, ':root');
const darkDeclarations = declarationsOf(tokensCss, '.dark');
const blocks: Array<[name: string, declarations: Map<string, string>]> = [
  [':root', rootDeclarations],
  ['.dark', darkDeclarations],
];

/* ---------------------------------------------------------------- preset parsing */

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The balanced `{...}` following the first occurrence of `marker`, without its braces. */
function objectBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`tailwind-preset.ts has no "${marker}" entry`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  throw new Error(`tailwind-preset.ts "${marker}" object is never closed`);
}

/**
 * Flatten `theme.extend.colors` into dotted utility paths → value strings, e.g.
 * `ink.strong` → `rgb(var(--nexus-ink-strong-rgb) / <alpha-value>)`.
 * Comments inside the object literal (which document the very contract under test) are skipped.
 */
function parseColorPaths(block: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  let index = 0;
  const length = block.length;
  const skipTrivia = () => {
    for (;;) {
      while (index < length && /[\s,]/.test(block[index] as string)) index += 1;
      if (block.startsWith('/*', index)) {
        const end = block.indexOf('*/', index);
        index = end === -1 ? length : end + 2;
        continue;
      }
      if (block.startsWith('//', index)) {
        const end = block.indexOf('\n', index);
        index = end === -1 ? length : end + 1;
        continue;
      }
      return;
    }
  };
  const readQuoted = (quote: string) => {
    index += 1;
    const start = index;
    while (index < length && block[index] !== quote) index += 1;
    const value = block.slice(start, index);
    index += 1;
    return value;
  };
  for (;;) {
    skipTrivia();
    if (index >= length) return out;
    const opening = block[index];
    let key: string;
    if (opening === "'" || opening === '"' || opening === '`') {
      key = readQuoted(opening);
    } else {
      const start = index;
      while (index < length && !/[:{\s,]/.test(block[index] as string)) index += 1;
      key = block.slice(start, index);
    }
    if (!key) throw new Error(`colors: could not parse a key near "${block.slice(index, index + 40)}"`);
    skipTrivia();
    if (block[index] === ':') index += 1;
    skipTrivia();
    if (block[index] === '{') {
      const open = index;
      let depth = 0;
      for (; index < length; index += 1) {
        if (block[index] === '{') depth += 1;
        else if (block[index] === '}' && (depth -= 1) === 0) {
          index += 1;
          break;
        }
      }
      parseColorPaths(block.slice(open + 1, index - 1), prefix ? `${prefix}.${key}` : key, out);
      continue;
    }
    let value = '';
    let quote: string | null = null;
    while (index < length) {
      const char = block[index];
      if (quote) {
        value += char;
        if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char;
        value += char;
      } else if (char === ',') {
        break;
      } else {
        value += char;
      }
      index += 1;
    }
    index += 1;
    out.set(prefix ? `${prefix}.${key}` : key, value.trim().replace(/^['"`]|['"`]$/g, ''));
  }
}

const presetColors = parseColorPaths(objectBlock(stripJsComments(presetSource), 'colors:'));

/* -------------------------------------------------------------------- assertions */

const RGB_SUFFIX = '-rgb';

function rgbNamesOf(declarations: Map<string, string>): string[] {
  return [...declarations.keys()].filter((name) => name.endsWith(RGB_SUFFIX));
}

function hexToTriplet(hex: string): number[] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1] as string;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

const tripletOf = (raw: string) => raw.split(/\s+/).filter(Boolean).map(Number);

describe('tokens.css — -rgb channel triplets', () => {
  it('declares every --nexus-*-rgb as exactly three integers in 0..255', () => {
    const problems: string[] = [];
    for (const [blockName, declarations] of blocks) {
      for (const name of rgbNamesOf(declarations)) {
        const raw = declarations.get(name) as string;
        const channels = raw.split(/\s+/).filter(Boolean);
        const valid =
          channels.length === 3 &&
          channels.every((channel) => /^\d+$/.test(channel) && Number(channel) >= 0 && Number(channel) <= 255);
        if (!valid) problems.push(`${blockName} ${name}: "${raw}"`);
      }
    }
    expect(problems, `every -rgb variable must be 3 space-separated integers 0..255:\n${problems.join('\n')}`).toEqual([]);
  });

  it('keeps each --nexus-<name>-rgb triplet equal to its #rrggbb sibling', () => {
    const mismatches: string[] = [];
    for (const [blockName, declarations] of blocks) {
      for (const rgbName of rgbNamesOf(declarations)) {
        const rgbRaw = declarations.get(rgbName) as string;
        const baseName = rgbName.slice(0, -RGB_SUFFIX.length);
        const baseValue = declarations.get(baseName);
        if (baseValue === undefined) {
          mismatches.push(`${blockName} ${rgbName}: declares no sibling ${baseName} to match`);
          continue;
        }
        const expected = hexToTriplet(baseValue);
        if (!expected) continue; // not a hex token (rgba(), gradient, …) — nothing to compare
        const actual = tripletOf(rgbRaw);
        if (expected.some((channel, position) => actual[position] !== channel)) {
          mismatches.push(
            `${blockName} ${baseName} = ${baseValue} → ${expected.join(' ')}, but ${rgbName} = ${rgbRaw}`,
          );
        }
      }
    }
    expect(
      mismatches,
      `a token's -rgb triplet must hold the exact channels of its hex value, or an /NN modifier ` +
        `renders a different colour than the flat token:\n${mismatches.join('\n')}`,
    ).toEqual([]);
  });

  it('declares every -rgb triplet in both :root and .dark', () => {
    const missing = [
      ...rgbNamesOf(rootDeclarations).filter((name) => !darkDeclarations.has(name)),
      ...rgbNamesOf(darkDeclarations).filter((name) => !rootDeclarations.has(name)),
    ];
    expect(missing, `the theme flip would lose these channel variables:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('tailwind preset ↔ token contract', () => {
  it('parses the preset color map (the guard checks the guard)', () => {
    expect(presetColors.size).toBeGreaterThan(10);
    expect(presetColors.get('ink.strong')).toContain('<alpha-value>');
    expect([...presetColors.keys()]).toContain('accent.soft');
  });

  it('points every <alpha-value> entry at an -rgb variable declared in BOTH :root and .dark', () => {
    const problems: string[] = [];
    for (const [key, value] of presetColors) {
      if (!value.includes('<alpha-value>')) continue;
      const referenced = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1] as string);
      if (referenced.length === 0) {
        problems.push(`colors.${key} = "${value}" uses <alpha-value> without referencing a variable`);
        continue;
      }
      for (const name of referenced) {
        if (!name.endsWith(RGB_SUFFIX)) {
          problems.push(
            `colors.${key} = "${value}" cannot carry an alpha modifier: ${name} is a flat value, ` +
              `not an ${RGB_SUFFIX} channel triplet`,
          );
        }
        for (const [blockName, declarations] of blocks) {
          if (!declarations.has(name)) {
            problems.push(`colors.${key} references ${name}, which tokens.css does not declare in ${blockName}`);
          }
        }
      }
    }
    expect(
      problems,
      `every preset color using <alpha-value> must resolve to an -rgb triplet present in both ` +
        `themes, otherwise Tailwind silently drops the utility:\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('resolves every preset color variable to a declared token', () => {
    const unknown: string[] = [];
    for (const [key, value] of presetColors) {
      for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = match[1] as string;
        for (const [blockName, declarations] of blocks) {
          if (!declarations.has(name)) unknown.push(`colors.${key} → ${name} is not declared in ${blockName}`);
        }
        if (value.includes('<alpha-value>') && !name.endsWith(RGB_SUFFIX)) {
          unknown.push(`colors.${key} → ${name} is a flat value; an /NN modifier needs ${name}${RGB_SUFFIX}`);
        }
      }
    }
    expect(unknown, `preset keys must point at real variables:\n${unknown.join('\n')}`).toEqual([]);
  });
});
