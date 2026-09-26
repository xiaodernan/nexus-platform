#!/usr/bin/env node
/**
 * NEXUS — the ledger's own citations, read back out of the source (§84 residue (d)).
 *
 * WHY THIS EXISTS. `data/seed/quality.sql` answers name a `File.java:NNN` and `scripts/check_jsonb_reads.mjs`
 * (D87) now opens that file and refuses seven ways of being wrong about it. The ledgers — `docs/DECISIONS.md`
 * and `docs/STATUS.md` — are written in the same grammar and carry ~200 such citations between them, and
 * nothing has ever opened them. §84 claimed a hand census of that plane ("all 71 resolved, 3 sit one line
 * off"); this script replaces the hand census with a run, and the first run contradicted the claim, so §84 is
 * corrected in this same diff. What it does find is this lane's own text: grammar illustrations written as
 * file names that no repo holds, a nested-class cite (`MeController.FavoriteBody:59`), and D86's
 * `services/platform/.../growth/EventRepository.java:NN` — an elided path, which is a citation to a file
 * that does not exist.
 *
 * WHAT IT CHECKS, per citation-shaped token:
 *   FILE NOT FOUND   the name carries a source extension or a directory path and the index holds no such file
 *   AMBIGUOUS        the basename is held by more than one file, so the cite names none of them in particular
 *   PAST EOF         the cited line is beyond the file's last line (and the whole range is printed)
 *   BACKWARDS        a `78-84` range written `84-78`
 *   ZERO             line 0, which no editor can show
 *
 * WHAT IS NOT A CITATION, stated because a checker that judged every `word:number` would be red on prose:
 * `127.0.0.1:5433` and `redis:6379` (host and port), `NEXUS_RL_AUTH:10` (an environment variable and its
 * value), `V1:574` is a migration cite and IS checked (`V1__…sql`), `EventsController:63` is a Java class
 * name without its extension and IS checked when the stem resolves to exactly one file, and a bare `:22`
 * continues the file before it — a continuation inherits its file, so it is counted, never judged alone.
 *
 * TWO SNAPSHOTS, AND WHICH ONE THE GATE READS. The default census is strict on HEAD and reads the working
 * copy only to report what the next commit will inherit: three lanes append to `docs/STATUS.md` at once, so
 * the bare run over committed text is the one two lanes can both run and compare. `--worktree` makes the
 * working copy strict instead, and that is the mode `db_gate_fresh.sh` step 8 runs — because the other seven
 * steps all read the tree they are standing in, and a green run has to certify the text about to be
 * committed, not the text before it. The choice was made from a measurement, not a preference: over a tree
 * already holding three lanes' uncommitted STATUS sections, the worktree census is 151 citations, 0 offenders.
 *
 * USAGE
 *   node scripts/check_ledger_citations.mjs              # strict on HEAD, working copy reported
 *   node scripts/check_ledger_citations.mjs --worktree    # strict on the working copy — what gate step 8 runs
 *   node scripts/check_ledger_citations.mjs --report      # never exit non-zero
 *   node scripts/check_ledger_citations.mjs --verbose     # list every citation and where it resolved
 *   node scripts/check_ledger_citations.mjs --text=<file> # census one file instead of both ledgers (plants)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { VENDOR_DIRS, walkFiles } from './source_index.mjs';

const ROOT = process.cwd();
const TEXT_ARG = process.argv.find((a) => a.startsWith('--text='));
/**
 * `--text=<path>` replaces the ledger list with one file, read as written. It exists for the same reason
 * D87's `--quality=` does: a witness must be able to show an arm failing without writing a tracked file that
 * two other lanes are appending to.
 */
const LEDGERS = TEXT_ARG ? [TEXT_ARG.slice('--text='.length)] : ['docs/DECISIONS.md', 'docs/STATUS.md'];
const REPORT_ONLY = process.argv.includes('--report');
const WORKTREE = process.argv.includes('--worktree') || Boolean(TEXT_ARG);
const VERBOSE = process.argv.includes('--verbose');

