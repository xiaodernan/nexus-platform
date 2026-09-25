#!/usr/bin/env node
/**
 * NEXUS — the jsonb-key read census (§81 residue (a)).
 *
 * WHY THIS EXISTS. `data/seed/quality.sql` (D84) refuses a jsonb key the build reads but no shipped payload
 * carries — the failure mode where a read returns nothing and the branch around it decides quietly. Its read
 * list, however, was **hand-transcribed from `col->>'key'` occurrences in the SQL strings**, and §81 recorded
 * that as the row's own residue: "a read made through `Json.str(row.get(...))` or a Java-side constant is
 * invisible to it, so widening the grep is owed to this row".
 *
 * This script is that widening. It finds reads in three shapes and reports the ones the SQL list does not
 * declare:
 *
 *   1. SQL          `alias.col->>'key'` / `alias.col->'key'` inside a Java text block
 *   2. Java accessor `Map<String,Object> seo = Json.jsonObject(row, "seo"); … seo.get("key")`
 *   3. Java nested  `cover.get("url")` where `cover` came out of such a map (reported as `key.subkey`)
 *
 * WHAT IT IS NOT, stated because a census that hides its own blind spots is the thing this project keeps
 * catching: it is a **textual** scan, not a type-aware one. A key reached through a helper
 * (`token(seo.get(field), …)`), a key named by a constant, or a map built in another file is still
 * invisible. It errs toward reporting, not toward silence: an unmatched accessor is listed with its site so
 * a human can judge it, and the run prints its own limits rather than implying completeness.
 *
 * USAGE
 *   node scripts/check_jsonb_reads.mjs            # report; exit 1 if a read is undeclared
 *   node scripts/check_jsonb_reads.mjs --report   # report only, always exit 0
 *
 * `scripts/db_gate_fresh.sh` runs this as its seventh step, so a widening of the build's jsonb reads reddens
 * the same one-command gate that reddens a broken seed. A missing `node` fails that step rather than skipping
 * it: a census whose second reader silently did not start is greener than it is.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const QUALITY_SQL = 'data/seed/quality.sql';
const SOURCE_ROOTS = ['services/platform/src/main/java', 'apps/ai/nexus_ai'];
const REPORT_ONLY = process.argv.includes('--report');
const VERBOSE = process.argv.includes('--verbose');

/* ------------------------------------------------------------------ declared */

/** Slice of `sql` from `from` (inclusive) to the next occurrence of `marker` after it. */
function sliceTo(sql, from, marker) {
  const end = sql.indexOf(marker, from + 1);
  return end < 0 ? sql.slice(from) : sql.slice(from, end);
}

/**
 * The (tbl, col, key) triples the gate answers for, parsed out of the `VALUES` list inside quality.sql's
 * `DO` block, plus each triple's kind from the answer table below it.
 */
function declaredReads() {
  const sql = readFileSync(join(ROOT, QUALITY_SQL), 'utf8');
  // The list lives in the `FOR p IN SELECT * FROM (VALUES …) v(tbl, col, key)`, not in an INSERT: the INSERT is
  // inside the loop and takes the loop's variables. Anchoring on the loop is what makes this parse the
  // literals rather than the placeholders.
  const start = sql.indexOf('FOR p IN SELECT * FROM (VALUES');
  if (start < 0) {
    throw new Error(`Could not find the read_cat VALUES list in ${QUALITY_SQL}`);
  }
  const end = sql.indexOf(') v(tbl, col, key)', start);
  if (end < 0) {
    throw new Error(`The read_cat VALUES list in ${QUALITY_SQL} has no column alias to close on`);
  }
  const kindsAt = sql.indexOf('INSERT INTO read_answer VALUES');
  if (kindsAt < 0) {
    throw new Error(`Could not find the read_answer table in ${QUALITY_SQL}`);
  }
  const kinds = new Map();
  for (const m of sliceTo(sql, kindsAt, '\nINSERT INTO qc\n').matchAll(
    /^\s*\(\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_.]+)',\s*'([a-z-]+)'/gm,
  )) {
    kinds.set(`${m[1]}.${m[2]}.${m[3]}`, m[4]);
  }
  const triples = new Map();
  for (const m of sql.slice(start, end).matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_.]+)'\)/g)) {
    triples.set(`${m[1]}.${m[2]}.${m[3]}`, null);
  }
  for (const triple of triples.keys()) {
    triples.set(triple, kinds.get(triple) ?? null);
  }
  return triples;
}

/* ------------------------------------------------------------------ found */

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === '__pycache__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(java|py)$/.test(name)) out.push(full);
  }
  return out;
}

