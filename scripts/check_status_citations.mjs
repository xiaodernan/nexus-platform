#!/usr/bin/env node
/**
 * NEXUS D117 — `STATUS §NN` is the one citation grammar this repository already uses for the ledger plane,
 * and eight of its tokens point at a section that does not exist.
 *
 * §124 measured that a bare `§NN` in these ledgers is THREE planes at once (TRACEABILITY's requirement
 * matrix, which is what the source comments overwhelmingly cite — `§ numbering = 新建 文本文档.txt` says
 * `docs/TRACEABILITY.md:1`; API_CONTRACT/AGENT_CONTRACT sections; and STATUS's own sections), so a general
 * "every section reference must resolve" gate would red on 528 legitimate tokens and is not written (D116).
 * The spelled form `STATUS §NN` is different: it names its own plane, so it has exactly one correct
 * resolution, and it is rare enough to judge.
 *
 * The one distinction the check has to make is between a citation and a mention of the citation. Half the
 * spelled tokens in this repository exist *because* the defect is being reported: `docs/STATUS.md` §123,
 * §124, §125 and `docs/DECISIONS.md` D115/D116/D117 each write the offending string to name it. A ledger
 * that quotes a bad citation is not making a bad claim, so:
 *
 *   CITATION  the token outside a code span — a pointer a reader follows. Must resolve to a `## N. `
 *             heading at HEAD. This is what the two Java comments are, and it is what a fix must satisfy.
 *   MENTION   the token inside a backtick span — a quotation of a string. Printed, counted, not judged.
 *
 * The split is mechanical (an odd number of backticks before the token on its line puts it in a span) and
 * it has a stated limit: a real citation written inside backticks in prose is exempted by this rule, and a
 * quotation of a string in a language that has no backtick convention is judged as a citation. Both are
 * printed with counts so the next reader can see which side a token was sorted to.
 *
 * Usage: node scripts/check_status_citations.mjs [--head-rev <rev>|--head-rev=<rev>]
 *                                                 [--dir <root>|--dir=<root>]
 *        A flag this reader does not parse is a refusal with exit 2, not a silence: the silent form reads as
 *        a green run on the plane the operator believed they had aimed at.
 * Exit: 0 every citation resolves · 1 a citation points at a section that is not there (or a heading was
 *       renumbered out from under it) · 2 not checkable — `git show` cannot spawn, no files could be
 *       read, or the scan saw no `STATUS §NN` token at all in either shape (D79: a reader that found
 *       nothing did not check anything).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';
import { VENDOR_DIRS } from './source_index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const notCheckable = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };

// D154: the reader had one flag shape, `--dir <root>`, and no answer for anything else. `--dir=<root>` — the
// spelling `check_comment_citations.mjs` documents and the shell makes easy to type — was silently ignored, so
// a run aimed at a fixture printed the repository's own 568 files and a PASS: an option that fails to fail.
// Both spellings are parsed now, and a flag this file does not read stops the run in the same vocabulary as
// every other refusal below.
//
// D159: the parsing is the shared parser's. What this file's own loop did with a value it had swallowed was
// nothing — `--dir --report` let the value loop bind the string `--report` to `--dir`, then a second sweep
// rejected that same token, so the run exited 2 blaming an unknown option when the request's actual defect was
// that `--dir` had no directory (measured on HEAD before the patch: `RESULT: NOT CHECKED — unknown option
// --report — flags this reader parses: dir, head-rev`). Note too that this file's old sentence listed its
// flags bare (`dir, head-rev`) while `check_ledger_sections.mjs` printed the same pair with their dashes; one
// sentence, one shape, derived from the spec.
const FLAGS = {
  '--dir': { kind: 'value', unit: 'directory' },
  '--head-rev': { kind: 'value', unit: 'revision' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) notCheckable(parsed.reason);

const ROOT = resolve(parsed.value['--dir'] ?? join(HERE, '..'));
const REV = parsed.value['--head-rev'] ?? 'HEAD';
// D199: this reader was the fourth one still deciding the directory question for itself. D181 ruled the
// exclusion one list and D197 made the shipped set the union, but this file kept a private nine-name `SKIP`, so
// gate step 12 indexed the generated seed output under the gitignored `data/seed/out_smoke/` that steps 7, 8 and
// 9 refuse: a `STATUS` citation planted in build output would be charged here and be invisible to the other
// readers, which is §84 residue (e) arriving at a fourth place. The private list named `.mvn`, which the shared
// set does not, and the dot rule below already covered it — so this fold drops files from the plane and adds
// none. The dot rule stays deliberately: it is this reader's own predicate, the same kind of choice as its
// extension list, and removing it would widen the plane rather than align it (the shared set names neither
// `.mvn` nor `.github`). `scripts/falsify_status_citations.mjs` arms both halves: the exclusion is live here, and
// a copy of this reader given back a private list reddens on the very fixture the shipped one declines to read.
const isSkipped = (name) => VENDOR_DIRS.has(name) || name.startsWith('.');
const EXT = /\.(java|kt|ts|tsx|js|mjs|cjs|py|sql|sh|md|mustache)$/;
const TOKEN = /STATUS §(\d+)/g;

const fail = notCheckable;

// `git show` always reads from this script's own repository, never from --dir: a fixture directory is a
// tree of files under review, not a checkout with a HEAD.
const REPO = join(HERE, '..');
let headStatus;
try { headStatus = execFileSync('git', ['show', `${REV}:docs/STATUS.md`], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: REPO, maxBuffer: 1 << 26 }); }
catch (e) { fail(`cannot read \`git show ${REV}:docs/STATUS.md\` — ${e.message.split('\n')[0]}`); }
const headings = new Set([...headStatus.replace(/\r\n/g, '\n').matchAll(/^## (\d+)\. /gm)].map((m) => m[1]));
if (headings.size === 0) fail(`\`${REV}:docs/STATUS.md\` has no \`## N. \` headings — the heading pattern matched nothing`);

const files = [];
const walk = (d) => {
  let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!isSkipped(e.name)) walk(join(d, e.name)); continue; }
    if (EXT.test(e.name)) files.push(join(d, e.name));
  }
};
walk(ROOT);
if (files.length === 0) fail(`no readable source files under ${ROOT}`);

const cited = [], mentioned = [];
let scanned = 0;
for (const f of files) {
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  scanned += 1;
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  text.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(TOKEN)) {
      const inSpan = (line.slice(0, m.index).match(/`/g) || []).length % 2 === 1;
      const rec = { where: `${rel}:${i + 1}`, n: m[1], resolves: headings.has(m[1]) };
      (inSpan ? mentioned : cited).push(rec);
    }
  });
}

console.log(`  head revision    ${REV} — ${headings.size} STATUS headings, min §${Math.min(...[...headings].map(Number))}, max §${Math.max(...[...headings].map(Number))}`);
console.log(`  files scanned    ${scanned} of ${files.length} candidates under ${ROOT}`);
console.log(`  citations        ${cited.length} (outside a code span) · ${cited.filter((c) => c.resolves).length} resolve`);
console.log(`  mentions         ${mentioned.length} (inside a code span) · ${mentioned.filter((c) => c.resolves).length} would resolve`);
for (const c of cited.filter((x) => !x.resolves)) console.log(`  BAD  ${c.where}: \`STATUS §${c.n}\` — no \`## ${c.n}. \` heading at ${REV}`);
for (const c of cited.filter((x) => x.resolves)) console.log(`  ok   ${c.where}: STATUS §${c.n}`);
if (cited.length === 0 && mentioned.length === 0) fail(`the scan saw no \`STATUS §NN\` token in either shape across ${scanned} files — the grammar is not the one this reader expects`);
if (cited.every((c) => c.resolves)) {
  console.log('\nRESULT: PASS — every spelled `STATUS §NN` citation resolves to a heading at HEAD');
  process.exit(0);
}
console.log('\nRESULT: FAIL — a spelled ledger citation points at a section that is not in the ledger');
process.exit(1);