/* ------------------------------------------------------------------ the source index */

/**
 * What a paragraph is allowed to point at: the build's own sources, which `source_index.mjs` names for D87's
 * site census, plus the docs, config and lock files a ledger cites — `docs/DATABASE.md:88`, `.github/workflows/ci.yml:24`,
 * `package.json:NN`. The directory exclusion is NOT local: it is the shared list in `source_index.mjs`, which
 * this checker grew by four tool-cache names — because that index would otherwise name `.gitignore` four times
 * instead of twice (`.pytest_cache` at the root and under `apps/ai/`) and report a true root cite AMBIGUOUS.
 */
const LEDGER_EXT = /\.(java|py|ts|tsx|mjs|cjs|sql|sh|md|ya?ml|json|toml|txt|properties|cfg|ini)$/;
const FILES = walkFiles(ROOT, (name) => LEDGER_EXT.test(name) || name.startsWith('.'));

const BY_BASENAME = new Map();
const BY_STEM = new Map();
for (const rel of FILES) {
  const base = rel.split('/').pop();
  BY_BASENAME.set(base, [...(BY_BASENAME.get(base) ?? []), rel]);
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  BY_STEM.set(stem, [...(BY_STEM.get(stem) ?? []), rel]);
}
/** `V1` -> `db/migration/V1__….sql`, the notation the ledgers use for a Flyway migration line. */
const MIGRATIONS = new Map();
for (const rel of FILES) {
  const m = rel.split('/').pop().match(/^(V\d+)__/);
  if (m) MIGRATIONS.set(m[1], [...(MIGRATIONS.get(m[1]) ?? []), rel]);
}

const LENGTH = new Map();
function fileLines(rel) {
  if (!LENGTH.has(rel)) LENGTH.set(rel, readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/).length);
  return LENGTH.get(rel);
}

/**
 * Resolve a cited name the way D87's site checker does — a path is matched by suffix, a bare name by
 * basename — plus two shapes the ledgers use and `quality.sql` does not: an extensionless Java class stem
 * (`EventsController`), and an outer-class/nested-record pair (`MeController.FavoriteBody`).
 */
function resolve(name) {
  // `./.gitignore` is the root-relative form the ledgers need for a file the repo root owns twice over:
  // bare `.gitignore` is held by the root AND by packages/sdk, so a root cite has to say it is at the root.
  if (name.startsWith('./')) return FILES.filter((rel) => rel === name.slice(2));
  if (name.includes('/')) return FILES.filter((rel) => rel === name || rel.endsWith(`/${name}`));
  if (MIGRATIONS.has(name)) return MIGRATIONS.get(name);
  if (LEDGER_EXT.test(name)) return BY_BASENAME.get(name) ?? [];
  const outer = name.match(/^([A-Z][A-Za-z0-9_]*)\.[A-Z][A-Za-z0-9_]*$/);       // Outer.Nested
  const stem = outer ? `${outer[1]}.java` : name;
  return BY_BASENAME.get(stem) ?? BY_STEM.get(stem) ?? [];
}

/* ------------------------------------------------------------------ what is a citation */

const HOST = /^[\d.]+$/;                                  // 127.0.0.1, 1.2.3
const ENV = /^[A-Z][A-Z0-9_]*$/;                          // NEXUS_RL_AUTH, HTTP
const SECTION = /^§?\d+$/;                                 // §81, D84 (no extension, no capital stem)
const FILE_SUFFIX = /\.[a-z][a-z0-9]{0,5}$/;              // something.java, generate.py, quality.sql
const CLASS_NAME = /^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)?$/;   // EventsController, MeController.FavoriteBody

/** True when the token is claiming to point at a file. */
function isCitation(name) {
  if (HOST.test(name) || ENV.test(name) || SECTION.test(name)) return false;
  if (name.startsWith('.')) return BY_BASENAME.has(name);   // .gitignore, .env.example
  if (name.includes('/')) return FILE_SUFFIX.test(name.split('/').pop()) || LEDGER_EXT.test(name);
  if (MIGRATIONS.has(name)) return true;
  return LEDGER_EXT.test(name) || CLASS_NAME.test(name);
}

