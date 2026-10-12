// Apply the drift reader's `--reaim` rows to a ledger, correctly: a range citation moves BOTH endpoints.
//
// Why this exists: `check_line_cite_drift.mjs --reaim` prints `site`, `file`, `from`, `to` for one MOVED
// citation — the line whose text the reader located. Two citations in the ledger are ranges
// (`path:191-202`, `path:413-419,:433-435`), so replacing only the printed number leaves a span that ends
// before it begins. That is a defect this lane shipped on 2026-10-03 (commit 3f83a37), caught by the ledger
// citation reader charging it strict. This applier takes the reader's rows and the delta they imply, and
// shifts every endpoint of the citation it is rewriting by that same delta.
//
// It changes nothing it was not told to: it refuses on a row whose `from` number is not on the site line, on a
// site line the file does not have, on a site file it cannot read, and on a run with zero rows (an empty scan is
// not a pass). A refusal now means the disk is exactly as it was found.
//
// The shape this file had until 2026-10-13 was the opposite: `if (apply) writeFileSync` sat INSIDE the per-site
// loop while `if (refused) return 1` sat after it. Fed one good row and one stale row, the run rewrote the good
// site on disk and still exited 1 — a half-repaired ledger reported as a refusal. A caller that re-ran to clean
// up got a second refusal with the first repair already in it, which reads like a stable failure. The probe that
// measured it is recorded in the D314 entry of docs/DECISIONS.md; the validation pass below is the fix it names,
// and the selftest cases that drive it through real files are the reason it cannot ship broken the same way
// again: the old cases called `shiftCitation` directly, so every seam they skipped could rot unnoticed.
//
//   node scripts/apply_line_cite_reaim.mjs --rows=<file> --apply    # rewrite the ledgers in place
//   node scripts/apply_line_cite_reaim.mjs --rows=<file>            # print the rewrite, change nothing
//   node scripts/apply_line_cite_reaim.mjs --selftest               # behavioural cases, on a temp fixture plane
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlags } from './cli_args.mjs';

// A citation into one file, as it appears on a ledger line: `path.ext:123`, optionally followed by more
// endpoint numbers introduced by `-` (a span) or `,` (a continuation of the same file).
const CITE = /([A-Za-z0-9_./-]+\.(?:mjs|py|sh|java|ts|tsx|json|sql)):(\d+)((?:(?:-|,):?\d+)*)/g;

// Shift every endpoint that belongs to the citation whose START is `from`, by `delta`.
// Returns { text, moved } where moved counts the endpoints rewritten.
export function shiftCitation(line, file, from, to) {
  const delta = to - from;
  let moved = 0;
  const text = line.replace(CITE, (whole, path, start, rest) => {
    if (path !== file || Number(start) !== from) return whole;
    // `rest` is the endpoint tail: `-202`, `,433-435`, or empty. Each number in it moves by the same delta.
    const shifted = rest.replace(/\d+/g, (n) => { moved++; return String(Number(n) + delta); });
    moved++; // the start itself
    return `${path}:${to}${shifted}`;
  });
  return { text, moved };
}

