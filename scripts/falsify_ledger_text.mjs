#!/usr/bin/env node
/**
 * NEXUS D157 — both sides of `scripts/check_ledger_citations.mjs`'s `--text` seam, shown rather than asserted.
 *
 * WHY THIS EXISTS. Gate step 8 runs the ledger census with `GATE_LEDGER_TEXT:+--text="$GATE_LEDGER_TEXT"`
 * (D152), and the claim recorded there was "the reader opens the file the environment names". It had never been
 * tested. D157 measured the reader first and found the same defect D156 found in step 7's reader, on the other
 * half of the same sentence: the old parser was
 *
 *   const TEXT_ARG = process.argv.find((a) => a.startsWith('--text='));
 *
 * so `--text=<plant>` worked, and `--text <plant>` — the spelling gate step 9's own driver comments about, and
 * the one a person types from the USAGE line — was not an error at all. Measured on the HEAD bytes:
 * `--text=<plant>` printed `headings seen 1 section(s)` and `FALSE LEDGER CITATIONS (1)` and exited 1, while
 * `--text <plant>` printed `headings seen 297 section(s)`, `citation-shaped 377`, `LEDGER CITATIONS — every
 * citation-shaped token resolves…` and exited 0. The second run censused the two real ledgers, said nothing
 * false, and was aimed at nothing. `--tex=<plant>` did the same. And the four non-vacuity guards were
 * `throw new Error`, which printed a stack trace with exit 1 — the code this reader uses for "a ledger names a
 * file that is not there" — so a census that had certified nothing was reporting a finding about the ledgers.
 *
 * THE ARMS. Each states its verdict before the shipped checker runs, and the harness exits 1 if a prediction
 * misses:
 *   · the control is this tree, `--worktree`, which must stay green and must not print `FALSE`;
 *   · the same plant reached by each of the two spellings has to give the SAME verdict (that pair is D156's
 *     census in miniature, and it is the regression half — before the fix the second one was the green lie);
 *   · a plant naming a file that does not exist reddens a different arm of the census, so the seam is not
 *     proven only against past-EOF citations;
 *   · an unknown flag, a missing value, an empty value, a value that reads as another flag, a switch given a
 *     value, and `--text` twice each exit 2 with `RESULT: NOT CHECKED` — refused, not ignored;
 *   · a file with no `## ` heading exits 2 rather than throwing;
 *   · `--report` over a true plant still prints the offence (report mode is a caller's choice about the exit
 *     code, not a way to be blind);
 *   · D197 — the exclusion LIST is armed the same way as the seam: a citation naming a file that is on disk
 *     inside a skipped directory is charged rather than resolved, one plant text gives two verdicts over two
 *     index roots that differ only in where the twin sits, the census prints the shared set's own size rather
 *     than a copy of it, and the radius the list costs the real tree is measured by a second walk that must
 *     first reproduce the shipped index file for file and then refuse if any file it kept out is tracked;
 *   · the shipped gate's `--help` has to name every knob its own Environment-overrides block documents, and
 *     step 8 has to both run this harness and pass the knob to the reader — a knob nobody can discover, or a
 *     harness nobody runs, is an arm that does not exist.
 *
 * WHAT IT DOES NOT COVER, because a census that hides its blind spots is the thing this project keeps catching:
 * the plants live in the OS temp directory but the checker's *source index* is built from `process.cwd()`, so
 * the file-resolution half of every arm is judged against the real repository. That is intended (it is what
 * makes a cite one line past the checker's own last line a true past-EOF, and why that number is read out of
 * the file instead of written here) and it means this harness must be run from the
 * repo root — which is how `db_gate_fresh.sh` invokes it. It does not re-test the citation grammar itself;
 * that plane is `check_comment_citations.mjs`'s slice, and step 8's green arm here is the guard against the
 * grammar silently stopping matching anything.
 *
 * USAGE   node scripts/falsify_ledger_text.mjs                       (from the repo root)
 *         node scripts/falsify_ledger_text.mjs --reader=<planted reader>   (expect exit 1: the seam is live)
 *         node scripts/falsify_ledger_text.mjs --help
 * EXIT    0 every prediction held · 1 an arm missed · 2 the harness could not start, or was asked for a
 *         flag it does not parse — which is the case D163 caught this file in, printing a green tally about
 *         a mutant it had never opened because an unknown word used to be nothing at all
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';
import { LEDGER_EXT, VENDOR_DIRS, walkFiles } from './source_index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(tmpdir(), 'nexus-d157-falsify');
const HARNESS = join(ROOT, 'scripts', 'falsify_ledger_text.mjs');
// D165 — this harness takes a reader now, because D163 caught it not taking one: `--reader=<mutant>` was an
// unrecognised word, so the run that believed it was testing a mutant had run the SHIPPED checker and printed
// "25 of 25 held" about a file it never opened. A harness that ignores a flag is the defect its own subjects
// are watched for, and the parse goes through the same shared parser so this file cannot grow a private dialect.
const SELF_SPEC = { '--reader': { kind: 'value', unit: 'reader file' }, '--help': { kind: 'switch' } };
const selfParsed = parseFlags(process.argv.slice(2), SELF_SPEC);
if (!selfParsed.ok) {
  console.log(`RESULT: NOT CHECKED — ${selfParsed.reason}`);
  process.exit(2);
}
if (selfParsed.switches.includes('--help')) {
  console.log('usage: node scripts/falsify_ledger_text.mjs [--reader=<planted reader>] [--help]');
  console.log('  every arm runs one reader; --reader aims them all at a planted copy, and the mutant arm');
  console.log('  says that it skipped, because there is nothing to plant inside a plant');
  process.exit(0);
}
const PLANTED = selfParsed.value['--reader'] ?? null;
const MUTATES = PLANTED === null;
const CHECKER = PLANTED ?? join(ROOT, 'scripts', 'check_ledger_citations.mjs');
const GATE = readFileSync(join(ROOT, 'scripts', 'db_gate_fresh.sh'), 'utf8').split(/\r?\n/);

rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const CRLF = (lines) => lines.join('\r\n') + '\r\n';
const fixture = (name, lines) => {
  const p = join(FIX, name);
  writeFileSync(p, CRLF(lines), 'utf8');
  return p;
};

// A citation to a real file, past its last line. The number is read out of the file rather than written down,
// for two reasons: the plant cannot drift back inside the file it cites, and D157's first version of this
// comment carried a literal past-EOF example that gate step 9 — which scans source comments with step 8's own
// grammar — correctly reddened for. A plant is allowed to hold a false citation; a comment about a plant is not.
const PAST_END = readFileSync(CHECKER, 'utf8').split(/\r?\n/).length + 1;
const PLANT_EOF = fixture('plant_past_eof.md', [
  '# D157 plant',
  '',
  '## D999 A line that is past the end',
  '',
  `The guard is at scripts/check_ledger_citations.mjs:${PAST_END}.`,
]);
// A citation to a file the index does not hold, and one that DOES resolve beside it. The resolvable line is
// not decoration: this arm's first version predicted `FILE NOT FOUND` from a plant holding only the missing
// cite, and the checker exited 2 with "1 citation(s) found and 0 file(s) resolved" instead. Its vacuity guard
// cannot tell "every citation points at a file nobody has" from "the index is broken", and it refuses rather
// than guessing — so the FILE NOT FOUND arm is only observable when at least one cite resolves, which the
// PLANT_ALONE arm below pins as its own prediction instead of leaving for the next person to rediscover.
const PLANT_MISS = fixture('plant_missing_file.md', [
  '# D157 plant',
  '',
  '## D998 A file nobody has',
  '',
  'The real one is at scripts/source_index.mjs:1 and the guard is at scripts/no_such_reader_at_all.mjs:12.',
]);
const PLANT_ALONE = fixture('plant_missing_only.md', [
  '# D157 plant',
  '',
  '## D997 Nothing in this census resolves',
  '',
  'The guard is at scripts/no_such_reader_at_all.mjs:12.',
]);
// A bare basename the index holds more than once. Measured while writing this file: `package.json` is held by
// six of them, so a cite that looks precise is naming none of the six, and that is a distinct refusal.
const PLANT_AMBIG = fixture('plant_ambiguous.md', [
  '# D157 plant',
  '',
  '## D996 A name the index holds twice',
  '',
  'The real one is at scripts/source_index.mjs:1 and the vague one is at package.json:1.',
]);
// Not a ledger: no `## ` heading anywhere, which the census reads as "I did not read what I claim to have".
const HEADLESS = fixture('plant_headless.md', ['# D157 plant', '', 'a citation-shaped token: package.json:1']);

// D161 — the blank-line class, aimed at the plane that judges it. Both numbers are derived from the cited file
// at run time for the same reason PAST_END is: a written-down line goes stale at the next edit. Here staleness
// would not merely rot the arm, it would empty it — the claim being pinned is that an EMPTY line offends while
// a line carrying text beside it does not, which needs one of each from the same file in the same run.
const TARGET = readFileSync(join(ROOT, 'scripts', 'cli_args.mjs'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const BLANK_AT = TARGET.findIndex((l, i) => i > 0 && !l.trim() && TARGET[i - 1].trim()) + 1;
const TEXT_AT = TARGET.findIndex((l) => l.includes('export function parseFlags')) + 1;
if (BLANK_AT < 1 || TEXT_AT < 1) {
  throw new Error(`cannot derive the blank-line fixture from scripts/cli_args.mjs (blank ${BLANK_AT}, parseFlags ${TEXT_AT})`);
}
const PLANT_BLANK = fixture('plant_blank_line.md', [
  '# D161 plant',
  '',
  '## D995 A citation that lands on an empty line',
  '',
  `The empty one is at scripts/cli_args.mjs:${BLANK_AT} and the real one is at scripts/cli_args.mjs:${TEXT_AT}.`,
]);

// D163 — the red D162 could only observe once, now reachable from here. Two supplied planes: a head plane with
// one committed section, and a disk plane that adds a second section citing a blank line. Without `--head-dir`
// and `--dir` this path is unwitnessable — no harness may write a new section into the real `docs/` — and a
// rule that has never been seen reddening twice is a rule nobody can re-check.
const planeFixture = (dir, extra) => {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), CRLF([
    '# D163 fixture', '', '## D900 A committed section', '', `The parser is at scripts/cli_args.mjs:${TEXT_AT}.`, extra,
  ]), 'utf8');
  writeFileSync(join(dir, 'docs', 'STATUS.md'), CRLF([
    '# D163 status fixture', '', '## 900. A committed status section', '', `The parser is at scripts/cli_args.mjs:${TEXT_AT}.`,
  ]), 'utf8');
  return dir;
};
const SEAM = join(FIX, 'seam');
const HEAD_PLANE = planeFixture(join(SEAM, 'head'), '');
const DISK_PLANE = planeFixture(join(SEAM, 'disk'),
  `\n## D901 A section being written\n\nIt cites scripts/cli_args.mjs:${BLANK_AT}, which is a blank line.\n`);
// D191 — a committed plane that opens and holds no `## ` heading. The unread guard covers a HEAD nobody could
// read; this covers the quieter failure, where the read succeeds and is empty, which makes every disk section
// look new and turns D161's counted backlog into judged offenders — the exemption inverted by an empty file.
const EMPTY_HEAD = join(SEAM, 'empty-head');
mkdirSync(join(EMPTY_HEAD, 'docs'), { recursive: true });
writeFileSync(join(EMPTY_HEAD, 'docs', 'DECISIONS.md'), CRLF([
  '# D191 fixture', '', 'The parser is at scripts/cli_args.mjs:1.', '',
]), 'utf8');
writeFileSync(join(EMPTY_HEAD, 'docs', 'STATUS.md'), CRLF(['# D191 status fixture', '']), 'utf8');

const run = (args, cwd = ROOT) => {
  const r = spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// D197 — the directory exclusion's teeth, on a supplied index root. `VENDOR_DIRS` now names `.scratch`, the
// lane's own working directory, because a D196 landing showed a stale copy of `cli_args.mjs` sitting there and
// making a citation about the shipped file read AMBIGUOUS — which stopped the gate at step 9 under
// `set -euo pipefail`. A skip list is a hiding place unless something proves nothing reaches through it, and
// neither half of that claim is observable over the real repository: the reader's index follows
// `process.cwd()` (D188), and no harness may plant a tracked-basename twin inside the tree it is certifying.
// So the checker stays the shipped one and only its ROOT moves. Each fixture holds 121 indexable files — the
// census refuses an index under a hundred, so the filler is there to keep the run a verdict rather than a
// refusal, and no plant cites it — one `probe/a/twin.mjs`, and one twin the two roots place differently: under
// `.scratch` (excluded, and on disk — the harness checks that below, because "not indexed" and "not written"
// must not be the same observation) and under `deep` (not excluded).
const EXC_ROOT = join(FIX, 'excl-root');
const KEEP_ROOT = join(FIX, 'keep-root');
const mkIndexRoot = (dir, twinDir) => {
  mkdirSync(join(dir, 'probe', 'a'), { recursive: true });
  mkdirSync(join(dir, twinDir), { recursive: true });
  mkdirSync(join(dir, 'deep'), { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(dir, 'probe', `f${String(i).padStart(3, '0')}.mjs`), CRLF(['// filler, uncited', '', 'export const v = 0;']), 'utf8');
  }
  writeFileSync(join(dir, 'probe', 'a', 'twin.mjs'), CRLF(['export const trackedTwin = 1;', '', '// second line']), 'utf8');
  writeFileSync(join(dir, twinDir, 'twin.mjs'), CRLF(['export const scratchTwin = 2;', '', '// second line']), 'utf8');
  writeFileSync(join(dir, 'deep', 'cited.mjs'), CRLF(['export const plainPathCite = 3;', '', '// second line']), 'utf8');
  return dir;
};
mkIndexRoot(EXC_ROOT, '.scratch');
mkIndexRoot(KEEP_ROOT, 'deep');
if (!existsSync(join(EXC_ROOT, '.scratch', 'twin.mjs'))) {
  throw new Error(`the excluded-directory fixture has no file to hide (${join(EXC_ROOT, '.scratch', 'twin.mjs')}) — a plant citing an absent path would prove absence, not exclusion`);
}
const PLANT_HIDDEN = fixture('plant_hidden_path.md', [
  '# D197 plant',
  '',
  '## D993 A citation into a directory the census skips',
  '',
  'The hidden one is at .scratch/twin.mjs:1, the plain path one is at deep/cited.mjs:1 and the shipped one is at probe/a/twin.mjs:1.',
]);
// D197 found the bigger hole while arming the smaller one: `isCitation` asked its bare-dotfile rule about names
// carrying a slash, so a PATH beginning with a dot directory was dropped before reaching the resolver — neither
// judged nor reported, and invisible in the counts because a dropped token is still a token. Two such cites are
// planted here, and both resolve. The arm reads `citation-shaped 2` rather than trusting a green, because under
// the classifier this file shipped until D197 the census counts zero citations and refuses the run: the failure
// mode of a dropped cite is a refusal, which is loud, and the failure mode of a wrongly-admitted one is a red,
// which is honest — what was missing entirely was a clause that judged them at all.
writeFileSync(join(EXC_ROOT, '.dotfile'), CRLF(['# a dot file the repository root owns', '', '// second line']), 'utf8');
mkdirSync(join(EXC_ROOT, 'dotdir'), { recursive: true });
writeFileSync(join(EXC_ROOT, 'dotdir', '.nested'), CRLF(['# a dot file under a dot-free directory', '', '// second line']), 'utf8');
const PLANT_DOTPATH = fixture('plant_dot_paths.md', [
  '# D197 plant',
  '',
  '## D990 Two path cites that begin with a dot',
  '',
  'The root-relative one is at ./.dotfile:1 and the nested one is at dotdir/.nested:1.',
]);
// The same two claims written the way a paragraph writes them when it does not spell the directory out: a bare
// basename. Over the excluded root the twin is not in the index, so the name is held once and the cite resolves;
// over the root that keeps its twin the same sentence reddens as AMBIGUOUS. That pair is the difference the
// exclusion makes, and it is the shape of the failure D196 actually hit.
const PLANT_BARE = fixture('plant_bare_twin.md', [
  '# D197 plant',
  '',
  '## D992 A basename held by a twin',
  '',
  'The vague one is at twin.mjs:1 and the precise one is at probe/a/twin.mjs:1.',
]);


// Every line the census prints for a plant must be identical across the two spellings, or the pair proves
// nothing about equivalence. Derived from the runs below rather than written down.
const ARMS = [
  { name: 'control: the two ledgers of this tree, --worktree', args: ['--worktree'], expect: 0,
    must: [/every citation-shaped token resolves/], absent: [/FALSE LEDGER CITATIONS/, /NOT CHECKED/, /UNCHECKED/],
    // Non-vacuity for the green arm: a heading count and a citation count are printed and nonzero, so "green"
    // is not the census having read nothing. The numbers themselves are not pinned — three lanes append here.
    floors: [/headings seen\s+(\d+) section/, /citation-shaped\s+(\d+)/] },
  { name: '--text=<plant> reaches the past-EOF arm of the census', args: [`--text=${PLANT_EOF}`], expect: 1,
    must: [/headings seen\s+1 section/, /FALSE LEDGER CITATIONS \(1\)/, /PAST EOF/] },
  { name: '--text <plant> — the same request, space-separated — reaches the same arm', args: ['--text', PLANT_EOF],
    expect: 1, must: [/headings seen\s+1 section/, /FALSE LEDGER CITATIONS \(1\)/, /PAST EOF/],
    sameVerdictAs: 1 },
  { name: '--text=<plant> reaches the file-not-found arm', args: [`--text=${PLANT_MISS}`], expect: 1,
    must: [/FALSE LEDGER CITATIONS \(1\)/, /FILE NOT FOUND/] },
  { name: 'a plant with nothing resolvable in it refuses instead of reporting one offender',
    args: [`--text=${PLANT_ALONE}`], expect: 2,
    must: [/RESULT: NOT CHECKED —/, /1 citation\(s\) found and 0 file\(s\) resolved/] },
  { name: '--text=<plant> reaches the ambiguous arm', args: [`--text=${PLANT_AMBIG}`], expect: 1,
    // The count and the candidate list are not pinned: which three of the six `package.json` files the walk
    // reports first is the index's business, and a floor of "some number, and the word hold it" is the claim.
    must: [/FALSE LEDGER CITATIONS \(1\)/, /AMBIGUOUS/, /[1-9]\d* files hold it: /] },
  { name: 'a citation onto an empty line offends on the --text plane, and it is the only offender there',
    args: [`--text=${PLANT_BLANK}`], expect: 1,
    must: [/name:number tokens\s+2/, /FALSE LEDGER CITATIONS \(1\)/, /BLANK LINE \(1\)/,
      new RegExp(`scripts/cli_args.mjs:${BLANK_AT} is empty`), /a blank line cannot hold the claim this cite makes/] },
  { name: '--worktree prints both blank halves over the real ledgers, and says what it reads HEAD for',
    // D191 — this arm used to pin the blind spot: `absent: [/BLANK LINE \(\d+\):/, /FALSE LEDGER CITATIONS/]`
    // was green only because `--worktree` collapsed its two census calls into one object, so
    // `newSections(work, head)` was 0 by construction and the blank class could not offend on the plane the
    // gate runs. It now pins the two sentences an operator reads, and it runs under `--report` on purpose:
    // whether this tree's ledgers are clean is arm "control: the two ledgers of this tree" business, and an
    // arm that mixes a print claim with a cleanliness claim reports one red for two reasons.
    args: ['--worktree', '--report'], expect: 0,
    must: [/text censised\s+the working copy \(strict\); HEAD is read only to say which sections are new/,
      /blank-line cites\s+\d+ at HEAD \(counted, not judged/, /new section\(s\), and a blank there offends/],
    absent: [/NOT CHECKED/, /UNCHECKED/] },
  // D162 — the reading plane's split, pinned as two printed halves: the committed count with its non-verdict,
  // and the new-section count with the sentence that says a blank THERE offends. D163 made the red side of this
  // rule reachable from a fixture (`--dir` / `--head-dir`, armed below), where before it could only be observed
  // once in a real ledger draft; this arm stays because it pins what an operator sees on the clean tree.
  { name: 'the default plane reports both blank halves and stays green while no new section cites one',
    args: [], expect: 0,
    must: [/blank-line cites\s+\d+ at HEAD \(counted, not judged/, /new section\(s\), and a blank there offends/,
      /0 blank\(s\) among \d+ new section/],
    absent: [/BLANK LINE \(\d+\):/, /FALSE LEDGER CITATIONS/] },
  // D163 — four faces of the new seam: red, control, and the two refusals that keep a mistyped request from
  // quietly reading the repository instead of the plane the caller asked for.
  { name: 'a new section citing a blank line reddens when both planes are supplied',
    args: ['--head-dir', HEAD_PLANE, '--dir', DISK_PLANE], expect: 1,
    must: [/FALSE LEDGER CITATIONS — BLANK LINE IN A NEW SECTION \(1\)/, new RegExp(`scripts/cli_args\\.mjs:${BLANK_AT}`),
      /1 blank\(s\) among 1 new section\(s\)/] },
  { name: 'the same head plane with no new section is green — the rule judges newness, not the fixture',
    args: ['--head-dir', HEAD_PLANE, '--dir', HEAD_PLANE], expect: 0,
    must: [/0 blank\(s\) among 0 new section\(s\)/], absent: [/FALSE LEDGER CITATIONS/, /BLANK LINE \(\d+\):/] },
  // D191 — the same rule on the plane the gate actually runs. Before this unit `--worktree` read one census
  // object for both of its planes, so these two arms could not exist: the red one printed
  // `0 blank(s) among 0 new section(s)` and exited 0 over a fixture whose new section cites an empty line.
  { name: '--worktree over a supplied pair reddens on a blank inside the new section',
    args: ['--worktree', '--head-dir', HEAD_PLANE, '--dir', DISK_PLANE], expect: 1,
    must: [/text censised\s+the working copy \(strict\); HEAD is read only to say which sections are new/,
      /1 blank\(s\) among 1 new section\(s\)/, /FALSE LEDGER CITATIONS \(1\)/, /BLANK LINE \(1\)/,
      new RegExp(`scripts/cli_args\\.mjs:${BLANK_AT} is empty`)],
    absent: [/0 blank\(s\) among 0 new section/, /BLANK LINE IN A NEW SECTION/] },
  { name: 'that same mode, with nothing new on disk, stays green — the arm that keeps the red one honest',
    args: ['--worktree', '--head-dir', HEAD_PLANE, '--dir', HEAD_PLANE], expect: 0,
    must: [/0 blank\(s\) among 0 new section\(s\)/, /every citation-shaped token resolves/],
    absent: [/FALSE LEDGER CITATIONS/, /BLANK LINE \(\d+\):/] },
  { name: 'a committed plane with no section is refused under --worktree, not read as "everything is new"',
    args: ['--worktree', '--head-dir', EMPTY_HEAD, '--dir', DISK_PLANE], expect: 2,
    must: [/RESULT: NOT CHECKED — the committed plane holds 0/, /no section on disk could be called old/] },
  // D191 also found `--verbose` dead: `ledgerText` had long ago stopped returning a string, so the dump threw
  // `ledgerText(...).split is not a function` — exit 1, the code of a verdict, for a crash (the exact shape
  // D157 named and this reader has refused elsewhere). There was no arm for `--verbose` at all.
  { name: '--verbose prints the resolved list for the plane being judged instead of crashing',
    args: ['--verbose', '--report', `--text=${PLANT_BLANK}`], expect: 0,
    must: [/EVERY CITATION AND WHERE IT RESOLVED \(working copy text\):/,
      /scripts\/cli_args\.mjs:\d+ -> scripts\/cli_args\.mjs/, /BLANK LINE \(1\)/] },
  // D165 — the pair is enforced. Measured before the guard existed: `--head-dir` alone turned the 12 committed
  // blank citations into offenders and exited 1 — the exemption inverted by half a command line — and `--dir`
  // alone printed a NEGATIVE count of sections being written, which is two trees' heading totals being
  // subtracted rather than any claim about newness. Both refusals name the partner flag, and the count is now
  // a set difference, so it cannot go negative even on a pair that disagrees in both directions.
  { name: '--dir without --head-dir is refused, because one plane alone mixes two trees',
    args: ['--dir', DISK_PLANE], expect: 2,
    must: [/RESULT: NOT CHECKED — --dir was given without --head-dir/, /the two planes are addressed as a pair/] },
  { name: '--head-dir without --dir is refused for the same reason, in the other direction',
    args: ['--head-dir', HEAD_PLANE], expect: 2,
    must: [/RESULT: NOT CHECKED — --head-dir was given without --dir/, /against the ledgers of this tree/] },
  { name: '--dir= is refused with its unit named, not silently read as the repository', args: ['--dir='], expect: 2,
    must: [/RESULT: NOT CHECKED — --dir was given without a directory/] },
  { name: '--head-dir followed by another flag is refused, because a seam may not guess which plane',
    args: ['--head-dir', '--dir', DISK_PLANE], expect: 2,
    must: [/RESULT: NOT CHECKED — --head-dir was followed by --dir/, /there is no directory to read/] },
  { name: 'an unparseable flag is refused, not dropped', args: [`--tex=${PLANT_EOF}`], expect: 2,
    must: [/RESULT: NOT CHECKED — unknown option --tex/] },
  { name: '--text= with nothing after the sign', args: ['--text='], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was given without a path/] },
  { name: '--text with nothing after the sign', args: ['--text'], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was given without a path/] },
  { name: '--text followed by another flag', args: ['--text', '--report'], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was followed by --report/] },
  { name: '--text twice, which copy is the census', args: [`--text=${PLANT_EOF}`, `--text=${PLANT_MISS}`], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was given 2 times/] },
  { name: 'a switch given a value', args: ['--worktree=1'], expect: 2,
    must: [/RESULT: NOT CHECKED — --worktree is a switch and was given a value/] },
  { name: 'a bare positional argument', args: [PLANT_EOF], expect: 2,
    must: [/RESULT: NOT CHECKED — unexpected argument/] },
  { name: 'a file with no "## " heading refuses instead of throwing', args: [`--text=${HEADLESS}`], expect: 2,
    must: [/RESULT: NOT CHECKED —/, /saw no "## " heading/], absent: [/at .*check_ledger_citations\.mjs:\d+/, /Error:/] },
  { name: '--report over a true plant still prints the offence', args: ['--report', `--text=${PLANT_EOF}`], expect: 0,
    must: [/FALSE LEDGER CITATIONS \(1\)/, /PAST EOF/] },
  // D197 — the arms above judge what a plant says; these judge what the INDEX is allowed to contain. The first is
  // the hiding-place charge: `.scratch/twin.mjs` is demonstrably on disk (the harness throws before this run if it
  // is not), so a green would mean the census resolved bytes it was told to skip — and the same run resolves the
  // cite under `deep/`, which is a path in a directory nobody skips, so the offence is the exclusion speaking and
  // not a walker that sees no paths at all. The last two arms are ONE plant text over two roots whose only
  // difference is which directory the twin sits in: excluded resolves, not-excluded is AMBIGUOUS. That pair is
  // the failure D196 actually hit, written as a prediction instead of a story.
  { name: 'a citation into an excluded directory is charged even though the file is on disk, beside a path cite that resolves',
    args: [`--text=${PLANT_HIDDEN}`], cwd: EXC_ROOT, expect: 1,
    must: [/FALSE LEDGER CITATIONS \(1\)/, /FILE NOT FOUND \(1\)/, /\.scratch\/twin\.mjs:1/,
      /no indexed file has that name or path/, /distinct files cited\s+2/],
    absent: [/every citation-shaped token resolves/, /RESULT: NOT CHECKED/] },
  { name: 'a basename whose twin sits in the excluded directory resolves to the shipped file',
    args: [`--text=${PLANT_BARE}`], cwd: EXC_ROOT, expect: 0,
    must: [/every citation-shaped token resolves/, /citation-shaped\s+2/],
    absent: [/FALSE LEDGER CITATIONS/, /AMBIGUOUS/] },
  { name: 'the same sentence over a root that keeps its twin is AMBIGUOUS (D196\'s failure, witnessed)',
    args: [`--text=${PLANT_BARE}`], cwd: KEEP_ROOT, expect: 1,
    must: [/FALSE LEDGER CITATIONS \(1\)/, /AMBIGUOUS/, /2 files hold it: /] },
  { name: 'a path citation beginning with a dot directory is counted and judged, not dropped by the classifier',
    args: [`--text=${PLANT_DOTPATH}`], cwd: EXC_ROOT, expect: 0,
    must: [/name:number tokens\s+2/, /citation-shaped\s+2/, /every citation-shaped token resolves/,
      /strict offenders\s+0/], absent: [/RESULT: NOT CHECKED/, /FALSE LEDGER CITATIONS/] },
];

// The wiring and discoverability arms read the shipped gate rather than the checker: what is being certified is
// that the seam is reachable *from inside the gate*, which is the whole standing rule (D98, D150-D152).
function gateKnobs() {
  const from = GATE.findIndex((l) => l.startsWith('# Environment overrides:'));
  if (from < 0) throw new Error('db_gate_fresh.sh has no Environment overrides block to read knobs out of');
  const names = [];
  for (let i = from + 1; i < GATE.length; i += 1) {
    if (!GATE[i].startsWith('#')) break;
    if (/^#$/.test(GATE[i])) break;
    const m = GATE[i].match(/^#\s{3}([A-Z][A-Z0-9_]{3,})/);
    if (m) names.push(m[1]);
  }
  return names;
}

const results = [];
for (const arm of ARMS) {
  const r = run(arm.args, arm.cwd);
  results.push({ arm, ...r, printed: r.out });
}

{
  const knobs = gateKnobs();
  let out, code;
  try { out = execFileSync('bash', ['scripts/db_gate_fresh.sh', '--help'], { cwd: ROOT, encoding: 'utf8' }); code = 0; }
  catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status ?? -1; }
  const missing = knobs.filter((k) => !out.includes(k));
  results.push({
    arm: { name: `the shipped --help documents every knob in its own Environment block (${knobs.length} names)`,
      expect: 0, must: knobs.map((k) => new RegExp(k)), absent: [] },
    code, out, missing,
  });
}
{
  const from = GATE.findIndex((l) => l.includes('step "8/12'));
  const to = GATE.findIndex((l, i) => i > from && /^step /.test(l));
  const region = from < 0 ? '' : GATE.slice(from, to < 0 ? GATE.length : to).join('\n');
  const want = [/node scripts\/falsify_ledger_text\.mjs/, /GATE_LEDGER_TEXT:\+--text=/,
    /GATE_LEDGER_DIR:\+--dir=/, /GATE_LEDGER_HEAD_DIR:\+--head-dir=/,
    // The two modes are mutually exclusive BY TEXT: `--worktree` alongside a supplied plane would compare
    // nothing and still print a verdict, so the branch itself is what is pinned here, not just the flags.
    /if \[ -n "\$\{GATE_LEDGER_DIR:-\}" \]/, /node scripts\/check_ledger_citations\.mjs --worktree/];
  results.push({
    arm: { name: 'gate step 8 runs this harness AND passes the knob to the reader', expect: 0, must: want, absent: [] },
    code: want.every((re) => re.test(region)) ? 0 : 1, out: region,
  });
}

// D189 — step 13's honesty is a `cd`, and a `cd` is exactly the thing a later edit loses. The leg that ran the
// reader with `--dir`/`--head-dir` aimed at a worktree looked like a clean-checkout census and was not: the
// knobs move the ledgers, the source index follows `process.cwd()` (D188's measurement: 77 files cited and 0
// offenders from the main tree, 65 and 41 from inside the worktree, same commit). So the wiring arm pins the
// three bare legs and the reconciliation line, and its floor is the same scan's output — a narrower regex can
// never shrink the population it certifies. The pair arm runs that identical predicate over a copy where
// `cd "$WT"` is put back to `cd "$ROOT"` and predicts the red, because an arm nobody has seen fail is a story.
const step13 = (lines) => {
  const from = lines.findIndex((l) => l.includes('step "13/13'));
  const region = from < 0 ? '' : lines.slice(from).join('\n');
  const readers = [...new Set([...region.matchAll(/cd "\$WT" && node scripts\/([\w.]+\.mjs)/g)].map((m) => m[1]))];
  // D190 — step 13 runs each of its three readers twice now: once from this directory with that step's own
  // plane knob aimed at the worktree, once from inside the worktree with no knob, and one `reconcile` line
  // reports the pair. So the wiring arm asks for three knob captures, three bare captures and three calls, and
  // reads the `reconcile` function body for digits — a count that lives in the body is a number the step
  // remembers instead of one it measured, which is the failure this whole lane keeps tripping over.
  const knob = (region.match(/="\$\( cd "\$ROOT" && node scripts\/([\w.]+\.mjs)/g) ?? []).length;
  const bare = (region.match(/="\$\( cd "\$WT" && node scripts\/([\w.]+\.mjs)/g) ?? []).length;
  const calls = [...region.matchAll(/^reconcile (\S+) "\$FILES_[A-Z]+" /gm)].map((m) => m[1]);
  const body = (region.match(/^reconcile\(\) \{([\s\S]*?)^\}$/m) ?? [, ''])[1];
  // `$1`-style positional reads are not counts, so they are stripped before the digit scan; what survives is a
  // number that was typed into the reporting line.
  const literal = (body.replace(/\$\w/g, '').match(/[0-9]/g) ?? []).length;
  return { region, readers, knob, bare, calls, body, literal,
    ok: from >= 0 && readers.length === 3 && knob === 3 && bare === 3
      && calls.join(',') === '13a,13b,13c' && body.length > 0 && literal === 0 };
};
{
  const s = step13(GATE);
  results.push({
    arm: { name: `gate step 13 runs its three reader legs INSIDE the worktree (${s.readers.join(', ') || 'no bare leg found'})`,
      expect: 0, must: [], absent: [] },
    code: s.ok ? 0 : 1,
    out: `readers ${s.readers.length} of 3 · knob legs ${s.knob} of 3 · bare legs ${s.bare} of 3 · reconcile calls [${s.calls.join(' ')}] · literal digit(s) in the reconcile body ${s.literal}`,
  });
}
{
  const mutated = GATE.map((l) => l.replace(/cd "\$WT"/g, 'cd "$ROOT"'));
  const s = step13(mutated);
  results.push({
    arm: { name: 'the same predicate reddens when the legs are put back to the main tree (D189 witnesses itself)',
      expect: 1, must: [], absent: [] },
    code: s.ok ? 0 : 1, out: `mutated copy: readers ${s.readers.length} of 3`,
  });
}
{
  const mutated = GATE.map((l) => l.replace(/\$\(off "\$3"\)/g, '0'));
  const s = step13(mutated);
  results.push({
    arm: { name: 'the same predicate reddens when a reconciliation count stops coming out of a run (D190 witnesses itself)',
      expect: 1, must: [], absent: [] },
    code: s.ok ? 0 : 1, out: `literal-injected copy: digits ${s.literal} · calls [${s.calls.join(' ')}]`,
  });
}
{
  const mutated = GATE.filter((l) => !/^reconcile 13a /.test(l));
  const s = step13(mutated);
  results.push({
    arm: { name: 'the same predicate reddens when one leg stops reporting its pair (D190, the missing-call case)',
      expect: 1, must: [], absent: [] },
    code: s.ok ? 0 : 1, out: `13a-call-removed copy: calls [${s.calls.join(' ')}]`,
  });
}
{
  const mutated = GATE.map((l) => l.replace(/Q7_KNOB="\$\( cd "\$ROOT"/, 'Q7_KNOB="$( cd "$WT"'));
  const s = step13(mutated);
  results.push({
    arm: { name: 'the same predicate reddens when a knob leg stops being driven from the main tree (D190, the contrast case)',
      expect: 1, must: [], absent: [] },
    code: s.ok ? 0 : 1, out: `knob-leg-repointed copy: knob ${s.knob} of 3 · bare ${s.bare} of 3`,
  });
}
// The four arms above are text predicates, and a text predicate is satisfied by a function that never computed
// anything. These two run the gate's own helpers — the lines from `FILES_READS=` to the closing brace of
// `reconcile`, cut verbatim out of the shipped file into a scratch script bash really executes under the same
// `set -euo pipefail` the gate runs — over synthetic reader output, so each branch of `off` is taken by a run
// rather than asserted in a comment: two legs that printed their offender headers (the counts have to come out
// of the texts and subtract to the printed gap), and a leg that printed a crash instead of a verdict, which has
// to read `no-verdict` and refuse the subtraction, because a reader that died is not a reader that found nothing.
const helpers = (lines) => {
  const from = lines.findIndex((l) => l.startsWith('FILES_READS='));
  const to = lines.findIndex((l, i) => i > from && l === '}');
  return from < 0 || to < 0 ? '' : lines.slice(from, to + 1).join('\n');
};
const runHelpers = (knobText, wtText) => {
  const src = helpers(GATE);
  if (!src) return { code: -1, out: 'the reconcile helper block could not be cut out of db_gate_fresh.sh' };
  const pa = join(FIX, 'd190-knob.txt'), pb = join(FIX, 'd190-wt.txt'), ps = join(FIX, 'd190-reconcile.sh');
  writeFileSync(pa, knobText, 'utf8');
  writeFileSync(pb, wtText, 'utf8');
  const dir = FIX.replace(/\\/g, '/');
  writeFileSync(ps, `set -euo pipefail\n${src}\nreconcile 13t "$FILES_READS" "$(cat '${dir}/d190-knob.txt')" "$(cat '${dir}/d190-wt.txt')"\n`, 'utf8');
  try { return { code: 0, out: execFileSync('bash', [ps], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};
{
  const { code, out } = runHelpers(
    '  citations resolved   12 file(s) under a 21-dir vendor exclusion\nFALSE SITES (8):\n',
    '  citations resolved   10 file(s) under a 14-dir vendor exclusion\nFALSE SITES (11):\n');
  results.push({
    arm: { name: 'reconcile prints both runs\' counts and their difference, computed by the gate\'s own helpers',
      expect: 0, must: [/knob leg 12 file\(s\) cited \/ 8 offender\(s\), in-worktree leg 10 \/ 11/,
        /moves the offender count by 3/], absent: [/no-verdict/, /not comparable/] },
    code, out,
  });
}
{
  const { code, out } = runHelpers('node:internal/errors:900\n  throw err;\n',
    '  citations resolved   10 file(s) under a 14-dir vendor exclusion\nFALSE SITES (11):\n');
  results.push({
    arm: { name: 'a leg that printed neither an offender header nor its clean sentence reads no-verdict and stops the subtraction',
      expect: 0, must: [/no-verdict/, /not comparable/], absent: [/moves the offender count by/] },
    code, out,
  });
}

// The equivalence claim, checked as text rather than as two independent predictions: the two spellings of the
// same plant have to produce the same verdict lines, or arm 3 is only a second red, not a second reader.
{
  const a = results[1];
  const b = results[2];
  const digest = (t) => t.split(/\r?\n/).filter((l) => /headings seen|citation-shaped|FALSE LEDGER CITATIONS|PAST EOF/.test(l)).join('|');
  const equal = a.code === b.code && digest(a.out) === digest(b.out);
  results.push({
    arm: { name: 'the two spellings of --text print the same verdict about the same plant', expect: 0,
      must: [], absent: [] },
    code: equal ? 0 : 1, out: `equals: exit ${a.code} [${digest(a.out)}]\nspace:    exit ${b.code} [${digest(b.out)}]`,
  });
}

// D197 — four claims about the exclusion LIST, each read out of the module that owns it rather than retyped
// here (D196's rule: a copy of another file's vocabulary is not that file's vocabulary). The size arm is the one
// that keeps the census's own limits paragraph honest, the membership arms say the name is in the list and prove
// the predicate can see its absence, and the last two measure the exclusion's radius over the REAL tree: the
// harness walks it a second time with one name lifted, refuses to believe its own walk until it reproduces the
// shipped index file for file, and then charges the census if any file it kept out turns out to be tracked — the
// case in which a skip list would be hiding a first-party claim rather than a lane's scratch.
{
  const s = run(['--worktree', '--report']);
  results.push({
    arm: { name: `the census prints the shared list's own size (${VENDOR_DIRS.size} names), not a copy of it`,
      expect: 0, must: [new RegExp(`The directory exclusion is ${VENDOR_DIRS.size} names`)], absent: [] },
    ...s,
  });
}
{
  const lifted = new Set([...VENDOR_DIRS].filter((n) => n !== '.scratch'));
  results.push({
    arm: { name: 'the shared list holds the name D197 added, read out of the module this harness imports',
      expect: 0, must: [], absent: [] },
    code: VENDOR_DIRS.has('.scratch') ? 0 : 1,
    out: `${VENDOR_DIRS.size} names in the set · .scratch present ${VENDOR_DIRS.has('.scratch')}`,
  });
  results.push({
    arm: { name: 'that predicate reddens on the same list with D197\'s name lifted — it is a test, not a tautology',
      expect: 1, must: [], absent: [] },
    code: lifted.has('.scratch') ? 0 : 1, out: `lifted copy holds ${lifted.size} names`,
  });
}
{
  const accept = (name) => LEDGER_EXT.test(name) || name.startsWith('.');
  // A mirror of `walkFiles`, differing in exactly one decision: whether `keep` is skipped. Its own arm below
  // demands that the mirror reproduce the shipped walk when nothing is kept, so the radius printed after it is
  // a measurement of the shipped list rather than of a traversal this file invented.
  const walkKeeping = (keep, dir = '', out = []) => {
    let entries;
    try { entries = readdirSync(join(ROOT, dir)); } catch { return out; }
    for (const name of entries) {
      if (name !== keep && VENDOR_DIRS.has(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(ROOT, rel)).isDirectory()) walkKeeping(keep, rel, out);
      else if (accept(name)) out.push(rel);
    }
    return out;
  };
  const shipped = walkFiles(ROOT, accept);
  const shippedSet = new Set(shipped);
  const mirror = walkKeeping(null);
  const reproduces = mirror.length === shipped.length && mirror.every((p) => shippedSet.has(p));
  results.push({
    arm: { name: `the harness's mirror walk reproduces the shipped index file for file (${shipped.length} entries)`,
      expect: 0, must: [], absent: [] },
    code: reproduces ? 0 : 1, out: `shipped ${shipped.length} · mirror ${mirror.length}`,
  });
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter((l) => l !== ''));
  const extras = walkKeeping('.scratch').filter((p) => !shippedSet.has(p));
  results.push({
    arm: { name: `the exclusion keeps out no tracked file (${extras.length} file(s) untracked, index ${shipped.length})`,
      expect: 0, must: [], absent: [] },
    code: reproduces && shipped.length >= 100 && extras.every((p) => !tracked.has(p)) ? 0 : 1,
    out: `radius ${extras.length} file(s) · tracked among them ${extras.filter((p) => tracked.has(p)).length}`
      + ` · shipped index ${shipped.length} · tracked set ${tracked.size}`,
  });
  // The liveness half: the same predicate run over a population that certainly contains one tracked file has to
  // call it, which needs no `.scratch` on disk and so also holds on a clean checkout.
  const oneTracked = shipped.find((p) => tracked.has(p)) ?? null;
  const caught = extras.concat(oneTracked === null ? [] : [oneTracked]).filter((p) => tracked.has(p));
  results.push({
    arm: { name: 'that predicate reddens when a file inside the excluded directory is tracked (D197 witnesses itself)',
      expect: 1, must: [], absent: [] },
    code: caught.length > 0 ? 1 : 0,
    out: `population given to the charge: ${extras.length} excluded file(s) + ${oneTracked === null ? 'nothing derived' : oneTracked} → caught ${caught.length}`,
  });
}

let fails = 0;
// D165 — the arm that says the seam arms are predictions and not decoration: rebuild the reader with its
// committed-plane read broken and run THIS harness against it, predicting exit 1. The planted copy goes into a
// temp directory together with the two modules it imports relatively, because the first attempt at this in
// D163 wrote the copy alone and the child died of MODULE_NOT_FOUND at exit 1 — a red that belongs to the
// harness's own import, not to the predicate, and a mutant measured that way is worth nothing.
// Skipped when `--reader` already aims this run at a plant: there is nothing to plant inside a plant.
if (MUTATES) {
  // Its own root, NOT under FIX: the planted reader is a harness run, and every harness run clears FIX at its
  // start — the first version of this arm wrote the mutant into FIX and the child deleted it before opening it.
  const MDIR = join(tmpdir(), `nexus-d165-mutant-${process.pid}`);
  mkdirSync(MDIR, { recursive: true });
  const src = readFileSync(CHECKER, 'utf8');
  // D191 — the blind spot is the committed plane's census, so the mutant puts it back rather than the
  // predicate that consumes it: under `--worktree` the committed read becomes a second read of the working
  // copy, which is what the reader used to do. Runtime-equivalent, not a crash — every sentence above the
  // mutation still prints, and the two arms that name the newness denominator are the ones that go red.
  const anchor = 'census(true, () => false)';
  const hits = src.split(anchor).length - 1;
  let code = -1;
  let out = '';
  if (hits !== 1) {
    out = `the committed-plane census appears ${hits} times in the reader — the mutant has no anchor`;
  } else {
    try {
      writeFileSync(join(MDIR, 'check_ledger_citations.mjs'),
        src.replace(anchor, 'WORKTREE ? census(false, () => false) : ' + anchor), 'utf8');
      for (const sib of ['cli_args.mjs', 'source_index.mjs']) {
        writeFileSync(join(MDIR, sib), readFileSync(join(ROOT, 'scripts', sib), 'utf8'), 'utf8');
      }
      const child = spawnSync(process.execPath, [HARNESS, `--reader=${join(MDIR, 'check_ledger_citations.mjs')}`],
        { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
      code = child.status ?? -1;
      out = `${child.stdout || ''}${child.stderr || ''}`;
    } catch (e) {
      out = `the mutant could not be run: ${e.message}`;
    }
  }
  rmSync(MDIR, { recursive: true, force: true });
  results.push({
    arm: { name: 'a reader with D191\'s committed-plane read put back to the blind spot reddens this harness', expect: 1,
      // The child's own verdict is the evidence, not its exit code alone: the mutant reader must FAIL to
      // redden the seam's red arm, which the child reports as that arm missing with the heading named as the
      // text it never printed. (First version of this regex predicted `0 printed` for the arm's reader exit —
      // the child exits 1 because IT has a missed arm, which is a different 1.)
      // D191 — two arms must go red, not one: the `--worktree` seam pair (its blank stops offending) and the
      // empty-committed-plane refusal (a second disk read has sections in it, so nothing looks unread). The
      // real-ledger arms are red in the child for the tree's own reason and are deliberately not pinned here.
      must: [/MISSED\s+exit 1 expected, \d+ printed\s+--worktree over a supplied pair reddens/,
        /expected text missing: .*FALSE LEDGER CITATIONS/,
        /MISSED\s+exit 2 expected, \d+ printed\s+a committed plane with no section is refused/,
        /RESULT: FAIL/, /\(skipped\) the mutant arm/] },
    code, out,
  });
} else {
  console.log(`  (skipped) the mutant arm: this run is already aimed at a planted reader (${CHECKER})`);
}
// And the harness's own door, since D163 caught it standing open: a flag this file does not parse must refuse.
{
  const child = spawnSync(process.execPath, [HARNESS, '--readers=x'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  results.push({
    arm: { name: 'a flag this harness does not parse is refused rather than ignored', expect: 2,
      must: [/RESULT: NOT CHECKED — unknown option --readers/, /flags this reader parses/] },
    code: child.status ?? -1, out: `${child.stdout || ''}${child.stderr || ''}`,
  });
}

for (const r of results) {
  const missed = (r.arm.must ?? []).filter((re) => !re.test(r.out));
  const unwanted = (r.arm.absent ?? []).filter((re) => re.test(r.out));
  const floors = (r.arm.floors ?? []).map((re) => (re.exec(r.out) ?? [])[1]).filter((v) => !(Number(v) > 0));
  const bad = r.code !== r.arm.expect || missed.length > 0 || unwanted.length > 0 || floors.length > 0;
  if (bad) fails += 1;
  console.log(`${bad ? 'MISSED' : 'held  '}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  for (const m of missed) console.log(`         expected text missing: ${m}`);
  for (const u of unwanted) console.log(`         text that must not be there: ${u}`);
  for (const f of floors) console.log(`         count printed zero or unread: ${f}`);
  if (bad) console.log(`         verdict lines: ${r.out.split(/\r?\n/).filter((l) => /RESULT|FALSE|headings seen|citation/.test(l)).slice(0, 4).join(' | ')}`);
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped checker as a subprocess with cwd = the repo root, so the');
console.log('           source index is the real tree and the plants are temp files — see the header.');
if (fails) { console.log('\nRESULT: FAIL — the --text seam does not do what step 8 claims'); process.exit(1); }
console.log('\nRESULT: PASS — both spellings aim the census, an unparseable request refuses, and step 8 is reachable from the gate');
