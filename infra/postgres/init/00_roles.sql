-- NEXUS — database roles + privilege split.  docs/API_CONTRACT.md §0 is the binding text:
--   Platform service  -> role nexus_app : read-write on commerce tables (DML only — it creates nothing, D32).
--   AI service        -> role nexus_ai  : SELECT on
--                        merchants|offerings|locations|reviews|facts|business_hours|availability_slots
--                        |tenants|external_principals
--                        and read-write only on
--                        documents|chunks|facts|recommendation_sets|feedback_events|agent_runs|
--                        llm_calls|eval_*|review_summaries|seo_pages|campaigns|
--                        plus INSERT-only on events (D19). conversations/messages/handoffs stay with the
--                        platform: agent writes go through its internal token-guarded endpoint (D20).
--                        Everything else (cart, reservation, order, user, ...) is reachable only
--                        through platform HTTP APIs with a scoped token. Web never talks to Postgres.
--
-- WHEN THIS RUNS
--   1) /docker-entrypoint-initdb.d on the FIRST boot of a fresh volume (tables do not exist yet ->
--      the table grants below are skipped, only roles + default privileges land), and
--   2) again at the end of scripts/db_apply_migrations.sh / `make db-migrate`, when the V1 tables
--      exist and the explicit grants bind.
--   The file is fully idempotent and never fails on a missing table (to_regclass guard), so it can
--   be re-run at any time.
--
-- DEV CREDENTIALS ARE NOT SECRETS: NEXUS_DB_APP_PASSWORD / NEXUS_DB_AI_PASSWORD are injected by
-- infra/docker-compose.yml from the root .env. The fallbacks below are fixed, published, localhost
-- -only values so a fresh clone boots with zero setup. Real deployments inject from a secret store
-- (§131, DECISIONS D5). Nothing here is usable outside this machine.

-- --------------------------------------------------------------------------------- passwords
-- \getenv maps an UNSET environment variable to an undefined psql variable (not to the empty string),
-- and an undefined `:'var'` is passed through literally -> syntax error. Test each with `:{?name}` and
-- default it to '' so the plpgsql fallbacks below (the published localhost dev passwords) take over
-- when someone runs this file by hand outside scripts/db_apply_migrations.sh.
-- Hand the value to SQL through a custom GUC so plpgsql can read it (psql does not interpolate
-- inside dollar-quoted bodies).
\getenv nexus_app_password NEXUS_DB_APP_PASSWORD
\if :{?nexus_app_password}
\else
\set nexus_app_password ''
\endif
\getenv nexus_ai_password  NEXUS_DB_AI_PASSWORD
\if :{?nexus_ai_password}
\else
\set nexus_ai_password ''
\endif
SET nexus.app_password = :'nexus_app_password';
SET nexus.ai_password  = :'nexus_ai_password';

-- --------------------------------------------------------------------------------- create roles
DO $roles$
DECLARE
  app_pw text := COALESCE(NULLIF(current_setting('nexus.app_password', true), ''),
                          'nexus_dev_app_only');   -- local dev fallback, published in .env.example
  ai_pw  text := COALESCE(NULLIF(current_setting('nexus.ai_password', true), ''),
                          'nexus_dev_ai_only');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    EXECUTE format('CREATE ROLE nexus_app LOGIN PASSWORD %L', app_pw);
    RAISE NOTICE 'created role nexus_app';
  ELSE
    EXECUTE format('ALTER ROLE nexus_app WITH LOGIN PASSWORD %L', app_pw);
    RAISE NOTICE 'role nexus_app already exists, password refreshed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_ai') THEN
    EXECUTE format('CREATE ROLE nexus_ai LOGIN PASSWORD %L', ai_pw);
    RAISE NOTICE 'created role nexus_ai';
  ELSE
    EXECUTE format('ALTER ROLE nexus_ai WITH LOGIN PASSWORD %L', ai_pw);
    RAISE NOTICE 'role nexus_ai already exists, password refreshed';
  END IF;
END
$roles$;

