#!/usr/bin/env node
/**
 * NEXUS D103 — validate data/seed/falsifiers.tsv against the assertions the gate actually files.
 *
 * The denominator is qc, not the text: 103 of the 216 names are built at run time by the polymorphic sweeps
 * (D98), so a name checked against quality.sql alone would reject real rows and accept invented ones. The live
 * list is obtained the way D99/D100's harnesses get it — slice the shipped assertions at the hard-gate marker
 * (the verdict's RAISE would end the session, since the file sets ON_ERROR_STOP for itself), run them, read
 * the table back as one aggregated row so a name containing a newline cannot change the count.
 *
 * Usage: node scripts/check_falsifier_registry.mjs --db <loaded seed> [--container <name>]
 * Exit: 0 consistent · 1 a registry row is wrong · 2 not checkable. "Not checkable" is its own answer (D96):
 *       a reader that did not run is not a pass, and a registry validated against nothing is not green.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DB = arg('--db', null), CONTAINER = arg('--container', 'nexus-platform-postgres');
const TMPROOT = process.env.TMPDIR || 'C:/Users/18414/AppData/Local/Temp';
const notChecked = (why) => { console.error(`RESULT: NOT CHECKED — ${why}`); process.exit(2); };

const lines = readFileSync(join(ROOT, 'data', 'seed', 'quality.sql'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const mark = lines.filter((l) => l.startsWith('-- ====') && l.includes('C  hard gate'));
if (mark.length !== 1) notChecked('the hard-gate marker is missing or duplicated, so the slice has no safe end');
const slice = lines.slice(0, lines.indexOf(mark[0])).join('\n')
  + "\nSELECT count(*) || '#' || coalesce(string_agg(\"check\", chr(9) ORDER BY \"check\"), '') FROM qc;\n";

let live;
try {
  if (!DB) notChecked('no --db given; pass a loaded seed (scripts/db_gate_fresh.sh --keep)');
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB,
    '-v', 'ON_ERROR_STOP=0', '-tA', '-q'], { input: slice, encoding: 'utf8', maxBuffer: 1 << 26 });
  const line = out.split('\n').filter((l) => l.includes('#') && l.length > 40).pop();
  const [count, joined] = line.split('#');
  live = new Set((joined || '').split('\t').map((s) => s.trim()).filter(Boolean));
  if (Number(count) !== live.size) notChecked(`qc declares ${count} rows, names came back as ${live.size} — lossy read`);
} catch (e) { notChecked(`live assertion list unreadable: ${String(e.message).split('\n')[0]}`); }

const rows = readFileSync(join(ROOT, 'data', 'seed', 'falsifiers.tsv'), 'utf8').split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('\t'));

const bad = [];
const keys = new Set();
for (const r of rows) {
  const [check, unit, arm, witness] = r;
  if (r.length !== 4 || !check || !unit || !arm || !witness) { bad.push(`row is not check/unit/arm/witness: ${JSON.stringify(r)}`); continue; }
  if (!live.has(check)) bad.push(`not an assertion the gate files: ${check}`);
  const k = `${check}|${arm}`;
  if (keys.has(k)) bad.push(`duplicated (check, arm): ${k}`);
  keys.add(k);
  const ok = /^[0-9a-f]{7,40}$/.test(witness)
    ? (() => { try { execFileSync('git', ['cat-file', '-e', `${witness}^{commit}`], { cwd: ROOT }); return true; } catch { return false; } })()
    : existsSync(join(TMPROOT, witness)) || existsSync(resolve(TMPROOT, witness));
  if (!ok) bad.push(`witness cannot be opened (${witness}) for ${check}`);
}

for (const b of bad) console.error(`  registry problem: ${b}`);
const covered = new Set(rows.map((r) => r[0]).filter((c) => live.has(c)));
console.log(`  gate assertions   ${live.size}`);
console.log(`  registry rows     ${rows.length} (check, arm) pairs witnessed`);
console.log(`  assertions with a machine-checkable witness: ${covered.size} of ${live.size}`
  + ` (${(100 * covered.size / live.size).toFixed(1)}%) — grammar: a registry row naming the check,`
  + ' an arm that reddened it, and an artifact that still opens');
if (bad.length) { console.log('\nRESULT: FAIL — the registry is inconsistent with the gate'); process.exit(1); }
console.log('\nRESULT: PASS — every registry row names a live assertion, an arm, and an openable witness');
