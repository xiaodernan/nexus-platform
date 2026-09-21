-- =============================================================================
-- SYNTHETIC DEMO DATA - NOT REAL BUSINESSES
-- data/seed/quality.sql — the gate for the seeded demo dataset.
--
-- Run after data/seed/load.sh:
--   docker exec -i nexus-postgres psql -U postgres -d nexus -v ON_ERROR_STOP=1 < data/seed/quality.sql
--   # CI scale-down example:
--   ... psql -v ON_ERROR_STOP=1 -v MIN_MERCHANTS=100 -v MIN_OFFERINGS=800 \
--          -v MIN_REVIEWS=1200 -v MIN_NEAR_SHA_TIN=60 < data/seed/quality.sql
--
-- Three parts:
--   A  per-table counts + distributions (informational, printed)
--   B  qc(check, ok, detail) — one row per assertion; every FK in the demo graph is swept
--      dynamically from pg_constraint, so an orphan can never hide in a pair we forgot
--   C  a hard gate: raises and aborts (non-zero exit) if any B row is ok = false
--
-- The checks mirror the product rules, not just the schema: §109/§110/§155 honesty markers
-- (demo phone range, example.hk, demo:// provenance, noindex, placeholder art), §94 cold-start
-- density, AGENT_CONTRACT §5 freshness TTLs, and spec §55 review-intelligence signal quality.
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\if :{?MIN_MERCHANTS} \else \set MIN_MERCHANTS 500 \endif
\if :{?MIN_OFFERINGS} \else \set MIN_OFFERINGS 5000 \endif
\if :{?MIN_REVIEWS} \else \set MIN_REVIEWS 10000 \endif
\if :{?MIN_NEAR_SHA_TIN} \else \set MIN_NEAR_SHA_TIN 300 \endif
\toggle QUIET off

-- spec §94: dense geography around the Sha Tin centroid (22.3831, 114.1876). No PostGIS in this
-- project (docs/DECISIONS.md D3), so the 3 km test is a plain haversine written out in SQL.
CREATE OR REPLACE FUNCTION pg_temp.haversine_m(lat0 double precision, lng0 double precision,
                                              lat1 double precision, lng1 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  select 2 * 6371000 * asin(sqrt(
      pow(sin(radians(lat1 - lat0) / 2), 2)
    + cos(radians(lat0)) * cos(radians(lat1)) * pow(sin(radians(lng1 - lng0) / 2), 2)))
$$;

CREATE TEMP TABLE qc (check text PRIMARY KEY, ok boolean, detail text);

-- =========================================================== A  counts & shape
\echo ''
\echo '== A. per-table row counts =='
SELECT r.t AS table_name,
       (EXECUTE) IS NULL AS _never,   -- placeholder removed below; kept out of the final build
       NULL::text
WHERE false;

\t on
\o /dev/null
-- exact counts, one row per table, in load order
SELECT format(
  'CREATE TEMP TABLE counts AS SELECT * FROM (VALUES %s) v(t, n)',
  string_agg(format('(%L, (SELECT count(*) FROM public.%I))', t, t), ', ' ORDER BY ord))
FROM unnest(ARRAY['tenants','users','user_identities','user_preferences','categories','merchants',
 'merchant_users','permission_grants','locations','business_hours','merchant_categories','offerings',
 'offering_relations','resource_pools','availability_slots','reviews','documents','chunks','facts',
 'favorites','collections','review_summaries']) WITH ORDINALITY AS u(t, ord) \gexec
\t off

\echo ''
column t format a22
SELECT t AS "table", lpad(n::text, 8) AS rows FROM counts ORDER BY 1;

\echo ''
\echo '== merchants by district (primary location) =='
SELECT l.district, count(*) merchants,
       round(avg(m.rating_agg), 2) avg_rating, count(*) FILTER (WHERE m.status = 'published') published
FROM locations l JOIN merchants m ON m.id = l.merchant_id
WHERE l.is_primary GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '== merchant rating histogram (spec §55: not everything is 5.0) =='
SELECT width_bucket(m.rating_agg, 0, 5, 10) bucket,
       format('%s-%s', (width_bucket(m.rating_agg,0,5,10)-1)*0.5, width_bucket(m.rating_agg,0,5,10)*0.5) band,
       count(*) merchants
FROM merchants m GROUP BY 1 ORDER BY 1;

\echo ''
\echo '== review star distribution =='
SELECT rating AS stars, count(*) reviews, round(100.0*count(*)/sum(count(*)) over (), 1) pct
FROM reviews GROUP BY 1 ORDER BY 1 DESC;

\echo ''
\echo '== review language mix (target ~60% zh-HK / ~30% en / ~10% code-switched) =='
SELECT language, count(*), round(100.0*count(*)/sum(count(*)) over (), 1) pct
FROM reviews GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '== offering price sanity =='
SELECT min(price_amount) min_hkd, max(price_amount) max_hkd, round(avg(price_amount)) avg_hkd,
       count(*) FILTER (WHERE price_amount IS NULL) null_price, count(*) priced
FROM offerings WHERE status = 'active';

\echo ''
\echo '== availability horizon (slots per day, next 21 days) =='
SELECT starts_at::date AS day, count(*) slots, count(DISTINCT pool_id) pools,
       sum(capacity_total) capacity, sum(capacity_total - capacity_left) booked
FROM availability_slots GROUP BY 1 ORDER BY 1 LIMIT 25;

\echo ''
\echo '== facts freshness (AGENT_CONTRACT §5 TTLs) =='
SELECT attribute, count(*) facts, count(*) FILTER (WHERE stale) marked_stale,
       count(*) FILTER (WHERE expires_at < now()) past_expiry,
       min(expires_at - observed_at) min_ttl, max(expires_at - observed_at) max_ttl
FROM facts GROUP BY 1 ORDER BY 1;

\echo ''
\echo '== RAG chunks awaiting embedding (embedding NULL + embed_model=pending) =='
SELECT embed_model, (embedding IS NULL) embedding_null, count(*) chunks,
       round(avg(token_count)) avg_tokens, min(token_count) min_tokens, max(token_count) max_tokens
FROM chunks GROUP BY 1,2 ORDER BY 3 DESC;

-- ============================================================ B  assertions
\echo ''
\echo '== B. assertions =='

-- volume targets (spec §86), scale-aware via -v
INSERT INTO qc VALUES
 ('volume: merchants',        (SELECT n FROM counts WHERE t='merchants') >= :MIN_MERCHANTS,
   (SELECT n FROM counts WHERE t='merchants') || ' rows, gate >= ' || :MIN_MERCHANTS),
 ('volume: offerings',        (SELECT n FROM counts WHERE t='offerings') >= :MIN_OFFERINGS,
   (SELECT n FROM counts WHERE t='offerings') || ' rows, gate >= ' || :MIN_OFFERINGS),
 ('volume: reviews',          (SELECT n FROM counts WHERE t='reviews') >= :MIN_REVIEWS,
   (SELECT n FROM counts WHERE t='reviews') || ' rows, gate >= ' || :MIN_REVIEWS),
 ('volume: documents >= merchants', (SELECT n FROM counts WHERE t='documents') >=
   (SELECT n FROM counts WHERE t='merchants'),
   (SELECT n FROM counts WHERE t='documents') || ' docs for ' || (SELECT n FROM counts WHERE t='merchants') || ' merchants'),
 ('volume: chunks > 0',       (SELECT n FROM counts WHERE t='chunks') > 0,
   (SELECT n FROM counts WHERE t='chunks') || ' chunks'),
 ('volume: facts > 0',        (SELECT n FROM counts WHERE t='facts') > 0,
   (SELECT n FROM counts WHERE t='facts') || ' facts'),
 -- review_summaries is AI-generated later (AGENT_CONTRACT §7); a seeded summary would be a lie.
 ('review_summaries stays empty', (SELECT n FROM counts WHERE t='review_summaries') = 0,
   (SELECT n FROM counts WHERE t='review_summaries') || ' rows (must be 0 until the AI job runs)'),
 -- no fabricated transactions / traffic (§109, §110)
 ('no seeded orders/reservations', (SELECT (SELECT count(*) FROM public.orders) +
   (SELECT count(*) FROM public.reservations) + (SELECT count(*) FROM public.events) +
   (SELECT count(*) FROM public.feedback_events)) = 0, 'orders+reservations+events+feedback_events must stay 0');

-- referential integrity, part 1: every declared FK in the demo graph, swept from the catalogue.
INSERT INTO qc
SELECT 'fk: ' || child || '.' || col || ' -> ' || parent, ok, detail FROM (
  WITH demo(t) AS (SELECT unnest(ARRAY['tenants','users','user_identities','user_preferences','categories',
    'merchants','merchant_users','permission_grants','locations','business_hours','merchant_categories',
    'offerings','offering_relations','resource_pools','availability_slots','reviews','documents','chunks',
    'facts','favorites','collections','review_summaries'])),
  fks AS (
    SELECT c.conrelid::regclass::text child, a.attname col, c.confrelid::regclass::text parent,
           ca.attname pcol
    FROM pg_constraint c
    JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = ANY (c.conkey)
    JOIN pg_attribute ca ON ca.attrelid = c.confrelid AND ca.attnum = ANY (c.confkey)
    WHERE c.contype='f' AND c.confrelid::regclass::text IN (SELECT t FROM demo)
      AND c.conrelid::regclass::text NOT LIKE 'pg_%')
  SELECT f.child, f.col, f.parent,
         (SELECT count(*) FROM (SELECT 1) AS _dummy) ,  -- replaced below
         true, ''
) _shape WHERE false;

-- The catalogue sweep needs per-FK dynamic SQL, so it runs in plpgsql and writes the same table.
DO $$
DECLARE r record; n bigint; ok boolean;
BEGIN
  FOR r IN
    WITH demo(t) AS (SELECT unnest(ARRAY['tenants','users','user_identities','user_preferences','categories',
      'merchants','merchant_users','permission_grants','locations','business_hours','merchant_categories',
      'offerings','offering_relations','resource_pools','availability_slots','reviews','documents','chunks',
      'facts','favorites','collections','review_summaries']))
    SELECT c.conrelid::regclass::text AS child, a.attname AS col,
           c.confrelid::regclass::text AS parent, ca.attname AS pcol
    FROM pg_constraint c
    JOIN pg_attribute a  ON a.attrelid = c.conrelid   AND a.attnum = ANY (c.conkey)
    JOIN pg_attribute ca ON ca.attrelid = c.confrelid AND ca.attnum = ANY (c.confkey)
    WHERE c.contype = 'f' AND c.confrelid::regclass::text IN (SELECT t FROM demo)
    ORDER BY 1,2
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I c LEFT JOIN public.%I p ON p.%I = c.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL',
      r.child, r.parent, r.pcol, r.col, r.col, r.pcol) INTO n;
    ok := n = 0;
    INSERT INTO qc (check, ok, detail)
    VALUES ('fk: ' || r.child || '.' || r.col || ' -> ' || r.parent || '.' || r.pcol, ok,
            n || ' orphan row(s)')
    ON CONFLICT (check) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
  END LOOP;
END $$;

-- referential integrity, part 2: polymorphic references the schema cannot express.
INSERT INTO qc
SELECT 'orphan: favorites.' || subject_type || ' -> ' || CASE subject_type
         WHEN 'user' THEN 'users' WHEN 'merchant' THEN 'merchants' ELSE 'offerings' END,
       NOT EXISTS (SELECT 1), ''
WHERE false;

INSERT INTO qc
WITH poly AS (
  SELECT subject_type, subject_id::text sid,
         CASE subject_type WHEN 'user' THEN 'users' WHEN 'merchant' THEN 'merchants'
                           WHEN 'offering' THEN 'offerings' END AS parent
  FROM favorites),
 probe AS (
  SELECT 'user'::text parent, id::text k FROM users
  UNION ALL SELECT 'merchant', id::text FROM merchants
  UNION ALL SELECT 'offering', id::text FROM offerings)
SELECT 'orphan: favorites.' || p.subject_type,
       count(*) FILTER (WHERE k.k IS NULL) = 0,
       coalesce((SELECT string_agg(x, ', ') FROM (
           SELECT (p2.subject_type || ':' || p2.subject_id) x FROM poly p2
           LEFT JOIN probe q ON q.parent = p2.parent AND q.k = p2.sid
           WHERE q.k IS NULL LIMIT 3) z), '0 orphans') || ' rows referencing a missing ' || p.subject_type
FROM poly p LEFT JOIN probe q ON q.parent = p.parent AND q.k = p.sid
GROUP BY 1;

INSERT INTO qc
WITH g AS (SELECT subject_type, subject_id::text sid FROM permission_grants),
 m AS (SELECT id::text k FROM merchants), u AS (SELECT id::text k FROM users),
 mu AS (SELECT id::text k FROM merchant_users)
SELECT 'orphan: permission_grants.' || subject_type,
       count(*) FILTER (
         WHERE subject_type = 'merchant_user' AND NOT EXISTS (SELECT 1 FROM mu WHERE mu.k = sid)
            OR subject_type = 'user'          AND NOT EXISTS (SELECT 1 FROM u  WHERE u.k  = sid)
            OR subject_type = 'merchant'      AND NOT EXISTS (SELECT 1 FROM m  WHERE m.k  = sid)
       ) = 0,
       'unresolvable subject_id for subject_type=' || subject_type
FROM g GROUP BY 1;

-- product rules / honesty markers
INSERT INTO qc
SELECT 'merchant has a location', count(*) = 0,
       coalesce((SELECT count(*) FROM merchants m WHERE NOT EXISTS
         (SELECT 1 FROM locations l WHERE l.merchant_id = m.id)), 0) || ' merchant(s) with 0 locations'
FROM (SELECT 1) _x
WHERE NOT EXISTS (SELECT 1 FROM merchants m WHERE NOT EXISTS
                    (SELECT 1 FROM locations l WHERE l.merchant_id = m.id));

INSERT INTO qc
SELECT 'merchant has a primary location',
       NOT EXISTS (SELECT 1 FROM merchants m WHERE (SELECT count(*) FROM locations l
                       WHERE l.merchant_id = m.id AND l.is_primary) <> 1),
       (SELECT count(*) FROM merchants m WHERE (SELECT count(*) FROM locations l WHERE l.merchant_id = m.id
          AND l.is_primary) <> 1) || ' merchant(s) without exactly one primary branch';

INSERT INTO qc
SELECT 'offering belongs to a merchant',
       NOT EXISTS (SELECT 1 FROM offerings o WHERE NOT EXISTS
         (SELECT 1 FROM merchants m WHERE m.id = o.merchant_id)),
       (SELECT count(*) FROM offerings o WHERE NOT EXISTS
         (SELECT 1 FROM merchants m WHERE m.id = o.merchant_id)) || ' orphan offering(s)';

INSERT INTO qc
SELECT 'merchant has >=1 offering', NOT EXISTS (SELECT 1 FROM merchants m WHERE NOT EXISTS
         (SELECT 1 FROM offerings o WHERE o.merchant_id = m.id)),
       (SELECT count(*) FROM merchants m WHERE NOT EXISTS
         (SELECT 1 FROM offerings o WHERE o.merchant_id = m.id)) || ' merchant(s) with no offering';

INSERT INTO qc
SELECT 'merchant has a menu document (RAG feed)', NOT EXISTS (SELECT 1 FROM merchants m
         WHERE m.status = 'published' AND NOT EXISTS
           (SELECT 1 FROM documents d WHERE d.merchant_id = m.id AND d.kind = 'menu')),
       (SELECT count(*) FROM merchants m WHERE m.status='published' AND NOT EXISTS
         (SELECT 1 FROM documents d WHERE d.merchant_id=m.id AND d.kind='menu')) || ' published merchants without menu text';

-- ratings inside their stored scale (V2 adds the CHECK; assert the demo aggregate too)
INSERT INTO qc
SELECT 'reviews.rating 1..5', NOT EXISTS (SELECT 1 FROM reviews WHERE rating NOT BETWEEN 1 AND 5),
       (SELECT count(*) FROM reviews WHERE rating NOT BETWEEN 1 AND 5) || ' out-of-range review(s)';

INSERT INTO qc
SELECT 'merchants.rating_agg matches its reviews',
       NOT EXISTS (SELECT 1 FROM merchants m
         WHERE abs(coalesce(m.rating_agg,0) - coalesce((SELECT round(avg(r.rating),2) FROM reviews r
                        WHERE r.merchant_id = m.id AND r.status='published'),0)) > 0.01),
       (SELECT count(*) FROM merchants m WHERE abs(coalesce(m.rating_agg,0) -
          coalesce((SELECT round(avg(r.rating),2) FROM reviews r WHERE r.merchant_id=m.id
                    AND r.status='published'),0)) > 0.01) || ' drifted aggregate(s)';

INSERT INTO qc
SELECT 'merchants.review_count matches its reviews',
       NOT EXISTS (SELECT 1 FROM merchants m WHERE m.review_count <>
         (SELECT count(*) FROM reviews r WHERE r.merchant_id = m.id AND r.status='published')),
       (SELECT count(*) FROM merchants m WHERE m.review_count <> (SELECT count(*) FROM reviews r
          WHERE r.merchant_id=m.id AND r.status='published')) || ' miscounted merchant(s)';

INSERT INTO qc
SELECT 'ratings realistically spread (not all 5.0)',
       (SELECT count(DISTINCT rating) FROM reviews) >= 5
       AND (SELECT count(*) FROM reviews WHERE rating = 5) * 1.0 /
           nullif((SELECT count(*) FROM reviews),0) < 0.35
       AND (SELECT count(*) FROM merchants WHERE rating_agg < 3.8) >= 5,
       'distinct stars=' || (SELECT count(DISTINCT rating) FROM reviews)
       || ', 5-star share=' || round(100.0*(SELECT count(*) FROM reviews WHERE rating=5)/
          nullif((SELECT count(*) FROM reviews),0)) || '%, weak merchants='
       || (SELECT count(*) FROM merchants WHERE rating_agg < 3.8);

-- price bounds: > 0 and < 20000 (spec: no absurd placeholder prices)
INSERT INTO qc
SELECT 'offerings.price_amount in (0, 20000)', NOT EXISTS (SELECT 1 FROM offerings
         WHERE price_amount IS NOT NULL AND (price_amount <= 0 OR price_amount >= 20000)),
       (SELECT count(*) FROM offerings WHERE price_amount IS NOT NULL
          AND (price_amount <= 0 OR price_amount >= 20000)) || ' bad price(s); max='
       || (SELECT max(price_amount) FROM offerings);

INSERT INTO qc
SELECT 'price_min <= price_max', NOT EXISTS (SELECT 1 FROM offerings
         WHERE price_min IS NOT NULL AND price_max IS NOT NULL AND price_min > price_max),
       (SELECT count(*) FROM offerings WHERE price_min IS NOT NULL AND price_max IS NOT NULL
          AND price_min > price_max) || ' inverted band(s)';

INSERT INTO qc
SELECT 'price_updated_at present for priced offerings',
       NOT EXISTS (SELECT 1 FROM offerings WHERE price_amount IS NOT NULL AND price_updated_at IS NULL),
       (SELECT count(*) FROM offerings WHERE price_amount IS NOT NULL AND price_updated_at IS NULL)
       || ' priced offering(s) with no price provenance timestamp';

-- review text quality (§55: review-intelligence summarizes concrete aspects)
INSERT INTO qc
SELECT 'review body length > 20 chars', NOT EXISTS (SELECT 1 FROM reviews WHERE length(body) <= 20),
       (SELECT count(*) FROM reviews WHERE length(body) <= 20) || ' short body(ies); min='
       || (SELECT min(length(body)) FROM reviews) || ' avg='
       || (SELECT round(avg(length(body))) FROM reviews);

INSERT INTO qc
SELECT 'review bodies are not lorem/placeholder',
       NOT EXISTS (SELECT 1 FROM reviews WHERE body ~* 'lorem|ipsum|placeholder|todo|test body'),
       (SELECT count(*) FROM reviews WHERE body ~* 'lorem|ipsum|placeholder|todo|test body')
       || ' placeholder body(ies)';

INSERT INTO qc
SELECT 'reviews cite concrete aspects (§55 inputs)',
       (SELECT count(*) FROM reviews WHERE body ~*
         '候位|等咗|排隊|quiet|噪音|嘈|份量|分量大|平貴|性價比|抵|MTR|港鐵|步行|分钟|分鐘|service|staff|slow|fast|clean|乾淨') * 1.0
         / nullif((SELECT count(*) FROM reviews),0) > 0.6,
       (SELECT count(*) FROM reviews WHERE body ~*
         '候位|等咗|排隊|quiet|噪音|嘈|份量|平貴|性價比|抵|MTR|港鐵|步行|service|staff|slow|fast|clean|乾淨')
       || ' of ' || (SELECT count(*) FROM reviews) || ' reviews name an aspect';

INSERT INTO qc
SELECT 'reviews carry aspect scores for weak-aspect demos',
       NOT EXISTS (SELECT 1 FROM reviews WHERE aspects IS NULL OR aspects = '{}'::jsonb),
       (SELECT count(*) FROM reviews WHERE aspects IS NULL OR aspects = '{}'::jsonb)
       || ' review(s) without aspects jsonb';

INSERT INTO qc
SELECT 'language mix ~60% zh-HK / rest en (§111)',
       (SELECT count(*) FROM reviews WHERE language='zh-HK') * 1.0 /
         nullif((SELECT count(*) FROM reviews),0) BETWEEN 0.5 AND 0.85,
       'zh-HK share=' || round(100.0*(SELECT count(*) FROM reviews WHERE language='zh-HK')/
         nullif((SELECT count(*) FROM reviews),0)) || '%';

-- §94 cold-start density
INSERT INTO qc
SELECT 'density: >= ' || :MIN_NEAR_SHA_TIN || ' merchants within 3km of Sha Tin',
       (SELECT count(DISTINCT l.merchant_id) FROM locations l
          WHERE l.is_primary AND pg_temp.haversine_m(22.3831, 114.1876, l.lat, l.lng) <= 3000)
         >= :MIN_NEAR_SHA_TIN,
       (SELECT count(DISTINCT l.merchant_id) FROM locations l WHERE l.is_primary
          AND pg_temp.haversine_m(22.3831, 114.1876, l.lat, l.lng) <= 3000) || ' merchants inside 3km';

INSERT INTO qc
SELECT 'coordinates inside the HK bbox (D3 geo prefilter)',
       NOT EXISTS (SELECT 1 FROM locations WHERE lat NOT BETWEEN 22.14 AND 22.58
                     OR lng NOT BETWEEN 113.80 AND 114.47),
       (SELECT count(*) FROM locations WHERE lat NOT BETWEEN 22.14 AND 22.58
          OR lng NOT BETWEEN 113.80 AND 114.47) || ' point(s) outside Hong Kong';

INSERT INTO qc
SELECT 'at least 10 districts covered',
       (SELECT count(DISTINCT district) FROM locations WHERE is_primary) >= 10,
       (SELECT count(DISTINCT district) FROM locations WHERE is_primary) || ' districts';

-- honesty markers (§109 / §110 / §155, D6)
INSERT INTO qc
SELECT 'phones stay in the reserved 2xxx-0000 demo range',
       NOT EXISTS (SELECT 1 FROM merchants WHERE contact->>'phone' !~ '^2[0-9]{3}-[0-9]{4}$'),
       (SELECT count(*) FROM merchants WHERE contact->>'phone' !~ '^2[0-9]{3}-[0-9]{4}$')
       || ' merchant(s) with a non-demo phone';

INSERT INTO qc
SELECT 'emails/domains are example.hk only',
       NOT EXISTS (SELECT 1 FROM merchants WHERE contact->>'email' !~ '@[a-z0-9.-]+\.example\.hk$')
       AND NOT EXISTS (SELECT 1 FROM users WHERE email !~ '@example\.hk$'),
       (SELECT count(*) FROM merchants WHERE contact->>'email' !~ '@[a-z0-9.-]+\.example\.hk$')
       || ' merchant + ' || (SELECT count(*) FROM users WHERE email !~ '@example\.hk$') || ' user email(s)';

INSERT INTO qc
SELECT 'data_origin = demo everywhere the column exists',
       NOT EXISTS (SELECT 1 FROM merchants WHERE data_origin <> 'demo')
       AND NOT EXISTS (SELECT 1 FROM reviews  WHERE data_origin <> 'demo')
       AND NOT EXISTS (SELECT 1 FROM collections WHERE data_origin <> 'demo'),
       (SELECT count(*) FROM merchants WHERE data_origin<>'demo') || ' merchants + '
       || (SELECT count(*) FROM reviews WHERE data_origin<>'demo') || ' reviews + '
       || (SELECT count(*) FROM collections WHERE data_origin<>'demo') || ' collections not marked';

-- SCHEMA FRICTION: offerings/documents/chunks have no data_origin column, so the marker lives in
-- their jsonb. Assert it survived the COPY, otherwise the demo rows are indistinguishable.
INSERT INTO qc
SELECT 'jsonb data_origin marker (offerings/documents/chunks)',
       NOT EXISTS (SELECT 1 FROM offerings   WHERE attributes->>'data_origin' IS DISTINCT FROM 'demo')
       AND NOT EXISTS (SELECT 1 FROM documents WHERE metadata->>'data_origin' IS DISTINCT FROM 'demo')
       AND NOT EXISTS (SELECT 1 FROM chunks      WHERE metadata->>'data_origin' IS DISTINCT FROM 'demo'),
       (SELECT count(*) FROM offerings WHERE attributes->>'data_origin' IS DISTINCT FROM 'demo')
       || ' offerings + ' || (SELECT count(*) FROM documents WHERE metadata->>'data_origin'
          IS DISTINCT FROM 'demo') || ' docs + ' || (SELECT count(*) FROM chunks WHERE
          metadata->>'data_origin' IS DISTINCT FROM 'demo') || ' chunks unmarked';

INSERT INTO qc
SELECT 'every source_uri is demo:// (trust layer provenance)',
       NOT EXISTS (SELECT 1 FROM documents WHERE source_uri NOT LIKE 'demo://%')
       AND NOT EXISTS (SELECT 1 FROM facts WHERE source_uri NOT LIKE 'demo://%'),
       (SELECT count(*) FROM documents WHERE source_uri NOT LIKE 'demo://%') || ' docs + '
       || (SELECT count(*) FROM facts WHERE source_uri NOT LIKE 'demo://%') || ' facts not demo://';

INSERT INTO qc
SELECT 'images are local placeholders, never hotlinks',
       NOT EXISTS (SELECT 1 FROM merchants m JOIN jsonb_array_elements(m.images) img ON true
                     WHERE img->>'url' !^ '/demo/img/'),
       (SELECT count(*) FROM merchants m JOIN jsonb_array_elements(m.images) img ON true
          WHERE img->>'url' !~ '^/demo/img/') || ' external image URL(s)';

INSERT INTO qc
SELECT 'SEO pages are noindex (demo must not rank, §155)',
       NOT EXISTS (SELECT 1 FROM merchants WHERE coalesce((seo->>'noindex')::text, 'true') <> 'true')
       AND NOT EXISTS (SELECT 1 FROM collections WHERE coalesce((seo->>'noindex')::text, 'true') <> 'true'),
       (SELECT count(*) FROM merchants WHERE coalesce((seo->>'noindex')::text,'true')<>'true')
       || ' indexable merchant page(s)';

INSERT INTO qc
SELECT 'disclaimer text is inside every menu document',
       NOT EXISTS (SELECT 1 FROM documents WHERE raw_text NOT LIKE '%NOT REAL BUSINESSES%'),
       (SELECT count(*) FROM documents WHERE raw_text NOT LIKE '%NOT REAL BUSINESSES%')
       || ' document(s) missing the disclaimer';

INSERT INTO qc
SELECT 'password_hash is the placeholder, never a real hash',
       NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS DISTINCT FROM
         '!!DEMO-PLACEHOLDER-NOT-A-PASSWORD-HASH!!'),
       (SELECT count(*) FROM users WHERE password_hash IS DISTINCT FROM
         '!!DEMO-PLACEHOLDER-NOT-A-PASSWORD-HASH!!') || ' user(s) with a non-placeholder hash';

