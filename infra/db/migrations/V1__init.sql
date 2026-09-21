-- NEXUS platform schema (Flyway V1)
-- Authoritative contract. See docs/DATABASE.md for rationale.
-- Postgres 16 + pgvector. Extensions assumed available in pgvector/pgvector:pg16 image.

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy/keyword similarity
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector
CREATE EXTENSION IF NOT EXISTS btree_gist;    -- exclusion constraints on slots

-- ---------------------------------------------------------------- tenants
-- A tenant is a market/city deployment boundary (HK first, GBA later) - docs/ARCHITECTURE.md §47
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,              -- 'hong-kong'
  name          text NOT NULL,
  country_code  text NOT NULL,                     -- 'HK'
  region_code   text,                              -- 'NT'
  timezone      text NOT NULL DEFAULT 'Asia/Hong_Kong',
  currency      text NOT NULL DEFAULT 'HKD',
  locales       text[] NOT NULL DEFAULT ARRAY['en','zh-HK','zh-CN'],
  status        text NOT NULL DEFAULT 'active',    -- active|suspended
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,-- jurisdiction/compliance switches (§128)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users (consumers + platform staff)
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id),
  email          citext,
  phone          text,
  password_hash  text,                              -- null for pure-OAuth accounts
  display_name   text,
  avatar_url     text,
  locale         text NOT NULL DEFAULT 'zh-HK',
  role           text NOT NULL DEFAULT 'consumer',  -- consumer|platform_admin|platform_ops|creator
  status         text NOT NULL DEFAULT 'active',    -- active|disabled|deleted
  marketing_opt_in boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX users_email_uniq ON users(email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_tenant_idx ON users(tenant_id);

CREATE TABLE user_identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,               -- password|google|apple|github
  provider_id  text,                        -- subject / opaque id (never a token)
  secret_ref   text,                        -- pointer into secret store; never raw secrets
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);

-- ---------------------------------------------------------------- preferences / memory (§32,§117,§118)
CREATE TABLE user_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,                -- food|budget|location|brand|style|activity|language|accessibility
  key         text NOT NULL,                -- e.g. 'cuisine_dislike'
  value       jsonb NOT NULL,               -- e.g. {"values":["spicy"]}
  weight      numeric(4,3) NOT NULL DEFAULT 0.500,  -- confidence, 0..1
  source      text NOT NULL DEFAULT 'declared',     -- declared|inferred|transaction
  scope       text NOT NULL DEFAULT 'long_term',    -- session|long_term
  conversation_id uuid,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, key)
);
CREATE INDEX user_pref_user_idx ON user_preferences(user_id, kind);

-- ---------------------------------------------------------------- merchants + membership (RBAC §47-49)
CREATE TABLE merchants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  slug              text NOT NULL,
  legal_name        text NOT NULL,
  display_name      text NOT NULL,
  display_name_zh   text,
  description       text,
  category_primary  text,                        -- denormalised for listing speed
  status            text NOT NULL DEFAULT 'draft',   -- draft|pending_review|published|suspended
  ownership_verified boolean NOT NULL DEFAULT false,
  data_origin       text NOT NULL DEFAULT 'demo',    -- demo|merchant|imported|partnership - §109 honesty
  contact           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- phone/email/whatsapp/site
  socials           jsonb NOT NULL DEFAULT '{}'::jsonb,
  avg_price_hkd     numeric(10,2),
  price_band        text,                             -- $ | $$ | $$$ | $$$$
  rating_agg        numeric(3,2) NOT NULL DEFAULT 0,
  review_count      integer NOT NULL DEFAULT 0,
  popularity_score  numeric(6,4) NOT NULL DEFAULT 0,
  tags              text[] NOT NULL DEFAULT '{}',
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- quiet_ambience, kid_friendly, mtr_within_5min...
  images            jsonb NOT NULL DEFAULT '[]'::jsonb,
  seo               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_agent_enabled  boolean NOT NULL DEFAULT false,
  plan              text NOT NULL DEFAULT 'free',      -- free|pro|enterprise (§65)
  search_tsv        tsvector,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX merchants_tenant_status_idx ON merchants(tenant_id, status);
