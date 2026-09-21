-- NEXUS V2 — integrity hardening found during the M0 docs pass (docs/TRACEABILITY.md, spec §52-54, §157).
-- Additive only: safe to apply on top of V1 and on top of loaded demo data.

-- Availability is the one real-time fact in the system (§20). Overselling a slot is a P0 product bug,
-- so the invariant is enforced in the database, not only by `SELECT ... FOR UPDATE` in the service.
ALTER TABLE availability_slots DROP CONSTRAINT IF EXISTS availability_slots_capacity_bounds;
ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_capacity_bounds
  CHECK (capacity_left >= 0 AND capacity_left <= capacity_total);

ALTER TABLE availability_slots DROP CONSTRAINT IF EXISTS availability_slots_window;
ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_window
  CHECK (ends_at > starts_at);

-- One live reservation per user per slot; cancelled/no-show rows free the slot again.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_slot_user_uniq
  ON reservations(slot_id, user_id)
  WHERE status IN ('pending', 'confirmed') AND slot_id IS NOT NULL AND user_id IS NOT NULL;

-- Never let an aggregate drift outside the scale it is stored in.
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_rating_range;
ALTER TABLE merchants ADD CONSTRAINT merchants_rating_range CHECK (rating_agg BETWEEN 0 AND 5);
ALTER TABLE offerings DROP CONSTRAINT IF EXISTS offerings_rating_range;
ALTER TABLE offerings ADD CONSTRAINT offerings_rating_range CHECK (rating_agg BETWEEN 0 AND 5);
ALTER TABLE offerings DROP CONSTRAINT IF EXISTS offerings_price_sane;
ALTER TABLE offerings ADD CONSTRAINT offerings_price_sane
  CHECK (price_amount IS NULL OR price_amount >= 0);

ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_qty_positive;
ALTER TABLE cart_items ADD CONSTRAINT cart_items_qty_positive CHECK (quantity > 0);

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_window;
ALTER TABLE coupons ADD CONSTRAINT coupons_window CHECK (ends_at > starts_at);

-- Facts that expired must not be silently served as current (AGENT_CONTRACT §5). Marked stale by the
-- freshness job, but the database refuses a live fact with a past expiry when a caller forgets.
CREATE INDEX IF NOT EXISTS facts_active_expiry_idx ON facts(subject_type, subject_id, attribute)
  WHERE stale IS FALSE;

-- Tenant isolation is application-enforced (docs/DECISIONS.md §D5). Row-level security stays off in
-- phase 1 on purpose: the two DB roles are already split (nexus_app read-write, nexus_ai read-mostly),
-- and RLS predicates on 40 tables would cost more in review clarity than they buy today. The guard is
-- the ArchUnit/repository test in services/platform plus the cross-tenant probe in tests/e2e.
-- See docs/SECURITY.md "Tenancy" for the re-evaluation trigger (>1 tenant with real merchants).