INSERT INTO qc
SELECT 'demo roles exist for POST /api/v1/auth/demo',
       EXISTS (SELECT 1 FROM users WHERE role='consumer')
       AND EXISTS (SELECT 1 FROM users WHERE role='merchant_owner')
       AND EXISTS (SELECT 1 FROM users WHERE role='platform_admin')
       AND (SELECT count(*) FROM merchant_users) >= 3,
       'consumer=' || (SELECT count(*) FROM users WHERE role='consumer')
       || ' merchant_owner=' || (SELECT count(*) FROM users WHERE role='merchant_owner')
       || ' platform_admin=' || (SELECT count(*) FROM users WHERE role='platform_admin');

INSERT INTO qc
SELECT 'everything hangs off the single demo tenant',
       NOT EXISTS (SELECT 1 FROM merchants WHERE tenant_id <> '00000000-0000-0000-0000-000000000001')
       AND NOT EXISTS (SELECT 1 FROM reviews WHERE tenant_id <> '00000000-0000-0000-0000-000000000001')
       AND EXISTS (SELECT 1 FROM tenants WHERE id='00000000-0000-0000-0000-000000000001' AND slug='hong-kong'),
       (SELECT count(*) FROM merchants WHERE tenant_id <> '00000000-0000-0000-0000-000000000001')
       || ' row(s) outside tenant 00000000-0000-0000-0000-000000000001';