CREATE INDEX merchants_tags_idx ON merchants USING gin(tags);
CREATE INDEX merchants_attrs_idx ON merchants USING gin(attributes);
CREATE INDEX merchants_search_idx ON merchants USING gin(search_tsv);
CREATE INDEX merchants_name_trgm_idx ON merchants USING gin(display_name gin_trgm_ops);
CREATE INDEX merchants_rating_idx ON merchants(rating_agg DESC);

CREATE TABLE merchant_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'owner',  -- owner|admin|manager|staff|marketing|analyst|ai_agent (§48)
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, user_id)
);
CREATE INDEX merchant_users_user_idx ON merchant_users(user_id);

-- Declarative permission grants for humans AND AI agents (§49, §52)
CREATE TABLE permission_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL,        -- user|merchant_user|agent|api_key
  subject_id     uuid NOT NULL,
  merchant_id    uuid REFERENCES merchants(id) ON DELETE CASCADE,  -- null = tenant/platform scope
  permission     text NOT NULL,        -- read_products|write_products|read_orders|create_draft_campaign|publish_campaign|create_reservation|refund_payment|send_message|read_analytics
  granted_by     uuid,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, merchant_id, permission)
);
CREATE INDEX perm_subject_idx ON permission_grants(subject_type, subject_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,     -- sha256 of the secret; plaintext shown once
  prefix       text NOT NULL,            -- display prefix nx_live_ab12
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  label          text,
  address_line1  text NOT NULL,
  address_line2  text,
  district       text,               -- 'Sha Tin' | 'Tsim Sha Tsui'
  area           text,               -- 'NT' | 'KLN' | 'HKI'
  city           text NOT NULL,
  postcode       text,
  lat            numeric(9,6) NOT NULL,
  lng            numeric(9,6) NOT NULL,
  mtr_station    text,
  mtr_walk_min   integer,
  is_primary     boolean NOT NULL DEFAULT true,
  geo_properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX locations_geo_idx ON locations(lat, lng);
CREATE INDEX locations_tenant_district_idx ON locations(tenant_id, district);
CREATE INDEX locations_merchant_idx ON locations(merchant_id);

-- Opening hours: long TTL freshness class (§20)
CREATE TABLE business_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES locations(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL,        -- 0=Mon .. 6=Sun
  opens_at     time NOT NULL,
  closes_at    time NOT NULL,
  crosses_midnight boolean NOT NULL DEFAULT false,
  source       text NOT NULL DEFAULT 'merchant',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, location_id, weekday, opens_at)
);

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id),   -- null = global catalog
  slug        text NOT NULL,
  name        text NOT NULL,
  name_zh     text,
  parent_id   uuid REFERENCES categories(id),
  kind        text NOT NULL DEFAULT 'merchant',  -- merchant|product|service|experience
  sort_order  integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE merchant_categories (
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (merchant_id, category_id)
);

-- ---------------------------------------------------------------- catalogue (products + services)
-- Shared shape; `kind` distinguishes product vs service vs experience so Cart can hold all three (§41)
CREATE TABLE offerings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  kind              text NOT NULL DEFAULT 'product',   -- product|service|experience
  category_id       uuid REFERENCES categories(id),
  slug              text NOT NULL,
  name              text NOT NULL,
  name_zh           text,
  description       text,
  description_zh    text,
  price_amount      numeric(12,2),
  currency          text NOT NULL DEFAULT 'HKD',
  price_model       text NOT NULL DEFAULT 'fixed',     -- fixed|from_price|per_person|hourly|range
  price_min         numeric(12,2),
  price_max         numeric(12,2),
  price_source      text NOT NULL DEFAULT 'merchant',  -- merchant|imported|observed|estimated (§19)
  price_updated_at  timestamptz NOT NULL DEFAULT now(),-- drives freshness TTL (§20)
  stock_quantity    integer,                            -- null = unknown / not tracked
  stock_updated_at  timestamptz,
  bookable          boolean NOT NULL DEFAULT false,
  min_party_size    smallint,
  max_party_size    smallint,
  duration_minutes  integer,
  images            jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb, -- cuisine, spicy_level, accessibility, season...
  constraints       jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"no_pork":true}
  options           jsonb NOT NULL DEFAULT '[]'::jsonb, -- variants / add-ons
  status            text NOT NULL DEFAULT 'active',     -- draft|active|archived|out_of_stock
  popularity_score  numeric(6,4) NOT NULL DEFAULT 0,
  rating_agg        numeric(3,2) NOT NULL DEFAULT 0,
  review_count      integer NOT NULL DEFAULT 0,
  search_tsv        tsvector,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, slug)
);
CREATE INDEX offerings_merchant_idx ON offerings(merchant_id, status);
CREATE INDEX offerings_tenant_kind_idx ON offerings(tenant_id, kind, status);
CREATE INDEX offerings_price_idx ON offerings(price_amount);
CREATE INDEX offerings_search_idx ON offerings USING gin(search_tsv);
CREATE INDEX offerings_name_trgm_idx ON offerings USING gin(name gin_trgm_ops);
CREATE INDEX offerings_attrs_idx ON offerings USING gin(attributes);

