#!/usr/bin/env node
/*
 * NEXUS D158 — both flag spellings aim the two e2e readers at the SAME service, and this file is the arm that
 * says so on every drive of the end-to-end runner.
 *
 * WHAT WAS BROKEN, measured rather than asserted. `verify_served_reads.mjs` and `verify_contract_runtime.mjs`
 * looked their flags up with `argv.indexOf('--name')`, which is the spaced spelling only. Against the service
 * this lane found live while writing the fix, the measured pair was:
 *
 *   --tenant d158-not-a-tenant   -> 1 check, HTTP 404, exit 1     (the flag was read)
 *   --tenant=d158-not-a-tenant   -> 626 checks PASS against :8090 (the flag was dropped, another tenant answered)
 *   --base http://127.0.0.1:1    -> fetch failed, exit 1          (the flag was read)
 *   --base=http://127.0.0.1:1    -> 626 checks PASS against :8090 (the flag was dropped)
 *   --bes <url>                  -> exit 0, the report printed    (an unknown option was not refused)
 *
 * One character apart, and only one of the two runs checked what its caller asked for. The same defect the
 * ledger calls #102, in its fifth and sixth readers -- and in a plane where the PASS line named the tenant
 * nowhere, so a run could report 626 passing checks about a tenant nobody requested and nothing in the output
 * would say so. Both verdict lines name the tenant now.
 *
 * HOW THIS IS WITNESSED WITHOUT A SERVER. Every arm runs the SHIPPED reader as a subprocess against an
 * in-process HTTP stub on an ephemeral port, and the stub keeps the request log: which host the reader
 * addressed, which `X-Tenant` it sent, which path it asked for. That is out-of-band evidence of which plane a
 * run touched -- not the reader's own claim about it. No database, no Java process, no dependence on another
 * lane's server, so a quiet machine and a busy one run this file identically.
 *
 * WHY THE READERS RUN ASYNCHRONOUSLY. The first draft of this harness called them with `spawnSync`, and every
 * arm hung until its 120-second kill: `spawnSync` parks the parent's event loop, and the parent's event loop
 * is the thing that answers the stub. A witness that cannot service the world it planted measures nothing, so
 * children are awaited instead, and the log fills while they run.
 *
 * THE ARM THAT CANNOT BE FAKE. One arm rebuilds the old one-dialect parser as a mutant copy of the reader in
 * the OS temp dir and runs this harness against the mutant as a subprocess, predicting exit 1: if a reader
 * that ignores `--flag=value` did NOT redden this file, every green arm above would be measuring nothing. The
 * mutant arm is skipped when `--reader` already aims this run at a planted file (there is nothing to plant
 * inside a plant), and says that it skipped.
 *
 * WHAT IT DOES NOT COVER, stated because a census that hides its blind spots is what this project keeps
 * catching. This file witnesses `--base` and `--tenant` for those two readers only; the other shared-parser
 * readers are witnessed by harnesses of their own, one per gate step (7, 8, 9, 10 and 12). The last arm
 * enumerates the population instead of describing it, and as of D159 it counts 11 files in `scripts/` using
 * `process.argv` in code -- 8 on this shared parser, 3 still hand-written. D158 left that split at 4/7, and the
 * four that moved were precisely the ones already accepting both spellings from private tables
 * (`check_jsonb_reads.mjs`, `check_comment_citations.mjs`, `check_ledger_sections.mjs`,
 * `check_status_citations.mjs`); each of them is pinned by a harness of its own, so the move could be proved
 * behaviour-preserving rather than asserted. Of the three still hand-written, two decide behaviour by *presence*
 * alone (`check_contract_drift.mjs:36` `argv.includes('--report')`, and the untracked
 * `verify_payload_conformance.mjs` in this working copy, a `Set` of `--report` and `--json`), so `--report=1` is
 * not "report mode with a value" but a token nothing matches. In the drift checker that switch is the difference
 * between a report and a failed build -- its line 248 exits 1 only when `reportOnly` is false -- so a caller who
 * typed the glued form asked for tolerance and would get a red. Measured on this tree the two spellings are
 * INDISTINGUISHABLE: the drift set is empty, and both printed the same 5-line report and exited 0. So what is on
 * offer is a hazard read off the code plus the one plane where it cannot yet show, not a demonstration; answering
 * it needs a planted drift row and a rate, and `check_contract_drift.mjs` is another lane's file (reported, not
 * edited). The third is `check_falsifier_registry.mjs:38`, which takes a value in the spaced form only -- also
 * another lane's, also reported not edited.
 *
 * USAGE   node scripts/falsify_flag_dialect.mjs
 *         node scripts/falsify_flag_dialect.mjs --reader=<a planted reader>   (expect exit 1: the seam is live)
 * EXIT    0 every prediction held · 1 an arm missed · 2 the harness could not start
 */
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const FIX = join(tmpdir(), 'nexus-d158-falsify');
const SERVED = join(SCRIPTS, 'verify_served_reads.mjs');
const RUNTIME = join(SCRIPTS, 'verify_contract_runtime.mjs');
const HARNESS = join(SCRIPTS, 'falsify_flag_dialect.mjs');
const E2E = join(SCRIPTS, 'e2e_fresh.sh');
const TENANT = 'd158-probe-tenant';

