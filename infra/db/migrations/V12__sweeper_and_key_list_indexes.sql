-- V12 — the retention tick and the merchant key sweep stop walking whole tables.
--
-- D925 shipped RetentionSweeper: its one read asks for pending deletion_requests older
-- than N milliseconds. V1 left deletion_requests with no index beyond the primary key,
-- so every tick would sequentially scan a table whose entire job is to accumulate rows
-- forever — correct at fixture scale, wrong shape for the §106 ledger door. Two shapes
-- the code actually runs need support, and both are captured here with the predicates
-- read back out of the sweeper, not guessed:
--
--   (a) the tick:        WHERE status = 'pending' AND created_at < now() - :age
--                        ORDER BY created_at ASC LIMIT :limit
--                        (with an optional AND user_id = :user for the per-user lane)
--                          → a partial index on created_at over exactly the pending rows
--   (b) the per-user lane of the same sweep, and any /me-status read
--                          → user_id leading, newest first
--
-- Third, the merchant key door: GET /api/v1/merchant/api-keys joins api_keys to merchants
-- and filters on k.merchant_id and m.tenant_id, ordering by k.created_at DESC. The key_hash
-- unique index covers the verify path and nothing else; the list path had no leading-column
-- index. This composite covers the filter AND the sort.
--
-- What this migration does NOT do: no constraint is added, no column is rewritten, no rows
-- are touched, and nothing referenced by the demo seed changes shape — it is pure indexes,
-- IF NOT EXISTS throughout, exactly like V10/V11.

CREATE INDEX IF NOT EXISTS deletion_requests_pending_idx
  ON deletion_requests (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS deletion_requests_user_idx
  ON deletion_requests (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS api_keys_merchant_idx
  ON api_keys (merchant_id, created_at DESC);
