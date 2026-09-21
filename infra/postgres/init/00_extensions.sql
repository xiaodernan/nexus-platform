-- NEXUS — extension bootstrap (runs on FIRST boot of a fresh pgdata volume only).
-- Mirrors the top of infra/db/migrations/V1__init.sql; both are IF-NOT-EXISTS so running either
-- or both is safe. Kept separate so the roles script below can rely on citext/pg_trgm/vector
-- being present before any table exists.
-- Image pgvector/pgvector:pg16 ships: pgvector, pg_trgm, pgcrypto, btree_gist, citext (contrib).

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy/keyword similarity (AGENT_CONTRACT §6)
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector, embedding dim 1024 (DECISIONS D3)
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints on slots