CREATE TABLE offering_relations (
  from_offering uuid NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  to_offering   uuid NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  relation      text NOT NULL DEFAULT 'related_to',   -- related_to|upsell|bundle|belongs_to
  weight        numeric(4,3) NOT NULL DEFAULT 0.500,
  PRIMARY KEY (from_offering, to_offering, relation)
);

-- ---------------------------------------------------------------- availability + reservations (§40)
-- Generic resource model so restaurant/hotel/beauty/fitness share one service.
CREATE TABLE resource_pools (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  offering_id   uuid REFERENCES offerings(id) ON DELETE CASCADE,
  kind          text NOT NULL,            -- table|room|seat|treatment_room|class_slot|ticket
  name          text NOT NULL,
  capacity      integer NOT NULL DEFAULT 1,
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE availability_slots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  pool_id        uuid REFERENCES resource_pools(id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  capacity_total integer NOT NULL DEFAULT 1,
  capacity_left  integer NOT NULL DEFAULT 1,
  price_amount   numeric(12,2),
  currency       text NOT NULL DEFAULT 'HKD',
  source         text NOT NULL DEFAULT 'merchant',
  updated_at     timestamptz NOT NULL DEFAULT now(),   -- availability = real-time TTL (§20)
  CHECK (ends_at > starts_at)
);
CREATE INDEX slots_lookup_idx ON availability_slots(merchant_id, starts_at);
CREATE INDEX slots_pool_idx ON availability_slots(pool_id, starts_at);

CREATE TABLE reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,       -- human-readable NX-RES-xxxx
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  merchant_id    uuid NOT NULL REFERENCES merchants(id),
  user_id        uuid REFERENCES users(id),
  offering_id    uuid REFERENCES offerings(id),
  slot_id        uuid REFERENCES availability_slots(id),
  party_size     smallint NOT NULL DEFAULT 2,
  contact        jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  status         text NOT NULL DEFAULT 'pending', -- pending|confirmed|cancelled|completed|no_show
  total_amount   numeric(12,2),
  currency       text NOT NULL DEFAULT 'HKD',
  notes          text,
  source         text NOT NULL DEFAULT 'consumer', -- consumer|ai_agent|mcp|ucp|merchant
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_merchant_idx ON reservations(merchant_id, starts_at);
CREATE INDEX reservations_user_idx ON reservations(user_id, created_at DESC);

-- ---------------------------------------------------------------- orders / cart / payment (§41-42)
CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  session_id  text,
  merchant_id uuid REFERENCES merchants(id),      -- soft grouping; multi-merchant allowed
  status      text NOT NULL DEFAULT 'open',        -- open|converted|abandoned
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carts_user_idx ON carts(user_id, status);
CREATE INDEX carts_session_idx ON carts(session_id, status);

CREATE TABLE cart_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id     uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  offering_id uuid REFERENCES offerings(id),
  reservation_id uuid REFERENCES reservations(id),
  kind        text NOT NULL DEFAULT 'product',      -- product|service|experience|reservation
  quantity    integer NOT NULL DEFAULT 1,
  unit_price  numeric(12,2) NOT NULL,
  currency    text NOT NULL DEFAULT 'HKD',
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_source text NOT NULL DEFAULT 'merchant',
  priced_at   timestamptz NOT NULL DEFAULT now(),   -- revalidate against TTL before checkout
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (offering_id IS NOT NULL OR reservation_id IS NOT NULL)
);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,     -- NX-ORD-xxxx
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  merchant_id   uuid NOT NULL REFERENCES merchants(id),
  user_id       uuid REFERENCES users(id),
  status        text NOT NULL DEFAULT 'created', -- created|paid|preparing|completed|cancelled|refunded
  fulfillment   text NOT NULL DEFAULT 'pickup',  -- pickup|delivery|dine_in|reservation|virtual
  subtotal      numeric(12,2) NOT NULL DEFAULT 0,
  discount_total numeric(12,2) NOT NULL DEFAULT 0,
  fee_total     numeric(12,2) NOT NULL DEFAULT 0,
  tax_total     numeric(12,2) NOT NULL DEFAULT 0,
  total         numeric(12,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'HKD',
  contact       jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_merchant_idx ON orders(merchant_id, created_at DESC);
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);