/** Words that can follow `FROM`/`JOIN` in these text blocks but are never a table alias. */
const NOT_AN_ALIAS = new Set(['on', 'where', 'group', 'order', 'limit', 'offset', 'using', 'set', 'values',
  'as', 'inner', 'left', 'right', 'full', 'cross', 'join', 'lateral', 'having', 'returning', 'for']);

/**
 * Shape 1 — the SQL form. The column is the identifier before `->>`, the alias in front of it is resolved
 * through the FROM/JOIN aliases declared in the same file, which is what lets this reader contradict an
 * answer that points a real clause at the wrong table (`c.seo->>'generated_by'` is a read on collections,
 * because `FROM` says `from collections c` — D85's first finding).
 */
function sqlReads(text, aliasToTable) {
  const found = [];
  const pattern = /\b(?:([a-z_][a-z0-9_]*)\.)?([a-z_]+)\s*->>?\s*'([a-z_]+)'/g;
  for (const m of text.matchAll(pattern)) {
    found.push({ table: m[1] ? aliasToTable.get(m[1]) ?? null : null, col: m[2], key: m[3] });
  }
  return found;
}

/** `from collections c`, `join merchants m on …`, `from public.facts f` — alias to table, per file. */
function aliasMap(text) {
  const map = new Map();
  for (const m of text.matchAll(/\b(?:from|join)\s+(?:[a-z_]+\.)?([a-z_]+)\s+(?:as\s+)?([a-z_][a-z0-9_]*)\b/gi)) {
    if (!NOT_AN_ALIAS.has(m[2].toLowerCase())) map.set(m[2], m[1]);
  }
  return map;
}

/**
 * Shapes 2 and 3 — a jsonb column materialised into a Java map, then read by key.
 *
 * The binding is matched per file and per variable name, which is exactly the approximation: a variable
 * reused for two columns in one file would attribute both keys to both columns, so the report names the
 * variable and the line and lets a human see it rather than guessing silently.
 */
