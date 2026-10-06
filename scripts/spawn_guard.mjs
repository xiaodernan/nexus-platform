/**
 * NEXUS — one vocabulary for "the child process did not happen".
 *
 * WHY THIS EXISTS. Six tools in `scripts/` spawn a child — `git` to build a throwaway repository or read a
 * committed file, `node` to drive a reader, `bash` to ask a script for its help — and when this machine
 * refuses the spawn they die with **no verdict line at all**. Censused in STATUS §224: every one of them at
 * a bare `execFileSync('git'|'node'|'bash', …)` with no guard.
 *
 * The class has been met in three costumes, each diagnosed separately because nothing shared a name:
 *
 *   `falsify_quality_seam.mjs`        printed `rc null` for both planes — a process that never started,
 *                                     reported as a number a reader might have produced
 *   `check_comment_citations.mjs`     printed `exit 1`, because `err.status ?? 1` turns a `null` status into
 *                                     a plausible `1` that reads like a reader which ran and found something
 *   `falsify_line_cite_drift.mjs`     threw an uncaught `spawnSync git EBUSY` past a top-level block that
 *                                     cannot catch it: exit 1, no RESULT line
 *
 * All three are one event, and the event has a name and a reason:
 *
 * > **A process that never started and a process that ran and found nothing must not print the same line.**
 *
 * WHAT THIS GIVES, AND WHAT IT DELIBERATELY DOES NOT. It gives the *reason*, so a tool can put it in its own
 * verdict sentence. It does not decide the verdict — that belongs to the tool, whose refusal is different
 * from another tool's: a harness that builds repositories cannot run at all, while a reader that reads one
 * committed file can still refuse just that file. Printing one shared sentence here would flatten that.
 *
 * USAGE
 *   import { guard, spawnReason, isSpawnFailure } from './spawn_guard.mjs';
 *
 *   const r = guard(() => execFileSync('git', [...], { encoding: 'utf8' }));
 *   if (!r.ok) {
 *     if (r.spawn) { console.log(`RESULT: NOT CHECKED — … could not be started: ${r.reason}.`); process.exit(2); }
 *     console.log(`RESULT: NOT CHECKED — … failed: ${r.reason}.`);   // it ran, and did not do what we wanted
 *   }
 *   const out = r.value;
 */

/**
 * The reason a child did not happen, as one short string.
 *
 * `execFileSync` sets `status` to **`null`** on a spawn failure — not `undefined` — and puts the cause in
 * `error.code` (`EBUSY`, `ENOENT`, `EACCES`). A guard written `err.status === undefined` therefore never
 * fires, and `err.status ?? 1` turns that `null` into a `1` that looks like a real exit. Both bugs are in
 * this repository's history, which is why the test here is `== null` and the reason is carried separately.
 */
export function spawnReason(err) {
  if (!err) return 'no error object';
  if (err.status == null && err.code) return String(err.code);
  if (err.status != null) return `exit ${err.status}`;
  return String(err.message || err);
}

/**
 * The same question for `spawnSync`, which does **not** throw: it hands back an object whose `error` is set
 * and whose `status` is `null` when the child never started. `execFileSync` throws; `spawnSync` reports.
 * That difference is why the same event arrived as `rc null` in one tool and as an uncaught exception in
 * another — and why a helper that only catches cannot cover both.
 */
export function spawnResult(r, what = 'the child process') {
  if (r && r.error) return { ok: false, value: r, reason: String(r.error.code || r.error.message), spawn: true, what };
  if (r && r.status == null) return { ok: false, value: r, reason: 'no exit status', spawn: false, what };
  return { ok: true, value: r, reason: null, spawn: false, what };
}

/** True only when the child was never started — as opposed to started and unhappy. */
export function isSpawnFailure(err) {
  return !!err && err.status == null && !!err.code;
}

/**
 * Run something that spawns, and come back with either its value or the reason it did not happen.
 *
 * `what` is free text for the caller's own sentence; it is returned, not printed, because this module has no
 * business composing verdicts for tools it does not own.
 */
export function guard(fn, what = 'the child process') {
  try {
    return { ok: true, value: fn(), reason: null, spawn: false, what };
  } catch (err) {
    return { ok: false, value: null, reason: spawnReason(err), spawn: isSpawnFailure(err), what };
  }
}
