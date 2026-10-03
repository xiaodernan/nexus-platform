// Apply the drift reader's `--reaim` rows to a ledger, correctly: a range citation moves BOTH endpoints.
//
// Why this exists: `check_line_cite_drift.mjs --reaim` prints `site`, `file`, `from`, `to` for one MOVED
// citation — the line whose text the reader located. Two citations in the ledger are ranges
// (`path:191-202`, `path:413-419,:433-435`), so replacing only the printed number leaves a span that ends
// before it begins. That is a defect this lane shipped on 2026-10-03 (commit 3f83a37), caught by the ledger
// citation reader charging it strict. This applier takes the reader's rows and the delta they imply, and
// shifts every endpoint of the citation it is rewriting by that same delta.
//
// It changes nothing it was not told to: it refuses on a row whose `from` number is not on the site line, on
// a site line that holds the number twice, and on a run with zero rows (an empty scan is not a pass).
//
//   node scripts/apply_line_cite_reaim.mjs --rows=<file> --apply    # rewrite the ledgers in place
//   node scripts/apply_line_cite_reaim.mjs --rows=<file>            # print the rewrite, change nothing
//   node scripts/apply_line_cite_reaim.mjs --selftest               # behavioural cases, no git needed
import { readFileSync, writeFileSync } from 'node:fs';
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

// --------------------------------------------------------------------------- selftest (predictions written first)
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
  console.log(`\nRESULT: ${fails ? 'FAIL' : 'PASS'} — ${cases.length + refuses.length} selftest case(s), ${fails} mismatch(es)`);
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
  const apply = Boolean(parsed.flag['--apply']);
  // Group by site file, rewrite each site line once, refuse on any row whose number is not on its line.
  const bySite = new Map();
  for (const row of rows) {
    const [, site, file, from, to] = row.split('\t');
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push({ file, from: Number(from), to: Number(to) });
  }
  let refused = 0, applied = 0;
  for (const [site, list] of bySite) {
    // A site is `ledger:line`; only the part before the LAST colon is a path. Reading the whole token as a
    // path is what crashed the first real run: the selftest calls shiftCitation directly, so this seam was
    // never reached while the plane held 0 MOVED rows.
    const sep = site.lastIndexOf(':');
    const siteFile = site.slice(0, sep);
    const lnRaw = Number(site.slice(sep + 1));
    if (!Number.isInteger(lnRaw) || lnRaw < 1) { console.log(`REFUSE ${site} — site has no positive line number`); refused++; continue; }
    const text = readFileSync(siteFile, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    for (const r of list) {
      const idx = lnRaw - 1;
      const got = shiftCitation(lines[idx] ?? '', r.file, r.from, r.to);
      if (got.moved === 0) { console.log(`REFUSE ${site} — no citation to ${r.file}:${r.from} on that line, so the row is stale or the line moved`); refused++; continue; }
      lines[idx] = got.text;
      applied++;
      console.log(`  ${got.moved === 1 ? 'one' : `${got.moved} endpoints`} moved  ${site}  ${r.file}:${r.from} -> :${r.to}`);
    }
    if (apply) writeFileSync(siteFile, lines.join(eol), 'utf8');
  }
  if (refused) { console.log(`RESULT: REFUSED — ${refused} row(s) unmatched, ${applied} applied${apply ? '' : ' (dry run)'}`); return 1; }
  console.log(`RESULT: ${apply ? 'APPLIED' : 'DRY RUN'} — ${applied} site line(s) rewritten, endpoints shifted by each row's own delta`);
  return 0;
}

process.exit(main());
