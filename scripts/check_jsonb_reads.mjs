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
 *
 * A flag this reader does not parse, and a `--quality` whose value is empty, are a refusal with exit 2 and not a
 * silence. Before D156 only the `=` spelling was read, so `--quality <plant>` censused the SHIPPED file and
 * printed a truthful PASS about a plane nobody aimed at — the defect D154 fixed in `check_status_citations.mjs`
 * and D155 in `check_ledger_sections.mjs`, here in its third instance.
 *
 * `scripts/db_gate_fresh.sh` runs this as its seventh step, so a widening of the build's jsonb reads — or a
 * site citation that the source contradicts — reddens the same one-command gate that reddens a broken seed. A
 * missing `node` fails that step rather than skipping it: a census whose second reader silently did not start
 * is greener than it is.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SOURCE_EXT, VENDOR_DIRS, walkFiles } from './source_index.mjs';

const ROOT = process.cwd();
/**
 * `--quality=<path>` / `--quality <path>` points the census at a different copy of the seed gate. It exists for
 * this script's own witnesses: a plant has to change an answer row, and a plant that edits the tracked file
 * races any gate that is loading it. D156 made the second spelling work, gave the step an in-gate knob
 * (`GATE_QUALITY_SQL` in `scripts/db_gate_fresh.sh`), and turned an unread flag into a refusal — the flag was
 * documented here as "Nothing in the gate itself passes the flag" for exactly one reason: nothing did.
 */
const notCheckable = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };
const FLAGS = new Set(['quality', 'report', 'verbose']);

/** The one `--quality` value, from either spelling; empty or repeated is a refusal, not a default. */
function qualityPath() {
  const argv = process.argv.slice(2);
  const given = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] : null;
    if (name === null) notCheckable(`unexpected argument ${a} — this reader takes only --quality, --report, --verbose`);
    if (!FLAGS.has(name)) {
      notCheckable(`unknown option ${a} — flags this reader parses: ${[...FLAGS].join(', ')}`);
    }
    if (name !== 'quality') continue;
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
    if (value === undefined || value === '') notCheckable('--quality was given without a path');
    given.push(value);
  }
  if (given.length > 1) notCheckable(`--quality was given ${given.length} times — which copy is the census?`);
  return given[0];
}

const QUALITY_SQL = qualityPath() ?? 'data/seed/quality.sql';
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
  const sql = readFileSync(resolve(ROOT, QUALITY_SQL), 'utf8');
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
  if (at < 0) throw new Error(`Could not find "${insertMarker}" in ${QUALITY_SQL}`);
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
    throw new Error(`The ${table} VALUES list in ${QUALITY_SQL} ended somewhere a row was not closing — `
      + 'the parser cannot trust its own row count');
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
  const stats = { rows: 0, cited: 0, files: new Set(), linesRead: new Set(), numbered: 0 };
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

      for (const [field, text, content] of [['site', site, true], ['why', why, false]]) {
        const cites = citations(text);
        const resolved = [];
        for (const cite of cites) {
          stats.cited += 1;
          const cands = cite.name.includes('/')
            ? files.filter((rel) => rel === cite.name || rel.endsWith(`/${cite.name}`))
            : (byName.get(cite.name.split('/').pop()) ?? []);
          if (cands.length === 0) {
            offenders.push(`${rowId} cites ${cite.name} in ${field} — no file in the ${files.length}-file source `
              + 'index has that path or that name');
            continue;
          }
          if (cands.length > 1) {
            offenders.push(`${rowId} cites ${cite.name} in ${field} — the name is ambiguous, ${cands.length} `
              + `files hold it: ${cands.slice(0, 4).join(', ')}${cands.length > 4 ? ', …' : ''}`);
            continue;
          }
          const rel = cands[0];
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
      }
    }
  }
  return { offenders, stats, counts };
}

/* ------------------------------------------------------------------ run */

const declared = declaredReads();      // Map 'tbl.col.key' -> kind (null when the answer table has no row)
const sites = checkSites();            // { offenders, stats, counts } — every file:line the answers cite
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

if (sites.counts.read_answer !== declared.size) {
  sites.offenders.push(`this script parsed ${sites.counts.read_answer} read_answer rows while its read census `
    + `parsed ${declared.size} read_cat triples — the two are meant to agree, so one of the two parses stopped `
    + 'early and the sites it skipped went unchecked');
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
console.log('On the sites: a line that mentions the row\'s table, column or key is consistent with the claim,');
console.log('not proof of it — the check refutes a site pointing at unrelated code, a missing or ambiguous');
console.log('file, a line past the end of the file, a file that never names its row\'s table, a file named');
console.log('with no line at all, and source text quoted in a site that the cited line does not hold. It does');
console.log('not read control flow, so a citation to the right file and line for the wrong reason passes, and');
console.log('a `why` that cites a neighbouring table is trusted because naming that table is its point.');

process.exit((undeclared.length + contradicted.length + neverReadRead.length + kindless.length
  + sites.offenders.length) > 0 && !REPORT_ONLY ? 1 : 0);