/* ------------------------------------------------------------------ the planted reader, if any */
// The harness reads its own flags through the parser it exists to witness: a file that asks two spellings of
// every other reader and then parses only one of its own would be a census that exempts the counter.
const SELF_SPEC = { '--reader': { kind: 'value', unit: 'reader file' }, '--help': { kind: 'switch' } };
const selfParsed = parseFlags(process.argv.slice(2), SELF_SPEC);
if (!selfParsed.ok) {
  console.log('NEXUS — flag dialect harness');
  console.log(`  RESULT: NOT CHECKED — ${selfParsed.reason}`);
  process.exit(2);
}
if (selfParsed.flag['--help']) {
  console.log('usage: node scripts/falsify_flag_dialect.mjs [--reader=<path>]');
  console.log('  runs every arm against the shipped readers; --reader aims them at one planted reader file');
  process.exit(0);
}
const PLANTED = selfParsed.value['--reader'] ?? null;
const MUTATES = PLANTED === null;   // a planted reader IS the mutation; nothing to plant inside it
const READER = PLANTED ? resolve(ROOT, PLANTED) : SERVED;

/* ------------------------------------------------------------------ the stub service */
const log = [];
const stub = createServer((req, res) => {
  log.push({ host: req.headers.host ?? '', tenant: req.headers['x-tenant'] ?? '', url: req.url ?? '' });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/v3/api-docs' ? { openapi: '3.0.1', paths: {} } : {}));
});
await new Promise((done, fail) => { stub.once('error', fail); stub.listen(0, '127.0.0.1', done); });
const PORT = stub.address().port;
const STUB = `http://127.0.0.1:${PORT}`;
if (!Number.isInteger(PORT) || PORT === 0) {
  console.log('RESULT: NOT CHECKED — the stub service did not get a port');
  process.exit(2);
}

const capture = (cmd, args) => new Promise((done) => {
  execFile(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000 },
    (err, stdout, stderr) => done({
      code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
      out: `${stdout || ''}${stderr || ''}`,
      saw: [...log],
    }));
});
const runReader = async (reader, args) => { log.length = 0; return capture(process.execPath, [reader, ...args]); };

/* ------------------------------------------------------------------ the arms */
const results = [];
const arm = async (name, { expect, must = [], absent = [], saw = null, run }) => {
  let code, out, got;
  try {
    const res = await run();
    code = res.code; out = res.out; got = res.got ?? res.saw ?? [];
  } catch (e) { code = -2; out = `harness could not build this arm: ${e.message}`; got = []; }
  results.push({
    name, expect, code, out,
    missed: must.filter((re) => !re.test(out)),
    unwanted: absent.filter((re) => re.test(out)),
    sawBad: saw ? saw(got) : [],
  });
};

const digest = (t) => t.split(/\r?\n/).filter((l) => /RESULT|checks|routes in scope|answered|FAILED|NOT CHECKED/.test(l)).join('|');
const HIT = `127.0.0.1:${PORT}`;
const reachedStub = (rows, tenant) => (rows.length > 0
  && rows.every((r) => r.host === HIT && (tenant === undefined || r.tenant === tenant)))
  ? [] : [`the run addressed ${new Set(rows.map((r) => r.host || 'nothing')).size} host(s) and tenant(s) [${[...new Set(rows.map((r) => r.tenant || 'nothing'))].join(',')}]`];