function accessorReads(text) {
  const found = [];
  const bindings = new Map();
  const bindPattern = /(?:[A-Za-z<>,.\s]+?)\s+([a-z][A-Za-z0-9_]*)\s*=\s*(?:new\s+LinkedHashMap<[^>]*>\s*\(\s*)?Json\.jsonObject\(\s*[A-Za-z0-9_.()]+,\s*"([a-z_]+)"\s*\)/g;
  for (const m of text.matchAll(bindPattern)) {
    bindings.set(m[1], m[2]);
  }
  for (const [variable, col] of bindings) {
    // `getOrDefault` is the same read with a fallback: the key is still absent, it just does not throw a
    // null at the caller. Missing it would have hidden `degraded` and `proposals` on documents.metadata.
    const readPattern = new RegExp(`\\b${variable}\\.get(?:OrDefault)?\\(\\s*"([a-z_]+)"\\s*[,)]`, 'g');
    for (const m of text.matchAll(readPattern)) {
      found.push({ table: null, col, key: m[1], via: variable });
    }
    // A nested object lifted out of the same map: `cover.get("url")` where cover = seo.get("cover").
    const nestedPattern = new RegExp(
      `\\b(?:[A-Za-z<>,.\\s]+?)\\s+([a-z][A-Za-z0-9_]*)\\s*=\\s*${variable}\\.get\\(\\s*"([a-z_]+)"\\s*\\)`,
      'g',
    );
    for (const m of text.matchAll(nestedPattern)) {
      const inner = new RegExp(`\\b${m[1]}\\.get\\(\\s*"([a-z_]+)"\\s*\\)`, 'g');
      for (const n of text.matchAll(inner)) {
        found.push({ table: null, col, key: `${m[2]}.${n[1]}`, via: `${variable}.${m[2]}` });
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ run */

const declared = declaredReads();      // Map 'tbl.col.key' -> kind (null when the answer table has no row)
const files = SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root)));
const found = new Map();               // 'col.key' -> { col, key, tables:Set, sites:Set }
let total = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const site = relative(ROOT, file).replace(/\\/g, '/');
  const aliases = aliasMap(text);
  for (const read of [...sqlReads(text, aliases), ...accessorReads(text)]) {
    total += 1;
    const pair = `${read.col}.${read.key}`;
    const cell = found.get(pair)
      ?? { col: read.col, key: read.key, tables: new Set(), sites: new Set() };
    if (read.table) cell.tables.add(read.table);
    cell.sites.add(site);
    found.set(pair, cell);
  }
}

/**
 * The triples that answer one found read. Same column and key — or, for a nested leaf like `cover.url`, the
 * row for the object it hangs off, since the gate can only `?`-test a top-level key. When the read's table is
 * resolved from the FROM alias, the answer has to name THAT table: this is the rule that refutes an answer
 * pointing a real clause at a table the clause never runs over.
 */
function answers(cell) {
  const base = cell.key.includes('.') ? cell.key.split('.')[0] : cell.key;
  const hits = [];
  for (const triple of declared.keys()) {
    const [tbl, col, key] = triple.split('.');
    if (col !== cell.col || ![cell.key, base].includes(key)) continue;
    if (cell.tables.size > 0) {
      if (cell.tables.has(tbl)) hits.push(triple);
    } else {
      hits.push(triple);
    }
  }
  return hits;
}

function answersOf(pair) {
  return answers(found.get(pair));
}

const undeclared = [...found.keys()].filter((pair) => answersOf(pair).length === 0).sort();

/**
 * An answer naming a table the source contradicts, a `never-read` claim a read refutes, and an answer row with
 * no kind — all three are claims this scan can check without judging intent, so all three are fatal.
 */
const contradicted = [];
const neverReadRead = [];
const kindless = [];
const unseen = [];
for (const [triple, kind] of declared) {
  const [tbl, col, key] = triple.split('.');
  const cell = found.get(`${col}.${key}`);
  if (kind === null) kindless.push(triple);
  if (cell && cell.tables.size > 0 && !cell.tables.has(tbl)) {
    contradicted.push({ triple, tables: [...cell.tables].sort().join('|'), sites: [...cell.sites].join(', ') });
  }
  if (kind === 'never-read' && cell) neverReadRead.push(triple);
  if (!cell && kind !== 'never-read') unseen.push(triple);
}

console.log("NEXUS — jsonb key reads found in source, against the gate's declared list");
console.log(`  source files scanned        ${files.length}`);
console.log(`  read sites found            ${total}`);
console.log(`  distinct (column, key) read ${found.size}`);
console.log(`  declared in quality.sql     ${declared.size} triple(s)`);
console.log(`  tables resolved from FROM   ${[...found.values()].filter((c) => c.tables.size > 0).length}`
  + ` of ${found.size} read pair(s) — the rest are accessor reads, whose table is not in the text`);
console.log('');

if (VERBOSE) {
  console.log('EVERY READ THE SCAN FOUND (what the census below transcribes):');
  for (const pair of [...found.keys()].sort()) {
    const cell = found.get(pair);
    const tables = cell.tables.size > 0 ? [...cell.tables].sort().join('|') : 'table unknown';
    const answered = answers(cell);
    console.log(`  ${tables}.${cell.col} ? '${cell.key}'`
      + `  -> ${answered.length > 0 ? answered.join(', ') : 'NOT ANSWERED'}`
      + `  [${[...cell.sites].join(', ')}]`);
  }
  console.log('');
}

if (undeclared.length > 0) {
  console.log(`UNDECLARED — read by the build, not answered for by ${QUALITY_SQL} (${undeclared.length}):`);
  for (const pair of undeclared) {
    const cell = found.get(pair);
    const tables = cell.tables.size > 0 ? [...cell.tables].join('|') : 'table unknown';
    console.log(`  - ${tables}.${cell.col} ? '${cell.key}'   [${[...cell.sites].slice(0, 3).join(', ')}]`);
  }
  console.log('');
}

if (contradicted.length > 0) {
  console.log(`WRONG TABLE — answered for a table the read never runs over (${contradicted.length}):`);
  for (const row of contradicted) {
    console.log(`  - ${row.triple}: the source reads this column and key at ${row.tables}, not at `
      + `${row.triple.split('.')[0]}  [${row.sites}]`);
  }
  console.log('');
}

if (neverReadRead.length > 0) {
  console.log(`CALLED NEVER-READ, IS READ (${neverReadRead.length}):`);
  for (const triple of neverReadRead) console.log(`  - ${triple}`);
  console.log('');
}

if (kindless.length > 0) {
  console.log(`NO KIND — in the read list but not in read_answer (${kindless.length}):`);
  for (const triple of kindless) console.log(`  - ${triple}`);
  console.log('');
}

if (unseen.length > 0) {
  console.log(`NOT FOUND IN SOURCE (${unseen.length}) — stale answers, or reads outside what a textual scan`);
  console.log('can see; each is judged by hand, so this list is a report and not a failure:');
  for (const triple of unseen.sort()) console.log(`  - ${triple}`);
  console.log('');
}

console.log('LIMITS, stated rather than implied: this is a textual scan. A key reached through a helper,');
console.log('named by a constant, or built in another file is invisible to it, and a variable reused for two');
console.log('columns attributes both key sets to both columns. Table attribution is resolved only for SQL');
console.log('reads whose alias appears in a FROM/JOIN in the same file; an accessor read is matched on');
console.log('(column, key) alone, so one answer covers that key on any table. It errs toward reporting.');

process.exit((undeclared.length + contradicted.length + neverReadRead.length + kindless.length) > 0
  && !REPORT_ONLY ? 1 : 0);
