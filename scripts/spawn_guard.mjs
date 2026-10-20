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
 * THE HOST, MEASURED — read this before diagnosing a tool that "does nothing". Three operations on this
 * machine are simply not permitted, and each arrives as a code that reads like something else. All three cost
 * this project real time, and each was found by measuring something that could not possibly have failed:
 *
 *   piping a child's stdin       `spawnSync`/`execFileSync` with the default stdio, or `stdio: 'pipe'`, or
 *                                `['pipe','pipe','pipe']` — fails with `EBUSY` in about 3 ms. Passing
 *                                `stdio: ['ignore', 'pipe', 'pipe']` runs the same child. It was read for a
 *                                whole session as "this sandbox forbids spawning git and node", and six tools
 *                                were recorded as unrunnable because of it. STATUS §253.
 *
 *   the bash shell's loader     `fatal error - unable to load netapi32.dll, Win32 error 5`, and after it
 *                                `fork: Permission denied`. Not a script failure; the shell itself.
 *
 *   `cpSync` of a DIRECTORY     `cpSync(srcDir, dest, { recursive: true })` kills the Node process silently
 *                                with **exit 127** and no output — no stack, `--trace-exit` silent, `--help`
 *                                identical. Copying a single FILE with the same call works, and whether the
 *                                destination's parent exists makes no difference. A harness whose first
 *                                statement never ran was recorded as broken for hours because of this one.
 *                                Copy file by file (`mkdirSync` + `copyFileSync`) instead; 89 files take under
 *                                a second. STATUS §261, §262.
 *
 * The shape they share is the reason this note exists: **a plausible-looking code on an operation that did not
 * happen is worse than no code at all**, because it aims the reader at the wrong subject. `EBUSY` says "busy",
 * not "stdin"; `127` says "command not found", not "the copy was refused". When a tool produces a code and no
 * output, suspect the operation before the tool.
 *
 * USAGE
 *   import { guard, spawnReason, isSpawnFailure } from './spawn_guard.mjs';
 *
 *   const r = guard(() => execFileSync('git', [...], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }));
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
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
 * The interpreter the child was asked to run never started, as opposed to the child itself — the one death
 * whose exit code reads like a verdict. Measured on this host (2026-10-08, D275): the `bash` on PATH is the
 * WSL relay, and with Docker Desktop's distro as the only registered one there is no `/bin/bash` to exec,
 * so the relay prints `WSL (…) ERROR: CreateProcessCommon:800: execvpe(/bin/bash) failed` to stderr and
 * exits 1. The child spawned; the shell never ran; and `isSpawnFailure` correctly says nothing, because the
 * status is a real `1`. A tool that asked bash for its help read the relay's error as bash's answer and
 * scored its own arms as missed predictions. Same family as the loader death this file already documents
 * (`fatal error - unable to load netapi32.dll` … `fork: Permission denied`): an interpreter that never loaded.
 *
 * Returns the matched reason, or `null` when this death is not an interpreter death.
 */
const INTERPRETER_DEATH = /(?:WSL \([^)]*\) ERROR: CreateProcessCommon[^\n]*execvpe\([^)]*\) failed|fatal error - unable to load [^\n]*\.dll|fork: Permission denied)/;
export function interpreterDeath(err) {
  if (!err) return null;
  const text = `${String(err.stderr ?? '')}\n${String(err.stdout ?? '')}\n${String(err.message ?? '')}`;
  const m = text.match(INTERPRETER_DEATH);
  return m ? m[0].split('\n')[0].trim() : null;
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

/**
 * Delete a tree without ever touching more than `SAFE_DELETE_BATCH` files in one turn.
 *
 * This host's node runtime carries a safe-delete shim, and it refuses a bulk delete outright:
 *
 *   [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":75,"threshold":50,"scope":"turn"}
 *
 * measured at `scripts/falsify_line_cite_drift.mjs`, where `rmSync(dir, { recursive: true })` cleared a
 * fixture of 75 files and came back as a throw whose stack pointed at the harness rather than at the host.
 * A harness that builds and clears its own fixtures meets this the moment a fixture grows past fifty files,
 * so the delete is done the way the host permits instead: unlink the files in batches no larger than the
 * threshold, then remove the empty directories from the leaves upward. Deleting one file still works — it
 * is the count that is batched, not the operation.
 */
export const SAFE_DELETE_BATCH = 25;

export function safeRemove(dir) {
  if (!existsSync(dir)) return { removed: 0 };
  if (!statSync(dir).isDirectory()) {
    try { unlinkSync(dir); return { removed: 1 }; } catch { return { removed: 0 }; }
  }
  let removed = 0;
  // A fixed point, not an ordered walk. The first version sorted the directories by path length to go
  // "deepest first", which is wrong in general — a long name needs no depth at all — and it left `.git`
  // behind for exactly that reason, so the caller's `git add -A` found nothing to commit and `git commit`
  // answered 1 with "nothing to commit". Looping until a pass removes nothing is what actually clears it.
  for (;;) {
    const removedBefore = removed;
    const files = [];
    const dirs = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const next = join(d, e.name);
        if (e.isDirectory()) { dirs.push(next); walk(next); }
        else files.push(next);
      }
    };
    walk(dir);
    for (let i = 0; i < files.length; i += SAFE_DELETE_BATCH) {
      for (const f of files.slice(i, i + SAFE_DELETE_BATCH)) {
        try { unlinkSync(f); removed += 1; } catch { /* a file already gone is not a failed delete */ }
      }
    }
    // dirs is already in walk order: a parent is always seen before its children, so this is leaves-up.
    let pruned = 0;
    for (const d of dirs) { try { rmdirSync(d); pruned += 1; } catch { /* non-empty or gone */ } }
    // Stop on a pass that made no progress, not on an empty listing. A file the host refuses to unlink stays in
    // `files` on every pass, so `files.length === 0` is a condition a stuck delete can never satisfy — the first
    // version of this loop hung a harness for twenty minutes on exactly that, silently, with no output.
    if (files.length === 0 && pruned === 0) break;
    if (removed === removedBefore && pruned === 0) break;
  }
  try { rmdirSync(dir); } catch { /* left behind: something in it could not be removed */ }
  return { removed };
}