CREATE TABLE order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offering_id uuid REFERENCES offerings(id),
  name_snapshot text NOT NULL,
  quantity    integer NOT NULL DEFAULT 1,
  unit_price  numeric(12,2) NOT NULL,
  total_price numeric(12,2) NOT NULL,
  options     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'demo',    -- demo|stripe|alipayhk|payme|hsbc (§42 never store card data)
  provider_ref    text,
  idempotency_key text NOT NULL UNIQUE,
  amount          numeric(12,2) NOT NULL,
  currency        text NOT NULL DEFAULT 'HKD',
  status          text NOT NULL DEFAULT 'pending', -- pending|authorized|captured|failed|refunded|partially_refunded
  client_secret_ref text,
  failure_reason  text,
  captured_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount       numeric(12,2) NOT NULL,
  currency     text NOT NULL DEFAULT 'HKD',
  reason       text,
  status       text NOT NULL DEFAULT 'pending',   -- pending|succeeded|failed
  approved_by  uuid REFERENCES users(id),
  provider_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- reviews (§54-55)
CREATE TABLE reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  offering_id   uuid REFERENCES offerings(id),
  user_id       uuid REFERENCES users(id),
  author_label  text,                        -- for anonymous / imported
  rating        numeric(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title         text,
  body          text NOT NULL,
  language      text NOT NULL DEFAULT 'zh-HK',
  photos        jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_purchase   boolean NOT NULL DEFAULT false,
  verified_reservation boolean NOT NULL DEFAULT false,
  data_origin   text NOT NULL DEFAULT 'demo',   -- demo|user|imported - §109
  status        text NOT NULL DEFAULT 'published', -- pending|published|rejected|flagged
  moderation    jsonb NOT NULL DEFAULT '{}'::jsonb,
  helpful_count integer NOT NULL DEFAULT 0,
  aspects       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"service":4.5,"waiting_time":2.0}
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_merchant_idx ON reviews(merchant_id, created_at DESC);
CREATE INDEX reviews_offer_idx ON reviews(offering_id);
CREATE INDEX reviews_user_idx ON reviews(user_id);

CREATE TABLE review_summaries (
  merchant_id    uuid PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  overall        numeric(3,2) NOT NULL,
  praise         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label,evidence_count,review_ids}]
  complaints     jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_size    integer NOT NULL DEFAULT 0,
  model          text,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- conversations / messages (§25-26, §34)
CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  merchant_id  uuid REFERENCES merchants(id) ON DELETE CASCADE,
  channel      text NOT NULL DEFAULT 'web',         -- web|mcp|ucp|whatsapp|email
  mode         text NOT NULL DEFAULT 'ai',          -- ai|human|hybrid
  subject      text,
  state        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- intent state + filters (§34)
  status       text NOT NULL DEFAULT 'open',        -- open|handoff|closed|archived
  last_message_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conv_user_idx ON conversations(user_id, last_message_at DESC);
CREATE INDEX conv_merchant_idx ON conversations(merchant_id, last_message_at DESC);

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type       text NOT NULL,           -- user|ai_agent|merchant_user|system
  sender_id         uuid,
  role              text NOT NULL,           -- user|assistant|tool|system
  content           text NOT NULL,
  content_type      text NOT NULL DEFAULT 'text',  -- text|cards|comparison|form
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb, -- structured UI blocks + sources
  agent_run_id      uuid,
  confidence        numeric(4,3),
  handoff           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, created_at);

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  merchant_id     uuid NOT NULL REFERENCES merchants(id),
  reason          text NOT NULL,             -- low_confidence|user_request|policy|refund
  status          text NOT NULL DEFAULT 'open',  -- open|accepted|resolved|expired
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

