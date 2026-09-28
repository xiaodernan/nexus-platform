#!/usr/bin/env node
/**
 * NEXUS D181 — the console pages' i18n promise, censused instead of asserted.
 *
 * WHAT IT READS. Every `page.tsx` under `apps/web/app/`, in two passes that answer two different claims the
 * product makes about itself.
 *
 *   * NOINDEX, on the console plane. `apps/web/app/layout.tsx` sets `robots: { index: true, follow: true }`
 *     for the whole site, so a page under `app/admin/` or `app/merchant/` is offered to search engines
 *     unless it overrides that in its own `generateMetadata`. The promise is that operator surfaces stay out
 *     of the index, and nothing but a per-page directive can hold it — which is why this is a census and not
 *     a spot check. Measured on the tree that wrote this file: 20 console pages, every one declaring the
 *     directive. (docs/PLAN.md P3 says "21 pages now exist"; the count this reader takes is 20 page.tsx under
 *     those two subtrees, and the difference is recorded in STATUS section 187 rather than smoothed over.)
 *
 *   * NO INLINE COPY, on both planes. The dictionary in `apps/web/src/lib/i18n/` owns every user-visible
 *     string, so a CJK ideograph sitting in a page is copy that bypassed it. The rule is narrow and stated
 *     as the rule it is: this reader reports ideographs that are NOT inside a comment, and it does not
 *     claim that is the same set as "all hardcoded copy" — see the limits below.
 *
 * WHAT IT DOES NOT DO, stated rather than implied. It does not read the dictionary, so it cannot tell a key
 * that is missing from one that is unused. It does not judge whether a string is user-visible: a stable test
 * id and a button label are the same character to it. It cannot see hardcoded copy written in Latin script,
 * which is the whole reason the enforced rule is "no CJK ideograph outside a comment" rather than "no
 * hardcoded copy". And the accessibility half of the same plan item — contrast, labels, landmarks, focus
 * order — is not measured here at all; this reader holds the noindex and copy halves only, and says so.
 *
 * The comment scanner tracks single quotes, double quotes and template literals so that a `//` inside a
 * string does not open a comment, and refuses to guess about regex literals: an unterminated `/*` inside a
 * regular expression would swallow the rest of the file and hide copy rather than invent it. That failure
 * direction is the one this project accepts everywhere else (D94's over-reporting, section 84's "errs
 * toward reporting"), and it is named here because it is a real blind spot rather than a theoretical one.
 *
 * Usage: node scripts/check_console_i18n.mjs [--plane <dir>] [--verbose]
 * Exit:  0 the promise holds; 1 a page breaks it; 2 the scan itself is not trustworthy.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const fail = (msg) => { console.error(`check_console_i18n.mjs: ${msg}`); process.exit(2); };

// A mistyped flag must refuse rather than fall back to the repository, which is D158's rule and the reason
// this reader takes the shared parser rather than reading process.argv itself.
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
const APP_REL = 'apps/web/app';
/** The subtrees whose pages are operator surfaces. */
const CONSOLE_ROOTS = ['admin', 'merchant'];

/** CJK ideographs. Punctuation is out of scope on purpose: a fullwidth comma is not a claim about copy. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** `generateMetadata` is what makes a page's own directive possible at all. */
const METADATA = /export\s+(?:async\s+)?function\s+generateMetadata\b/;
/** The override itself. Anything but `index: false` leaves the root layout's `index: true` standing. */
const NOINDEX = /robots\s*:\s*\{[^}]*\bindex\s*:\s*false\b/;

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

/** Line numbers holding an ideograph that no comment covers. */
function inlineCopy(text) {
  const spans = commentSpans(text);
  const lines = new Set();
  for (const m of text.matchAll(CJK)) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    lines.add(text.slice(0, m.index).split('\n').length);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Every `page.tsx` under `dir`, as paths relative to the app root, read with literal names so `[id]` works. */
function pagesUnder(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) pagesUnder(abs, out);
    else if (e.isFile() && e.name === 'page.tsx') out.push(abs);
  }
  return out;
}

const all = pagesUnder(APP).sort();
// A census that read no file at all is a refusal, not a pass (D79): the plane may simply be wrong.
if (all.length === 0) fail(`no page.tsx was read under ${join(APP_REL)} in ${PLANE} — nothing was censused, so nothing can be reported green`);

const consolePages = all.filter((abs) => {
  const rel = relative(APP, abs).replace(/\\/g, '/');
  return CONSOLE_ROOTS.some((r) => rel.startsWith(`${r}/`));
});

const offenders = [];
for (const abs of all) {
  const rel = relative(APP, abs).replace(/\\/g, '/');
  const text = readFileSync(abs, 'utf8');
  const isConsole = consolePages.includes(abs);
  const copyLines = inlineCopy(text);

  if (copyLines.length > 0) {
    offenders.push(`${rel} — inline copy outside a comment: ${copyLines.length} line(s) hold a CJK ideograph (${copyLines.slice(0, 6).join(', ')}${copyLines.length > 6 ? ', ...' : ''})`);
  }
  if (isConsole) {
    if (!METADATA.test(text)) offenders.push(`${rel} — operator surface with no generateMetadata of its own, so it inherits the root layout's index: true`);
    else if (!NOINDEX.test(text)) offenders.push(`${rel} — operator surface whose generateMetadata does not override robots with index: false`);
  }
  if (VERBOSE) {
    const mark = copyLines.length === 0 && (!isConsole || NOINDEX.test(text)) ? 'held  ' : 'BREAK ';
    console.log(`  ${mark} ${rel}${isConsole ? '  [console]' : '  [public]'}  copy-lines=${copyLines.length}`);
  }
}

console.log('NEXUS — the console pages\' i18n promise, censused rather than asserted');
console.log(`  plane read           ${PLANE}`);
console.log(`  pages censused       ${all.length} page.tsx under ${APP_REL} (${consolePages.length} console, ${all.length - consolePages.length} public)`);
console.log(`  noindex promise      ${consolePages.length} console page(s); ${consolePages.filter((abs) => NOINDEX.test(readFileSync(abs, 'utf8'))).length} declare index: false`);
console.log(`  inline-copy promise  every page censused for CJK ideographs outside comments; ${offenders.length} offender(s)`);

if (offenders.length > 0) {
  console.log(`\nOFFENDERS (${offenders.length}):`);
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`\nRESULT: FAIL — ${offenders.length} console/i18n offender(s)`);
  process.exit(1);
}
console.log('\nRESULT: PASS — every page carries its copy in the dictionary, and every operator surface is noindex');