-- --------------------------------------------------------------------------------- connect/schema
-- The database name is whatever POSTGRES_DB created (nexus by default); grant on the current DB only.
DO $conn$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nexus_app, nexus_ai', current_database());
END
$conn$;
GRANT USAGE ON SCHEMA public TO nexus_app;           -- no CREATE: the platform role writes, never DDLs
GRANT USAGE         ON SCHEMA public TO nexus_ai;    -- usage only: the AI role may never DDL
-- `CREATE` used to be granted to the app role because that role also ran Flyway. D30 split the two
-- credentials — migrations now run as the infra superuser — and the privilege was never what made
-- migration work anyway: schema `CREATE` lets a role add objects, not alter existing ones, which is
-- precisely why V4 failed as `42501 must be owner of table user_identities` while the app role held it.
-- With the split in place nothing in the runtime path creates a database object, so the grant is
-- removed: it only widened the blast radius of a statement that reaches DDL. This file is re-run at the
-- end of scripts/db_apply_migrations.sh (see the header), so the narrowing lands on the existing dev
-- database as well as on a first-boot volume; the explicit REVOKE keeps a re-run free of error.
REVOKE CREATE ON SCHEMA public FROM nexus_app;

-- --------------------------------------------------------------------------------- future tables
-- FAIL-CLOSED on purpose. New objects created by the migrate role (the superuser that owns this
-- database: `postgres` under infra/docker-compose.yml, `nexus` if the volume was booted with a
-- different POSTGRES_USER) become read-write for the platform role automatically, and get NOTHING for
-- nexus_ai: no default SELECT. Two consequences that are intended, not accidents:
--   * a fresh volume where 00_roles.sql runs at initdb time must re-apply this file after the
--     migrations (scripts/db_apply_migrations.sh does exactly that) or nexus_ai has no access at all;
--   * any NEW AI-readable/-writable table must be granted explicitly inside the migration that
--     creates it, so an accidental commerce table can never become reachable for the AI service.
-- (A blanket `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO nexus_ai` was tried first and is
--  now revoked below: at initdb time it leaked SELECT over users/carts/orders/payments/audit_logs,
--  which API_CONTRACT §0 does not allow.)
--
-- The role is resolved from pg_database.datdba instead of the literal `postgres`, because a hardcoded
-- name aborts the whole file with `role "postgres" does not exist` on any container whose superuser
-- has another name — and this file is the last step of scripts/db_apply_migrations.sh, so that error
-- would look like a migration failure.
DO $dflt$
DECLARE
  migrate_role text;
BEGIN
  SELECT pg_get_userbyid(datdba) INTO migrate_role
    FROM pg_database WHERE datname = current_database();
  IF migrate_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migrate_role) THEN
    RAISE NOTICE 'migrate role for database % not resolvable, skipping default privileges',
      current_database();
    RETURN;
  END IF;
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO nexus_app',
    migrate_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO nexus_app',
    migrate_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       REVOKE ALL ON TABLES FROM nexus_ai',
    migrate_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       REVOKE ALL ON SEQUENCES FROM nexus_ai',
    migrate_role);
  RAISE NOTICE 'default privileges bound to migrate role %', migrate_role;
END
$dflt$;

-- --------------------------------------------------------------------------------- nexus_app
-- §0 "read-write on commerce tables": the platform service owns auth/RBAC/merchants/offerings/orders/
-- carts/reservations/payments/reviews/conversations/events/growth/admin, i.e. every table in V1.
-- (At first-boot initdb there are no tables yet; the ALL TABLES grants are then harmless no-ops and
-- the ALTER DEFAULT PRIVILEGES above covers everything the migration creates afterwards.)
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public TO nexus_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_app;

-- --------------------------------------------------------------------------------- nexus_ai
-- Start from a clean slate: REVOKE ALL on whatever exists, then grant exactly the §0 split below. This
-- makes the file self-healing — re-running it removes any grant that crept in through default
-- privileges or manual psql, in any order of execution. (Schema USAGE + CONNECT above are untouched,
-- so the role can still log in; everything else must be enumerated here.)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nexus_ai;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM nexus_ai;