-- ---------------------------------------------------------------- RAG: documents / chunks / embeddings (§12)
CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id),
  merchant_id  uuid REFERENCES merchants(id) ON DELETE CASCADE,
  offering_id  uuid REFERENCES offerings(id) ON DELETE CASCADE,
  kind         text NOT NULL,              -- menu|policy|faq|description|review|image_meta|url|pdf|xlsx
  source_uri   text,
  title        text,
  mime_type    text,
  raw_text     text,
  content_hash text NOT NULL,
  lang         text,
  status       text NOT NULL DEFAULT 'indexed',  -- pending|processing|indexed|failed
  error        text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_merchant_idx ON documents(merchant_id, kind);

CREATE TABLE chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  merchant_id   uuid REFERENCES merchants(id) ON DELETE CASCADE,   -- denormalised for tenant filter at query time
  tenant_id     uuid REFERENCES tenants(id),
  ordinal       integer NOT NULL,
  text          text NOT NULL,
  token_count   integer,
  section       text,
  embedding     vector(1024),
  embed_model   text,
  embedded_at   timestamptz,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_merchant_idx ON chunks(merchant_id);
CREATE INDEX chunks_text_trgm ON chunks USING gin(text gin_trgm_ops);
ALTER TABLE chunks ADD COLUMN search_tsv tsvector;
CREATE INDEX chunks_tsv_idx ON chunks USING gin(search_tsv);

-- ---------------------------------------------------------------- trust layer / provenance (§19, §53)
-- Every material claim an AI answer can cite must resolve to a fact row.
CREATE TABLE facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL,          -- merchant|offering|location|review|policy
  subject_id    uuid NOT NULL,
  merchant_id   uuid REFERENCES merchants(id) ON DELETE CASCADE,
  attribute     text NOT NULL,          -- price|opening_hours|availability|address|cuisine|capacity
  value         jsonb NOT NULL,
  unit          text,
  currency      text,
  source        text NOT NULL,          -- merchant|imported|observed|third_party|inferred
  source_uri    text,
  confidence    numeric(4,3) NOT NULL DEFAULT 1.000,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,            -- freshness TTL (§20)
  stale         boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facts_subject_idx ON facts(subject_type, subject_id, attribute);
CREATE INDEX facts_merchant_idx ON facts(merchant_id, attribute);
CREATE INDEX facts_expiry_idx ON facts(expires_at) WHERE stale IS FALSE;

CREATE TABLE trust_signals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  kind         text NOT NULL,          -- verified_business|review_anomaly|price_anomaly|duplicate_listing|fraud_flag
  severity     text NOT NULL DEFAULT 'info',  -- info|warn|high|critical
  score        numeric(4,3),
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_by  text NOT NULL DEFAULT 'rule',  -- rule|model|human
  status       text NOT NULL DEFAULT 'open',  -- open|reviewing|dismissed|confirmed
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trust_merchant_idx ON trust_signals(merchant_id, status);

CREATE TABLE moderation_cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id),
  subject_type text NOT NULL,            -- review|merchant|document|message|listing
  subject_id   uuid NOT NULL,
  reason       text NOT NULL,
  policy       text,
  auto_action  text,                      -- none|hide|flag|reject
  status       text NOT NULL DEFAULT 'open',
  assigned_to  uuid REFERENCES users(id),
  resolution   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- ---------------------------------------------------------------- recommendations / feedback (§17-18, §99)
CREATE TABLE recommendation_sets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  user_id        uuid REFERENCES users(id),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  query          text,
  intent         jsonb NOT NULL DEFAULT '{}'::jsonb,
  strategy       text NOT NULL DEFAULT 'hybrid_v1',
  items          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{subject_type,subject_id,rank,score,explanations[],fact_ids[]}]
  latency_ms     integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recset_user_idx ON recommendation_sets(user_id, created_at DESC);

CREATE TABLE feedback_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id),
  user_id         uuid REFERENCES users(id),
  subject_type    text NOT NULL,       -- recommendation_set|message|merchant|offering|search_result
  subject_id      uuid,
  signal          text NOT NULL,       -- like|dislike|not_relevant|too_expensive|too_far|wrong_category|click|reserve|purchase|dwell
  value           jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel         text NOT NULL DEFAULT 'web',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_subject_idx ON feedback_events(subject_type, subject_id);
