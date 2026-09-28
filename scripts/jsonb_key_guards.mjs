/**
 * NEXUS — every jsonb element key the seed's own checks read, and whether anything could ever fail them.
 *
 * WHY. D168 proved one row green by construction: `collections/guides reference live merchants` reads
 * `merchant_id` out of `collections.items`, a key the writer never emits, and it reads it only behind
 * `IS NOT NULL` — so the guard is false on every element, the count is empty, and the relationship the row is
 * named for goes unchecked. That was found by hand on one row. This file asks the same question of all of them,
 * read-only, from the text the gate ships: no database is opened, no product file is edited, and `quality.sql`
 * stays its owner's to change.
 *
 * THE TWO POPULATIONS IT JOINS, both derived rather than listed. Reads come from the statements themselves:
 * a `jsonb_array_elements(<rel>.<col>) <alias>` binding gives the column, and every `<alias>->>'<key>'` in the
 * same statement is a read of that column. The guard question is asked per key, per statement — a key is
 * `guarded-only` when EVERY occurrence of it is the left side of `IS NOT NULL`, which is the shape that cannot
 * fail on elements that never carry the key, and `unguarded` otherwise. What the seed actually writes is NOT
 * assumed here: a `guarded-only` key is a suspect to check against the writer, not a verdict, because the same
 * shape is harmless on a column whose elements do carry the key.
 *
 * WHAT IT PRINTS. One line per (column, key): the number of reads, whether every one is guarded, and the row's
 * own label so a human can find the statement. Then a summary that refuses to call an empty scan green.
 *
 * USAGE   node scripts/jsonb_key_guards.mjs [--sql <path>]      (default data/seed/quality.sql)
 * EXIT    always 0 — this is a report. Suspects are printed, not asserted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.length % 2 === 1 || argv.filter((a) => !a.startsWith('--')).length) {
  console.log('RESULT: NOT CHECKED — this report takes only --sql <path>');
  process.exit(2);
}
const args = new Map();
for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
if ([...args.keys()].some((k) => k !== '--sql')) {
  console.log('RESULT: NOT CHECKED — unknown option — this report takes only --sql <path>');
  process.exit(2);
}
const SQL = join(ROOT, args.get('--sql') ?? 'data/seed/quality.sql');
const text = readFileSync(SQL, 'utf8').replace(/\r\n/g, '\n');

// Statements, split the way the loader does. Dollar-quoted bodies ($tag$…$tag$) are kept whole so a DO block's
// own semicolons do not chop it into unrelated fragments.
const statements = [];
let cur = '', tag = null;
for (let i = 0; i < text.length; i += 1) {
  const at = text.slice(i, i + 40);
  if (!tag) {
    const open = at.match(/^\$([A-Za-z0-9_]*)\$/);
    if (open) { tag = open[0]; cur += open[0]; i += open[0].length - 1; continue; }
    if (text[i] === ';') { statements.push(cur); cur = ''; continue; }
    cur += text[i];
  } else if (at.startsWith(tag)) {
    cur += tag; i += tag.length - 1; tag = null;
  } else cur += text[i];
}
if (cur.trim()) statements.push(cur);

const rows = new Map();
for (const stmt of statements) {
  if (!stmt.includes('jsonb_array_elements')) continue;
  const label = (stmt.match(/SELECT '([^']{6,80})'/) || [, '(unnamed statement)'])[1];
  // Relation aliases: `FROM collections c`, `JOIN merchants m` — the array is bound to the ALIAS, and a report
  // that printed `c.items` instead of `collections.items` would be naming a query, not a column of the seed.
  const aliasToTable = new Map();
  for (const a of stmt.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\s+(?!ON\b|WHERE\b|USING\b|GROUP\b|SET\b)([a-z][a-z0-9_]*)\b/g)) {
    aliasToTable.set(a[2], a[1]);
  }
  const binds = new Map();
  for (const m of stmt.matchAll(/jsonb_array_elements\(([a-z_]+)\.([a-z_]+)\)\s+([a-z][a-z0-9_]*)/g)) {
    binds.set(m[3], { rel: m[1], col: m[2] });
  }
  // One pass per (column, key) per statement: the same four reads counted once each, not once per binding.
  for (const [alias, bound] of binds) {
    const reads = [...stmt.matchAll(new RegExp(`${alias}->>'([a-z_]+)'(\\s+IS\\s+NOT\\s+NULL)?`, 'g'))];
    const byKey = new Map();
    for (const r of reads) byKey.set(r[1], (byKey.get(r[1]) ?? 0) + 1);
    for (const [key, count] of byKey) {
      const all = [...stmt.matchAll(new RegExp(`${alias}->>'${key}'`, 'g'))].length;
      const guardedOnly = [...stmt.matchAll(new RegExp(`${alias}->>'${key}'\\s+IS\\s+NOT\\s+NULL`, 'g'))].length === all;
      const id = `${aliasToTable.get(bound.rel) ?? bound.rel}.${bound.col} · ${key}`;
      const seen = rows.get(id) ?? { reads: 0, guardedOnly: true, labels: new Set() };
      seen.reads += count;
      seen.guardedOnly = seen.guardedOnly && guardedOnly;
      seen.labels.add(label);
      rows.set(id, seen);
    }
  }
}

/* ------------------------------------------------------------------ the writer half, so the two can be joined */

// The keys each array column's elements actually carry, read out of the generator rather than assumed: a
// `<name> = [{ 'k': … }, …]` or `"<name>": [{…}]` literal whose FIRST object supplies the key list. Matched
// per column by name, because the gate's columns and the generator's local variables share them (`items`,
// `images`, `options`, `photos`). Where no literal is found the answer is `unknown`, printed as such — a
// missing writer is a fact about this probe, not a green.
const gen = readFileSync(join(ROOT, 'data', 'seed', 'generate.py'), 'utf8').replace(/\r\n/g, '\n');
const written = new Map();
for (const col of new Set([...rows.keys()].map((k) => k.split('.')[1].split(' ')[0]))) {
  const lits = [...gen.matchAll(new RegExp(`["']?${col}["']?\\s*[:=]\\s*\\[\\s*\\{([\\s\\S]{0,400}?)\\}`, 'g'))]
    .map((m) => [...m[1].matchAll(/["']([a-z_]+)["']\s*:/g)].map((k) => k[1]));
  const keys = new Set(lits.flat());
  if (keys.size) written.set(col, [...keys].sort());
  else written.set(col, null);
}

console.log(`  file               ${SQL.replace(ROOT + '/', '')}`);
console.log(`  statements scanned ${statements.length} · array statements 2`);
console.log(`  element key reads  ${rows.size} distinct (table.column · key) pairs`);
for (const [id, v] of [...rows.entries()].sort()) {
  const col = id.split(' · ')[0], key = id.split(' · ')[1];
  const w = written.get(col.split('.')[1]);
  const verdict = w === null ? 'writer unknown — the join is not made'
    : w.includes(key) ? 'written, so the read can fire' : 'READ-BUT-NOT-WRITTEN — suspect vacuous';
  console.log(`  - ${col} · ${key} · reads ${v.reads} · ${v.guardedOnly ? 'every read guarded' : 'has unguarded use'} · writer [${w ? w.join(', ') : '—'}] · ${verdict} · "${[...v.labels][0]}"`);
}
if (rows.size === 0) {
  console.log('  A scan that found nothing is not a green scan: check the split and the regex, not the seed.');
}
console.log('\n  Suspects are printed, not asserted — the writer is the other half, and this report reads neither.');
