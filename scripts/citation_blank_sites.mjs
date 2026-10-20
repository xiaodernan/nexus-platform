/**
 * NEXUS — every ledger citation that lands on a blank line, listed rather than counted.
 *
 * WHY THIS EXISTS. D160 measured the class, D161 armed it where rows are new, D166 reconciled the two
 * readers' counts — and through all of it the number was reported without the list. Twelve is a statistic;
 * the twelve *sites* are the work, and the difference matters the moment someone has to decide whether to
 * judge history: you cannot triage a count. This file prints, for each site, the citing line, the section
 * that cites it, the blank target, and the nearest line in that file which actually holds text — the
 * candidate the sentence was reaching for before an edit moved it.
 *
 * WHAT IT SHARES WITH THE GATE, so the list and the verdict cannot disagree: step 8's token grammar (sliced
 * out of the shipped file, not retyped), the shared file index in `source_index.mjs` (`LEDGER_EXT` plus
 * `walkFiles`, the same population the reader resolves against), the HEAD plane the reader is strict on for
 * the LEDGER side, and the same skip rules — a name the index holds twice is AMBIGUOUS and is never resolved
 * to a line, so it is not listed here either.
 *
 * THE ONE PLACE IT MIXES PLANES, on purpose: the citing rows come from HEAD while the cited files are read
 * from the working tree, because the point of the "text at line N" column is where the sentence's target
 * lives NOW. On the committed plane those two can differ — the 12 sites here are all blank in both planes.
 *
 * WHAT IT DOES NOT DO: it does not assert that the nearest-text line is the RIGHT one. That is a judgement
 * about a sentence, and the reader's standing limit is the same — it can check that a cited file has the
 * cited line, never that the line says what the claim says.
 *
 * USAGE   node scripts/citation_blank_sites.mjs [--worktree]
 * EXIT    always 0 — this is a report; step 8 is the reader with a verdict
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { guard } from './spawn_guard.mjs';
import { LEDGER_EXT, walkFiles } from './source_index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = process.argv.slice(2).includes('--worktree');
const EXTRA = process.argv.slice(2).filter((a) => a !== '--worktree');
if (EXTRA.length) {
  console.log(`RESULT: NOT CHECKED — unexpected argument ${EXTRA[0]} — this report takes only --worktree`);
  process.exit(2);
}

const checker = readFileSync(join(ROOT, 'scripts', 'check_ledger_citations.mjs'), 'utf8').replace(/\r\n/g, '\n');
const grammarLine = checker.split('\n').filter((l) => l.includes('matchAll(') && l.includes('(['));
if (grammarLine.length !== 1) throw new Error(`step 8's grammar moved or multiplied: ${grammarLine.length} lines`);
const GRAMMAR = new RegExp(grammarLine[0].match(/matchAll\((\/.*\/g)\)/)[1].slice(1, -2), 'g');

const FILES = walkFiles(ROOT, (name) => LEDGER_EXT.test(name) || name.startsWith('.'));
const CACHE = new Map();
/**
 * `git show` for the committed plane, refusing by name when the machine cannot spawn git at all.
 *
 * Only a **spawn failure** is refused here. `git show` also throws when the path simply is not at HEAD, and
 * that is a different event with a different meaning — a ledger citing a file no commit holds is a finding
 * for this census, not an environment note. Censused in STATUS §224.
 */
function gitShow(rel) {
  let thrown = null;
  const g = guard(() => execFileSync('git', ['show', `HEAD:${rel}`], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }),
    `git show HEAD:${rel}`);
  if (!g.ok) {
    if (!g.spawn) throw thrown ?? new Error(`${g.what} failed: ${g.reason}`);
    console.log(`RESULT: NOT CHECKED — this machine cannot spawn git (${g.reason}), so the committed plane`
      + ' is unreadable here.');
    console.log('  A refusal is not a finding, and the two must not share a verdict line.');
    process.exit(2);
  }
  return g.value;
}

const lines = (rel) => {
  if (!CACHE.has(rel)) {
    const raw = WORKTREE || !rel.startsWith('docs/')
      ? readFileSync(join(ROOT, rel), 'utf8')
      : gitShow(rel);
    CACHE.set(rel, raw.replace(/\r\n/g, '\n').split('\n'));
  }
  return CACHE.get(rel);
};

const rows = [];
for (const ledger of ['docs/DECISIONS.md', 'docs/STATUS.md']) {
  const L = lines(ledger);
  L.forEach((line, i) => {
    for (const t of line.matchAll(GRAMMAR)) {
      const name = t[1];
      const num = Number(t[2]);
      if (!(/\.[A-Za-z0-9]{1,6}$/.test(name) || name.startsWith('.'))) continue;
      const cands = name.includes('/')
        ? FILES.filter((r) => r === name || r.endsWith('/' + name))
        : FILES.filter((r) => r === name || r.endsWith('/' + name));
      if (cands.length !== 1) continue;
      const tgt = lines(cands[0]);
      const held = tgt[num - 1];
      if (held === undefined || held.trim()) continue;
      let near = num;
      for (let step = 1; step <= 6; step += 1) {
        if (tgt[num - 1 - step] !== undefined && tgt[num - 1 - step].trim()) { near = num - step; break; }
        if (tgt[num - 1 + step] !== undefined && tgt[num - 1 + step].trim()) { near = num + step; break; }
      }
      const section = [...L.slice(0, i)].reverse().find((l) => /^## /.test(l)) ?? '(preamble)';
      rows.push({ at: `${ledger} ${section.replace(/^##+ /, '').slice(0, 30)} :${i + 1}`,
        target: `${cands[0]}:${num}`, near, says: line.trim().slice(0, 58) });
    }
  });
}

console.log(`  plane            ${WORKTREE ? 'the working copy' : 'HEAD (git show) — the plane step 8 is strict on'}`);
console.log(`  blank cite sites ${rows.length} (each with the nearest line holding text, within six lines)`);
for (const r of rows) console.log(`  - ${r.at} -> ${r.target}; text at line ${r.near} · "${r.says}"`);
console.log('\n  This report asserts nothing; `check_ledger_citations.mjs` holds the verdict.');