CREATE INDEX feedback_user_idx ON feedback_events(user_id, created_at DESC);

-- ---------------------------------------------------------------- favorites / collections / saved search
CREATE TABLE favorites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type text NOT NULL,          -- merchant|offering|guide|collection
  subject_id   uuid NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, subject_type, subject_id)
);

CREATE TABLE saved_searches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text,
  query      text NOT NULL,
  intent     jsonb NOT NULL DEFAULT '{}'::jsonb,
  notify     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  author_id   uuid REFERENCES users(id),
  kind        text NOT NULL DEFAULT 'collection',   -- collection|guide|itinerary
  slug        text NOT NULL,
  title       text NOT NULL,
  title_zh    text,
  description text,
  cover_url   text,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ordered [{subject_type,subject_id,note}]
  visibility  text NOT NULL DEFAULT 'public',
  data_origin text NOT NULL DEFAULT 'demo',
  seo         jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX collections_author_idx ON collections(author_id, kind);

-- ---------------------------------------------------------------- growth: referral / coupons / campaigns (§59-62, §65)
CREATE TABLE coupons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  merchant_id   uuid REFERENCES merchants(id) ON DELETE CASCADE,
  code          text NOT NULL,
  kind          text NOT NULL DEFAULT 'percent',      -- percent|fixed|free_item
  value         numeric(12,2) NOT NULL,
  min_spend     numeric(12,2),
  max_uses      integer,
  used_count    integer NOT NULL DEFAULT 0,
  applies_to    jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'draft',        -- draft|scheduled|active|exhausted|retired
  created_by    uuid REFERENCES users(id),
  published_by  uuid REFERENCES users(id),            -- explicit human authorization (§27)
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  tenant_id    uuid REFERENCES tenants(id),
  title        text NOT NULL,
  goal         text,                       -- 'increase weekday afternoon traffic'
  channel      text[] NOT NULL DEFAULT '{}',   -- push|email|whatsapp|landing|social
  audience     jsonb NOT NULL DEFAULT '{}'::jsonb,
  creative     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- generated copy, images, landing page
  coupon_ids   uuid[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft',      -- draft|awaiting_approval|scheduled|live|paused|ended
  generated_by text NOT NULL DEFAULT 'ai_marketing_agent',
  metrics      jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_merchant_idx ON campaigns(merchant_id, status);

CREATE TABLE referrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),
  kind          text NOT NULL,              -- consumer|merchant|creator
  referrer_type text NOT NULL,              -- user|merchant
  referrer_id   uuid NOT NULL,
  invitee_email text,
  invitee_id    uuid REFERENCES users(id),
  code          text NOT NULL,
  status        text NOT NULL DEFAULT 'invited',  -- invited|signed_up|first_value|rewarded|expired
  reward        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  converted_at  timestamptz,
  UNIQUE (code, referrer_id)
);

CREATE TABLE subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  plan          text NOT NULL,               -- free|pro|enterprise
  status        text NOT NULL DEFAULT 'active',
  seats         integer NOT NULL DEFAULT 1,
  credits_total integer NOT NULL DEFAULT 0,
  credits_used  integer NOT NULL DEFAULT 0,
  amount        numeric(12,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'HKD',
  interval      text NOT NULL DEFAULT 'month',
  renews_at     timestamptz,
  trial_ends_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- SEO / content (§28-30, §64)
CREATE TABLE seo_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  path         text NOT NULL,             -- /hong-kong/restaurants/date-night
  kind         text NOT NULL,             -- city|category|category_district|theme|merchant|offering|guide
  title        text,
  title_zh     text,
  description  text,
  h1           text,
  body         text,
  faq          jsonb NOT NULL DEFAULT '[]'::jsonb,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- real listings backing the page (uniqueness guard §30)
  jsonld       jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical    text,
  lang         text NOT NULL DEFAULT 'zh-HK',
  status       text NOT NULL DEFAULT 'draft',   -- draft|published|noindex|retired
  quality_score numeric(4,3),                    -- anti-spam guard (§28)
  generated_by text NOT NULL DEFAULT 'ai_seo_agent',
  reviewed_by  uuid REFERENCES users(id),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, path, lang)
);
CREATE INDEX seo_pages_kind_idx ON seo_pages(tenant_id, kind, status);