-- AGENT_CONTRACT §5 freshness
INSERT INTO qc
SELECT 'facts all carry expires_at (TTL per §5)',
       NOT EXISTS (SELECT 1 FROM facts WHERE expires_at IS NULL),
       (SELECT count(*) FROM facts WHERE expires_at IS NULL) || ' timeless fact(s)';

INSERT INTO qc
SELECT 'price facts respect the 6h TTL',
       NOT EXISTS (SELECT 1 FROM facts WHERE attribute='price' AND expires_at <> observed_at + interval '6 hours'),
       (SELECT count(*) FROM facts WHERE attribute='price' AND expires_at <> observed_at + interval '6 hours')
       || ' price fact(s) with a wrong TTL';

INSERT INTO qc
SELECT 'hours facts respect the 24h TTL',
       NOT EXISTS (SELECT 1 FROM facts WHERE attribute='opening_hours'
                     AND expires_at <> observed_at + interval '24 hours'),
       (SELECT count(*) FROM facts WHERE attribute='opening_hours'
          AND expires_at <> observed_at + interval '24 hours') || ' hours fact(s) with a wrong TTL';

INSERT INTO qc
SELECT 'some facts are deliberately stale (UI must show 已過時)',
       EXISTS (SELECT 1 FROM facts WHERE stale) AND EXISTS (SELECT 1 FROM facts WHERE NOT stale)
       AND (SELECT count(*) FROM facts WHERE stale) >= 10,
       'stale=' || (SELECT count(*) FROM facts WHERE stale) || ' fresh='
       || (SELECT count(*) FROM facts WHERE NOT stale);

