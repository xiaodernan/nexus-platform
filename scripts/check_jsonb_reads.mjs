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
 * THE SECOND THING IT CHECKS — `site` citations (D87). Both answer tables (`read_answer`, `shape_answer`)
 * carry a hand-written `site` column of `File.java:NNN` citations, and until now the gate refused a *blank*
 * site and nothing more. D86 shipped three sites that were false while its row was green, so the citations
 * are now read back out of the shipped source and judged: a cited file has to exist and be unambiguous, its
 * line has to be inside the file, the line has to mention the table/column/key the row is about, the file has
 * to name the row's table at all, and any source text quoted inside a site has to be on the line it cites.
 * See `checkSites` below for the arms and their stated limits.
 *
 * USAGE
 *   node scripts/check_jsonb_reads.mjs                  # report; exit 1 if a read is undeclared or a site is false
 *   node scripts/check_jsonb_reads.mjs --report          # report only, always exit 0
 *   node scripts/check_jsonb_reads.mjs --verbose         # print every read the scan found, with its sites
 *   node scripts/check_jsonb_reads.mjs --quality=<path>  # census this copy of the seed gate instead of
 *   node scripts/check_jsonb_reads.mjs --quality <path>  # data/seed/quality.sql — BOTH spellings work (D156)
 *   node scripts/check_jsonb_reads.mjs --roots=a,b       # census these source roots instead of the two the
 *                                                       # script names — the seam that makes the census's own
 *                                                       # population reachable, so its coverage guard can be
 *                                                       # witnessed without editing shipped bytes (D193)
 *
 * A flag this reader does not parse, and a `--quality` whose value is empty, are a refusal with exit 2 and not a
 * silence. Before D156 only the `=` spelling was read, so `--quality <plant>` censused the SHIPPED file and
 * printed a truthful PASS about a plane nobody aimed at — the defect D154 fixed in `check_status_citations.mjs`
 * and D155 in `check_ledger_sections.mjs`, here in its third instance. A `--quality` that names a path with no
 * file behind it, or a directory, is the same class of refusal (D194): it used to travel forty lines to
 * `readFileSync` and die there, exit 1 with a stack, which is this step's code for a read or a site that is wrong.
 *
 * WHAT THE LAST LINE IS FOR (D194). A finished run prints `REPORT COMPLETE — N reason(s) to redden, --report b,
 * this run exits C` as its last line, naming the reason count and the code it then takes. The header at the top of
 * the report is not the end of it: an arm scoring this output needed one line stating that the census reached its
 * verdict. Alongside it the unused answer kinds joined the exit term — that block had spent its whole life printing
 * a sentence and exiting 0, which is what D193 stopped doing for the out-of-roots coverage block.
 *
 * `scripts/db_gate_fresh.sh` runs this as its seventh step, so a widening of the build's jsonb reads — or a
 * site citation that the source contradicts — reddens the same one-command gate that reddens a broken seed. A
 * missing `node` fails that step rather than skipping it: a census whose second reader silently did not start
 * is greener than it is.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SOURCE_EXT, VENDOR_DIRS, walkFiles } from './source_index.mjs';
import { parseFlags } from './cli_args.mjs';

const ROOT = process.cwd();
/**
 * `--quality=<path>` / `--quality <path>` points the census at a different copy of the seed gate. It exists for
 * this script's own witnesses: a plant has to change an answer row, and a plant that edits the tracked file
 * races any gate that is loading it. D156 made the second spelling work, gave the step an in-gate knob
 * (`GATE_QUALITY_SQL` in `scripts/db_gate_fresh.sh`), and turned an unread flag into a refusal — the flag was
 * documented here as "Nothing in the gate itself passes the flag" for exactly one reason: nothing did.
 */
const notCheckable = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };

// D159: this file kept TWO dialects in one reader — `--quality` was parsed by its own loop, while `--report` and
// `--verbose` were answered by `process.argv.includes(...)`. Measured on HEAD before the patch, that made one
// request behave four ways: `--quality --report` ended in an uncaught ENOENT for a file literally named
// `--report` and exit 1 (a crash where a refusal belongs — a mistyped request reporting a finding it never
// computed), `--report=1` and `--verbose=1` were both accepted silently and answered exit 0 with the
// non-verbose report, and only a genuinely unknown name refused. The table below is the single source now, and
// the parser is the shared one, so a reader cannot re-invent the bug by re-inventing the loop.
const FLAGS = {
  '--quality': { kind: 'value', unit: 'path' },
  '--roots': { kind: 'value', unit: 'comma-separated source roots' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) notCheckable(parsed.reason);

const QUALITY_SQL = parsed.value['--quality'] ?? 'data/seed/quality.sql';
// D194: a `--quality` that names nothing readable used to reach `readFileSync` fifty lines later and die there,
// which is exit 1 wearing a stack trace — this directory's code for "a read or a site is wrong". D159 had made
// the request legal (a mistyped flag value now refuses), so nothing between a legal request and the verdict said
// the file is simply not there. Measured before this guard: a missing path and a directory both exit 1 with
// `node:fs` frames, and only a file that exists but holds no answers refused at 2.
const QUALITY_PATH = resolve(ROOT, QUALITY_SQL);
const qualityEntry = statSync(QUALITY_PATH, { throwIfNoEntry: false });
if (!qualityEntry) {
  notCheckable(`${QUALITY_PATH} is not there — the census was pointed at a path with no file behind it, so it has`
    + ' no answers to read and can neither agree nor disagree with any');
}
if (!qualityEntry.isFile()) {
  notCheckable(`${QUALITY_PATH} is a ${qualityEntry.isDirectory() ? 'directory' : 'thing that is not a regular'
    + ' file'}, not the seed gate — the census reads one text file and was handed something else`);
}
const SOURCE_ROOTS = ['services/platform/src/main/java', 'apps/ai/nexus_ai'];
// D193: which directories the READ census walks. It is a flag now because the census's own coverage claim is
// only testable if its population can be narrowed from outside the shipped bytes: `unseen` used to excuse every
// miss as "outside what a textual scan can see", and a scan pointed at one subtree would then report a green
// over 0 files read. The default is unchanged; `--roots` exists for this script's witnesses.
const CENSUS_ROOTS = parsed.value['--roots'] === undefined
  ? SOURCE_ROOTS
  : parsed.value['--roots'].split(',').map((r) => r.trim()).filter((r) => r !== '');
if (CENSUS_ROOTS.length === 0) {
  notCheckable('--roots was given but names no directory — a census that walks nothing would report every '
    + 'declared answer as a read its scan cannot see, which is a refusal, not a verdict');
}
const REPORT_ONLY = parsed.switches.includes('--report');
const VERBOSE = parsed.switches.includes('--verbose');

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
  const sql = readFileSync(resolve(ROOT, QUALITY_SQL), 'utf8');
  // The list lives in the `FOR p IN SELECT * FROM (VALUES …) v(tbl, col, key)`, not in an INSERT: the INSERT is
  // inside the loop and takes the loop's variables. Anchoring on the loop is what makes this parse the
  // literals rather than the placeholders.
  const start = sql.indexOf('FOR p IN SELECT * FROM (VALUES');
  if (start < 0) {
    notCheckable(`could not find the read_cat VALUES list in ${QUALITY_SQL} — this census has no declared list `
      + 'to read, so it can neither agree nor disagree with one');
  }
  const end = sql.indexOf(') v(tbl, col, key)', start);
  if (end < 0) {
    notCheckable(`the read_cat VALUES list in ${QUALITY_SQL} has no column alias to close on — the parse would `
      + 'run to the end of the file and call whatever it reached a declaration');
  }
  const kindsAt = sql.indexOf('INSERT INTO read_answer VALUES');
  if (kindsAt < 0) {
    notCheckable(`could not find the read_answer table in ${QUALITY_SQL} — no answer rows means nothing to `
      + 'contradict, and a census that answers nothing is not a green');
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

/* ------------------------------------------------------------------ sites */

/**
 * The file index the site census resolves against. It lives in `source_index.mjs` because D88's ledger checker
 * asks the same question of the same repository, and §84's residue (e) named two hand lists drifting as the
 * hazard: the checker's first run resolved `PermissionService` to a `.class` file under a build directory the
 * old local list had never heard of.
 */
const sourceIndex = () => walkFiles(ROOT, (name) => SOURCE_EXT.test(name));

/**
 * `-- comment` text is stripped before parsing, but only outside a string literal: a comment's semicolon
 * would otherwise read as the end of the VALUES list and silently drop every row after it. This is not
 * hypothetical — the `-- The mirror of every row above: … as `reachable`; D84 then …` comment inside the
 * read_answer list ends with a `;`, and a comment-blind first version of this parser lost the 17th row.
 */
function stripSqlComments(text) {
  let out = '';
  let inLit = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inLit) {
      out += c;
      if (c === "'") {
        if (text[i + 1] === "'") {
          out += text[i + 1];
          i += 1;
        } else {
          inLit = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inLit = true;
      out += c;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** The top-level `( … )` rows of a VALUES list, as cell arrays with the SQL string literals concatenated. */
function valuesRows(sql, insertMarker, table) {
  const text = stripSqlComments(sql);
  const at = text.indexOf(insertMarker);
  if (at < 0) notCheckable(`could not find "${insertMarker}" in ${QUALITY_SQL} — the ${table} rows this census `
    + 'checks were never read');
  let i = text.indexOf('VALUES', at) + 'VALUES'.length;
  const rows = [];
  let depth = 0;
  let from = 0;
  let inLit = false;
  let closeAt = -1;
  let endAt = -1;
  while (i < text.length) {
    const c = text[i];
    if (inLit) {
      if (c === "'") {
        if (text[i + 1] === "'") i += 1;
        else inLit = false;
      }
      i += 1;
      continue;
    }
    if (c === "'") {
      inLit = true;
    } else if (c === '(') {
      if (depth === 0) from = i + 1;
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        rows.push(text.slice(from, i));
        closeAt = i;
      }
    } else if (c === ';' && depth === 0) {
      endAt = i;
      break;
    }
    i += 1;
  }
  // A list that ended anywhere other than just after a row's own `)` means this parse stopped early — which
  // would silently check fewer rows than the file ships. Report the count rather than the smaller green.
  if (endAt >= 0 && text.slice(closeAt + 1, endAt).trim() !== '') {
    notCheckable(`the ${table} VALUES list in ${QUALITY_SQL} ended somewhere a row was not closing — `
      + 'the parser cannot trust its own row count, and a census over fewer rows than the file ships is a '
      + 'smaller green, not a true one');
  }
  return rows.map((row) => {
    const cells = [];
    let cur = '';
    let cd = 0;
    let cl = false;
    for (const c of row) {
      if (cl) {
        cur += c;
        if (c === "'") cl = false;
        continue;
      }
      if (c === "'") {
        cl = true;
        cur += c;
        continue;
      }
      if (c === '(') cd += 1;
      if (c === ')') cd -= 1;
      if (c === ',' && cd === 0) {
        cells.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cells.push(cur);
    // `'a' || <newline> || 'b'` is one value: concatenate its literals and unquote `''`.
    return cells.map((cell) => [...cell.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
      .join(''));
  });
}

/** A citation token: `File.java:NN`, `dir/File.java:NN-NN`, `File.java`, or a bare `:NN` after a file. */
const CITE_RE = /(?:[a-z_]+\/)*[A-Za-z0-9_]+\.(?:java|py|ts|tsx|mjs|cjs|sql|sh)(?::\d+(?:-\d+)?(?:\s*,\s*:\d+(?:-\d+)?)*)?|:\d+(?:-\d+)?(?:\s*,\s*:\d+(?:-\d+)?)?/g;

/** Every `file[:lines]` mention in a site string, bare `:NN` continuations carrying the file before them. */
function citations(text) {
  const out = [];
  let file = null;
  for (const m of text.matchAll(CITE_RE)) {
    const tok = m[0];
    if (tok.startsWith(':')) {
      if (file) file.spans.push(...tok.match(/\d+(?:-\d+)?/g));
      continue;
    }
    const cut = tok.indexOf(':');
    const name = cut < 0 ? tok : tok.slice(0, cut);
    const spans = cut < 0 ? [] : [...tok.slice(cut + 1).matchAll(/\d+(?:-\d+)?/g)].map((s) => s[0]);
    file = { name, spans, raw: tok };
    out.push(file);
  }
  return out;
}

/**
 * The seven ways a site citation can be false, all of them checked against the shipped source rather than
 * against another hand-written list. Rules 1-3 run over `site` AND `why`; 4-7 over `site` only, because a
 * `why` may legitimately point at neighbouring code that is not the row's own subject (and one does: the
 * `offerings.options` answer cites `order_items.options` precisely to say it is a different column).
 */
function checkSites() {
  const sql = readFileSync(resolve(ROOT, QUALITY_SQL), 'utf8');
  const files = sourceIndex();
  const byName = new Map();
  for (const rel of files) {
    const base = rel.split('/').pop();
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(rel);
  }
  const lines = new Map();
  const read = (rel) => {
    if (!lines.has(rel)) lines.set(rel, readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/));
    return lines.get(rel);
  };
  const mentions = (rel, word) => new RegExp(`\\b${word}\\b`).test(read(rel).join('\n'));

  const answerTables = [
    { table: 'read_answer', marker: 'INSERT INTO read_answer VALUES', width: 6 },
    { table: 'shape_answer', marker: 'INSERT INTO shape_answer VALUES', width: 5 },
  ];
  const offenders = [];
  const stats = { rows: 0, cited: 0, files: new Set(), linesRead: new Set(), numbered: 0,
    rowSites: new Map(), kinds: new Map() };
  const counts = {};

  for (const spec of answerTables) {
    const rows = valuesRows(sql, spec.marker, spec.table);
    counts[spec.table] = rows.length;
    for (const cells of rows) {
      if (cells.length !== spec.width) {
        offenders.push(`${spec.table} row parsed as ${cells.length} cells, not ${spec.width}: `
          + `"${cells.slice(0, 3).join('.')}" — the parse cannot be trusted, so the site is not checked`);
        continue;
      }
      stats.rows += 1;
      const [tbl, col] = cells;
      const key = spec.width === 6 ? cells[2] : null;
      const subject = key ? [tbl, col, key] : [tbl, col];
      const site = spec.width === 6 ? cells[4] : cells[3];
      const why = spec.width === 6 ? cells[5] : cells[4];
      const rowId = `${spec.table} ${subject.join('.')}`;
      if (spec.table === 'read_answer') stats.kinds.set(rowId, cells[3]);

      for (const [field, text, content] of [['site', site, true], ['why', why, false]]) {
        const cites = citations(text);
        const resolved = [];
        // D193: where each citation of a `site` actually landed. The absence classes below need the difference
        // between "no file on this plane by that name", "more than one file" and "a file this census does not
        // walk" — three reasons a human would answer differently, all of them decidable here.
        const outcomes = [];
        for (const cite of cites) {
          stats.cited += 1;
          const cands = cite.name.includes('/')
            ? files.filter((rel) => rel === cite.name || rel.endsWith(`/${cite.name}`))
            : (byName.get(cite.name.split('/').pop()) ?? []);
          if (cands.length === 0) {
            outcomes.push({ name: cite.name, outcome: 'missing' });
            offenders.push(`${rowId} cites ${cite.name} in ${field} — no file in the ${files.length}-file source `
              + 'index has that path or that name');
            continue;
          }
          if (cands.length > 1) {
            outcomes.push({ name: cite.name, outcome: 'ambiguous', cands });
            offenders.push(`${rowId} cites ${cite.name} in ${field} — the name is ambiguous, ${cands.length} `
              + `files hold it: ${cands.slice(0, 4).join(', ')}${cands.length > 4 ? ', …' : ''}`);
            continue;
          }
          const rel = cands[0];
          outcomes.push({ name: cite.name, outcome: 'resolved', rel });
          const file = read(rel);
          stats.files.add(rel);
          resolved.push({ rel, cite, file });
          // Structure first, and it runs over `why` too: a range that runs backwards or past the end of the
          // file is false wherever it is written. (A first version put these checks behind the `content`
          // guard below, and two plants against the `why` column came back green.)
          for (const span of cite.spans) {
            const [a, b] = span.split('-').map(Number);
            const lo = a;
            const hi = b ?? a;
            if (b !== undefined && b < a) {
              offenders.push(`${rowId} cites ${rel}:${span} in ${field} — the range runs backwards`);
              continue;
            }
            if (hi > file.length) {
              offenders.push(`${rowId} cites ${rel}:${span} in ${field} — the file has ${file.length} lines`);
              continue;
            }
            if (!content) continue;
            const body = file.slice(lo - 1, hi).join('\n');
            const hit = subject.some((word) => new RegExp(`\\b${word}\\b`).test(body));
            if (!hit) {
              offenders.push(`${rowId} cites ${rel}:${span} but that line mentions none of ${subject.join('/')}`
                + `  [${file[lo - 1].trim().slice(0, 90)}]`);
            }
            for (let n = lo; n <= hi; n += 1) stats.linesRead.add(`${rel}:${n}`);
            stats.numbered += 1;
          }
          // Content next, and this is a claim only a `site` makes: a `why` may name neighbouring code on
          // purpose, which is how the `offerings.options` answer says `order_items.options` is not it.
          if (!content) continue;
          if (!mentions(rel, tbl)) {
            offenders.push(`${rowId} answers for the table ${tbl} but cites ${rel} in ${field}, which never `
              + `names "${tbl}" anywhere in its ${file.length} lines`);
          }
          if (cite.spans.length === 0) {
            offenders.push(`${rowId} cites ${rel} in ${field} with no line number, so nothing here can be `
              + 'checked against it — a file alone is not a site');
          }
        }
        if (content) {
          if (cites.length === 0) {
            offenders.push(`${rowId} gives the site "${site}" — no source citation in it at all`);
          } else if (!cites.some((c) => c.spans.length > 0)) {
            offenders.push(`${rowId} names ${cites.map((c) => c.name).join(', ')} as its site and not one of `
              + 'them carries a line number, so the claim cannot be checked');
          }
          for (const quoted of [...site.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])) {
            const text2 = resolved.map(({ rel, cite }) => {
              const file = read(rel);
              return cite.spans.flatMap((s) => {
                const [a, b] = s.split('-').map(Number);
                return file.slice(a - 1, b ?? a);
              }).join('\n');
            }).join('\n');
            if (!new RegExp(`"${quoted}"`).test(text2)) {
              offenders.push(`${rowId} quotes "${quoted}" in its site but none of the lines it cites contains `
                + `"${quoted}"  [${site.slice(0, 110)}]`);
            }
          }
        }
        // Only a read_answer row has a kind, and only its `site` names the code the read census should reach;
        // a `why` may point at neighbouring code on purpose, which is not where its read lives.
        if (content && spec.table === 'read_answer') stats.rowSites.set(rowId, outcomes);
      }
    }
  }
  return { offenders, stats, counts };
}

/* ------------------------------------------------------------------ run */

const declared = declaredReads();      // Map 'tbl.col.key' -> kind (null when the answer table has no row)
const sites = checkSites();            // { offenders, stats, counts } — every file:line the answers cite
const files = CENSUS_ROOTS.flatMap((root) => walk(join(ROOT, root)));
const found = new Map();               // 'col.key' -> { col, key, tables:Set, sites:Set }
let total = 0;

// D193's own floor, read from the same walk it protects: a census that opened no file has no sight, so every
// answer would land in a bucket and every bucket sentence would be about a run that read nothing. `--report`
// cannot silence this either — exit 2 says the reader could not answer, which is not the same claim as "the
// answers are wrong", and a green that a narrowed population can produce is not a green.
if (files.length === 0) {
  notCheckable(`the read census walked ${CENSUS_ROOTS.length} root(s) — ${CENSUS_ROOTS.join(', ')} — and opened `
    + '0 source file(s). Its "not found in source" list would be a list of what it never looked at');
}

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

// The floor one level inside the previous one: opening files is not the same as finding reads. With `found` empty
// this census has no second reader of the answer list, so every read-expected answer would print as a miss the
// run explains by its own blindness, and what remained measured was this script's parse of one SQL file.
if (found.size === 0) {
  notCheckable(`the read census opened ${files.length} file(s) under ${CENSUS_ROOTS.length} root(s) — `
    + `${CENSUS_ROOTS.join(', ')} — and found 0 jsonb read(s) in them. A scanner that finds nothing cannot`
    + ' contradict an answer list, it can only agree with it');
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
 * What each answer kind claims about the source text, so this census knows which of its own misses it should be
 * able to explain. D193 replaced the sentence that used to sit under this loop — "stale answers, or reads outside
 * what a textual scan can see; each is judged by hand" — because the misses it grouped had three different
 * reasons, two of them decidable by the run itself, and the bucket's membership changed between planes (measured
 * 0 on the working tree, 2 on a clean checkout of HEAD, both of them because the cited file is not committed).
 *
 * The keys are not a hand list of the vocabulary: `KINDS_SEEN` below is read out of the same parse of the shipped
 * answer rows, and a kind in that census with no entry here stops the run. D194 closed the other direction: an
 * entry with no kind reddens it, because a branch of this table that no row answers for is a rule this plane does
 * not have, and the run that prints the fact and then exits 0 is the pattern D193 made fatal for `--roots`.
 */
const READ_EXPECTED = {
  reachable: true,        // the key is read by shipped code, so the scan should find the read
  'dead-reader': true,    // the read is in the text; nothing calls the code that holds it
  'empty-by-guard': true, // the read is in the text; the table it reads is held empty
  'never-read': false,    // the mirror kind (quality.sql's own words): a key that ships and no read names
};

const KINDS_SEEN = new Map();          // kind -> the answer rows carrying it
for (const [rowId, kind] of sites.stats.kinds) {
  const list = KINDS_SEEN.get(kind) ?? [];
  list.push(rowId.replace(/^read_answer /, ''));
  KINDS_SEEN.set(kind, list);
}
const unkindedKinds = [...KINDS_SEEN.keys()].filter((k) => !(k in READ_EXPECTED)).sort();
const branchlessKinds = Object.keys(READ_EXPECTED).filter((k) => !KINDS_SEEN.has(k)).sort();

const contradicted = [];
const neverReadRead = [];
const kindless = [];
// A declared answer whose (column, key) the read census did not find, with the reason this run can give for it.
const misses = [];
const unattributed = [];
for (const [triple, kind] of declared) {
  const [tbl, col, key] = triple.split('.');
  const cell = found.get(`${col}.${key}`);
  if (kind === null) kindless.push(triple);
  if (cell && cell.tables.size > 0 && !cell.tables.has(tbl)) {
    contradicted.push({ triple, tables: [...cell.tables].sort().join('|'), sites: [...cell.sites].join(', ') });
  }
  if (kind === null) continue;
  if (READ_EXPECTED[kind] === false && cell) neverReadRead.push(triple);
  if (cell || READ_EXPECTED[kind] === false) continue;
  // From here: the answer expects a findable read and the scan found none. Its own `site` says where to look,
  // and the site census already resolved every citation in it — so the reason for the miss is in this process.
  const outcomes = sites.stats.rowSites.get(`read_answer ${triple}`);
  if (outcomes === undefined) {
    unattributed.push(triple);   // no parsed row: this run cannot say where it looked, so it may not excuse it
  } else if (outcomes.length === 0) {
    misses.push({ triple, kind, reason: 'site-names-no-file', detail: 'its site holds no source citation at all' });
  } else if (outcomes.every((o) => o.outcome === 'missing')) {
    misses.push({ triple, kind, reason: 'file-not-on-this-plane',
      detail: outcomes.map((o) => o.name).join(', ') });
  } else if (outcomes.some((o) => o.outcome === 'ambiguous') && !outcomes.some((o) => o.outcome === 'resolved')) {
    misses.push({ triple, kind, reason: 'site-file-ambiguous',
      detail: outcomes.filter((o) => o.outcome === 'ambiguous')
        .map((o) => `${o.name}: ${o.cands.slice(0, 3).join(', ')}`).join(' | ') });
  } else {
    const walked = outcomes.filter((o) => o.outcome === 'resolved')
      .map((o) => o.rel).filter((rel) => CENSUS_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`)));
    const elsewhere = outcomes.filter((o) => o.outcome === 'resolved')
      .map((o) => o.rel).filter((rel) => !walked.includes(rel));
    if (walked.length === 0) {
      misses.push({ triple, kind, reason: 'outside-the-census-roots', detail: elsewhere.join(', ') });
    } else {
      misses.push({ triple, kind, reason: 'not-read-in-the-file-where-it-should-be', detail: walked.join(', ') });
    }
  }
}

// The two directions of drift between this reader's table and the shipped vocabulary, which are two different
// facts. A kind on a row with no branch here is a refusal: the run would answer it by whichever branch happened
// to be last, so it has no verdict to give (the defect this project has now named three times). A branch here
// with no row on the plane is not a refusal — every row was judged, and what the judging found is that this
// census carries a rule nothing files an answer under, which reddens the run below rather than being printed
// above an exit 0.
if (unkindedKinds.length > 0) {
  notCheckable(`${QUALITY_SQL} answers with ${unkindedKinds.length} kind(s) this census has no expectation for: `
    + `${unkindedKinds.join(', ')} — refusing to guess whether a read should have been found in the source`);
}
if (unattributed.length > 0) {
  notCheckable(`${unattributed.length} declared triple(s) the read census did not find whose answer row this`
    + ` script parsed no site for, so it cannot say where it looked: ${unattributed.join(', ')} — an exemption`
    + ' that cannot name its own reason is not an exemption, it is a silence');
}

console.log("NEXUS — jsonb key reads found in source, against the gate's declared list");
// D193: this census reads two populations that are not the same set — the directories its read scan walks, and
// the whole-repo index the site citations resolve against — and the difference between them is a fact about the
// plane, not about the answers. Both print, because the working tree and a clean checkout of HEAD give different
// numbers here (measured before the change: 174 files / 0 misses on the working copy, 129 / 2 on HEAD).
console.log(`  census plane        ${ROOT}`);
console.log(`  read scan walks     ${CENSUS_ROOTS.length} root(s): ${CENSUS_ROOTS.join(', ')}`);
console.log(`  source files scanned        ${files.length}`);
console.log(`  read sites found            ${total}`);
console.log(`  distinct (column, key) read ${found.size}`);
console.log(`  declared in quality.sql     ${declared.size} triple(s)`);
console.log(`  answer kinds in use   ${[...KINDS_SEEN.keys()].sort().join(', ')} — this census expects a`
  + ` findable read in ${Object.entries(READ_EXPECTED).filter(([, v]) => v).length} of the `
  + `${Object.keys(READ_EXPECTED).length} kind(s) it classifies`
  + (branchlessKinds.length > 0 ? `; ${branchlessKinds.length} classify no row on this plane (${branchlessKinds.join(', ')})` : ''));
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

// The misses, split by the reason this run can give for each. Every reason is decided from data this script
// already read — the answer row's own `site`, the file index, and the roots the scan walked — so the only class
// left for a human is the one where the file is present, walked, and simply does not hold the read.
const MISS_WHY = {
  'file-not-on-this-plane': 'the file its site names is not in the index this run read. This is a plane fact, not'
    + ' a hand judgement, and the FALSE SITES block below reddens the same row for the same file',
  'site-file-ambiguous': 'its site names a file the index holds more than once, so no single file can be checked',
  'site-names-no-file': 'its site holds no source citation, so the census was never told where to look',
  'outside-the-census-roots': 'its site resolves to a file outside the root(s) this scan walks — the read may be'
    + ' perfectly live and this census structurally blind to it, which is a coverage fact, not a stale answer',
  'not-read-in-the-file-where-it-should-be': 'its site resolves inside the walked roots and no read of that'
    + ' (column, key) is in the text. This is the one class genuinely judged by hand: a read through a helper or'
    + ' a constant, or a read that was deleted',
};
const missesByReason = new Map();
for (const m of misses) {
  const list = missesByReason.get(m.reason) ?? [];
  list.push(m);
  missesByReason.set(m.reason, list);
}
// Every reason prints, including the ones with no member: a taxonomy that only shows its occupied drawers cannot
// be compared between two planes, and a branch of this classifier that never fires is exactly what D191 and
// D192 made the ledgers look for.
console.log(`ANSWERS THE READ CENSUS DID NOT FIND (${misses.length}) — each with the reason this run can give:`);
for (const [reason, why] of Object.entries(MISS_WHY)) {
  const rows = missesByReason.get(reason) ?? [];
  console.log(`  ${reason} (${rows.length}${rows.length === 0 ? ' — none on this plane' : ''}): ${why}`);
  for (const m of rows) console.log(`    - ${m.triple}  kind ${m.kind}  ${m.detail}`);
}
for (const reason of [...missesByReason.keys()].filter((r) => !MISS_WHY[r])) {
  console.log(`  ${reason} (${missesByReason.get(reason).length}): no stated reason — this class is new and the`
    + ' sentence for it was not written');
  for (const m of missesByReason.get(reason)) console.log(`    - ${m.triple}  kind ${m.kind}  ${m.detail}`);
}
console.log('');

// D194: the second direction of vocabulary drift, and it reddens. A branch of `READ_EXPECTED` that no answer row
// on this plane is filed under means this census is asking a question nothing answers — the class is unfalsifiable
// here, exactly as a read filed outside the walked roots is, so it joins the exit term instead of sitting in the
// kinds line above as a sentence with no consequence.
if (branchlessKinds.length > 0) {
  console.log(`ANSWER KINDS UNUSED (${branchlessKinds.length}) — this census expects an answer filed under a kind`
    + ` no row on this plane carries: ${branchlessKinds.join(', ')}`);
  for (const k of branchlessKinds) {
    console.log(`  - ${k} — a branch that classifies nothing decides nothing: the expectation it states cannot be`
      + ' met or contradicted by this plane, and its absence was last noticed by this run rather than by a row');
  }
  console.log('  fix: file an answer of that kind, or retire the branch from READ_EXPECTED with the reason.\n');
}

if (sites.counts.read_answer !== declared.size) {
  sites.offenders.push(`this script parsed ${sites.counts.read_answer} read_answer rows while its read census `
    + `parsed ${declared.size} read_cat triples — the two are meant to agree, so one of the two parses stopped `
    + 'early and the sites it skipped went unchecked');
}

// D193's belt, and it is a claim about this process's own data, not a phrase scraped from a child's report: the
// class above promises that a row whose site file is absent is already reddened by the site census. A promise a
// second reader can break is not a rule, so every such row is looked for by name in the offenders it claims to
// be covered by, and a row that is not there is filed here instead of excused there.
const PLANE_FACT_REASONS = ['file-not-on-this-plane', 'site-file-ambiguous', 'site-names-no-file'];
for (const m of misses.filter((x) => PLANE_FACT_REASONS.includes(x.reason))) {
  const rowId = `read_answer ${m.triple}`;
  if (!sites.offenders.some((o) => o.startsWith(rowId))) {
    sites.offenders.push(`${rowId} is reported as ${m.reason} and this run promises the site census reddens that, `
      + 'but no offender names the row — the exemption is covering a claim nothing judges');
  }
}

console.log(`ANSWER SITES — ${sites.stats.rows} answer row(s) cite ${sites.stats.cited} source location(s) `
  + `in ${sites.stats.files.size} file(s); ${sites.stats.linesRead.size} distinct source line(s) read back`);
console.log(`  rows parsed          ${sites.counts.read_answer} read_answer + ${sites.counts.shape_answer}`
  + ` shape_answer`);
console.log(`  line spans checked   ${sites.stats.numbered} across ${sites.stats.cited} citation token(s) — a`
  + ' citation naming a file with no line has nothing to compare against, so it is reported too');
console.log(`  citations resolved   ${sites.stats.files.size} file(s) under a ${VENDOR_DIRS.size}-dir vendor`
  + ' exclusion');
if (sites.offenders.length > 0) {
  console.log(`FALSE SITES (${sites.offenders.length}):`);
  for (const row of sites.offenders) console.log(`  - ${row}`);
} else {
  console.log('  every cited line names the table, column or key its row is about');
}
console.log('');

console.log('LIMITS, stated rather than implied: this is a textual scan. A key reached through a helper,');
console.log('named by a constant, or built in another file is invisible to it, and a variable reused for two');
console.log('columns attributes both key sets to both columns. Table attribution is resolved only for SQL');
console.log('reads whose alias appears in a FROM/JOIN in the same file; an accessor read is matched on');
console.log('(column, key) alone, so one answer covers that key on any table. It errs toward reporting.');
console.log('');
console.log('On a miss: this census can say WHY it did not find a read — the file is not in the index, the name');
console.log('is ambiguous, the site names no file, the file is outside the roots it walks, or the file is here');
console.log('and walked and the key text is not in it. Only that last case is a judgement left to a human, and');
console.log('only "outside the roots" is fatal of the others: a build that reads jsonb in a directory this scan');
console.log('was never told to walk makes every answer there unfalsifiable, so the fix is to widen the roots,');
console.log('not to be excused for not seeing it.');
console.log('');
console.log('On the sites: a line that mentions the row\'s table, column or key is consistent with the claim,');
console.log('not proof of it — the check refutes a site pointing at unrelated code, a missing or ambiguous');
console.log('file, a line past the end of the file, a file that never names its row\'s table, a file named');
console.log('with no line at all, and source text quoted in a site that the cited line does not hold. It does');
console.log('not read control flow, so a citation to the right file and line for the wrong reason passes, and');
console.log('a `why` that cites a neighbouring table is trusted because naming that table is its point.');

// A miss whose site resolves outside the roots this scan walks is not a stale answer, it is a census aimed at
// the wrong directory — and while it stayed inside the report bucket it was the one failure mode of this reader
// that could never stop the gate. It reddens now, and `--roots` is what makes that arm reachable.
const blindSpots = misses.filter((m) => m.reason === 'outside-the-census-roots');
if (blindSpots.length > 0) {
  console.log(`CENSUS COVERAGE — ${blindSpots.length} answer(s) cite a file outside the root(s) this scan walks,`
    + ' so no read there could ever have been found:');
  for (const m of blindSpots) console.log(`  - ${m.triple}  ${m.detail}`);
  console.log('  fix: widen the roots this census walks, or the answers are unfalsifiable from this directory.\n');
}

// D194: the run states its own verdict and the exit code it takes, in one line a reader of this output can require.
// Before it, a reader that died on the way to the end of this function looked finished to anything keying on the
// header line, and an arm over it reported a moved census rather than a dead run. The harness requires this line
// (or the refusal's own) and checks the number it declares against the code the process actually exited with.
const verdictCount = undeclared.length + contradicted.length + neverReadRead.length + kindless.length
  + blindSpots.length + branchlessKinds.length + sites.offenders.length;
const exitCode = verdictCount > 0 && !REPORT_ONLY ? 1 : 0;
console.log(`REPORT COMPLETE — ${verdictCount} reason(s) to redden, --report ${REPORT_ONLY}, this run exits ${exitCode}`);
process.exit(exitCode);
