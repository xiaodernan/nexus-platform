#!/usr/bin/env node
/**
 * NEXUS D186 — the console pages' accessibility promise, censused on the four axes docs/PLAN.md names.
 *
 * WHAT IT READS: the console render tree, which is not a directory. It is `apps/web/app/admin/**`,
 * `apps/web/app/merchant/**`, the shell those pages render inside (`apps/web/app/layout.tsx`,
 * `apps/web/src/components/site-chrome.tsx`, `locale-badges.tsx`), the components under
 * `apps/web/src/components/console/`, and every `@nexus/ui` module those files import (directly, plus
 * whatever those modules import from inside the package). A console file that imports a UI symbol this
 * reader does not know is a refusal (exit 2), not a silently narrower census.
 *
 * Four questions, one per axis:
 *
 *   LANDMARKS    exactly one `<main` in the render tree, and it must be the shell's, carrying the id the
 *                skip link points at; no `role="main"` anywhere; every `<nav>` carries an accessible name;
 *                and every console page must render the console nav — either `ConsoleNav` itself or one of
 *                the shell components whose body renders it. That last rule is a proxy, and is named as
 *                one: it compares the component the source references, not the tree a browser builds.
 *
 *   NAMES        every `Input` / `Textarea` / `Select` composed in the tree must pass `label` or
 *                `aria-label` / `aria-labelledby`; every raw `<input|select|textarea>` must carry one of
 *                those, or an `id` that an `htmlFor` in the same file points at, or sit inside a
 *                `<label>...</label>`.
 *
 *   FOCUS ORDER  no positive `tabIndex` anywhere -- a positive tabindex reorders the whole page's tab
 *                sequence, which is why this is the one focus rule with no exception; and every
 *                `outline-none` must be answered, in the string that carries it, by a `focus-visible:` or
 *                `focus-within:` token -- or, for a form control whose field wrapper draws the ring (the
 *                compound-field pattern), by a `focus-within:` anywhere in the same file.
 *
 *   CONTRAST     `packages/ui/src/styles/tokens.css` prints a ratio beside ten of its colours and cites
 *                `packages/ui/README.md` for "the measured ratios". This reader recomputes every printed
 *                pair from the hex values in the same file and fails when the printed number is not the
 *                measurement (to the one decimal the comment prints), or when a pair is under 4.5:1.
 *
 * WHAT IT DOES NOT DO, stated rather than implied. It is a source reader, not a browser: it does not
 * resolve the style that lands on a node, so a contrast pair assembled from two classNames on two
 * elements is invisible to it, as is any pair the palette does not print. It cannot see an accessible name
 * that arrives from the *content* of an `aria-labelledby` target rather than its presence. Its JSX scanner
 * skips comments but not string literals, so a `<Input` written inside a string would be censused like any
 * other -- that direction over-reports, which is the direction this project accepts (section 84). The
 * `outline-none` rule reads the string the token sits in on its own line, so a multi-line className would
 * be read as un-answered; no site in the tree does that today, and the rule states it rather than guessing.
 * And it says nothing about heading order or reading order: whether the DOM a screen reader walks makes
 * sense is not something a source scan can answer, and this reader does not pretend to.
 *
 * Usage: node scripts/check_console_a11y.mjs [--plane <dir>] [--verbose]
 * Exit:  0 every axis holds; 1 an axis is broken; 2 the census itself is not trustworthy.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const fail = (msg) => { console.error(`check_console_a11y.mjs: ${msg}`); process.exit(2); };

const FLAGS = {
  '--plane': { kind: 'value', unit: 'directory' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) fail(parsed.reason);
const VERBOSE = parsed.switches.includes('--verbose');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLANE = parsed.value['--plane'] ? resolve(parsed.value['--plane']) : ROOT;
const APP = join(PLANE, 'apps', 'web', 'app');
const COMPONENTS = join(PLANE, 'apps', 'web', 'src', 'components');
const UI_SRC = join(PLANE, 'packages', 'ui', 'src');
const TOKENS = join(UI_SRC, 'styles', 'tokens.css');
const UI_README = join(PLANE, 'packages', 'ui', 'README.md');

const rel = (abs) => relative(PLANE, abs).replace(/\\/g, '/');
const read = (abs) => readFileSync(abs, 'utf8');

function filesUnder(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) filesUnder(abs, exts, out);
    else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(abs);
  }
  return out;
}

function firstFile(candidates) {
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return null;
}

/* ---------------------------------------------------------------- the console render tree */