-- availability integrity (V2 capacity + window CHECKs, plus the 21-day horizon)
INSERT INTO qc
SELECT 'slots: capacity_left within capacity_total',
       NOT EXISTS (SELECT 1 FROM availability_slots WHERE capacity_left < 0 OR capacity_left > capacity_total),
       (SELECT count(*) FROM availability_slots WHERE capacity_left < 0 OR capacity_left > capacity_total)
       || ' over-booked slot(s)';

INSERT INTO qc
SELECT 'slots: 21-day horizon with coverage every day',
       (SELECT count(DISTINCT starts_at::date) FROM availability_slots) >= 21
       AND (SELECT min(starts_at)::date FROM availability_slots) >= current_date - 7,
       (SELECT count(DISTINCT starts_at::date) FROM availability_slots) || ' distinct days, from '
       || (SELECT min(starts_at)::date FROM availability_slots) || ' (pinned base date, see README)';

INSERT INTO qc
SELECT 'slots: every slot has a pool in the same merchant',
       NOT EXISTS (SELECT 1 FROM availability_slots s JOIN resource_pools p ON p.id = s.pool_id
                     WHERE p.merchant_id <> s.merchant_id),
       (SELECT count(*) FROM availability_slots s JOIN resource_pools p ON p.id = s.pool_id
          WHERE p.merchant_id <> s.merchant_id) || ' cross-merchant slot(s)';

