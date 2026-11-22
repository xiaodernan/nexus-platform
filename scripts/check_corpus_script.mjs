#!/usr/bin/env node
/**
 * D1535 — the chapter corpus is the largest piece of Hong Kong Chinese this product ships, and until
 * now no gate read its script.
 *
 * `check_ui_script.mjs` polices the UI dictionaries: 2,962 literals across four blocks. The 178-chapter
 * arc is a different population with a different failure mode — it is written chapter by chapter, in
 * prose, and D1533 already recorded what happens when a chapter's characters come from memory rather
 * than from a reviewed list (合成敕事指南 for 合成敘事指南, 輪子呕 for 輪子嘶). That unit built a census
 * for the EN arm and an invariant for new chapters; nobody ran the obvious measurement on what was
 * already on disk.
 *
 * Measured on 2026-11-22: 93 literals in `apps/web/src/lib/mock/seed.ts` carried at least one
 * Simplified character — 供应, 手冲, 首尔, 鸳鸯, 酸种面包, 草拟, 写字樓, 阿杰, and a U+4A0F where 發
 * belonged. This reader is that measurement, kept.
 *
 * WHAT IT CHARGES. Every string literal in the corpus file, against the same 3,873-character inventory
 * the UI census uses (`scripts/data/simp-only-chars.txt`), minus the named exclusions — characters that
 * are real Traditional forms a fold would "correct" into a different word (皇后, 余Sir, 一群, 床單).
 * The exclusion list is SHARED with the UI census on purpose: one script law, one place to argue with
 * it, and a character cannot be legitimate in a chapter and illegitimate in a heading.
 *
 * WHAT IT REFUSES. No inventory, no corpus, or a scan that found implausibly few literals — all exit 2.
 * A scanner that read nothing would otherwise report the cleanest possible corpus.
 *
 * Usage: node scripts/check_corpus_script.mjs [--repo DIR] [--verbose]
 * Exit: 0 clean · 1 offender(s) · 2 could not judge.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUSIONS, auditExclusions, readSimpOnlyChars } from './check_ui_script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join('apps', 'web', 'src', 'lib', 'mock', 'seed.ts');
// A corpus of 178 chapters produces thousands of literals. Anything under this is a scan that did not
// happen — a file read as one line, a language change, a truncated checkout.
const MIN_LITERALS = 500;

export function corpusLiterals(src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  let line = 1;
  let i = 0;
  let quote = null;
  let startLine = 0;
  let buf = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote === null) {
      if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; startLine = line; buf = []; i += 1; continue; }
      if (c === '\n') line += 1;
      i += 1;
      continue;
    }
    if (c === '\\') { if (src[i + 1] !== '\n') buf.push(src[i + 1] ?? ''); i += 2; continue; }
    if (c === quote) {
      out.push({ line: startLine, raw: buf.join('') });
      quote = null;
      i += 1;
      continue;
    }
    if (c === '\n') { line += 1; buf.push(' '); i += 1; continue; }
    buf.push(c);
    i += 1;
  }
  if (quote !== null) out.push({ line: startLine, raw: buf.join(''), unterminated: true });
  void lines;
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const repoArg = argv.indexOf('--repo');
  const repo = resolve(repoArg > -1 && argv[repoArg + 1] ? argv[repoArg + 1] : join(HERE, '..'));
  const verbose = argv.includes('--verbose');
  const path = join(repo, CORPUS);

  const inv = readSimpOnlyChars(repo);
  if (inv.problem) {
    console.log(`RESULT: NOT CHECKED — ${inv.problem}`);
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.log(`RESULT: NOT CHECKED — no corpus at ${path}; a reader with nothing to read is not a pass`);
    process.exit(2);
  }
  const charge = new Set(inv.chars.filter((c) => !(c in EXCLUSIONS)));
  const literals = corpusLiterals(readFileSync(path, 'utf8'));
  if (literals.length < MIN_LITERALS) {
    console.log(`RESULT: NOT CHECKED — the scan found ${literals.length} literal(s) in ${CORPUS}, fewer than the`);
    console.log(`  ${MIN_LITERALS} a corpus of this size produces; the scanner did not read the file it thinks it read`);
    process.exit(2);
  }
  const unterminated = literals.find((l) => l.unterminated);
  if (unterminated) {
    console.log(`RESULT: NOT CHECKED — a literal opened at line ${unterminated.line} never closes; the rest of the file was not judged`);
    process.exit(2);
  }

  const offenders = [];
  const seen = new Map();
  for (const lit of literals) {
    const bad = [];
    for (const ch of lit.raw) {
      if (!charge.has(ch)) continue;
      if (!bad.includes(ch)) bad.push(ch);
      seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
    if (bad.length) offenders.push({ line: lit.line, bad, text: lit.raw.slice(0, 90) });
  }

  const { dead } = auditExclusions(inv.chars);
  console.log(`zh-HK chapter corpus script census — ${repo}`);
  console.log(`inventory: ${inv.chars.length} simplified-only character(s); ${Object.keys(EXCLUSIONS).length} excluded by name`);
  if (dead.length) {
    // Not a defect: 面 and 嘅 are in the product's own queried pair tables (canonical.py maps 面→麵,
    // lexicon.py maps 嘅→的), so the UI census still needs them. opencc's s2t leaves both alone, so
    // they are dead weight HERE — printed rather than silently carried, because an exclusion whose
    // reason has expired is how an exclusion list becomes folklore.
    console.log(`  note — ${dead.length} exclusion(s) are not charged by this inventory (live only for the product's own pair table): ${dead.join(' ')}`);
  }

  if (!offenders.length) {
    console.log(`RESULT: PASS — 0 simplified character(s) over ${literals.length} literal(s) of ${CORPUS}`);
    return;
  }
  for (const o of offenders) {
    console.log(`  WRONG-SCRIPT ${CORPUS}:${o.line} [${o.bad.join('')}] '${o.text}'`);
    if (verbose) console.log(`    fix: ${o.bad.map((c) => `${c}→${EXCLUSIONS[c]?.to ?? '?'}`).join('  ')}`);
  }
  const perChar = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(' ');
  console.log(`RESULT: FAIL — ${seen.size} distinct character(s) across ${offenders.length} literal(s): ${perChar}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
