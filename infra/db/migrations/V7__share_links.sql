-- V7 — the link table `POST /api/v1/share` has been waiting for.
--
-- WHY THIS EXISTS: API_CONTRACT §8 has documented `POST /api/v1/share {subject_type,subject_id}` → "short
-- link + OG payload" since the contract was written, and V1–V6 never created a table to hold the link.
-- DECISIONS records that gap beside the moderation queue's missing door rather than deleting the contract
-- row, because the §59–62 growth loop needs the short link: a share with no address is not a share.
--
-- THREE DECISIONS ARE ENCODED IN THE CONSTRAINTS, and each is here rather than in the service because the
-- database is what has to hold:
--
--   * `code` is unique across the whole table, not per tenant. A short link is handed to a stranger who
--     knows nothing about tenants; the code is the only handle they have, so it must resolve on its own.
--   * One LIVE link per subject, as a PARTIAL unique index. Re-sharing a merchant therefore returns the
--     same code instead of minting a second address for the same page — idempotent by construction, with
--     no "look up first" race between two concurrent shares. `revoked_at IS NULL` is what lets a revoked
--     link be replaced instead of permanently blocking its subject.
--   * `hits` exists but is NOT incremented by the resolver route: a GET that writes is a GET that cannot be
--     cached and that turns a link preview into a write amplification vector. The edge counts the click.
--
-- NO `updated_at` COLUMN, deliberately. V1 installs its `set_updated_at()` trigger by walking a list of
-- table names, and this table is not on that list. Adding a column the trigger would expect, without the
-- trigger, is the shape of the incident that made the trust layer read-only for a day (V6: `facts` had a
-- trigger expecting `updated_at` that the table never declared). A link has `created_at` and `revoked_at`;
-- nothing here is ever edited in place.
--
-- The alphabet in the CHECK is Crockford base32 without I, L, O and U: a code is read aloud and typed by
-- hand, and those four are the characters people mistype or that form accidental words.

-- EVERY STATEMENT IS `IF NOT EXISTS`, and that is the point of this file, not a style.
--
-- Two ledgers hold this database: `scripts/db_apply_migrations.sh` keeps `schema_migrations`, and the
-- platform keeps `flyway_schema_history`, and neither reads the other (DECISIONS D32). V7 was applied
-- to the dev database by hand, so its objects existed while BOTH ledgers still said "pending" — and
-- the platform's next boot ran Flyway, which tried to create `share_links` and died on 42P07, leaving
-- the service unbootable. The same failure was waiting for any database `db_apply_migrations.sh` had
-- built from scratch (the seed gate builds exactly one, and reports `migrations=7`).
--
-- The content of the hand-applied copy was compared against this file before the `IF NOT EXISTS` went
-- in — columns, defaults, the three indexes, both CHECKs and both FKs, on `nexus` and on `nexus_test`,
-- one for one — so re-running it changes nothing and both ledgers can adopt the same row. This is the
-- convention the script already assumed of V4 ("resumable", D30); V7 simply did not follow it.

CREATE TABLE IF NOT EXISTS share_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  code         text NOT NULL,
  subject_type text NOT NULL,        -- merchant|offering|collection|guide
  subject_id   uuid NOT NULL,
  created_by   uuid REFERENCES users(id),
  hits         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT share_links_code_format CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{6,16}$'),
  CONSTRAINT share_links_subject_type_known
    CHECK (subject_type IN ('merchant', 'offering', 'collection', 'guide'))
);

CREATE UNIQUE INDEX IF NOT EXISTS share_links_code_uidx ON share_links(code);

-- One live link per subject; a revoked row steps aside instead of blocking a replacement.
CREATE UNIQUE INDEX IF NOT EXISTS share_links_live_subject_uidx
  ON share_links(tenant_id, subject_type, subject_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS share_links_subject_idx ON share_links(subject_type, subject_id);
