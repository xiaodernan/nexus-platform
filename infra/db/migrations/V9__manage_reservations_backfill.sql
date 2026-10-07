-- V9 — `manage_reservations` exists; the memberships that predate it get their grant rows.
--
-- D26 recorded the ruling this mint closes: advancing a consumer hold out of `pending` is the
-- merchant's own judgement about a real evening, and until the §5 vocabulary named who may make
-- that judgement, no route made it — the inbox's own `definitions` printed "this route never moves
-- a booking into it". The route now exists (POST /api/v1/merchant/reservations/{id}/accept, behind
-- MerchantPermissions.MANAGE_RESERVATIONS), and the preset lists gained the permission — but preset
-- lists only write grants when a membership row is written. Every owner/admin/manager membership
-- that predates this migration holds grant rows shaped by the older preset, and a single-owner
-- merchant cannot self-grant (demoting or re-granting around `last_admin` is refused), so without
-- this backfill the demo database's owners — the exact people the acceptance route exists for —
-- would answer 403 on a route their role is supposed to carry.
--
-- The rows copy the seeder's own spelling (data/seed/generate.py): subject_type='merchant_user'
-- with subject_id = the USER id, not the membership row (PermissionService joins users on
-- subject_id; a membership id there is the silent-403 defect D42 fixed), no expires_at (a role
-- assignment is not a TTL), granted_by NULL — no human granted this, a migration did, and V8 kept
-- the column nullable precisely so an attribution gap can be stated rather than faked.
--
-- Active memberships only: the workspace write path reconciles grants against the row (D40), so a
-- disabled membership is one whose grants are supposed to be gone; re-arming those rows here would
-- resurrect access the console removed. Idempotent by the table's own UNIQUE key, so a database
-- that somehow carries the row already stays untouched.
INSERT INTO permission_grants (subject_type, subject_id, merchant_id, permission, granted_by, created_at)
SELECT 'merchant_user', mu.user_id, mu.merchant_id, 'manage_reservations', NULL, now()
FROM merchant_users mu
WHERE mu.role IN ('owner', 'admin', 'manager') AND mu.status = 'active'
ON CONFLICT (subject_type, subject_id, merchant_id, permission) DO NOTHING;