// --------------------------------------------------------------------------- validation pass (reads, never writes)
// Turn the reader's rows into per-file rewrite plans, or into refusals. Every site file is read and every row is
// checked here; nothing is written. The caller can therefore see the complete list of reasons a plan is not
// trustworthy before it decides to touch a single byte.
export function planJobs(rows) {
  const bySite = new Map();
  for (const row of rows) {
    const [, site, file, from, to] = row.split('\t');
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push({ file, from: Number(from), to: Number(to) });
  }
  const jobs = [];
  const refusals = [];
  for (const [site, list] of bySite) {
    // A site is `ledger:line`; only the part before the LAST colon is a path. Reading the whole token as a path
    // is what crashed the first real run, because the cases that could not reach this loop all called
    // `shiftCitation` with a line they had already built in memory.
    const sep = site.lastIndexOf(':');
    const siteFile = site.slice(0, sep);
    const lnRaw = Number(site.slice(sep + 1));
    if (!Number.isInteger(lnRaw) || lnRaw < 1) {
      refusals.push(`REFUSE ${site} — site has no positive line number`);
      continue;
    }
    let text;
    try {
      text = readFileSync(siteFile, 'utf8');
    } catch (err) {
      refusals.push(`REFUSE ${site} — the site file cannot be read (${err.code || err.message}), so its row cannot be validated`);
      continue;
    }
    // The file's own ending is part of the plan. A ledger checked out CRLF must come back CRLF, or a one-digit
    // repair would silently re-encode every line this run did not touch.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    if (lnRaw > lines.length) {
      refusals.push(`REFUSE ${site} — the file holds ${lines.length} line(s), so there is no line ${lnRaw} to rewrite`);
      continue;
    }
    let rowsApplied = 0;
    for (const r of list) {
      const got = shiftCitation(lines[lnRaw - 1] ?? '', r.file, r.from, r.to);
      if (got.moved === 0) {
        refusals.push(`REFUSE ${site} — no citation to ${r.file}:${r.from} on that line, so the row is stale or the line moved`);
        continue;
      }
      lines[lnRaw - 1] = got.text;
      rowsApplied += 1;
      console.log(`  ${got.moved === 1 ? 'one' : `${got.moved} endpoints`} moved  ${site}  ${r.file}:${r.from} -> :${r.to}`);
    }
    if (rowsApplied) jobs.push({ siteFile, eol, lines, rowsApplied });
  }
  return { jobs, refusals };
}

// The only path that reaches `writeFileSync`, and it is reached only when `refusals` is empty. An exit code of 1
// from here on therefore always means: the disk is exactly as this run found it.
export function reaim(rows, apply) {
  const { jobs, refusals } = planJobs(rows);
  const planned = jobs.reduce((a, j) => a + j.rowsApplied, 0);
  if (refusals.length) {
    for (const r of refusals) console.log(r);
    console.log(`RESULT: REFUSED — ${refusals.length} row(s) unmatched, ${planned} validated row(s) planned and 0 written`);
    return 1;
  }
  if (apply) for (const j of jobs) writeFileSync(j.siteFile, j.lines.join(j.eol), 'utf8');
  console.log(`RESULT: ${apply ? 'APPLIED' : 'DRY RUN'} — ${planned} site line(s) rewritten, endpoints shifted by each row's own delta`);
  return 0;
}

// --------------------------------------------------------------------------- selftest (predictions written first)
// A fixture plane is a directory under the system temp dir, never inside a repository: the cases below call the
// real `reaim`, which opens the paths its rows name, so the paths have to be disposable.
function fixture(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `reaim-selftest-${name}-`));
  const paths = {};
  for (const [rel, content] of Object.entries(files)) {
    paths[rel] = join(dir, rel);
    writeFileSync(paths[rel], content, 'utf8');
  }
  return { dir, paths };
}

