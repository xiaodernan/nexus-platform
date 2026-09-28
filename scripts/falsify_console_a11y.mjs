#!/usr/bin/env node
/**
 * NEXUS D186 -- both sides of scripts/check_console_a11y.mjs, shown rather than asserted.
 *
 * A validator whose first run is also its first test has not been tested, so every arm states the verdict
 * it expects *before* the shipped checker is called, and the harness exits non-zero if a prediction
 * misses. Nine arms must redden, one per way the reader claims a console page can lose a landmark, a
 * name, a focus ring or a printed ratio: a second `<main>`, a page that renders no console nav, an
 * `<Input>` composed without a `label`, a raw `<input>` with no accessible name, a positive `tabIndex`,
 * an `outline-none` nothing answers (the plant that found the rule answering for itself), a ratio edited
 * away from its measurement, a pair dropped under the bar, and the cited README removed.
 *
 * Three arms must refuse with exit 2 rather than pass, because "did not run" and "found nothing" are
 * different answers (D93, D96): a console file importing a `@nexus/ui` symbol the census does not know, a
 * plane whose console subtrees are gone, and a palette that prints no ratio to recompute.
 *
 * Each arm gets its own copy of the console render tree under the system temp directory, so no arm can
 * borrow another arm's redness and the working tree is never the fixture. Every mutation asserts that the
 * text it rewrites is present in the copy, so an arm cannot pass by silently running an unmutated tree --
 * the failure mode D110 named.
 *
 * Usage: node scripts/falsify_console_a11y.mjs
 * Exit:  0 every prediction held; 1 an arm missed (the reader cannot do what its docblock says)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(tmpdir(), 'nexus-d186-falsify');
const CHECKER = join(ROOT, 'scripts', 'check_console_a11y.mjs');

/** Everything the census reads, and nothing else: no `node_modules`, no other lane's pages. */
const SUBTREES = [
  'apps/web/app',
  'apps/web/src/components',
  'packages/ui/src',
  'packages/ui/README.md',
];

rmSync(FIX, { recursive: true, force: true });

function fixture(slug) {
  const dir = join(FIX, slug);
  for (const s of SUBTREES) cpSync(join(ROOT, s), join(dir, s), { recursive: true });
  return dir;
}

