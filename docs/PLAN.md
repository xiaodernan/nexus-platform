# NEXUS — the long-term work plan

This file is the forward-looking queue. `docs/STATUS.md` is the ledger (what was done, and what each pass
found); `docs/DECISIONS.md` is the numbered rulings. **This is what to do next**, in the order the project's
own evidence justifies, so a session that starts with no context can pick up work without re-deriving it.

Read the tail of `STATUS.md` first — its head is stale by construction.

## How to work on this project (the rules that are not negotiable)

1. **One owner per file tree.** Do not edit another lane's files to make your test pass; report it.
2. **Never claim a thing works without quoting the command and its real output.** Unverified work is
   labelled `unverified` in the ledger, and the label is not a formality.
3. **Migrations are append-only** (`V<n>__*.sql`). Never edit V1–V7. A new table must not declare
   `updated_at` unless it also gets the trigger V1 installs by walking a name list.
4. **`TenantJdbc` enforces tenancy in code** — selects/updates need `tenant_id = :tenant_id`, inserts must
   write `tenant_id`, else `IllegalStateException` at runtime.
5. **A check that cannot run says so.** `UNCHECKED` with its own exit code is a verdict; a stack trace is
   not. Every checker in `scripts/` follows this.
6. **Read the failures, not the schemas.** A number like "34 failures" is usually one cause; find it by
   reading the assertion, not by diffing things that look suspicious.

## Environment (measured, and it moves under you)

- Test container is **`nexus-platform-postgres`** (renamed from `nexus-platform-testpg`; `docker exec` on
  the old name says "container is not running", which is misleading). `127.0.0.1:5433`, DBs `nexus`
  (seeded demo) and `nexus_test` (schema only). Redis `nexus-platform-redis` on 6380.
- Ports 5432/6379/8080/8000/3000 belong to OTHER projects. Ours: platform 8090, AI 8010, web prod 3002.
- **Maven is shared and slow.** Take `mkdir .tmp-p4/mvnlock` before any `mvn`. A run killed from outside
  leaves BOTH the lock and a half-written `target/`, so `rmdir` the lock and expect a slow recompile.
  Prefer `-Dtest=Class#method` over a full run: a full run is 5–7 minutes, one method is seconds.
- **`db_gate_fresh.sh` needs `TMPDIR=/tmp TMP=/tmp TEMP=/tmp`** or it aborts in step 2 with
  `[safe-delete][SAFE_DELETE_INVALID_PATH]`. It drops its `nexus_gate_<pid>` database only when the run
  *completes* — a killed run leaves it behind; drop it yourself.
- `check_ledger_citations.mjs` cannot run in HEAD mode here (`spawnSync git EBUSY`); use `--worktree`.

## The queue

### P1 - CLOSED: the platform suite's two named reds were one stale test database (D178, STATUS section 184)

Both named reds traced to the same cause: `nexus_test` was missing the objects of migrations V4, V5 and V6
(`user_identities.tenant_id` and its foreign key, `users_email_tenant_uniq`, `user_identities_tenant_uniq`,
`facts_one_row_per_claim_uidx`, `facts.updated_at`), so `GET /api/v1/me` raised `column ui.tenant_id does not
exist` instead of answering, and any `facts` update threw. Repaired in place with the migration script's own
documented path for a ledger-less database whose content predates it:

    NEXUS_DB_NAME=nexus_test scripts/db_apply_migrations.sh --record V1__init --record V2__integrity \
      --record V3__merchant_funnel_no_fanout --record V7__share_links

which recorded the four versions whose content already matched and applied the three that did not, ending
`migrations=7`; no database was dropped or reseeded. Re-measured: `MerchantWorkspaceTest` 14/0,
`CommerceApiTest` 8/0 in 23.91 s (was 7 failures in 184.6 s, which this plan had read as a stall), and the
auth/favorite/fact/review classes 29/0. Item 3's full-suite count was deliberately not taken -- a full
regression is not worth its cost on every pass -- so no total is claimed for the suite here.

### P2 — the residues the ledger names as still open

- **CLOSED — the import lane.** Decided and witnessed: no fabricated marker goes into the seed, because
  `import_job` is a provenance claim ("an import produced this row") and `empty-by-guard` is not available
  anyway — the gate defines that kind as "the table is empty" and rejects it while `offerings` has rows. The
  seed's `dead-reader` answer for the read therefore stands, and the half that was genuinely missing — a
  witness for the selector — was added: `services/platform/src/test/java/com/nexus/merchant/
  MerchantImportDoorTest.java` drives a real offline import through the door and reads the dashboard back
  (1/1 green; 1/1 red with the selector's marker predicate planted out, file restored byte-exact).
  See D179 and STATUS §185.
- **`collections.seo` provenance.** The §27 publishability branch reads `generated_by`, absent on all four
  rows, so `author_id` always decides. The contract names `author_id` as the sanctioned fallback, so this is
  a *reporting* gap, not a bug: do not stamp a provenance token the content cannot honestly claim.
- **CLOSED — the string-valued jsonb residue.** Repaired in place rather than shipped as a migration, and
  the queue's numbers were stale: 20 cells over five columns (`agent_runs.plan`, `agent_runs.tool_calls`,
  `agent_runs.retrieval`, `events.properties`, `events.context`), not 114 over three, on rows written
  2026-09-27 — the writer is already fixed (rows from 2026-09-28 carry real arrays). A from-scratch gate
  database has 0 such cells, so no migration; the eight guarded UPDATEs, their `UPDATE 4` x5 output and the
  two benign test-database cells are in D180 / STATUS §186.