function selftest() {
  const cases = [
    { name: 'single line cite moves one endpoint', line: 'see scripts/x.py:1292 for it', file: 'scripts/x.py', from: 1292, to: 1286, want: 'see scripts/x.py:1286 for it', wantMoved: 1 },
    { name: 'span moves both endpoints', line: '(scripts/db_gate_fresh.sh:191-202 now counts)', file: 'scripts/db_gate_fresh.sh', from: 191, to: 203, want: '(scripts/db_gate_fresh.sh:203-214 now counts)', wantMoved: 2 },
    { name: 'continuation tail moves every endpoint', line: '(scripts/db_gate_fresh.sh:413-419,:433-435) and', file: 'scripts/db_gate_fresh.sh', from: 413, to: 425, want: '(scripts/db_gate_fresh.sh:425-431,:445-447) and', wantMoved: 4 },
    { name: 'a different file on the same line is left alone', line: 'a.mjs:64 and b.py:191-202', file: 'scripts/db_gate_fresh.sh', from: 191, to: 203, want: 'a.mjs:64 and b.py:191-202', wantMoved: 0 },
    { name: 'a second citation to the same file with another start is untouched', line: 'x.sh:10 and x.sh:191-202', file: 'x.sh', from: 191, to: 203, want: 'x.sh:10 and x.sh:203-214', wantMoved: 2 },
  ];
  // The refusal cases: the applier must not invent a number the row does not license.
  const refuses = [
    { name: 'row whose start is absent from the site line', line: 'nothing cited here', file: 'x.sh', from: 191, to: 203 },
  ];
  let fails = 0;
  for (const c of cases) {
    const got = shiftCitation(c.line, c.file, c.from, c.to);
    const ok = got.text === c.want && got.moved === c.wantMoved;
    console.log(`${ok ? 'MATCHED' : 'MISMATCH'} ${c.name}: moved ${got.moved} (want ${c.wantMoved}) text [${got.text}]`);
    if (!ok) fails++;
  }
  for (const c of refuses) {
    const got = shiftCitation(c.line, c.file, c.from, c.to);
    const ok = got.moved === 0; // nothing rewritten is the refusal signal the caller checks
    console.log(`${ok ? 'MATCHED' : 'MISMATCH'} refuse-case ${c.name}: moved ${got.moved} (want 0)`);
    if (!ok) fails++;
  }
  // The write-ordering cases, driven through files on a throwaway plane. Each prediction — exit code, the exact
  // bytes every fixture file must hold afterwards, and the refusal sentence a refusing case must print — is
  // written down before the code that answers it runs. The refusal sentence is part of the prediction because
  // `exit 1, nothing written` is true of EVERY refusal: a case that only checks those two facts cannot tell a
  // stale-row refusal from the past-EOF refusal it claims to be testing, because the `?? ''` fallback turns a
  // missing line into an empty one and answers with the stale-row message instead.
  const planeCases = [
    {
      name: 'a refused run writes nothing, not even its validated row',
      files: { 'a.md': 'head\nx.py:100 tail\nstale line\n' },
      rows: [{ rel: 'a.md', ln: 2, file: 'x.py', from: 100, to: 200 },
             { rel: 'a.md', ln: 3, file: 'x.py', from: 999, to: 1000 }],
      apply: true, wantCode: 1, wantRefusal: 'no citation to x.py:999 on that line',
      want: { 'a.md': 'head\nx.py:100 tail\nstale line\n' },
    },
    {
      name: 'a clean run writes every row of every site file',
      files: { 'a.md': 'head\nx.py:100 tail\n', 'b.md': 'x.py:100 other\nfooter\n' },
      rows: [{ rel: 'a.md', ln: 2, file: 'x.py', from: 100, to: 200 },
             { rel: 'b.md', ln: 1, file: 'x.py', from: 100, to: 200 }],
      apply: true, wantCode: 0,
      want: { 'a.md': 'head\nx.py:200 tail\n', 'b.md': 'x.py:200 other\nfooter\n' },
    },
    {
      name: 'a clean dry run writes nothing',
      files: { 'a.md': 'x.py:100 tail\n' },
      rows: [{ rel: 'a.md', ln: 1, file: 'x.py', from: 100, to: 200 }],
      apply: false, wantCode: 0,
      want: { 'a.md': 'x.py:100 tail\n' },
    },
    {
      name: 'a row naming a line past end of file refuses and writes nothing',
      files: { 'a.md': 'x.py:100 tail\n' },
      rows: [{ rel: 'a.md', ln: 9, file: 'x.py', from: 100, to: 200 }],
      apply: true, wantCode: 1, wantRefusal: 'the file holds 2 line(s), so there is no line 9',
      want: { 'a.md': 'x.py:100 tail\n' },
    },
    {
      name: 'a CRLF ledger comes back CRLF, at the same line count',
      files: { 'crlf.md': 'head\r\nx.py:100 tail\r\n' },
      rows: [{ rel: 'crlf.md', ln: 2, file: 'x.py', from: 100, to: 200 }],
      apply: true, wantCode: 0,
      want: { 'crlf.md': 'head\r\nx.py:200 tail\r\n' },
    },
    {
      name: 'a site file that cannot be read refuses instead of crashing',
      files: { 'a.md': 'x.py:100 tail\n' },
      rows: [{ rel: 'absent.md', ln: 1, file: 'x.py', from: 100, to: 200 }],
      apply: true, wantCode: 1, wantRefusal: 'the site file cannot be read (ENOENT)',
      want: { 'a.md': 'x.py:100 tail\n' },
    },
    {
      // Prediction, written before this case ever ran: a ledger that carries BOTH line-ending spellings has no
      // single answer to "which line is 3", and the reader numbers lines by counting separators of one spelling.
      // Splitting on the file's first-found CRLF makes this file two lines, so the row's line 3 is past the end and
      // the run refuses. Rewriting it anyway would spend a coordinate on a file whose numbering is not settled,
      // which is how a one-digit repair lands on the wrong sentence. Expected: exit 1, nothing written, and the
      // refusal naming `the file holds 2 line(s), so there is no line 3`.
      name: 'a mixed-ending ledger refuses instead of rewriting a shifted line',
      files: { 'mixed.md': 'a\r\nb\nx.py:100 tail\n' },
      rows: [{ rel: 'mixed.md', ln: 3, file: 'x.py', from: 100, to: 200 }],
      apply: true, wantCode: 1, wantRefusal: 'the file holds 2 line(s), so there is no line 3',
      want: { 'mixed.md': 'a\r\nb\nx.py:100 tail\n' },
    },
  ];
  for (const c of planeCases) {
    const { dir } = fixture(c.name, c.files);
    const P = (rel) => join(dir, rel);
    let code = 'threw', drifted = [], after = {};
    // Capture what the run printed: the verdict a refusing case owes is its reason, and the reason only exists in
    // these lines. `reaim` reports through `console.log`, so the capture is a temporary rebind around the call,
    // restored in `finally` — a thrown arm must not leave the selftest printing into a dead array.
    const say = console.log;
    const logs = [];
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const rows = c.rows.map((r) => `reaim\t${P(r.rel)}:${r.ln}\t${r.file}\t${r.from}\t${r.to}`);
      code = reaim(rows, c.apply);
      after = Object.fromEntries(Object.keys(c.want).map((rel) => [rel, readFileSync(P(rel), 'utf8')]));
      drifted = Object.entries(c.want).filter(([rel, text]) => after[rel] !== text);
    } catch (err) {
      logs.push(`threw: ${err.code || err.name}: ${err.message}`);
    } finally {
      console.log = say;
      rmSync(dir, { recursive: true, force: true });
    }
    // A refusal that names a different reason is a different run: the case is not satisfied by any exit 1.
    const reasonOk = !c.wantRefusal || logs.some((l) => l.includes(c.wantRefusal));
    const ok = code === c.wantCode && drifted.length === 0 && reasonOk;
    console.log(`${ok ? 'MATCHED' : 'MISMATCH'} ${c.name}: exit ${code} (want ${c.wantCode}), ${drifted.length} file(s) differ from the plan, refusal reason ${
      c.wantRefusal ? (reasonOk ? 'named' : `NOT named (want [${c.wantRefusal}])`) : 'not claimed by this case'}`);
    for (const line of logs) console.log(`      | ${line.replace(dir, '<plane>')}`);
    for (const [rel, text] of drifted) console.log(`      ${rel}: got ${JSON.stringify(after[rel])} want ${JSON.stringify(text)}`);
    if (!ok) fails++;
  }
  const total = cases.length + refuses.length + planeCases.length;
  console.log(`\nRESULT: ${fails ? 'FAIL' : 'PASS'} — ${total} selftest case(s), ${fails} mismatch(es)`);
  return fails ? 1 : 0;
}

function main() {
  const parsed = parseFlags(process.argv.slice(2), {
    '--rows': { kind: 'value' },
    '--apply': { kind: 'switch' },
    '--selftest': { kind: 'switch' },
  });
  if (parsed.flag['--selftest']) return selftest();
  const rowsFile = parsed.value['--rows'];
  if (!rowsFile) { console.log('RESULT: NOT RUN — --rows=<file> holding the reader\'s tab-separated reaim rows, or --selftest'); return 2; }
  const rows = readFileSync(rowsFile, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('reaim\t'));
  if (rows.length === 0) { console.log(`RESULT: REFUSED — ${rowsFile} holds no reaim row, so an empty run must not read as a clean one`); return 1; }
  return reaim(rows, Boolean(parsed.flag['--apply']));
}

process.exit(main());
