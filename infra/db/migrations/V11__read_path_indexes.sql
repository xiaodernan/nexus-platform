-- V11 — indexes for the read paths that query by the leading column, not the primary key.
--
-- Every index here closes a hole called out by the codebase's own read patterns: the repositories
-- filter by cart_id / order_id / payment_id / conversation_id / subject_id etc. with no supporting
-- index, so those queries seq-scan on large corpora. All are plain btree indexes (no partial
-- semantics except the one documented); pg_trgm / hnsw already exist where the app needs them.
-- Everything is IF NOT EXISTS so re-applying the migration (fresh bootstrap, or an environment
-- where one of these was created by hand) is a no-op, exactly like V10.
--
-- What this migration does NOT do: it does not add FK enforcement, it does not backfill anything,
-- it does not drop or rewrites any existing index, and it does not touch the write path's unique
-- constraints.

CREATE INDEX IF NOT EXISTS cart_items_cart_idx ON cart_items (cart_id);
CREATE INDEX IF NOT EXISTS cart_items_offering_idx ON cart_items (offering_id);
CREATE INDEX IF NOT EXISTS cart_items_reservation_idx ON cart_items (reservation_id);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_provider_ref_idx ON payments (provider, provider_ref);

CREATE INDEX IF NOT EXISTS refunds_payment_idx ON refunds (payment_id);

CREATE INDEX IF NOT EXISTS handoffs_conversation_idx ON handoffs (conversation_id);
CREATE INDEX IF NOT EXISTS handoffs_merchant_idx ON handoffs (merchant_id);

-- The moderation queue's typical lookup (review/listing by subject); partially unindexed today.
CREATE INDEX IF NOT EXISTS moderation_subject_idx ON moderation_cases (subject_id);

CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

CREATE INDEX IF NOT EXISTS resource_pools_merchant_idx ON resource_pools (merchant_id);
CREATE INDEX IF NOT EXISTS resource_pools_offering_idx ON resource_pools (offering_id);

-- The MerchantCards catalogue filter names categories by `name` (see MerchantCards' own comment:
-- this correlated subquery exploded on nexus_test at production-ish scale).
CREATE INDEX IF NOT EXISTS categories_merchant_name_idx
  ON categories (name) WHERE kind = 'merchant';

-- V8 added granted_by and kept grants keyed (subject_*); admin/merchant-wide grant reconciliation
-- scans merchant_id with no covering index.
CREATE INDEX IF NOT EXISTS permission_grants_merchant_idx ON permission_grants (merchant_id);