-- ---------------------------------------------------------------- events (§58) + notifications (§123-125)
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  event_id    uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id),
  actor_type  text NOT NULL DEFAULT 'anonymous',   -- user|merchant_user|agent|system|anonymous
  actor_id    uuid,
  name        text NOT NULL,                       -- search|view|click|favorite|compare|reserve|cart_add|checkout|purchase|cancel|review|share|feedback
  subject_type text,
  subject_id  uuid,
  session_id  text,
  conversation_id uuid,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- device, locale, geo coarse, utm
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ingest_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_name_time_idx ON events(name, occurred_at DESC);
CREATE INDEX events_actor_idx ON events(actor_type, actor_id, occurred_at DESC);
CREATE INDEX events_subject_idx ON events(subject_type, subject_id);
CREATE INDEX events_tenant_time_idx ON events(tenant_id, occurred_at DESC);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id),
  audience     text NOT NULL,             -- consumer|merchant|platform
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  merchant_id  uuid REFERENCES merchants(id) ON DELETE CASCADE,
  channel      text NOT NULL DEFAULT 'in_app',   -- in_app|email|push|whatsapp
  template     text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',   -- pending|sent|failed|suppressed
  read_at      timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX notifications_merchant_idx ON notifications(merchant_id, created_at DESC);

-- ---------------------------------------------------------------- AI observability / evaluation (§69-72, §160)
CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id),
  user_id         uuid,
  merchant_id     uuid,
  conversation_id uuid,
  task_id         text,
  agent           text NOT NULL,              -- user_intent|search|retrieval|ranking|recommendation|reservation|cart|customer_service|marketing|analytics|seo|fraud|fact_verification
  parent_run_id   uuid REFERENCES agent_runs(id),
  model           text,
  provider        text,
  status          text NOT NULL DEFAULT 'running',  -- running|succeeded|failed|fallback|cancelled
  plan            jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_summary   text,
  output_summary  text,
  tool_calls      jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieval       jsonb NOT NULL DEFAULT '[]'::jsonb,
  fact_ids        uuid[] NOT NULL DEFAULT '{}',
  prompt_tokens   integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd        numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms      integer,
  error           text,
  fallback_used   text,                        -- model_fallback|deterministic_search|human (§105)
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX agent_runs_agent_idx ON agent_runs(agent, started_at DESC);
CREATE INDEX agent_runs_conv_idx ON agent_runs(conversation_id);

CREATE TABLE llm_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id  uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  purpose       text NOT NULL,              -- intent|rerank|summary|generate|classify
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd      numeric(10,6),
  latency_ms    integer,
  status        text NOT NULL DEFAULT 'ok',
  cache_hit     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_run_idx ON llm_calls(agent_run_id);
CREATE INDEX llm_calls_time_idx ON llm_calls(created_at DESC);

CREATE TABLE eval_suites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  size        integer NOT NULL DEFAULT 0,
  version     text NOT NULL DEFAULT '1',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id    uuid NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  query       text NOT NULL,
  locale      text NOT NULL DEFAULT 'zh-HK',
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- user prefs, geo, time
  expected    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- intent fields, must_include, must_exclude, behaviour
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id      uuid NOT NULL REFERENCES eval_suites(id),
  agent         text NOT NULL,
  model         text,
  strategy      text,
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- task_success, tool_success, precision@k, relevance, hallucination_rate, p95_latency, cost, human_intervention
  case_results  jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- ---------------------------------------------------------------- audit / security (§50-52)
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid REFERENCES tenants(id),
  actor_type   text NOT NULL,          -- user|merchant_user|agent|api_key|system
  actor_id     uuid,
  action       text NOT NULL,          -- login|update_product|publish_campaign|refund|delete_data|tool_call|permission_denied
  subject_type text,
  subject_id   uuid,
  merchant_id  uuid,
  ip           inet,
  user_agent   text,
  before       jsonb,
  after        jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_idx ON audit_logs(actor_type, actor_id, created_at DESC);
CREATE INDEX audit_merchant_idx ON audit_logs(merchant_id, created_at DESC);
CREATE INDEX audit_action_idx ON audit_logs(action, created_at DESC);

CREATE TABLE rate_limit_buckets (
  key         text PRIMARY KEY,        -- principal + scope
  window_start timestamptz NOT NULL,
  count       integer NOT NULL DEFAULT 0
);

CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  scope       text NOT NULL,
  owner_id    uuid,
  response    jsonb,
  status      text NOT NULL DEFAULT 'in_progress',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

-- ---------------------------------------------------------------- UCP / MCP (§43-45)
-- Merchant capability profiles published for external agents. Logic stays out of business code.
CREATE TABLE agent_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  protocol     text NOT NULL,             -- ucp|mcp|a2a
  version      text NOT NULL,
  endpoint     text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_handlers jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'draft',   -- draft|published|revoked
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, protocol, version)
);

CREATE TABLE external_principals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol      text NOT NULL,             -- ucp|mcp
  client_id     text NOT NULL,
  name          text NOT NULL,             -- 'ChatGPT', 'Gemini'
  merchant_id   uuid REFERENCES merchants(id) ON DELETE CASCADE,  -- null = platform-wide read
  scopes        text[] NOT NULL DEFAULT '{}',
  key_hash      text,
  status        text NOT NULL DEFAULT 'active',
  linked_user_id uuid REFERENCES users(id),
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protocol, client_id)
);

-- ---------------------------------------------------------------- data retention helpers (§106)
CREATE TABLE deletion_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,             -- account|memory|personalization|export
  status      text NOT NULL DEFAULT 'pending',
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- triggers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','merchants','locations','offerings','reservations',
                           'carts','orders','payments','conversations','documents','facts',
                           'campaigns','seo_pages','subscriptions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- merchant full-text vector maintenance
CREATE OR REPLACE FUNCTION merchant_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('simple',
    coalesce(NEW.display_name,'') || ' ' || coalesce(NEW.display_name_zh,'') || ' ' ||
    coalesce(NEW.description,'') || ' ' || array_to_string(NEW.tags,' '));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER merchants_tsv BEFORE INSERT OR UPDATE OF display_name, display_name_zh, description, tags
  ON merchants FOR EACH ROW EXECUTE FUNCTION merchant_tsv();

CREATE OR REPLACE FUNCTION offering_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('simple',
    coalesce(NEW.name,'') || ' ' || coalesce(NEW.name_zh,'') || ' ' ||
    coalesce(NEW.description,'') || ' ' || coalesce(NEW.description_zh,''));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER offerings_tsv BEFORE INSERT OR UPDATE OF name, name_zh, description, description_zh
  ON offerings FOR EACH ROW EXECUTE FUNCTION offering_tsv();

CREATE OR REPLACE FUNCTION chunk_tsv() RETURNS trigger AS $$
BEGIN
  IF NEW.search_tsv IS NULL THEN
    NEW.search_tsv := to_tsvector('simple', coalesce(NEW.text,''));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER chunks_tsv BEFORE INSERT OR UPDATE OF text
  ON chunks FOR EACH ROW EXECUTE FUNCTION chunk_tsv();

-- ---------------------------------------------------------------- analytics views (§56, §161-162)
CREATE OR REPLACE VIEW v_merchant_funnel AS
SELECT m.tenant_id, m.id AS merchant_id,
  count(*) FILTER (WHERE e.name='view')                          AS views,
  count(*) FILTER (WHERE e.name='click')                         AS clicks,
  count(*) FILTER (WHERE e.name='reserve' OR e.name='cart_add')  AS actions,
  count(DISTINCT r.id)                                           AS reservations,
  count(DISTINCT o.id)                                           AS orders,
  coalesce(sum(o.total),0)                                       AS revenue
FROM merchants m
LEFT JOIN events e ON e.subject_type='merchant' AND e.subject_id = m.id
LEFT JOIN reservations r ON r.merchant_id = m.id AND r.status IN ('confirmed','completed')
LEFT JOIN orders o ON o.merchant_id = m.id AND o.status NOT IN ('cancelled','refunded')
GROUP BY m.tenant_id, m.id;

CREATE OR REPLACE VIEW v_north_star AS
SELECT date_trunc('day', occurred_at) AS day, tenant_id,
  count(DISTINCT session_id)                                   AS sessions,
  count(*) FILTER (WHERE name='search')                        AS searches,
  count(*) FILTER (WHERE name IN ('reserve','purchase','favorite','cart_add')) AS fulfilled_intents
FROM events GROUP BY 1,2;