-- Applied table-by-table with a to_regclass guard so this file stays runnable at ANY point in the
-- bring-up sequence (fresh volume, mid-migration, or steady state) without erroring on a table that
-- does not exist yet.
--
-- (a) COMMERCE READS ONLY. Missing privileges on carts/orders/reservations/users are deliberate:
--     mutations there go through platform HTTP APIs with a scoped token (§0).
DO $ai_ro$
DECLARE
  t text;
  ro text[] := ARRAY[
    'merchants','offerings','locations','reviews','business_hours','availability_slots',
    'tenants','user_preferences','categories','merchant_categories'];
BEGIN
  FOREACH t IN ARRAY ro LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE %I TO nexus_ai', t);
    ELSE
      RAISE NOTICE 'skipping SELECT grant on % (table not created yet)', t;
    END IF;
  END LOOP;
END
$ai_ro$;

-- (b) AI-WRITABLE SET (read-write). facts is listed in both halves of §0; the read-write grant
--     supersedes the read-only one, exactly as the contract intends (the AI service is the writer
--     of inferred/observed facts). eval_* resolves to the three eval tables present in V1.
--     user_preferences is D19 and READ-ONLY: `get_user_preferences` is an AI tool (§32), while writing
--     a preference stays a platform call (/api/v1/me/preferences) so one actor owns one table.
--     conversations/messages/handoffs are NOT here — superseding D19's draft list. The platform
--     implemented the agent write path as one guarded endpoint (POST
--     /api/v1/internal/conversations/{id}/agent-message behind NEXUS_AI_INTERNAL_TOKEN), so SQL-level
--     writes from nexus_ai would be a second, unaudited door around the first. D20 in docs/STATUS.md.
DO $ai_rw$
DECLARE
  t text;
  rw text[] := ARRAY[
    'documents','chunks','facts','recommendation_sets','feedback_events','agent_runs','llm_calls',
    'eval_suites','eval_cases','eval_runs','review_summaries','seo_pages','campaigns','coupons'];
BEGIN
  FOREACH t IN ARRAY rw LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO nexus_ai', t);
    ELSE
      RAISE NOTICE 'skipping RW grant on % (table not created yet)', t;
    END IF;
  END LOOP;
END
$ai_rw$;

-- (c) APPEND-ONLY (D19): `record_event` is an AI tool (§58), so the AI service writes telemetry, but
--     it gets INSERT and nothing else — an agent must not be able to rewrite or delete the record of
--     what already happened. The bigserial id needs sequence USAGE, DELETE/UPDATE/TRUNCATE stay absent.
--     MEASURED CONSEQUENCE (verified on the live DB): with INSERT but no SELECT, `INSERT ... RETURNING`
--     fails with "permission denied for table events" — RETURNING is checked against SELECT. So the
--     event writer must insert without RETURNING and generate `event_id` itself.
DO $ai_append$
BEGIN
  IF to_regclass('public.events') IS NOT NULL THEN
    EXECUTE 'GRANT INSERT ON TABLE events TO nexus_ai';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE events_id_seq TO nexus_ai';
  ELSE
    RAISE NOTICE 'skipping append grant on events (table not created yet)';
  END IF;
END
$ai_append$;

-- (c2) Principal lookup for MCP/API callers: SELECT only, so an agent can resolve its own scope but
--      never mint or edit a principal.
DO $ai_principals$
BEGIN
  IF to_regclass('public.external_principals') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE external_principals TO nexus_ai';
  END IF;
END
$ai_principals$;

-- (d) NOT granted, on purpose: users, orders, order_items, carts, cart_items, payments, refunds,
--     reservations, coupons, subscriptions, api_keys, permission_grants, audit_logs, moderation_cases,
--     trust_signals, deletion_requests, favourites, saved_searches, collections, notifications,
--     offering_relations, resource_pools, availability..., merchant_users, categories.
--     Mutations there go through platform HTTP APIs with a scoped token (§0), and nothing in
--     AGENT_CONTRACT asks the AI to write them. Adding a table here requires a contract amendment.