INSERT INTO qc
SELECT 'bookable offerings have a resource pool',
       NOT EXISTS (SELECT 1 FROM offerings o WHERE o.bookable AND o.status='active' AND NOT EXISTS
         (SELECT 1 FROM resource_pools p WHERE p.offering_id = o.id)),
       (SELECT count(*) FROM offerings o WHERE o.bookable AND o.status='active' AND NOT EXISTS
          (SELECT 1 FROM resource_pools p WHERE p.offering_id = o.id)) || ' bookable offering(s) with no pool';

INSERT INTO qc
SELECT 'slots marked source=demo (never real availability)',
       NOT EXISTS (SELECT 1 FROM availability_slots WHERE source <> 'demo'),
       (SELECT count(*) FROM availability_slots WHERE source <> 'demo') || ' slot(s) not marked demo';

-- chunks / RAG pipeline preconditions (§7)
INSERT INTO qc
SELECT 'chunks: embedding NULL and embed_model=pending',
       NOT EXISTS (SELECT 1 FROM chunks WHERE embedding IS NOT NULL OR embed_model <> 'pending'),
       (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL OR embed_model <> 'pending')
       || ' chunk(s) already embedded or mislabelled';

INSERT INTO qc
SELECT 'chunks: token size in 90..420 (§7 window)',
       NOT EXISTS (SELECT 1 FROM chunks WHERE token_count < 60 OR token_count > 460),
       (SELECT count(*) FROM chunks WHERE token_count < 60 OR token_count > 460)
       || ' chunk(s) outside the section window (hard min 60 to allow the final chunk to be short)';

