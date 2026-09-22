-- NEXUS V6 — give `facts` the column its own trigger already assumes (DECISIONS D38).
-- Additive; no rows are touched.
--
-- V1:967-970 walks a list of tables — `facts` among them — and creates
-- `<table>_updated_at BEFORE UPDATE ... EXECUTE FUNCTION set_updated_at()`, which assigns
-- `NEW.updated_at = now()`. Every table on that list has an `updated_at` column except `facts`
-- (V1:537-553 declares `created_at` and stops), so the trigger fires against a field that does not
-- exist and PostgreSQL aborts with `record "new" has no field "updated_at"`.
--
-- The consequence is not cosmetic: **an UPDATE of any facts row has never been possible in any
-- environment**, and the error only appears the first time something tries it. docs/DATABASE.md §7 and
-- AGENT_CONTRACT §5 describe `facts` as the row a rendered claim cites, and D25 requires a merchant edit
-- to *restate* that row; D36 makes one row per (subject, attribute) a database constraint; and D37 leaves
-- the review queue to be published, which moves an aggregate and therefore must restate a rating fact.
-- All three of those read as design intent that the schema silently forbade. `FactRepository.record` was
-- an INSERT-only method not because a claim could not change, but because changing one threw.
--
-- Adding the column satisfies the trigger the way every other table already does. It is nullable-free and
-- defaults to the row's creation time, so an existing fact reports "unchanged since it was written" rather
-- than a fabricated refresh.

ALTER TABLE facts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN facts.updated_at IS
    'Maintained by facts_updated_at (V1 trigger, V6 column): when this claim was last restated. Distinct '
    'from observed_at, which is when the value was true of the world, and from expires_at, its TTL deadline.';
