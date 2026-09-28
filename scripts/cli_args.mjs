/*
 * NEXUS D158 — one argument parser for the readers that take flags, so a flag cannot be read in one dialect.
 *
 * WHY THIS EXISTS. Four checkers each grew its own argv reader in this arc, and each one was red for the same
 * reason: `process.argv.indexOf('--name')` never sees `--name=value`, and `argv.find(a => a.startsWith('--name='))`
 * never sees `--name value`. Neither shape raises an error -- the flag is simply absent, so the reader falls
 * back to its default and prints a true-looking verdict about the plane nobody asked it to read. This lane
 * measured it twice before writing this file (D156's `--quality`, D157's `--text`), then measured the same
 * defect live (D158): `verify_served_reads.mjs --tenant=x` probes another tenant while
 * `--tenant=x` -- one character apart -- probes the default one and reports 626 passing checks.
 *
 * A per-file patch fixes one reader and leaves the next one free to re-invent the bug, which is what
 * `docs/STATUS.md` §161 named as the real residue. So the templates below are the single copy: the two
 * spellings parse from one table, and anything the table does not name is refused rather than dropped.
 *
 * WHAT IT RETURNS. `{ ok: true, value, flag }` on a well-formed request, or `{ ok: false, reason }` with a
 * sentence that states what was wrong and which flags the reader takes. It does NOT print and does NOT exit:
 * every reader owns its own verdict vocabulary (`RESULT: NOT CHECKED`, its title lines, its exit code), and a
 * parser that decided how a run reports would be a second thing to test. A caller that ignores `ok` is the
 * only way this module can be wrong, and the harness that runs each reader pins that it is not.
 *
 * The refusal sentences are shared text on purpose: `scripts/falsify_ledger_text.mjs` pins several of them
 * verbatim, so a edit here reddens that harness -- which is the point of one copy rather than four.
 */

/** @typedef {{ kind: 'value', unit?: string } | { kind: 'switch' }} Spec */

const switchNames = (spec) => Object.entries(spec).filter(([, s]) => s.kind === 'switch').map(([n]) => n);
const valueNames = (spec) => Object.entries(spec).filter(([, s]) => s.kind === 'value').map(([n]) => n);

/**
 * Parse `argv` against `spec` (names written WITH their leading `--`).
 *
 * Refuses: an option the spec does not name, a bare positional, a switch given a value, a value flag with no
 * value, a value that reads as another flag, a value flag given twice, and a `--name=` whose right side is
 * empty. Every refusal is a sentence, never a silent default.
 */
export function parseFlags(argv, spec) {
  const names = Object.keys(spec);
  const units = Object.fromEntries(names.map((n) => [n, spec[n].unit ?? 'path']));
  const value = {};
  const flag = {};
  const given = {};
  const takesValue = (n) => spec[n] && spec[n].kind === 'value';

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) return { ok: false, reason: `unexpected argument ${a} — this reader takes only ${names.join(', ')}` };
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    if (!spec[name]) return { ok: false, reason: `unknown option ${name}` };
    if (spec[name].kind === 'switch') {
      if (eq >= 0) return { ok: false, reason: `${name} is a switch and was given a value (${a.slice(eq + 1)})` };
      given[name] = (given[name] ?? 0) + 1;
      if (given[name] > 1) return { ok: false, reason: `${name} was given ${given[name]} times` };
      flag[name] = true;
      continue;
    }
    let val;
    if (eq >= 0) {
      val = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined) return { ok: false, reason: `${name} was given without a ${units[name]}` };
      val = next;
      i += 1;
    }
    if (val === '') return { ok: false, reason: `${name} was given without a ${units[name]}` };
    if (val.startsWith('--')) {
      return { ok: false, reason: `${name} was followed by ${val}, which reads as another flag — there is no ${units[name]} to read` };
    }
    given[name] = (given[name] ?? 0) + 1;
    if (given[name] > 1) return { ok: false, reason: `${name} was given ${given[name]} times — which ${units[name]} is the run` };
    value[name] = val;
  }
  return { ok: true, value, flag, switches: switchNames(spec).filter((n) => flag[n]), knobs: valueNames(spec) };
}

/** The usage lines a header block should print, derived from the spec rather than counted by hand. */
export function flagHelp(spec) {
  return Object.entries(spec).map(([n, s]) => `  ${n}${s.kind === 'value' ? ` <${s.unit ?? 'path'}>` : ''}`);
}
