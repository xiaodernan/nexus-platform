/**
 * NEXUS — the one file index the census scripts share.
 *
 * `scripts/check_jsonb_reads.mjs` (D87) and `scripts/check_ledger_citations.mjs` (D88) both answer the same
 * question — "is there a file at this citation?" — over the same repository, and §84's residue (e) named the
 * cost of letting each keep its own exclusion list: a hand list, and a new vendored directory silently joins
 * the source index. The ledger checker's first run is the case that made one list out of two: it grew four
 * tool-cache names (`.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tmp-out`) the site checker never needed.
 * Measured, for the record: drop those four from the set and the ledger index grows from 569 files to 573,
 * every extra from `.pytest_cache` at the root and under `apps/ai/` — two `.gitignore` and two `README.md`.
 * That is not cosmetic: the index would then name `.gitignore` four times instead of twice, so a paragraph
 * citing the file the repo root owns would be reported AMBIGUOUS on account of a directory no author meant to
 * cite. The other three names are insurance against a build that leaves output behind; today they contribute
 * nothing either predicate accepts — 247 `.class` files sit under `target/` and `.tmp-out/`, and `.class`
 * matches neither list, so no compiled class can enter either index.
 *
 * The two consumers still choose their own file predicate: the site census indexes source the build compiles,
 * while the ledger census has to resolve a documentation or config path a paragraph cites. What cannot drift
 * is which directories are not part of the repository's own text.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that hold no first-party claim: a citation into one is a bug in the citation. */
export const VENDOR_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'target', 'build', 'dist',
  '.next', 'out', 'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tmp-out']);

/** Files the build compiles or the seed runs — the site census's predicate. */
export const SOURCE_EXT = /\.(java|py|ts|tsx|mjs|cjs|sql|sh)$/;

/**
 * What a ledger is allowed to cite: the build's sources plus the docs, config and lock files a paragraph
 * points at. `check_ledger_citations.mjs` (gate step 8) is its only other user, and the reason it lives here
 * is D166: a second reader of the same claim kept its own copy of this predicate, so the two resolved
 * different file sets and the project quoted three different blank-citation counts for one sentence.
 */
export const LEDGER_EXT = /\.(java|py|ts|tsx|mjs|cjs|sql|sh|md|ya?ml|json|toml|txt|properties|cfg|ini)$/;

/**
 * Every file under `root` that `accept` names, as forward-slash paths relative to it, skipping VENDOR_DIRS.
 * A directory it cannot read is skipped rather than thrown on: the walk runs over a working tree another
 * lane may be mid-write in.
 */
export function walkFiles(root, accept, dir = '', out = []) {
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    if (VENDOR_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) walkFiles(root, accept, rel, out);
    else if (accept(name)) out.push(rel);
  }
  return out;
}
