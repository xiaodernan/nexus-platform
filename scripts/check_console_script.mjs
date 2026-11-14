#!/usr/bin/env node
/**
 * NEXUS D1127 — the console fixture plane's script auditor.
 *
 * The other census (`check_ui_script.mjs`) charges the four zh dict carriers and the matcher
 * vocabulary. It explicitly does NOT charge the console fixtures (the admin + merchant screens),
 * which hold the product's operating surface — pages whose strings go to real operators today — and
 * which had drifted into Simplified Chinese alongside Traditional in the same object (D1126).
 *
 * This reader holds the SAME law on the console plane, stated the same way:
 *   every string literal in the console fixture files must write Traditional Chinese,
 *   checked against the same two pair tables the product already maintains.
 *
 * POPULATION (all-or-nothing; structural, not a ban list):
 *   apps/web/src/lib/console-fixtures.ts   — the admin/coaching screens' fixture prose
 *   apps/web/src/lib/console-merchant.ts   — the merchant console's fixture prose
 *   apps/web/src/lib/format.ts             — the shared formatter (its zh literals render everywhere)
 *   apps/web/src/lib/console-*.ts          — any future console fixture by the same glob
 *
 * NOT CHARGED: comments (English prose may discuss Chinese words), test files, and the en half of any
 * locale-keyed map (the map's boolean membership is by `zh*` key position — unreachable here because
 * every carrier file already declares zh directly, and one says so at the top).
 *
 * Same three exclusions as the sister reader (台, 面, 嘅), same union gate rigour, same exit codes:
 *   0 — every literal is clean Traditional script
 *   1 — at least one Simplified spelling; lines printed
 *   2 — malformed plane (missing file, empty pair table, unparseable fixture)
 *
 * Usage: node scripts/check_console_script.mjs [--verbose]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';
import { readPairTable } from './check_ui_script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGS = {
  '--plane': { kind: 'value', unit: 'directory' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) {
  console.error(`check_console_script.mjs: ${parsed.reason}`);
  process.exit(2);
}
const VERBOSE = parsed.switches.includes('--verbose');
const REPO = parsed.value['--plane'] ? resolve(parsed.value['--plane']) : resolve(HERE, '..');

/** The same three exclusions, stated once and printed with their counts so a dead exclusion is visible. */
const EXCLUDE = new Set(['台', '面', '嘅']);

/**
 * Usage: node scripts/check_console_script.mjs [--plane <dir>] [--verbose]
 *   --plane <dir>  Run against a scratch plane (used by the falsifier's arms); defaults to the repository.
 */
function population() {
  const dir = join(REPO, 'apps/web/src/lib');
  const names = existsSync(dir)
    ? readdirSync(dir).filter((n) => (/^console[-_].*\.ts$/.test(n) || n === 'format.ts') && !n.endsWith('.test.ts'))
    : [];
  return names.map((n) => join(dir, n));
}

/**
 * Every string literal in `src`, skipping comments and tracking template-literal `${...}` honestly.
 * Errors toward finding copy (an unterminated construct swallows to EOF — same discipline as the
 * sister readers) rather than toward silently passing a file.
 */
function stringLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const noteNewline = (ch) => { if (ch === '\n') line += 1; };

  let inLineComment = false;
  let inBlockComment = false;
  let template = 0; // template-literal nesting depth
  let inTemplateString = false;

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Handle line comment
    if (!inBlockComment && ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // Handle block comment
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        noteNewline(src[i]);
        i += 1;
      }
      i = Math.min(n, i + 2);
      inBlockComment = false;
      continue;
    }
    // Strings
    if (ch === "'" || ch === '"' || (ch === '`' && !inTemplateString)) {
      const quote = ch;
      i += 1;
      const startLine = line;
      let literal = '';
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') {
          literal += c + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === quote) { closed = true; i += 1; break; }
        if (c === '\n' && quote !== '`') break; // unterminated single/double — stop, report later
        literal += c;
        noteNewline(c);
        i += 1;
      }
      if (quote === '`') inTemplateString = template > 0; // ends when closing backtick matched
      out.push({ literal, line: startLine });
      continue;
    }
    if (ch === '`' && inTemplateString) {
      inTemplateString = template > 0;
    }
    noteNewline(ch);
    i += 1;
  }
  return out;
}

function read() {
  const { table, detail, problems } = readPairTable(REPO);
  const files = population();
  if (files.length === 0) problems.push('no console fixture plane found — population is empty, nothing to charge');
  if (problems.length) {
    for (const p of problems) console.error('check_console_script.mjs: ' + p);
    process.exit(2);
  }
  return { table, detail, files };
}

const { table, detail, files } = read();

const offenders = [];
const perFile = new Map();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const { literal, line } of stringLiterals(src)) {
    const bad = [];
    for (const ch of literal) {
      if (EXCLUDE.has(ch)) continue;
      if (table.has(ch)) bad.push(ch);
    }
    if (bad.length) {
      const entry = { file: relative(REPO, file), line, bad, sample: literal.slice(0, 96) };
      offenders.push(entry);
      perFile.set(relative(REPO, file), (perFile.get(relative(REPO, file)) ?? 0) + bad.length);
    }
  }
}

const total = offenders.reduce((acc, e) => acc + e.bad.length, 0);
const rel = (s) => s; // already repo-relative
console.log(`check_console_script.mjs — ${files.length} carrier(s), pairs canonical ${detail.canonical} / lexicon ${detail.lexicon}`);
if (total === 0) {
  console.log('RESULT: PASS — 0 simplified character(s) over the console fixture plane');
  process.exit(0);
}
for (const e of offenders.slice(0, VERBOSE ? offenders.length : 30)) {
  console.error(`FAIL ${rel(e.file)}:${e.line}  ${JSON.stringify(e.bad.join(''))}  :: "${e.sample}"`);
}
console.log(`RESULT: FAIL — ${total} simplified character(s) in ${offenders.length} literal(s)`);
process.exit(1);