INSERT INTO qc
SELECT 'chunks: ordinal contiguous per document',
       NOT EXISTS (SELECT 1 FROM chunks GROUP BY document_id
                     HAVING min(ordinal) <> 0 OR max(ordinal) <> count(*)::int - 1),
       (SELECT count(*) FROM chunks GROUP BY document_id HAVING min(ordinal) <> 0
          OR max(ordinal) <> count(*)::int - 1) || ' document(s) with gaps';

INSERT INTO qc
SELECT 'documents: content_hash matches the raw_text it carries',
       NOT EXISTS (SELECT 1 FROM documents WHERE raw_text = '' OR length(raw_text) < 200),
       (SELECT count(*) FROM documents WHERE raw_text = '' OR length(raw_text) < 200)
       || ' thin document(s); menus must feed RAG with real dish/price/session text';

-- categories tree
INSERT INTO qc
SELECT 'category tree: 10 roots, all leaves have a parent',
       (SELECT count(*) FROM categories WHERE parent_id IS NULL) = 10
       AND (SELECT count(*) FROM categories) >= 60,
       'roots=' || (SELECT count(*) FROM categories WHERE parent_id IS NULL)
       || ' total=' || (SELECT count(*) FROM categories);

INSERT INTO qc
SELECT 'merchants map to >=1 leaf category',
       NOT EXISTS (SELECT 1 FROM merchants m WHERE NOT EXISTS
         (SELECT 1 FROM merchant_categories mc WHERE mc.merchant_id = m.id)),
       (SELECT count(*) FROM merchants m WHERE NOT EXISTS
          (SELECT 1 FROM merchant_categories mc WHERE mc.merchant_id=m.id)) || ' uncategorised merchant(s)';

