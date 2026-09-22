-- NEXUS V5 — one facts row per claim (spec §19; docs/DATABASE.md §7; DECISIONS D38).
-- Additive plus one bounded cleanup: it deletes nothing that is not a duplicate of a newer row.
--
-- `facts` is the table a rendered number cites, and every reader picks the claim with
-- `order by observed_at desc limit 1`. That spelling only means "the current truth" while there is one row
-- per (subject, attribute) — and until now nothing made that true. `FactRepository.record` was a bare
-- INSERT, so the second time a merchant edited a price or a week of opening hours, the first claim stayed
-- in the table as a live, well-formed rival: two rows, one of them about a price nobody pays any more, and
-- a limit-1 to decide which one a consumer is told the value came from.
--
-- The dedupe keeps the newest observation per claim — the row the readers were already showing — and drops
-- the older siblings, then the unique index makes the invariant a fact about the database instead of a
-- habit of the code. A second observation of the same claim is an UPDATE (see `FactRepository.record`),
-- which is also what keeps `stale` and `expires_at` honest: a refreshed claim is fresh again, not a second
-- expiry clock running beside the first.

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY subject_type, subject_id, attribute
                            ORDER BY observed_at DESC NULLS LAST, created_at DESC, id DESC) AS rn
    FROM facts
)
DELETE FROM facts
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS facts_one_row_per_claim_uidx
    ON facts(subject_type, subject_id, attribute);
