-- V14 — llm_calls distinguishes "the provider reported zero cached tokens" from
-- "the provider did not report cache accounting at all".
--
-- V13 added `cached_tokens integer NOT NULL DEFAULT 0`, and every reader divides
-- `sum(cached_tokens)` by `sum(prompt_tokens)`. Measured against the operator's proxy
-- (wkapi.pro / gpt-6-sol, 2026-11-13, eight byte-identical requests): `prompt_tokens` was
-- 4529 on all eight, `cached_tokens` was 4352 on five of them, and the response carried no
-- `prompt_tokens_details` at all on the other three. Persisted as 0, those three read as
-- total misses and drag the console's hit-rate from 96% to 60% — which is the operator's
-- complaint ("the cache hit rate is far too low") produced by the ledger, not by the cache.
--
-- `cache_reported` is the missing bit: true = the provider answered the cache question,
-- false = it did not. Aggregates divide cached by prompt over reporting rows only, and the
-- console shows the coverage alongside the rate, so "we do not know" can never masquerade
-- as "nothing was cached".
--
-- Additive, NOT NULL with a default, no backfill: rows written before this unit keep
-- `false`, which is the truthful reading for them too — nobody recorded a report.

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cache_reported boolean NOT NULL DEFAULT false;
