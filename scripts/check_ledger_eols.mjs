#!/usr/bin/env node
/**
 * NEXUS — the ledgers' line-ending census, per section.
 *
 * WHY THIS EXISTS: byte-targeted repairs on the ledgers (the fence fix, the applier's splice, any
 * script that rewrites a line) work across line endings one section at a time, and the two ledgers
 * carry both spellings — the body is CRLF and the recently appended sections are LF. A section that
 * mixes the two inside itself is where byte tools break: a pattern written for one spelling misses
 * the other, and a splice that counts one way renumbers the other way. The census prints the whole
 * file's split, then names every section that mixes. Mixed sections are the failure (exit 1); a
 * uniform split is reported, not judged — neither spelling is the wrong one, and converting either
 * is a decision for the lanes that wrote them, not this reader.
 *
 * Measured 2026-10-17 (first run): STATUS 14605 CRLF / 39 LF with zero mixed sections; DECISIONS
 * 14359 CRLF / 0 LF. The 39 LF lines are this lane's recent appends — whole sections, uniformly LF.
 * The "mixed line endings" phrasing an earlier entry used for the fence repair's surface is
 * corrected by this measurement: the mixing is whole-file, not per-section.
 *
 * Usage: node scripts/check_ledger_eols.mjs            # census both ledgers
 *        node scripts/check_ledger_eols.mjs --file X   # census one file instead
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: check_ledger_eols.mjs [--file <path>]   # default: census both ledgers');
  process.exit(0);
}
const files = args.includes('--file')
  ? [args[args.indexOf('--file') + 1]]
  : ['docs/STATUS.md', 'docs/DECISIONS.md'];

let mixedTotal = 0;
let failed = false;
for (const rel of files) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, rel));
  } catch {
    console.log(`${rel}: UNCHECKED — the census cannot open the file, so no section was read (exit 2, not a verdict about spellings)`);
    process.exit(2);
  }
  const lines = raw.toString('latin1').split('\n');
  // Drop the trailing empty element a trailing newline produces; the last real line keeps its \r.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const sections = [];
  let sec = '(before first heading)';
  for (const line of lines) {
    if (/^## /.test(line)) sec = line.toString('utf-8').replace(/\r$/, '').slice(0, 48);
    const crlf = line.endsWith('\r');
    if (!crlf && line.length === 0) continue; // a blank separator carries no spelling of its own
    let entry = sections.find((s) => s.section === sec);
    if (!entry) {
      entry = { section: sec, crlf: 0, lf: 0 };
      sections.push(entry);
    }
    if (crlf) entry.crlf += 1;
    else entry.lf += 1;
  }
  const crlfTotal = sections.reduce((a, s) => a + s.crlf, 0);
  const lfTotal = sections.reduce((a, s) => a + s.lf, 0);
  const mixed = sections.filter((s) => s.crlf > 0 && s.lf > 0);
  mixedTotal += mixed.length;
  console.log(`${rel}: CRLF ${crlfTotal}, LF ${lfTotal}, sections ${sections.length}, mixed ${mixed.length}`);
  for (const s of mixed) {
    console.log(`  MIXED SECTION: ${s.section} — CRLF ${s.crlf} / LF ${s.lf}`);
    failed = true;
  }
}
if (failed) {
  console.log('RESULT: FAIL — a section mixing both spellings is where byte tools break; the sections are named above');
  process.exit(1);
}
console.log('RESULT: PASS — no section mixes line endings; the split is whole-file, which byte tools handle one section at a time');
process.exit(0);