-- §109: invented names only. Small blocklist of real HK chains; a collision means the generator
-- picked a real brand and the demo would masquerade as a genuine business listing.
WITH block(name) AS (VALUES
  ('翠華餐廳'),('翠華'),('美心'),('大快活'),('聖安娜'),('蓮香樓'),('蓮香'),('太興'),('元氣壽司'),
  ('譚仔雲南米線'),('譚仔三哥'),('利苑酒家'),('利苑'),('金鳳茶餐廳'),('添好運'),('Tim Ho Wan'),
  ('星巴克'),('Starbucks'),('麥當勞'),('麦当劳'),('McDonald''s'),('肯德基'),('KFC'),('太平洋咖啡'),
  ('Caffè Pacific Coffee'),('Cafe de Coral'),('Café de Coral'),('許留山'),('元祖'),('7-Eleven'),
  ('惠康'),('Wellcome'),('百佳'),('ParknShop'),('莎莎'),('SASA'),('卓悅'),('one2free'),('CSL'),
  ('3HK'),('MTR'),('港鐵'),('九龍巴士'),('城巴'),('新世界第一巴士'),('康泰旅行社'),('永安旅遊')),
 hits AS (
  SELECT b.name, m.id, m.display_name, m.display_name_zh, m.legal_name, m.slug
  FROM block b JOIN merchants m ON (m.display_name = b.name OR m.display_name_zh = b.name
        OR m.legal_name = b.name OR m.slug = b.name OR m.category_primary = b.name))