// ---- verify_served_reads: the two spellings must address the same service with the same tenant.
const sSpace = await runReader(READER, ['--base', STUB, '--tenant', TENANT]);
await arm(`${'verify_served_reads'} --base/--tenant spaced reaches the stub`, {
  expect: 1,
  must: [/checks FAILED \(against http:\/\/127\.0\.0\.1:/, /as tenant d158-probe-tenant\)/],
  absent: [/NOT CHECKED/],
  saw: (rows) => reachedStub(rows, TENANT),
  run: () => sSpace,
});
const sEquals = await runReader(READER, [`--base=${STUB}`, `--tenant=${TENANT}`]);
await arm('the glued spelling reaches the same stub with the same tenant', {
  expect: 1,
  must: [/checks FAILED \(against http:\/\/127\.0\.0\.1:/, /as tenant d158-probe-tenant\)/],
  absent: [/NOT CHECKED/],
  saw: (rows) => reachedStub(rows, TENANT),
  run: () => sEquals,
});
await arm('the two spellings printed the same verdict about the same stub', {
  expect: sEquals.code === sSpace.code && digest(sEquals.out) === digest(sSpace.out) ? 0 : 1,
  run: () => ({ code: 0, out: `equals exit ${sEquals.code} / space exit ${sSpace.code}\n${digest(sEquals.out)}\n${digest(sSpace.out)}` }),
});
// The default has to be visible too: a run that names no tenant must print the one it used, or a caller cannot
// tell a default from a request -- which is the half the pre-fix reader hid behind a host-only PASS line.
const sNoTenant = await runReader(READER, [`--base=${STUB}`]);
await arm('a glued --base with no --tenant reaches the stub and names the tenant it fell back to', {
  expect: 1,
  must: [/against http:\/\/127\.0\.0\.1:/, /as tenant hong-kong\)/],
  saw: (rows) => reachedStub(rows, 'hong-kong'),
  run: () => sNoTenant,
});

// ---- the refusals: an unparseable request exits 2 and addresses nothing.
const refused = (label, args) => arm(label, {
  expect: 2,
  must: [/RESULT: NOT CHECKED —/],
  saw: (rows) => (rows.length === 0 ? [] : [`a refused run still sent ${rows.length} request(s) to the stub`]),
  run: () => runReader(READER, args),
});
await refused('--base= with nothing after the sign is refused', ['--base=']);
await refused('--base given another flag is refused', ['--base', '--tenant', TENANT]);
await refused('--tenant with no value is refused', ['--base', STUB, '--tenant']);
await refused('--tenant= empty is refused', ['--base', STUB, '--tenant=']);
await refused('an option this reader does not name is refused, not dropped', ['--base', STUB, '--tesnant', 'x']);
await refused('--base given twice is refused', ['--base', STUB, `--base=${STUB}`]);
await refused('a bare positional is refused', [STUB]);

// ---- verify_contract_runtime: the same pair, and the report names the service that answered.
const RUN_READER = PLANTED ? SERVED : RUNTIME;   // a planted served-reads reader has no /v3/api-docs path
const cSpace = await runReader(RUN_READER, ['--base', STUB]);
await arm('verify_contract_runtime --base spaced asks the stub for its document', {
  expect: 1,
  must: [/service answering      : http:\/\/127\.0\.0\.1:/],
  saw: (rows) => (rows.some((r) => r.url === '/v3/api-docs') ? [] : ['the stub never saw the /v3/api-docs request']),
  run: () => cSpace,
});
const cEquals = await runReader(RUN_READER, [`--base=${STUB}`]);
await arm('verify_contract_runtime --base= glued asks the same stub', {
  expect: 1,
  must: [/service answering      : http:\/\/127\.0\.0\.1:/],
  saw: (rows) => (rows.some((r) => r.url === '/v3/api-docs') ? [] : ['the stub never saw the /v3/api-docs request']),
  run: () => cEquals,
});
await arm('the two spellings of --base print the same report about the same service', {
  expect: cEquals.code === cSpace.code && digest(cEquals.out) === digest(cSpace.out) ? 0 : 1,
  run: () => ({ code: 0, out: `equals exit ${cEquals.code} / space exit ${cSpace.code}\n${digest(cEquals.out)}\n${digest(cSpace.out)}` }),
});
await arm('verify_contract_runtime refuses an option it does not read', {
  expect: 2, must: [/RESULT: NOT CHECKED — unknown option --bes/],
  saw: (rows) => (rows.length === 0 ? [] : ['a refused run still sent a request']),
  run: () => runReader(RUN_READER, ['--bes', STUB]),
});
await arm('verify_contract_runtime refuses --base= with no address', {
  expect: 2, must: [/RESULT: NOT CHECKED — --base was given without a service URL/],
  run: () => runReader(RUN_READER, ['--base=']),
});