const consoleFiles = [join(APP, 'admin'), join(APP, 'merchant')]
  .flatMap((d) => filesUnder(d, ['.tsx', '.ts']));
const consolePages = consoleFiles.filter((f) => basename(f) === 'page.tsx');
const consoleComponents = filesUnder(join(COMPONENTS, 'console'), ['.tsx', '.ts']);
const shellFiles = [join(APP, 'layout.tsx'), join(COMPONENTS, 'site-chrome.tsx'), join(COMPONENTS, 'locale-badges.tsx')]
  .filter(existsSync);

if (consolePages.length === 0) {
  fail(`no console page.tsx was read under ${rel(APP)}/admin or /merchant in ${PLANE} -- nothing was censused, so nothing can be reported green`);
}

/**
 * The `@nexus/ui` names this census knows how to follow. A `null` means the export renders nothing (a type,
 * or the class-name helper), so there is no module to read. An import outside this table is a refusal.
 */
const UI_SYMBOLS = {
  Badge: 'packages/ui/src/primitives/Badge.tsx',
  Icon: 'packages/ui/src/icons/Icon.tsx',
  Button: 'packages/ui/src/primitives/Button.tsx',
  Input: 'packages/ui/src/primitives/Input.tsx',
  Textarea: 'packages/ui/src/primitives/Input.tsx',
  Select: 'packages/ui/src/primitives/Select.tsx',
  Container: 'packages/ui/src/primitives/Layout.tsx',
  Skeleton: 'packages/ui/src/primitives/Skeleton.tsx',
  EmptyState: 'packages/ui/src/feedback/States.tsx',
  ErrorState: 'packages/ui/src/feedback/States.tsx',
  DemoBadge: 'packages/ui/src/trust/Renderers.tsx',
  IconName: null,
  cx: null,
};

const directUi = new Set();
for (const abs of [...consoleFiles, ...consoleComponents, ...shellFiles]) {
  const text = read(abs);
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@nexus\/ui'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!(name in UI_SYMBOLS)) {
        fail(`${rel(abs)} imports @nexus/ui's \`${name}\`, which this census does not know -- widen UI_SYMBOLS rather than censusing a surface that shrank`);
      }
      const p = UI_SYMBOLS[name];
      if (p) directUi.add(join(PLANE, p));
    }
  }
}

/** Follow `./x` imports inside the package too: the focus recipes live in `button-classes.ts`/`field-classes.ts`. */
const uiFiles = (() => {
  const seen = new Set();
  const queue = [...directUi];
  while (queue.length > 0) {
    const abs = queue.pop();
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    const dir = dirname(abs);
    for (const m of read(abs).matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const base = resolve(dir, m[1]);
      const found = firstFile([base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]);
      if (found && !seen.has(found)) queue.push(found);
    }
  }
  return [...seen];
})();

const renderTree = [...new Set([...shellFiles, ...consoleFiles, ...consoleComponents, ...uiFiles])].sort();

/* ---------------------------------------------------------------- a small JSX tag scanner */

/** Half-open [start, end) ranges of `text` that are comments, with string literals understood. */
function commentSpans(text) {
  const spans = [];
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      spans.push([i, end]);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      spans.push([i, end]);
      i = end;
      continue;
    }
    i += 1;
  }
  return spans;
}

const inSpans = (spans, idx) => spans.some(([a, b]) => idx >= a && idx < b);

/** `{ name, closing, selfClosing, attrs, start, end }` for every uncommented tag whose name is in `names`. */
function scanTags(text, names, spans) {
  const tags = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9_.]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[2];
    if (!names.has(name) || inSpans(spans, m.index)) continue;
    const closing = m[1] === '/';
    let i = re.lastIndex;
    let depth = 0;
    let quote = null;
    let end = -1;
    while (i < text.length) {
      const c = text[i];
      if (quote) {
        if (c === '\\') { i += 2; continue; }
        if (c === quote) quote = null;
        i += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue; }
      if (c === '{') { depth += 1; i += 1; continue; }
      if (c === '}') { depth -= 1; i += 1; continue; }
      if (c === '>' && depth === 0) { end = i; break; }
      i += 1;
    }
    if (end < 0) continue;
    const attrs = text.slice(re.lastIndex, end);
    tags.push({ name, closing, selfClosing: /\/\s*$/.test(attrs), attrs, start: m.index, end });
    re.lastIndex = end + 1;
  }
  return tags;
}