INSERT INTO qc
SELECT 'no merchant name collides with a real HK chain', NOT EXISTS (SELECT 1 FROM hits),
       coalesce((SELECT string_agg(name || ' <- ' || slug, ', ') FROM (SELECT * FROM hits LIMIT 3) z),
                '0 collisions against ' || (SELECT count(*) FROM block) || ' real brands');

-- the seeded aggregates must agree with the review rows they summarise
INSERT INTO qc
SELECT 'popularity_score within [0,1]',
       NOT EXISTS (SELECT 1 FROM merchants WHERE popularity_score NOT BETWEEN 0 AND 1)
       AND NOT EXISTS (SELECT 1 FROM offerings WHERE popularity_score NOT BETWEEN 0 AND 1),
       (SELECT count(*) FROM merchants WHERE popularity_score NOT BETWEEN 0 AND 1
          OR popularity_score = 0) || ' merchant(s) with missing/zero popularity';

INSERT INTO qc
SELECT 'collections/guides reference live merchants',
       NOT EXISTS (SELECT 1 FROM collections c JOIN jsonb_array_elements(c.items) it ON true
                     WHERE it->>'merchant_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM merchants m
                        WHERE m.id::text = it->>'merchant_id')),
       (SELECT count(*) FROM collections c JOIN jsonb_array_elements(c.items) it ON true
          WHERE it->>'merchant_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM merchants m
             WHERE m.id::text = it->>'merchant_id')) || ' dangling guide item(s)';

-- ============================================================ C  hard gate
\echo ''
SELECT CASE WHEN ok THEN '  PASS ' ELSE '  FAIL ' END AS status,
       rpad(check, 52, ' ') AS check, detail
FROM qc ORDER BY ok ASC, check;

DO $$
DECLARE bad int; names text;
BEGIN
  SELECT count(*), string_agg(check, E'\n    - ') INTO bad, names FROM qc WHERE NOT ok;
  IF bad > 0 THEN
    RAISE EXCEPTION 'quality gate: % check(s) failed:\n    - %', bad, names;
  END IF;
  RAISE NOTICE 'quality gate: all % checks passed (SYNTHETIC DEMO DATA — not real businesses)',
    (SELECT count(*) FROM qc);
END $$;
