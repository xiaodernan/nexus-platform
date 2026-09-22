-- =============================================================================
-- V4 — identity uniqueness follows the tenant, not the globe (D29)
--
-- V1 declared `users_email_uniq ON users(email)` and `UNIQUE (provider, provider_id)` on
-- user_identities, but every read path in the service is tenant-scoped: IdentityRepository looks a
-- person up with `where tenant_id = :tenant_id`, and AuthService's own duplicate message says "already
-- registered *in this tenant*". The two halves disagreed, and the database won: a second tenant that
-- registered the same address, or used the same OAuth subject, got an unhandled DuplicateKeyException —
-- a 500 from a public, unauthenticated route. The §87 demo login hit it too, because it inserts
-- demo.consumer@example.hk once per tenant: the first tenant to click demo got a session, every tenant
-- after it got a 500 (reproduced in the dev/test databases by simply running the demo login twice).
--
-- §2 makes a row in another tenant read as absent — that has to include the account rows, otherwise two
-- HK tenants cannot both hold alice@example.com and the platform has one global namespace wearing a
-- tenant_id column. So uniqueness moves to (tenant, identity), which is strictly more permissive: no
-- existing row can violate it, since the old indexes were the tighter rule.
-- =============================================================================

-- 1. user_identities has no tenant column today; the reads get it by joining users. Carrying it makes
--    the constraint expressible and matches how locations/offerings already duplicate tenant_id.
-- Every statement is written to be safe to re-run: this migration was first applied by hand to a
-- development database, where a failure halfway through has to be resumable without a reset.
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

UPDATE user_identities ui
   SET tenant_id = u.tenant_id
  FROM users u
 WHERE ui.user_id = u.id AND ui.tenant_id IS NULL;

-- Any row this refuses to fill is an identity attached to a user with no tenant — a data bug worth
-- stopping the migration over, because a NULL tenant_id would slip past a NOT NULL-less unique index
-- and re-create the same collision in one specific shape.
ALTER TABLE user_identities ALTER COLUMN tenant_id SET NOT NULL;

-- `UNIQUE (provider, provider_id)` was declared inline, so it is a constraint, and a constraint's index
-- cannot be dropped directly (psql: "requires it").
ALTER TABLE user_identities DROP CONSTRAINT IF EXISTS user_identities_provider_provider_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_tenant_uniq
  ON user_identities(tenant_id, provider, provider_id);

-- 2. Same move for the address. The predicate is kept verbatim from V1: a soft-deleted account must not
--    hold its email hostage, and NULL emails (pure-OAuth accounts) never collide.
DROP INDEX IF EXISTS users_email_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_tenant_uniq ON users(tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