function edit(dir, p, from, to) {
  const before = readFileSync(join(dir, p), 'utf8');
  if (!before.includes(from)) throw new Error(`${p} does not hold the text this arm rewrites: ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(join(dir, p), before.replace(from, to), 'utf8');
}
function editAll(dir, p, from, to) {
  const before = readFileSync(join(dir, p), 'utf8');
  if (!before.includes(from)) throw new Error(`${p} does not hold the text this arm rewrites: ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(join(dir, p), before.split(from).join(to), 'utf8');
}

const ARMS = [
  {
    name: 'control: this tree as it stands',
    apply: () => {},
    expect: 0,
    must: [/RESULT: PASS/, /20\/20 console page\(s\) render AdminChrome\/MerchantChrome/, /10 printed pair\(s\) recomputed/],
  },
  {
    name: 'a second <main> in a console page',
    apply: (d) => edit(d, 'apps/web/app/admin/page.tsx', 'export const dynamic',
      'const secondLandmark = <main>two</main>;\n\nexport const dynamic'),
    expect: 1,
    must: [/2 <main> element\(s\)/],
  },
  {
    name: 'a console page that renders no nav (the import list is not the render)',
    apply: (d) => editAll(d, 'apps/web/app/merchant/settings/page.tsx', 'MerchantChrome', 'MerchantShell'),
    expect: 1,
    must: [/no navigation landmark/],
  },
  {
    name: 'an <Input> composed without a label',
    apply: (d) => edit(d, 'apps/web/src/components/console/offering-form.tsx',
      '          label={copy.fields.title}\n', ''),
    expect: 1,
    must: [/a <Input> is composed with no `label`/],
  },
  {
    name: 'a raw <input> with no accessible name (its <label> wrapper replaced)',
    apply: (d) => {
      edit(d, 'apps/web/src/components/console/agent-config-form.tsx',
        '<label className="flex items-center gap-2 text-xs text-ink-strong">', '<div className="flex items-center gap-2 text-xs text-ink-strong">');
      edit(d, 'apps/web/src/components/console/agent-config-form.tsx', '</label>', '</div>');
    },
    expect: 1,
    must: [/a raw <input> has no accessible name/],
  },
  {
    name: 'a positive tabIndex',
    apply: (d) => edit(d, 'apps/web/src/components/console/console-parts.tsx',
      'export function', 'const reorder = () => <div tabIndex={3} />;\n\nexport function'),
    expect: 1,
    must: [/tabIndex=\{3\} takes the whole page's focus order out of document order/],
  },
  {
    name: 'an outline-none whose only answer is its own focus-visible: variant',
    apply: (d) => edit(d, 'packages/ui/src/primitives/button-classes.ts',
      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2', ''),
    expect: 1,
    must: [/outline-none is not answered/],
  },
  {
    name: 'a printed contrast ratio edited away from its measurement',
    apply: (d) => edit(d, 'packages/ui/src/styles/tokens.css',
      '--nexus-ink-strong: #0b0d14; /* 19.4:1 on surface */', '--nexus-ink-strong: #0b0d14; /* 12.0:1 on surface */'),
    expect: 1,
    must: [/prints 12:1 beside #0b0d14 on #ffffff/, /the measurement is 19\.41:1/],
  },
  {
    name: 'a text colour dropped under the 4.5:1 bar',
    apply: (d) => edit(d, 'packages/ui/src/styles/tokens.css',
      '--nexus-ink-faint: #6a7288;', '--nexus-ink-faint: #9aa2b4;'),
    expect: 1,
    must: [/under the 4\.5:1 the palette's own header states/],
  },
  {
    name: 'the README the palette cites, removed',
    apply: (d) => rmSync(join(d, 'packages/ui/README.md'), { force: true }),
    expect: 1,
    must: [/README\.md for its measured ratios, and that file does not exist/],
  },
  {
    name: 'REFUSAL: a console file imports a @nexus/ui symbol the census does not know',
    apply: (d) => edit(d, 'apps/web/src/components/console/console-parts.tsx',
      'import { Badge', "import { Widget } from '@nexus/ui';\nimport { Badge"),
    expect: 2,
    must: [/which this census does not know/],
  },
  {
    name: 'REFUSAL: a plane with no console pages at all',
    apply: (d) => {
      rmSync(join(d, 'apps/web/app/admin'), { recursive: true, force: true });
      rmSync(join(d, 'apps/web/app/merchant'), { recursive: true, force: true });
    },
    expect: 2,
    must: [/no console page\.tsx was read/],
  },
  {
    name: 'REFUSAL: a palette that prints no ratio to recompute',
    apply: (d) => {
      const abs = join(d, 'packages/ui/src/styles/tokens.css');
      writeFileSync(abs, readFileSync(abs, 'utf8').replace(/\d+(?:\.\d+)?\s*:\s*1/g, 'x'), 'utf8');
    },
    expect: 2,
    must: [/prints no ratio this reader can recompute/],
  },
];

const results = [];
for (const arm of ARMS) {
  const dir = fixture(arm.name.replace(/[^\w]+/g, '_').slice(0, 40));
  arm.apply(dir);
  let out;
  let code;
  try {
    out = execFileSync('node', [CHECKER, '--plane', dir], { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
    code = 0;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  results.push({ arm, code, missed: arm.must.filter((re) => !re.test(out)), out });
}

let fails = 0;
for (const r of results) {
  const okCode = r.code === r.arm.expect;
  const ok = okCode && r.missed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  if (!okCode) {
    console.log(`        verdict differs -- the arm printed: ${r.out.split('\n').filter((l) => /RESULT|OFFENDERS|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
  for (const m of r.missed) {
    console.log(`        expected text missing: ${m}   -- printed: ${r.out.split('\n').filter((l) => /RESULT|OFFENDERS|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped checker as a subprocess on its own copy of the console');
console.log('           render tree, so no arm can redden another; each mutation refuses if the text it');
console.log('           rewrites is absent, so no arm can pass by running an unmutated tree.');
if (fails) {
  console.log('\nRESULT: FAIL -- the accessibility census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- the census reddens on every way a landmark, name, focus ring or printed ratio can break, and refuses when it cannot see');