- **CLOSED — §84 residue (e).** One list now: `scripts/check_comment_citations.mjs` imports `VENDOR_DIRS`
  from `scripts/source_index.mjs` instead of carrying its own 15-name `SKIP`, and the list is the measured union
  of the two (21 names) so no reader lost a file another reader kept. The drift was live, not cosmetic: steps 7
  and 8 were indexing 21 generated `.sql` files under the gitignored `data/seed/out_smoke/` and `.tmp-p4/`'s
  scratch sources, and a cite into that build output was CERTIFIED under the old list and FILE NOT FOUND under
  the union. See D181 and STATUS §187.

### P3 — reach and honesty (the product's own promises)

- **Programmatic SEO quality gate — HALF MEASURED, HALF UNBUILT.** `quality_score` holds: the four-term
  `indexable` formula is evaluated in `SeoController` exactly as API_CONTRACT §8 prints it, and `SeoReadTest`
  is 10/0 (each gate term flips the verdict, `below_quality_bar` included). The `data` uniqueness guard is
  named by four documents (GROWTH.md:33, DATABASE.md:171, MERCHANT.md:56, `SeoRepository.java:19`) and read
  by nothing: measured on `nexus_test`, two published rows with different paths and byte-identical `data`
  insert cleanly at `quality_score = 0.900`. "Enforced against the shipped seed" is vacuous either way —
  `seo_pages` is empty there by design (D64). Left unbuilt on purpose: "unique" has no threshold to implement
  against. See D185 and STATUS §191.
- **CLOSED — the AI lane's degraded paths.** Read off the payloads, not the code, on both planes (the live
  `nexus` and no database at all): all nine answer surfaces carry `degraded`, and it is `true` everywhere the
  answer cannot be the real thing — including `understand`/`recommend` with a database, where the mock model
  is what is degraded. `reason`/`note` exist only where the contract names them (the conversations read, and
  RAG). The census is pinned as `apps/ai/tests/test_degraded_labels.py` (9 tests, offline, default suite) and
  it reddens on a planted `degraded:false`. The plan's "and its reason" is a contract question, not a code
  defect. See D183 and STATUS §189.
- **CLOSED -- the console pages' copy and noindex promises** (measured: **20** console `page.tsx` under
  `app/admin` and `app/merchant`, not the 21 this bullet used to claim). `scripts/check_console_i18n.mjs`
  censuses every `page.tsx` under `apps/web/app`: 20 of 20 console pages override the root layout's
  `index: true`, and one page broke the copy rule by keeping a private weekday table with a vocabulary of
  its own where `apps/web/src/lib/format.ts` already exports the shared one -- fixed, with that module's
  first test as the witness. See D184 and STATUS §190. **The accessibility half is closed in D195**:
  `scripts/check_console_a11y.mjs` measures it on four axes (20 console pages, 1 `<main>` with an id, 2/2
  named `<nav>`, 24 controls with an accessible name, 0 positive `tabindex`, 10 printed ratios recomputed
  with the tightest at 4.80:1), its 13 arms redden it, and both console censuses and their arms are wired
  into `.github/workflows/ci.yml` and into gate step 14 -- before D195 they PASSED and no surface ran them.
  **Still open, named rather than implied:** the copy rule cannot see Latin-script copy, and the
  accessibility census reads the render tree rather than a rendered page (no browser, no computed style).

### P4 — the standing invariants (run these, don't assume them)

```
node scripts/check_contract_drift.mjs            # 114 parsed / 106 served / 0 CLIENT-ONLY
node scripts/check_jsonb_reads.mjs               # 0 undeclared
node scripts/check_ledger_citations.mjs --worktree   # 0 offenders (HEAD mode cannot run here)
node scripts/check_console_i18n.mjs                # 31 pages / 20 console / 0 offenders
node scripts/check_console_a11y.mjs                # 20 console pages, 10 ratios recomputed, tightest 4.80:1
node scripts/check_reader_reachability.mjs         # 10 of 10 readers invoked; 7 piped CI steps, 0 unprotected
TMPDIR=/tmp bash scripts/db_gate_fresh.sh        # 216 quality checks, all steps
cd apps/web && npx tsc --noEmit && npx vitest run
cd services/platform && mvn -o test
```

## What this plan is not

It is not a burndown. Every unit that closes a residue also reports the narrower residue it found, which is
why the ledger grows while the defects shrink. The measure of progress is not "tasks remaining" but **how
many claims in this repo are backed by a command someone actually ran** — that number only goes up.