/* ------------------------------------------------------------------ the scan */

/**
 * `name:12`, `name:217,:289`, `name:78-84` all yield spans; a span is `a` or `a-b`. Bare `:22` has no name
 * here and is counted separately as a continuation of the previous cite.
 */
function citeTokens(line) {
  const out = [];
  for (const m of line.matchAll(/(?:^|[^\w./-])([\w.\-/]+):(\d+(?:[-,:]\d+)*)/g)) {
    const spans = [];
    let backwards = null;
    for (const part of m[2].split(/[,:]/)) {
      if (!part.includes('-')) { spans.push([Number(part)]); continue; }
      const [a, b] = part.split('-').map(Number);
      spans.push([a, b]);
      if (b < a && backwards === null) backwards = `${a}-${b}`;
    }
    out.push({ name: m[1], spans, backwards });
  }
  return out;
}

function ledgerText(ledger, committed) {
  if (committed) {
    return execFileSync('git', ['show', `HEAD:${ledger}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  }
  return readFileSync(isAbsolute(ledger) ? ledger : join(ROOT, ledger), 'utf8');
}

/**
 * One pass over one ledger. `committed` selects HEAD text vs the working copy; the section a token sits in is
 * carried so an offender can be attributed to the entry that made it, and the section count doubles as the
 * non-vacuity floor: a scan that reaches zero sections has not read the file it claims to have read.
 */
function census(committed) {
  const stats = { tokens: 0, citations: 0, continuations: 0, sections: 0, files: new Set(), offenders: [] };
  for (const ledger of LEDGERS) {
    const text = ledgerText(ledger, committed);
    let section = '(before the first heading)';
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^## /.test(line)) { stats.sections += 1; section = line.replace(/^##+ /, '').slice(0, 46); }
      for (const m of line.matchAll(/(?:^|[^\w./-]):(\d+)/g)) stats.continuations += 1;
      for (const cite of citeTokens(line)) {
        stats.tokens += 1;
        if (!isCitation(cite.name)) continue;
        stats.citations += 1;
        const where = `${ledger} ${section} :${i + 1}`;
        const cands = resolve(cite.name);
        if (cands.length === 0) {
          stats.offenders.push({ kind: 'FILE NOT FOUND', where, cite, detail: 'no indexed file has that name or path' });
          continue;
        }
        if (cands.length > 1) {
          stats.offenders.push({ kind: 'AMBIGUOUS', where, cite,
            detail: `${cands.length} files hold it: ${cands.slice(0, 3).join(', ')}${cands.length > 3 ? ', …' : ''}` });
          continue;
        }
        const rel = cands[0];
        stats.files.add(rel);
        const n = fileLines(rel);
        if (cite.backwards) {
          stats.offenders.push({ kind: 'BACKWARDS', where, cite, detail: `${cite.name}:${cite.backwards} in ${rel}, which has ${n} lines` });
        }
        for (const span of cite.spans) {
          const [a, b = a] = span;
          if (a === 0 || b === 0) {
            stats.offenders.push({ kind: 'ZERO', where, cite, detail: `${rel} has no line 0` });
            continue;
          }
          if (b > n) {
            stats.offenders.push({ kind: 'PAST EOF', where, cite, detail: `${cite.name}:${span.join('-')} — ${rel} has ${n} lines` });
            break;
          }
        }
      }
    });
  }
  return stats;
}

const head = census(!WORKTREE);
const work = WORKTREE ? head : census(false);

// Non-vacuity, in the same spirit as D87's row-count guard: a scan that resolves nothing is not a green scan.
if (FILES.length < 100) throw new Error(`the source index holds ${FILES.length} files; a walk that finds almost nothing cannot check a citation`);
if (head.sections === 0) throw new Error(`the census read ${LEDGERS.join(', ')} and saw no "## " heading — it did not read the ledger it claims to have censised`);
if (head.citations === 0) throw new Error(`no citation-shaped token in ${head.tokens} name:number tokens — either the classifier or the index broke, and a run that checks nothing is the reddest kind of green`);
if (head.citations > 0 && head.files.size === 0) throw new Error(`${head.citations} citation(s) found and ${head.files.size} file(s) resolved — the index cannot see any file the ledgers name`);

console.log('NEXUS — every file:line citation in docs/DECISIONS.md and docs/STATUS.md, read back out of the source');
console.log(`  text censised            ${WORKTREE ? 'the working copy (strict)' : 'HEAD (strict); the working copy is reported'}`);
console.log(`  headings seen            ${head.sections} section(s) — an offender is attributed to the one that wrote it`);
console.log(`  name:number tokens       ${head.tokens}`);
console.log(`  citation-shaped          ${head.citations} (the rest are host:port, ENV:value, §NN or prose)`);
console.log(`  bare :NN continuations   ${head.continuations} — they inherit the file before them, so nothing is judged on them alone`);
console.log(`  distinct files cited     ${head.files.size}`);
if (!WORKTREE) {
  console.log(`  working copy citations   ${work.citations} in ${work.sections} section(s), ${work.offenders.length} offender(s)`);
}
console.log('');

if (VERBOSE) {
  console.log('EVERY CITATION AND WHERE IT RESOLVED (HEAD text):');
  for (const ledger of LEDGERS) {
    for (const line of ledgerText(ledger, !WORKTREE).split(/\r?\n/)) {
      for (const cite of citeTokens(line)) {
        if (!isCitation(cite.name)) continue;
        const c = resolve(cite.name);
        console.log(`  ${cite.name}:${cite.spans.map((s) => s.join('-')).join(',')} -> `
          + (c.length === 1 ? c[0] : c.length === 0 ? 'NOT FOUND' : `${c.length} candidates`));
      }
    }
  }
  console.log('');
}

const strict = WORKTREE ? work : head;
if (strict.offenders.length > 0) {
  console.log(`FALSE LEDGER CITATIONS (${strict.offenders.length}):`);
  const byKind = new Map();
  for (const o of strict.offenders) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
  for (const [kind, rows] of byKind) {
    console.log(`  ${kind} (${rows.length}):`);
    for (const r of rows) console.log(`    - ${r.where}  ${r.cite.name}:${r.cite.spans.map((s) => s.join('-')).join(',')} — ${r.detail}`);
  }
  console.log('');
} else {
  console.log('LEDGER CITATIONS — every citation-shaped token resolves to one file, by name, within its bounds.');
  console.log('');
}

if (!WORKTREE && work.offenders.length > 0) {
  console.log('The working copy is not strict, so these are what the NEXT commit will inherit — they are');
  console.log('another lane\'s unwritten paragraph or this lane\'s own draft, and a gate that reddened on the');
  console.log('first would be a gate two lanes could not run at the same time.');
  console.log('');
}

console.log('LIMITS, stated rather than implied: this checks that a cited file exists, is named uniquely, and');
console.log('has the line it cites. It cannot check that the line says what the sentence claims — a ledger');
console.log('citation has no row identifiers to compare against, unlike a quality.sql answer site (D87). It is');
console.log('blind to a misspelled extension (`Foo.jva:12` is not file-shaped) and to a name written without');
console.log('capitalisation or extension, and a file deleted later still resolves if its line number survives.');
console.log(`The directory exclusion is ${VENDOR_DIRS.size} names, shared with D87 through source_index.mjs —`);
console.log('one hand list rather than two, but still a hand list, which is what §84 residue (e) owns.');
if (WORKTREE) {
  console.log('This run is strict on the WORKING COPY, so a citation in another lane\'s uncommitted paragraph');
  console.log('can redden it; the message names that file, section and line, and the claim goes to its owner.');
}

process.exit(strict.offenders.length > 0 && !REPORT_ONLY ? 1 : 0);