/* ------------------------------------------------------------------ the arm that proves the others are alive */
if (MUTATES) {
  let code = -2, out = '';
  try {
    rmSync(FIX, { recursive: true, force: true });
    mkdirSync(FIX, { recursive: true });
    const src = readFileSync(SERVED, 'utf8');
    const anchor = 'const parsed = parseFlags(argv, SPEC);';
    const hits = src.split(anchor).length - 1;
    if (hits !== 1) throw new Error(`the shared-parser call appears ${hits} times in the reader, expected exactly one — the mutant has no anchor`);
    const old = 'const arg = (n, f) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; };\n'
      + "const parsed = { ok: true, value: { '--base': arg('base', 'http://127.0.0.1:8090'), '--tenant': arg('tenant', 'hong-kong') }, flag: {} };";
    writeFileSync(join(FIX, 'verify_served_reads.mjs'), src.replace(anchor, old), 'utf8');
    copyFileSync(join(SCRIPTS, 'cli_args.mjs'), join(FIX, 'cli_args.mjs'));
    const nested = await new Promise((done) => {
      const child = spawn(process.execPath, [HARNESS, `--reader=${join(FIX, 'verify_served_reads.mjs')}`],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.stderr.on('data', (d) => { buf += d; });
      child.on('close', (rc) => done({ code: rc, out: buf }));
    });
    code = nested.code; out = nested.out;
  } catch (e) { out = `the mutant could not be built: ${e.message}`; }
  await arm('a reader rebuilt with the OLD one-dialect parser reddens this harness', {
    expect: 1,
    must: [/RESULT: FAIL/, /addressed|left the stub|sent a request/],
    absent: [/RESULT: PASS/],
    run: () => ({ code, out }),
  });
} else {
  console.log(`  (skipped) the mutant arm: this run is already aimed at a planted reader (${READER})`);
}

/* ------------------------------------------------------------------ the wiring, read out of the runner */
const RUNNER = readFileSync(E2E, 'utf8').replace(/\r\n/g, '\n').split('\n');
{
  const harnessAt = RUNNER.findIndex((l) => l.includes('node scripts/falsify_flag_dialect.mjs'));
  const firstReader = RUNNER.findIndex((l) => l.startsWith('node ') && l.includes('verify_served_reads.mjs'));
  const knobAt = RUNNER.findIndex((l) => l.includes('E2E_FLAG_PLANT:') || l.includes('E2E_FLAG_PLANT:+'));
  await arm('scripts/e2e_fresh.sh runs this harness BEFORE it starts the service its reader probes', {
    expect: harnessAt >= 0 && firstReader >= 0 && harnessAt < firstReader && knobAt >= 0 ? 0 : 1,
    run: () => ({ code: 0, out: `harness call line ${harnessAt}, first reader call line ${firstReader}, knob line ${knobAt}` }),
  });
  const help = await new Promise((done) => {
    execFile('bash', [E2E, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 },
      (err, stdout, stderr) => done({ code: err ? 1 : 0, out: `${stdout || ''}${stderr || ''}` }));
  });
  const knobNames = [];
  for (const line of RUNNER) { const m = line.match(/^#\s{3}([A-Z][A-Z0-9_]{3,})/); if (m) knobNames.push(m[1]); }
  const missing = knobNames.filter((k) => !help.out.includes(k));
  await arm(`the runner's --help documents every knob its own header lists (${knobNames.length} names)`, {
    expect: missing.length === 0 && knobNames.length >= 4 ? 0 : 1,
    run: () => ({ code: 0, out: `${help.out}\nmissing: ${missing.join(',') || 'none'}\nknobs: ${knobNames.join(',')}` }),
  });
}

/* ------------------------------------------------------------------ the population, printed not guessed */
{
  const argvReaders = [];
  for (const name of readdirSync(SCRIPTS).filter((n) => n.endsWith('.mjs'))) {
    const text = readFileSync(join(SCRIPTS, name), 'utf8');
    // A file counts as a reader when its CODE uses argv, not when its prose mentions it -- `cli_args.mjs` and
    // `falsify_ledger_text.mjs` both quote the broken shape inside a comment, and a census that counted that
    // would mislabel the population it reports. Drop the comment-looking lines first, then look for any use of
    // `process.argv` -- `= `, a call argument (`parseFlags(process.argv.slice(2), SPEC)`), `.includes`, `.find`,
    // `.indexOf`: the first version of this predicate required the assignment form and so failed to see its own
    // census running the shared parser, which is the same blind spot this whole file exists to close.
    const code = text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
    if (!/\bprocess\.argv\./.test(code)) continue;
    argvReaders.push({ name, shared: /from '\.\/cli_args\.mjs'/.test(text) });
  }
  const shared = argvReaders.filter((r) => r.shared).map((r) => r.name).sort();
  const hand = argvReaders.filter((r) => !r.shared).map((r) => r.name).sort();
  // Every reader the arc has moved onto the parser is named here, because the census is the place a silent
  // revert to a private loop would show up: a reader that goes back to `argv.indexOf` keeps printing its old
  // verdicts, so no other arm reddens. D159 added the last four gate checkers to this list.
  const want = ['verify_served_reads.mjs', 'verify_contract_runtime.mjs', 'check_ledger_citations.mjs',
    'check_jsonb_reads.mjs', 'check_comment_citations.mjs', 'check_ledger_sections.mjs',
    'check_status_citations.mjs', 'falsify_flag_dialect.mjs'];
  await arm('the shared parser has readers, and the hand-written ones are named', {
    expect: shared.length >= want.length && want.every((n) => shared.includes(n)) ? 0 : 1,
    must: [/shared-parser readers: .*verify_served_reads\.mjs/, /shared-parser readers: .*check_ledger_citations\.mjs/,
      /shared-parser readers: .*check_comment_citations\.mjs/, /hand-written parsers: /],
    run: () => ({ code: 0, out: `shared-parser readers: ${shared.join(', ')}\nhand-written parsers: ${hand.join(', ')}` }),
  });
  console.log(`  argv readers in scripts/: ${argvReaders.length} — on the shared parser ${shared.length}, hand-written ${hand.length}`);
  console.log(`  shared parser: ${shared.join(', ')}`);
  console.log(`  hand-written: ${hand.join(', ')}`);
}

stub.close();

/* ------------------------------------------------------------------ the table */
let fails = 0;
for (const r of results) {
  const bad = r.expect !== r.code || r.missed.length > 0 || r.unwanted.length > 0 || r.sawBad.length > 0;
  if (bad) fails += 1;
  console.log(`${bad ? 'MISSED' : 'held  '}  exit ${r.expect} expected, ${r.code} printed   ${r.name}`);
  for (const m of r.missed) console.log(`         expected text missing: ${m}`);
  for (const u of r.unwanted) console.log(`         text that must not be there: ${u}`);
  for (const s of r.sawBad) console.log(`         the stub says: ${s}`);
  if (bad) console.log(`         verdict: ${r.out.split(/\r?\n/).filter((l) => /RESULT|addressed|against |answering|NOT CHECKED|equals exit/.test(l)).slice(0, 3).join(' | ') || r.out.slice(0, 160)}`);
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  the stub answered on ${STUB}; every arm ran a shipped reader as a subprocess against it and the`);
console.log('  stub kept the request log, so which plane a run addressed is measured rather than claimed by');
console.log("  the run itself. No database, no service, no other lane's port is opened.");
if (fails) { console.log('\nRESULT: FAIL — a flag spelling still aims a reader somewhere its caller did not ask'); process.exit(1); }
console.log('\nRESULT: PASS — both dialects aim one plane, an unparseable request refuses, and a one-dialect reader reddens this file');