/** `<label>...</label>` spans, paired with a stack so a nested label cannot borrow its parent's name. */
function labelSpans(tags) {
  const spans = [];
  const open = [];
  for (const t of tags) {
    if (t.name !== 'label') continue;
    if (t.closing) { const s = open.pop(); if (s) spans.push([s.start, t.end]); }
    else if (!t.selfClosing) open.push(t);
  }
  return spans;
}

/** Every match of `re` in `text` that no comment covers. */
function matchesOutside(text, re, spans) {
  return [...text.matchAll(re)].filter((m) => !inSpans(spans, m.index));
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** A file's text with its import declarations removed: what a page *renders*, not what it mentions. */
const bodyOf = (text) => text.replace(/import\s+(?:type\s+)?[\s\S]*?\sfrom\s+'[^']*';?/g, '');

/* ---------------------------------------------------------------- the census */

const ALL_TAGS = new Set(['main', 'nav', 'label', 'input', 'select', 'textarea', 'Input', 'Textarea', 'Select']);

const perFile = renderTree.map((abs) => {
  const text = read(abs);
  const spans = commentSpans(text);
  return { abs, text, spans, tags: scanTags(text, ALL_TAGS, spans) };
});

const offenders = [];
const note = (s) => offenders.push(s);
const site = (f, idx) => `${rel(f.abs)}:${lineOf(f.text, idx)}`;

/* ---- axis 1: landmarks ---- */
let mainCount = 0;
let mainIsShell = false;
let mainHasId = false;
let roleMainSites = 0;
let navTotal = 0;
let navNamed = 0;
for (const f of perFile) {
  for (const t of f.tags) {
    if (t.name === 'main' && !t.closing) {
      mainCount += 1;
      if (basename(f.abs) === 'layout.tsx') mainIsShell = true;
      if (/id\s*=\s*["']nexus-main["']/.test(t.attrs)) mainHasId = true;
    }
    if (t.name === 'nav' && !t.closing) {
      navTotal += 1;
      if (/\baria-label(?:ledby)?\s*=/.test(t.attrs)) navNamed += 1;
      else note(`${site(f, t.start)} -- <nav> carries no aria-label/aria-labelledby, so a screen reader announces an unnamed navigation landmark`);
    }
  }
  roleMainSites += matchesOutside(f.text, /role\s*=\s*["']main["']/g, f.spans).length;
}
if (mainCount !== 1) {
  note(`landmarks -- the render tree declares ${mainCount} <main> element(s); a document has one main landmark, so every page would render ${mainCount}`);
} else {
  if (!mainIsShell) note('landmarks -- the one <main> is not in app/layout.tsx, so a page-level <main> is standing in for the shell');
  if (!mainHasId) note('landmarks -- the shell\'s <main> carries no id="nexus-main", so the skip link has nothing to land on');
}
if (roleMainSites > 0) note(`landmarks -- ${roleMainSites} role="main" declaration(s); the shell already owns the main landmark`);
const layout = perFile.find((f) => basename(f.abs) === 'layout.tsx');
if (!layout || matchesOutside(layout.text, /href\s*=\s*["']#nexus-main["']/g, layout.spans).length === 0) {
  note('landmarks -- app/layout.tsx has no skip link targeting #nexus-main, so a keyboard user cannot jump past the header');
}

const shellModules = consoleComponents.filter((f) => /-shell\.tsx$/.test(f));
const navRenderers = new Set();
for (const abs of shellModules) {
  const text = read(abs);
  const re = /export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9]*)/g;
  const hits = [...text.matchAll(re)];
  hits.forEach((m, i) => {
    const body = text.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : text.length);
    if (/<ConsoleNav\b/.test(body)) navRenderers.add(m[1]);
  });
}
if (navRenderers.size === 0) fail(`no component among ${shellModules.map(rel).join(', ')} renders <ConsoleNav> -- the landmark proxy has nothing to look for`);
const navNames = [...navRenderers];
let pagesWithNav = 0;
for (const abs of consolePages) {
  // The import list is not the render: a page that imports the chrome and never composes it is exactly the
  // defect this rule exists to find, so the test runs against the body rather than the whole file.
  const body = bodyOf(read(abs));
  if (/\bConsoleNav\b/.test(body) || navNames.some((n) => new RegExp(`\\b${n}\\b`).test(body))) pagesWithNav += 1;
  else note(`landmarks -- ${rel(abs)} renders neither ConsoleNav nor ${navNames.join('/')}, so it is the one console page with no navigation landmark`);
}

/* ---- axis 2: names ---- */
const FIELD_PRIMITIVES = new Set(['Input', 'Textarea', 'Select']);
const RAW_CONTROLS = new Set(['input', 'select', 'textarea']);
const NAMED_BY_ATTR = /\baria-label(?:ledby)?\s*=/;
let controlsCensused = 0;

for (const f of perFile) {
  const labels = labelSpans(f.tags);
  const htmlFors = new Set([...f.text.matchAll(/htmlFor\s*=\s*\{([^}]*)\}/g)].map((m) => m[1].trim()));
  for (const t of f.tags) {
    if (t.closing) continue;
    if (FIELD_PRIMITIVES.has(t.name)) {
      controlsCensused += 1;
      if (!/\blabel\s*=/.test(t.attrs) && !NAMED_BY_ATTR.test(t.attrs)) {
        note(`${site(f, t.start)} -- a <${t.name}> is composed with no \`label\` and no \`aria-label\`/\`aria-labelledby\``);
      }
      continue;
    }
    if (!RAW_CONTROLS.has(t.name)) continue;
    controlsCensused += 1;
    if (NAMED_BY_ATTR.test(t.attrs)) continue;
    if (labels.some(([a, b]) => t.start > a && t.end < b)) continue;
    const idExpr = /\bid\s*=\s*\{([^}]*)\}/.exec(t.attrs);
    if (idExpr && htmlFors.has(idExpr[1].trim())) continue;
    note(`${site(f, t.start)} -- a raw <${t.name}> has no accessible name: no aria-label/aria-labelledby, no htmlFor pointing at it, and no <label> around it`);
  }
}

/* ---- axis 3: focus order ---- */
let outlineSites = 0;
let outlineInherited = 0;
for (const f of perFile) {
  for (const m of matchesOutside(f.text, /\btabIndex\s*=\s*\{?\s*["']?([0-9]+)/g, f.spans)) {
    if (Number(m[1]) >= 1) {
      note(`${site(f, m.index)} -- tabIndex={${m[1]}} takes the whole page's focus order out of document order`);
    }
  }
  for (const m of matchesOutside(f.text, /outline-none/g, f.spans)) {
    outlineSites += 1;
    const at = m.index;
    let sq = -1;
    for (let i = at - 1; i >= 0 && f.text[i] !== '\n'; i -= 1) {
      if (f.text[i] === "'" || f.text[i] === '"' || f.text[i] === '`') { sq = i; break; }
    }
    const str = sq < 0 ? '' : f.text.slice(sq + 1, f.text.indexOf(f.text[sq], sq + 1));
    // `outline-none` carries its own variant prefix, so strip it before asking whether anything else in
    // the string answers for it -- otherwise `focus-visible:outline-none` answers for itself.
    if (/focus-visible:|focus-within:/.test(str.replace(/(focus-visible:|focus:)?outline-none/g, ''))) continue;
    const tag = f.tags.find((t) => t.start <= at && at <= t.end);
    if (tag && RAW_CONTROLS.has(tag.name) && /focus-within:/.test(f.text)) {
      outlineInherited += 1;
      continue;
    }
    note(`${site(f, at)} -- outline-none is not answered by a focus-visible:/focus-within: token, so keyboard focus on this element draws no ring`);
  }
}

/* ---- axis 4: contrast ---- */
const contrast = (() => {
  if (!existsSync(TOKENS)) fail(`${rel(TOKENS)} was not read -- the contrast axis has nothing to measure`);
  const text = read(TOKENS);

  const blockAt = (selector) => {
    const i = text.indexOf(selector);
    if (i < 0) return null;
    const open = text.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') { depth -= 1; if (depth === 0) return text.slice(open + 1, j); }
    }
    return null;
  };

  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  const themes = [
    { name: 'light', block: blockAt(':root') },
    { name: 'dark', block: blockAt('.dark') },
  ];
  const pairs = [];
  for (const t of themes) {
    if (!t.block) fail(`tokens.css has no ${t.name} block, so its ratios cannot be recomputed`);
    const hex = {};
    for (const m of t.block.matchAll(/--nexus-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) hex[m[1]] = m[2];
    const claims = [];
    for (const m of t.block.matchAll(/--nexus-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;[^\n]*?\/\*\s*([^*]*?)\*\//g)) {
      const r = /(\d+(?:\.\d+)?)\s*:\s*1/.exec(m[3]);
      if (r) claims.push({ token: m[1], hex: m[2], printed: Number(r[1]), on: /accent/.test(m[3]) ? 'accent' : 'surface' });
    }
    for (const c of claims) {
      const bg = hex[c.on];
      if (!hex[c.token] || !bg) fail(`tokens.css's ${t.name} block prints a ratio for --nexus-${c.token} without the hex that would recompute it`);
      pairs.push({ theme: t.name, ...c, bg, computed: ratio(c.hex, bg) });
    }
  }
  if (pairs.length === 0) fail('tokens.css prints no ratio this reader can recompute, so the contrast axis measured nothing');
  return { pairs, readme: existsSync(UI_README) };
})();

for (const p of contrast.pairs) {
  if (Math.abs(p.printed - p.computed) > 0.05) {
    note(`contrast -- ${p.theme} --nexus-${p.token} prints ${p.printed}:1 beside ${p.hex} on ${p.bg}; the measurement is ${p.computed.toFixed(2)}:1`);
  }
  if (p.computed < 4.5) {
    note(`contrast -- ${p.theme} --nexus-${p.token} on ${p.bg} measures ${p.computed.toFixed(2)}:1, under the 4.5:1 the palette's own header states`);
  }
}
if (!contrast.readme) {
  note('contrast -- packages/ui/src/styles/tokens.css cites packages/ui/README.md for its measured ratios, and that file does not exist');
}

/* ---------------------------------------------------------------- the verdict */

const tightest = contrast.pairs.reduce((a, b) => (b.computed < a.computed ? b : a));
console.log("NEXUS -- the console pages' accessibility promise, censused on four axes");
console.log(`  plane read            ${PLANE}`);
console.log(`  render tree           ${renderTree.length} file(s): ${consolePages.length} console page(s), ${consoleComponents.length} console component(s), ${shellFiles.length} shell file(s), ${uiFiles.length} @nexus/ui module(s)`);
console.log(`  landmarks             1 <main> expected; ${mainCount} found (id="nexus-main": ${mainHasId ? 'yes' : 'no'}); ${navNamed}/${navTotal} <nav> named; ${pagesWithNav}/${consolePages.length} console page(s) render ${navNames.join('/')}`);
console.log(`  names                 ${controlsCensused} control(s) censused for an accessible name`);
console.log(`  focus order           0 positive tabindex expected; ${outlineSites} outline-none site(s), ${outlineInherited} answered by the field wrapper's focus-within`);
console.log(`  contrast              ${contrast.pairs.length} printed pair(s) recomputed; tightest ${tightest.theme} --nexus-${tightest.token} on ${tightest.bg} = ${tightest.computed.toFixed(2)}:1`);
if (VERBOSE) {
  for (const p of contrast.pairs) {
    console.log(`      ${p.theme.padEnd(5)} --nexus-${p.token.padEnd(12)} printed ${String(p.printed).padStart(5)}:1  measured ${p.computed.toFixed(2).padStart(6)}:1`);
  }
  for (const abs of renderTree) console.log(`      read  ${rel(abs)}`);
}

if (offenders.length > 0) {
  console.log(`\nOFFENDERS (${offenders.length}):`);
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`\nRESULT: FAIL -- ${offenders.length} accessibility offender(s) in the console render tree`);
  process.exit(1);
}
console.log('\nRESULT: PASS -- every console page keeps its landmark, every control its name, every outline its ring, and every printed ratio its measurement');
