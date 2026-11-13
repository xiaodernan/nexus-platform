-- V13 — llm_calls surfaces the provider's cache accounting.
--
-- The ONE cache-relation signal the operator can see without dev-tools is the `cache_hit`
-- boolean — it answers "did the prefix serve from cache?" but NOT "how many tokens did
-- the upstream re-read from its own prefix cache instead of recomputing?" — which is the
-- question the adapter actually reports (`usage.prompt_tokens_details. cached_tokens`). The
-- unit `D1036/D1037` lifted that the adapter sees; nothing persisted it into the §9 cost
-- ledger. This column makes it visible to the ledger: one INTEGER per call, default 0, no
-- mutation path, no backfill — old rows simply read as 0 cached tokens, which is the safe
-- floor and a truthful reading ("nothing was reported cached at the time this row was
-- written").
--
-- This migration does NOT re-cost any row, does NOT mutate anything any reader depends on,
-- and does NOT add an index — `sum(cached_tokens)` is a trivial aggregate over the existing
-- `created_at DESC` index and no obvious access path demands its own.

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cached_tokens integer NOT NULL DEFAULT 0;
