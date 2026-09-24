-- =============================================================================
-- SYNTHETIC DEMO DATA - NOT REAL BUSINESSES
-- data/seed/quality.sql — the gate for the seeded demo dataset.
--
-- Run after data/seed/load.sh:
--   docker exec -i nexus-platform-postgres psql -U postgres -d nexus -v ON_ERROR_STOP=1 < data/seed/quality.sql
--   # Read that line for what it is: this is a gate on the *artifact*, so the supported invocation is
--   # a database the seed just wrote (scripts/db_gate_fresh.sh does it end to end). Pointed at a
--   # database that has served traffic, most of part B is a diagnostic and the run is red — measured
--   # on the demo `nexus` DB on 2026-09-25: 8 checks failing, one of them this file's own
--   # "no traffic outside the seeded tables", naming agent_runs (40), audit_logs (53), events (35),
--   # referrals (1) and reservations (6). Correct verdicts for a DB that is the seed plus traffic;
--   # not a gate result. Use scripts/seed_truncate_probe.sh or db_gate_fresh.sh for the gate.
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
\if :{?MIN_MERCHANTS} \else \set MIN_MERCHANTS 500 \endif
\if :{?MIN_OFFERINGS} \else \set MIN_OFFERINGS 5000 \endif
\if :{?MIN_REVIEWS} \else \set MIN_REVIEWS 10000 \endif
\if :{?MIN_NEAR_SHA_TIN} \else \set MIN_NEAR_SHA_TIN 300 \endif

-- spec §94: dense geography around the Sha Tin centroid (22.3831, 114.1876). No PostGIS in this
-- project (docs/DECISIONS.md D3), so the 3 km test is a plain haversine written out in SQL.
CREATE OR REPLACE FUNCTION pg_temp.haversine_m(lat0 double precision, lng0 double precision,
                                              lat1 double precision, lng1 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  select 2 * 6371000 * asin(sqrt(
      pow(sin(radians(lat1 - lat0) / 2), 2)
    + cos(radians(lat0)) * cos(radians(lat1)) * pow(sin(radians(lng1 - lng0) / 2), 2)))
$$;

CREATE TEMP TABLE qc ("check" text PRIMARY KEY, ok boolean, detail text);

-- =========================================================== A  counts & shape
\echo ''
\echo '== A. per-table row counts =='
\t on
\o /dev/null
-- One answer to "which tables does the seed own?" (D64). Part A's counts, the FK sweep and the
-- traffic sweep in part B all ask that question, and until now each carried its own copy of the
-- list. Measured before this was written: part A and `generate.py`'s DEMO_TABLES agreed on 23 names,
-- part B's sweep had 22 and was silently missing `moderation_cases`, so every key *into* that table
-- went unchecked while the file claimed the demo graph was swept.
CREATE TEMP TABLE seed_anchor AS
  SELECT u.t, u.ord FROM unnest(ARRAY[
    'tenants','users','user_identities','user_preferences','categories','merchants',
    'merchant_users','permission_grants','locations','business_hours','merchant_categories','offerings',
    'offering_relations','resource_pools','availability_slots','reviews','moderation_cases','documents',
    'chunks','facts','favorites','collections','review_summaries']) WITH ORDINALITY AS u(t, ord);

-- exact counts, one row per table, in load order
SELECT format(
  'CREATE TEMP TABLE counts AS SELECT * FROM (VALUES %s) v(t, n)',
  string_agg(format('(%L, (SELECT count(*) FROM public.%I))', t, t), ', ' ORDER BY ord))
FROM seed_anchor \gexec
\o
\t off

\echo ''
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
   (SELECT n FROM counts WHERE t='review_summaries') || ' rows (must be 0 until the AI job runs)');
-- The §109/§110 "no fabricated traffic" claim used to be a row here naming four tables by hand
-- (orders, reservations, events, feedback_events). It is now the catalogue-driven pair in part B,
-- which reaches 29 tables on V1–V7 instead of four.

-- referential integrity: every declared FK in the demo graph, swept from the catalogue.
-- The sweep needs per-FK dynamic SQL, so it runs in plpgsql and writes the qc table.
DO $$
DECLARE r record; n bigint; ok boolean;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS child, a.attname AS col,
           c.confrelid::regclass::text AS parent, ca.attname AS pcol
    FROM pg_constraint c
    JOIN pg_attribute a  ON a.attrelid = c.conrelid   AND a.attnum = ANY (c.conkey)
    JOIN pg_attribute ca ON ca.attrelid = c.confrelid AND ca.attnum = ANY (c.confkey)
    WHERE c.contype = 'f' AND c.confrelid::regclass::text IN (SELECT t FROM seed_anchor)
    ORDER BY 1,2
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I c LEFT JOIN public.%I p ON p.%I = c.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL',
      r.child, r.parent, r.pcol, r.col, r.col, r.pcol) INTO n;
    ok := n = 0;
    INSERT INTO qc ("check", ok, detail)
    VALUES ('fk: ' || r.child || '.' || r.col || ' -> ' || r.parent || '.' || r.pcol, ok,
            n || ' orphan row(s)')
    ON CONFLICT ("check") DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
  END LOOP;
END $$;

-- §109/§110, written as a property of the schema rather than of a list. The claim is not "orders and
-- reservations happen to be empty" but "no table that refers to the seed's own tables holds a row the
-- seed did not write". The set is read from `pg_constraint` at run time — the same closure
-- `out/00_truncate.sql` uses (D63), so the loader and the gate ask the same question of the same
-- catalogue and neither can drift ahead of the other. Counting an arbitrary table needs dynamic SQL,
-- so this runs in plpgsql and leaves its arithmetic behind for the census row to read.
CREATE TEMP TABLE traffic_sweep (swept int, reached int, blockers text);
DO $$
DECLARE
  anchor    text[] := ARRAY(SELECT t FROM seed_anchor);
  closure   text[];
  tbl       text;
  rows_now  bigint;
  swept     int := 0;
  reached   int := 0;
  bad       text := '';
BEGIN
  WITH RECURSIVE closed(oid) AS (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY (anchor)
      UNION
        SELECT fk.conrelid FROM pg_constraint fk JOIN closed p ON fk.confrelid = p.oid
         WHERE fk.contype = 'f'
  )
  SELECT array_agg(c.relname ORDER BY c.relname) INTO closure
    FROM closed JOIN pg_class c ON c.oid = closed.oid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';

  IF closure IS NULL THEN
    INSERT INTO traffic_sweep VALUES (0, 0, 'the anchor names no table in this database');
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY closure LOOP
    reached := reached + 1;
    IF tbl = ANY (anchor) THEN
      CONTINUE;                     -- the seed wrote these; part A already counts them
    END IF;
    swept := swept + 1;
    EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO rows_now;
    IF rows_now > 0 THEN
      bad := bad || tbl || ' (' || rows_now || ' row(s)), ';
    END IF;
  END LOOP;
  INSERT INTO traffic_sweep VALUES (swept, reached, rtrim(bad, ', '));
END $$;

INSERT INTO qc
-- The census, and it runs before the verdict means anything: "all clear" and "looked at nothing" are
-- the same shape, so the sweep has to say how many tables it actually opened. Measured 29 on V1–V7;
-- the floor is two thirds of that, so a narrowed anchor or a dead closure arm goes red on the count.
SELECT 'traffic sweep reaches the whole closure, not a hand list', swept >= 20,
       swept || ' of ' || reached || ' closure table(s) lie outside the anchor and were counted '
       || '(the hand list this replaces named 4)'
FROM traffic_sweep;

INSERT INTO qc
SELECT 'no traffic outside the seeded tables', blockers = '' AND swept > 0,
       CASE WHEN swept = 0 THEN
              'the closure reaches nothing outside the anchor, so this row has no evidence either way '
              || '— that is a defect in the sweep, not a clean bill of health'
            WHEN blockers = '' THEN swept || ' referencing table(s) all empty'
            ELSE 'written elsewhere: ' || blockers
            || ' — this database is the seed plus traffic, so quality.sql is reading it as a '
            || 'diagnostic and not as a gate on the artifact'
       END
FROM traffic_sweep;

-- referential integrity, part 2: polymorphic references the schema cannot express. A subject_type
-- the probe does not know about is an orphan by definition, so an invented type cannot pass.
INSERT INTO qc
WITH probe AS (
  SELECT 'user'::text t, id::text k FROM users
  UNION ALL SELECT 'merchant', id::text FROM merchants
  UNION ALL SELECT 'offering', id::text FROM offerings
  UNION ALL SELECT 'collection', id::text FROM collections),
 g AS (
  SELECT f.subject_type t, (q.k IS NULL) bad
  FROM favorites f
  LEFT JOIN probe q ON q.t = f.subject_type AND q.k = f.subject_id::text)
SELECT 'orphan: favorites.' || t,
       count(*) FILTER (WHERE bad) = 0,
       count(*) FILTER (WHERE bad) || ' unresolvable of ' || count(*) || ' row(s)'
FROM g GROUP BY t;

INSERT INTO qc
WITH g AS (SELECT subject_type, subject_id::text sid, merchant_id FROM permission_grants),
 probe AS (
  -- `subject_id` names a row in whatever table `subject_type` spells — except for a workspace grant.
  -- AuthorizationInterceptor asks for `principal.subjectId()` and `principal.userId()`, and both of those
  -- are ids on `users`, so a grant keyed to a `merchant_users` row id is unreachable at runtime (D31).
  -- The probe joins the way the interceptor does: the person, plus an active membership at that merchant.
  SELECT 'merchant'::text parent, id::text k, NULL::uuid m FROM merchants
  UNION ALL SELECT 'user', id::text, NULL FROM users
  UNION ALL SELECT 'merchant_user', u.id::text, mu.merchant_id
    FROM merchant_users mu JOIN users u ON u.id = mu.user_id WHERE mu.status = 'active')
SELECT 'orphan: permission_grants.' || g.subject_type,
       count(*) FILTER (WHERE q.k IS NULL) = 0,
       count(*) FILTER (WHERE q.k IS NULL) || ' unresolvable subject_id of ' || count(*) || ' grant(s)'
FROM g LEFT JOIN probe q ON q.parent = g.subject_type AND q.k = g.sid
     AND (q.m IS NULL OR q.m = g.merchant_id)
GROUP BY g.subject_type;

-- facts is the third polymorphic table, and until now nobody had asked the general question of it.
-- Every existing fact check reads `JOIN merchants` or `JOIN offerings`, so a fact keyed to a
-- `location` — 684 of them in the demo dataset, `address` observations — could point at no row at all
-- and each of those checks would still have held. V1's comment declares the subject set as
-- `merchant|offering|location|review|policy`; the probe below resolves four of those, and the fifth is
-- reported rather than papered over: `policy` names no table in the schema, so a fact keyed to a
-- policy cannot resolve to anything and goes red as an orphan — which is the honest verdict, and a
-- coinage of that type is therefore a decision somebody has to make explicitly (generate.py's
-- `self.fact(...)` call sites emit merchant/location/offering only).
INSERT INTO qc
WITH probe AS (
  SELECT 'merchant'::text t, id::text k FROM merchants
  UNION ALL SELECT 'offering', id::text FROM offerings
  UNION ALL SELECT 'location', id::text FROM locations
  UNION ALL SELECT 'review', id::text FROM reviews),
 g AS (
  SELECT f.subject_type t, (q.k IS NULL) bad
  FROM facts f
  LEFT JOIN probe q ON q.t = f.subject_type AND q.k = f.subject_id::text)
SELECT 'orphan: facts.' || t,
       count(*) FILTER (WHERE bad) = 0,
       count(*) FILTER (WHERE bad) || ' unresolvable of ' || count(*) || ' fact(s)'
FROM g GROUP BY t;

-- product rules / honesty markers
INSERT INTO qc
SELECT 'merchant has a location',
       NOT EXISTS (SELECT 1 FROM merchants m WHERE NOT EXISTS
         (SELECT 1 FROM locations l WHERE l.merchant_id = m.id)),
       (SELECT count(*) FROM merchants m WHERE NOT EXISTS
          (SELECT 1 FROM locations l WHERE l.merchant_id = m.id)) || ' merchant(s) with 0 locations';

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

-- `category_primary` is the bare display label: `MerchantCards.subtitleOf` appends the district
-- itself, and the AI service resolves a categorised search through merchant_categories — a label
-- carrying " · District" both rendered twice and matched no taxonomy node.
INSERT INTO qc
SELECT 'category_primary is one of the merchant''s own category names',
       NOT EXISTS (SELECT 1 FROM merchants m WHERE m.category_primary IS NULL
         OR m.category_primary LIKE '% · %'
         OR NOT EXISTS (SELECT 1 FROM merchant_categories mc JOIN categories c ON c.id = mc.category_id
                         WHERE mc.merchant_id = m.id AND c.name = m.category_primary)),
       (SELECT count(*) FROM merchants m WHERE m.category_primary IS NULL OR m.category_primary LIKE '% · %'
         OR NOT EXISTS (SELECT 1 FROM merchant_categories mc JOIN categories c ON c.id = mc.category_id
                        WHERE mc.merchant_id = m.id AND c.name = m.category_primary))
         || ' merchant(s) with a label outside their own categories';

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
                     WHERE img->>'url' !~ '^/demo/img/'),
       (SELECT count(*) FROM merchants m JOIN jsonb_array_elements(m.images) img ON true
          WHERE img->>'url' !~ '^/demo/img/') || ' external image URL(s)';

INSERT INTO qc
SELECT 'SEO pages are noindex (demo must not rank, §155)',
       NOT EXISTS (SELECT 1 FROM merchants WHERE seo->>'noindex' IS DISTINCT FROM 'true')
       AND NOT EXISTS (SELECT 1 FROM collections WHERE seo->>'noindex' IS DISTINCT FROM 'true'),
       (SELECT count(*) FROM merchants WHERE seo->>'noindex' IS DISTINCT FROM 'true')
       || ' merchant page(s) + ' ||
       (SELECT count(*) FROM collections WHERE seo->>'noindex' IS DISTINCT FROM 'true')
       || ' collection page(s) without an explicit noindex';

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
-- users.role has no merchant value (V1 comment: consumer|platform_admin|platform_ops|creator);
-- merchant access comes from merchant_users.role, which is what /auth/demo?role=merchant must find.
SELECT 'demo identities exist for /api/v1/auth/demo',
       EXISTS (SELECT 1 FROM users WHERE role='consumer')
       AND EXISTS (SELECT 1 FROM users WHERE role='platform_admin')
       AND (SELECT count(*) FROM merchant_users mu JOIN users u ON u.id = mu.user_id
             WHERE mu.role = 'owner') >= 3,
       'consumer=' || (SELECT count(*) FROM users WHERE role='consumer')
       || ' platform_admin=' || (SELECT count(*) FROM users WHERE role='platform_admin')
       || ' owner_links=' || (SELECT count(*) FROM merchant_users mu JOIN users u ON u.id = mu.user_id
                                WHERE mu.role = 'owner');

INSERT INTO qc
SELECT 'everything hangs off the single demo tenant',
       NOT EXISTS (SELECT 1 FROM merchants WHERE tenant_id <> '00000000-0000-0000-0000-000000000001')
       AND NOT EXISTS (SELECT 1 FROM reviews WHERE tenant_id <> '00000000-0000-0000-0000-000000000001')
       AND EXISTS (SELECT 1 FROM tenants WHERE id='00000000-0000-0000-0000-000000000001' AND slug='hong-kong'),
       (SELECT count(*) FROM merchants WHERE tenant_id <> '00000000-0000-0000-0000-000000000001')
       || ' row(s) outside tenant 00000000-0000-0000-0000-000000000001';

-- AGENT_CONTRACT §5 freshness
-- D39: the moderation queue is only real if it contains what is waiting. A pending or flagged review with
-- no case is content nobody will ever read; a case whose review is already published or rejected describes a
-- decision that has nothing left to decide. Both directions are checked, and the queue is checked non-empty,
-- because an empty inbox passes a "nothing is orphaned" test while the demo claims to have a review process.
WITH waiting AS (
  SELECT r.id FROM reviews r WHERE r.status IN ('pending', 'flagged')
), with_case AS (
  SELECT w.id, (SELECT count(*) FROM moderation_cases c
                 WHERE c.subject_type = 'review' AND c.subject_id = w.id) AS cases
  FROM waiting w
)
INSERT INTO qc
SELECT 'every waiting review has exactly one open case',
       NOT EXISTS (SELECT 1 FROM with_case WHERE cases <> 1)
       AND NOT EXISTS (SELECT 1 FROM with_case wc
                        WHERE NOT EXISTS (SELECT 1 FROM moderation_cases c
                                            WHERE c.subject_id = wc.id AND c.status = 'open')),
       (SELECT count(*) FROM with_case WHERE cases <> 1) || ' waiting review(s) without exactly one case'
       || ', ' || (SELECT count(*) FROM moderation_cases mc WHERE mc.subject_type = 'review'
                     AND mc.status = 'open'
                     AND NOT EXISTS (SELECT 1 FROM reviews r
                                      WHERE r.id = mc.subject_id
                                        AND r.status IN ('pending','flagged')))
       || ' open case(s) over nothing waiting';

INSERT INTO qc
SELECT 'no case points at a review consumers can already read',
       NOT EXISTS (SELECT 1 FROM moderation_cases c JOIN reviews r ON r.id = c.subject_id
                    WHERE c.subject_type = 'review' AND r.status IN ('published','rejected')),
       (SELECT count(*) FROM moderation_cases c JOIN reviews r ON r.id = c.subject_id
          WHERE c.subject_type = 'review' AND r.status IN ('published','rejected'))
       || ' case(s) whose subject is already decided';

INSERT INTO qc
SELECT 'the queue has something in it (an empty inbox is not proof of a process)',
       (SELECT count(*) FROM moderation_cases WHERE subject_type = 'review' AND status = 'open') > 0,
       (SELECT count(*) FROM moderation_cases WHERE subject_type = 'review' AND status = 'open')
       || ' open review case(s)';

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

-- §19: the card prints 「4.3 · 128 則評價」, so the number must exist as a fact with a source, a
-- timestamp and a confidence — and it must be the same number. These recompute the mean from the
-- published review rows in SQL and compare: a stored aggregate that only Python's round-half-to-even
-- agrees with used to pass a tolerance-based check and still disagree with every SQL recompute (D35).
WITH recomputed AS (
  SELECT 'merchant'::text AS st, r.merchant_id AS sid, round(avg(r.rating), 2) AS val,
         count(*) AS n, max(r.created_at) AS through_at
    FROM reviews r WHERE r.status = 'published' GROUP BY r.merchant_id
  UNION ALL
  SELECT 'offering', r.offering_id, round(avg(r.rating), 2), count(*), max(r.created_at)
    FROM reviews r WHERE r.status = 'published' AND r.offering_id IS NOT NULL GROUP BY r.offering_id
), rated AS (
  SELECT rc.st, rc.sid, rc.val, rc.n, rc.through_at,
         (SELECT count(*) FROM facts f
           WHERE f.subject_type = rc.st AND f.subject_id = rc.sid AND f.attribute = 'rating') AS nfacts,
         (SELECT f.id FROM facts f
           WHERE f.subject_type = rc.st AND f.subject_id = rc.sid AND f.attribute = 'rating' LIMIT 1) AS fid
    FROM recomputed rc WHERE rc.n > 0
)
INSERT INTO qc
SELECT 'rating: every reviewed subject has exactly one rating fact',
       NOT EXISTS (SELECT 1 FROM rated WHERE nfacts <> 1)
       AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.attribute = 'rating'
                        AND NOT EXISTS (SELECT 1 FROM rated rc
                                         WHERE rc.st = f.subject_type AND rc.sid = f.subject_id)),
       (SELECT count(*) FROM rated WHERE nfacts <> 1) || ' reviewed subject(s) without one fact'
       || ', ' || (SELECT count(*) FROM facts f WHERE f.attribute = 'rating'
                    AND NOT EXISTS (SELECT 1 FROM rated rc
                                     WHERE rc.st = f.subject_type AND rc.sid = f.subject_id))
       || ' rating fact(s) over no published review';

WITH recomputed AS (
  SELECT 'merchant'::text AS st, r.merchant_id AS sid, round(avg(r.rating), 2) AS val,
         count(*) AS n, max(r.created_at) AS through_at
    FROM reviews r WHERE r.status = 'published' GROUP BY r.merchant_id
  UNION ALL
  SELECT 'offering', r.offering_id, round(avg(r.rating), 2), count(*), max(r.created_at)
    FROM reviews r WHERE r.status = 'published' AND r.offering_id IS NOT NULL GROUP BY r.offering_id
)
INSERT INTO qc
SELECT 'rating fact restates the recomputed mean',
       NOT EXISTS (SELECT 1 FROM facts f JOIN recomputed rc
                     ON rc.st = f.subject_type AND rc.sid = f.subject_id
                   WHERE f.attribute = 'rating'
                     AND ((f.value->>'value')::numeric(4,2) <> rc.val
                          OR (f.value->>'count')::int <> rc.n)),
       (SELECT count(*) FROM facts f JOIN recomputed rc
          ON rc.st = f.subject_type AND rc.sid = f.subject_id
        WHERE f.attribute = 'rating'
          AND ((f.value->>'value')::numeric(4,2) <> rc.val OR (f.value->>'count')::int <> rc.n))
       || ' rating fact(s) disagreeing with their reviews';

WITH recomputed AS (
  SELECT 'merchant'::text AS st, r.merchant_id AS sid, round(avg(r.rating), 2) AS val, count(*) AS n
    FROM reviews r WHERE r.status = 'published' GROUP BY r.merchant_id
  UNION ALL
  SELECT 'offering', r.offering_id, round(avg(r.rating), 2), count(*)
    FROM reviews r WHERE r.status = 'published' AND r.offering_id IS NOT NULL GROUP BY r.offering_id
)
INSERT INTO qc
SELECT 'rating fact agrees with the rendered aggregate column',
       NOT EXISTS (SELECT 1 FROM facts f JOIN merchants m ON m.id = f.subject_id
                    WHERE f.attribute = 'rating' AND f.subject_type = 'merchant'
                      AND (f.value->>'value')::numeric(4,2) <> m.rating_agg)
       AND NOT EXISTS (SELECT 1 FROM facts f JOIN offerings o ON o.id = f.subject_id
                    WHERE f.attribute = 'rating' AND f.subject_type = 'offering'
                      AND o.rating_agg IS NOT NULL
                      AND (f.value->>'value')::numeric(4,2) <> o.rating_agg),
       (SELECT count(*) FROM facts f JOIN merchants m ON m.id = f.subject_id
         WHERE f.attribute = 'rating' AND f.subject_type = 'merchant'
           AND (f.value->>'value')::numeric(4,2) <> m.rating_agg)
       || ' merchant and '
       || (SELECT count(*) FROM facts f JOIN offerings o ON o.id = f.subject_id
         WHERE f.attribute = 'rating' AND f.subject_type = 'offering' AND o.rating_agg IS NOT NULL
           AND (f.value->>'value')::numeric(4,2) <> o.rating_agg)
       || ' offering fact(s) off their own column';

WITH recomputed AS (
  SELECT 'merchant'::text AS st, r.merchant_id AS sid, max(r.created_at) AS through_at
    FROM reviews r WHERE r.status = 'published' GROUP BY r.merchant_id
  UNION ALL
  SELECT 'offering', r.offering_id, max(r.created_at)
    FROM reviews r WHERE r.status = 'published' AND r.offering_id IS NOT NULL GROUP BY r.offering_id
)
INSERT INTO qc
SELECT 'rating fact is observed after the newest review it averages',
       NOT EXISTS (SELECT 1 FROM facts f JOIN recomputed rc
                     ON rc.st = f.subject_type AND rc.sid = f.subject_id
                   WHERE f.attribute = 'rating'
                     AND (f.observed_at < rc.through_at
                          OR (f.value->>'reviewed_through')::timestamptz <> rc.through_at)),
       (SELECT count(*) FROM facts f JOIN recomputed rc
          ON rc.st = f.subject_type AND rc.sid = f.subject_id
        WHERE f.attribute = 'rating'
          AND (f.observed_at < rc.through_at
               OR (f.value->>'reviewed_through')::timestamptz <> rc.through_at))
       || ' rating fact(s) with an impossible evidence window';

WITH rated AS (
  SELECT 'merchant'::text AS st, r.merchant_id AS sid, count(*) AS n
    FROM reviews r WHERE r.status = 'published' GROUP BY r.merchant_id
  UNION ALL
  SELECT 'offering', r.offering_id, count(*)
    FROM reviews r WHERE r.status = 'published' AND r.offering_id IS NOT NULL GROUP BY r.offering_id
)
INSERT INTO qc
SELECT 'rating confidence tracks the sample size (§19 hedge floor)',
       NOT EXISTS (SELECT 1 FROM facts f JOIN rated rc ON rc.st = f.subject_type AND rc.sid = f.subject_id
                   WHERE f.attribute = 'rating'
                     AND f.confidence <> CASE WHEN rc.n < 5 THEN 0.7
                                              WHEN rc.n < 50 THEN 0.8 ELSE 0.9 END),
       (SELECT count(*) FROM facts f JOIN rated rc ON rc.st = f.subject_type AND rc.sid = f.subject_id
         WHERE f.attribute = 'rating'
           AND f.confidence <> CASE WHEN rc.n < 5 THEN 0.7
                                    WHEN rc.n < 50 THEN 0.8 ELSE 0.9 END)
       || ' rating fact(s) whose confidence ignores n';

-- facts invariants the schema cannot state: `facts` has no CHECK on source, no bound on confidence,
-- and no uniqueness on (subject, attribute). `FactSource` is a documented vocabulary (API_CONTRACT §2,
-- AGENT_CONTRACT §4 ranks exactly those strings), so an undeclared value silently resolves below every
-- real claim while outranking them in any `max()` that reads source as text.
INSERT INTO qc
SELECT 'facts.source is a documented provenance (§2)',
       NOT EXISTS (SELECT 1 FROM facts WHERE source NOT IN
                     ('merchant','imported','observed','third_party','inferred','demo')),
       (SELECT count(*) FROM facts WHERE source NOT IN
          ('merchant','imported','observed','third_party','inferred','demo'))
       || ' fact(s) with an undeclared source';

INSERT INTO qc
SELECT 'one fact per (subject, attribute)',
       NOT EXISTS (SELECT 1 FROM facts GROUP BY subject_type, subject_id, attribute HAVING count(*) > 1),
       (SELECT coalesce(sum(c), 0) FROM (SELECT count(*) c FROM facts
          GROUP BY subject_type, subject_id, attribute HAVING count(*) > 1) d)
       || ' competing row(s); the reader would have to guess which is true';

INSERT INTO qc
SELECT 'confidence within 0..1 and a TTL that runs forward',
       NOT EXISTS (SELECT 1 FROM facts WHERE confidence < 0 OR confidence > 1)
       AND NOT EXISTS (SELECT 1 FROM facts
                        WHERE expires_at IS NOT NULL AND expires_at <= observed_at)
       AND NOT EXISTS (SELECT 1 FROM facts WHERE stale AND expires_at > now()),
       (SELECT count(*) FROM facts WHERE confidence < 0 OR confidence > 1) || ' bad confidence, '
       || (SELECT count(*) FROM facts WHERE expires_at IS NOT NULL AND expires_at <= observed_at)
       || ' non-forward TTL, '
       || (SELECT count(*) FROM facts WHERE stale AND expires_at > now()) || ' stale-while-live';

-- An estimate is not a merchant statement. `offerings.price_source` keeps the word (the profile's
-- `flags.estimated_price` reads it); the fact that carries the same number says `inferred`, or the
-- provenance vocabulary silently grows a seventh member nothing documents.
INSERT INTO qc
SELECT 'an estimated price is facted as inferred, not as merchant',
       NOT EXISTS (SELECT 1 FROM facts f JOIN offerings o ON o.id = f.subject_id
                    WHERE f.subject_type = 'offering' AND f.attribute = 'price'
                      AND o.price_source = 'estimated'
                      AND (f.source <> 'inferred' OR (f.value->>'estimated')::text <> 'true'))
       AND NOT EXISTS (SELECT 1 FROM facts f JOIN offerings o ON o.id = f.subject_id
                        WHERE f.subject_type = 'offering' AND f.attribute = 'price'
                          AND o.price_source <> 'estimated'
                          AND (f.value->>'estimated')::text = 'true'),
       (SELECT count(*) FROM facts f JOIN offerings o ON o.id = f.subject_id
         WHERE f.subject_type = 'offering' AND f.attribute = 'price'
           AND o.price_source = 'estimated'
           AND (f.source <> 'inferred' OR (f.value->>'estimated')::text <> 'true'))
       || ' estimate(s) claiming another provenance';

INSERT INTO qc
SELECT 'rating facts respect the 24h TTL and cite their own reviews',
       NOT EXISTS (SELECT 1 FROM facts WHERE attribute='rating'
                     AND (expires_at IS DISTINCT FROM observed_at + interval '24 hours'
                          OR source <> 'observed' OR unit IS NOT NULL OR currency IS NOT NULL)),
       (SELECT count(*) FROM facts WHERE attribute='rating'
          AND (expires_at IS DISTINCT FROM observed_at + interval '24 hours'
               OR source <> 'observed' OR unit IS NOT NULL OR currency IS NOT NULL))
       || ' mis-shaped rating fact(s)';

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

-- resource_pools.offering_id is nullable by design (V1): a restaurant's table pool serves every
-- sitting, so the hard rule is that the merchant behind an active bookable offering has a pool.
INSERT INTO qc
SELECT 'bookable offerings resolve to a pool',
       NOT EXISTS (SELECT 1 FROM offerings o WHERE o.bookable AND o.status='active' AND NOT EXISTS
         (SELECT 1 FROM resource_pools p WHERE p.merchant_id = o.merchant_id AND p.status='active')),
       (SELECT count(*) FROM offerings o WHERE o.bookable AND o.status='active' AND NOT EXISTS
          (SELECT 1 FROM resource_pools p WHERE p.merchant_id = o.merchant_id AND p.status='active'))
       || ' bookable offering(s) with no merchant pool; '
       || (SELECT count(*) FROM offerings o WHERE o.bookable AND o.status='active' AND EXISTS
          (SELECT 1 FROM resource_pools p WHERE p.offering_id = o.id AND p.status='active'))
       || ' bound to a specific offering';

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
WITH sized AS (
  SELECT c.id, c.token_count,
         count(*) OVER (PARTITION BY c.document_id) AS n_chunks,
         ordinal::int = (max(ordinal::int) OVER (PARTITION BY c.document_id)) AS is_last
  FROM chunks c)
SELECT 'chunks: token size inside the §7 window',
       NOT EXISTS (SELECT 1 FROM sized WHERE token_count > 400
         OR token_count < CASE WHEN n_chunks = 1 THEN 20 WHEN is_last THEN 40 ELSE 200 END),
       (SELECT count(*) FROM sized WHERE token_count > 400
         OR token_count < CASE WHEN n_chunks = 1 THEN 20 WHEN is_last THEN 40 ELSE 200 END)
       || ' chunk(s) outside the bounds (ceiling 400; interior of a split doc >= 200; a doc tail >= '
       || '40 because that is the shortest authored section in the seed scripts)';

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

-- RBAC reachability. PermissionService resolves a `merchant_user` grant by joining
-- `users u on u.id = g.subject_id`, so subject_id must be a *user id* even though the column carries
-- no FK — which is why the pg_constraint sweep above could never see it. Writing the merchant_users
-- row id there loads cleanly and then answers 403 on every workspace route forever; the first seeded
-- demo console did exactly that (3 owners, 15 grants, 0 reachable permissions).
WITH bad AS (
  SELECT g.id
  FROM permission_grants g
  WHERE g.subject_type = 'merchant_user' AND NOT EXISTS (
      SELECT 1 FROM merchant_users mu
       WHERE mu.user_id = g.subject_id AND mu.merchant_id = g.merchant_id AND mu.status = 'active'))
INSERT INTO qc
SELECT 'merchant_user grants reach a membership',
       NOT EXISTS (SELECT 1 FROM bad),
       (SELECT count(*) FROM bad) || ' unreachable of '
       || (SELECT count(*) FROM permission_grants WHERE subject_type = 'merchant_user');

-- ...and the other direction: a dataset where nobody holds a grant is a console nobody can open.
INSERT INTO qc
SELECT 'every seeded owner membership has grants',
       NOT EXISTS (SELECT 1 FROM merchant_users mu WHERE mu.role IN ('owner','manager')
                     AND NOT EXISTS (SELECT 1 FROM permission_grants g
                                      WHERE g.subject_type = 'merchant_user'
                                        AND g.subject_id = mu.user_id AND g.merchant_id = mu.merchant_id)),
       (SELECT count(*) FROM merchant_users mu WHERE mu.role IN ('owner','manager')
          AND NOT EXISTS (SELECT 1 FROM permission_grants g
                           WHERE g.subject_type = 'merchant_user'
                             AND g.subject_id = mu.user_id AND g.merchant_id = mu.merchant_id))
       || ' silent membership(s)';

-- A role row is a label; the grants are the access (D5, D40). "Has grants" above is therefore not the
-- question a console screen can be built on: the seeded owner used to hold five of the twelve permissions
-- the `owner` preset names, and none of them was `admin_members`, so every one of §5's nine workspace
-- routes answered 403 for the only merchant humans in the demo — a screen that renders "Owner" over an
-- account that cannot open the owner's own door. Assert the permission that gates the door by name.
WITH bad AS (SELECT mu.id FROM merchant_users mu
              WHERE mu.role IN ('owner', 'admin') AND mu.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM permission_grants g
                                 WHERE g.subject_type = 'merchant_user'
                                   AND g.subject_id = mu.user_id AND g.merchant_id = mu.merchant_id
                                   AND g.permission = 'admin_members'))
INSERT INTO qc
SELECT 'owner can administer workspace',
       NOT EXISTS (SELECT 1 FROM bad) AND (SELECT count(*) FROM merchant_users
                                             WHERE role IN ('owner', 'admin') AND status = 'active') > 0,
       (SELECT count(*) FROM bad) || ' active owner/admin membership(s) lacking admin_members, of '
       || (SELECT count(*) FROM merchant_users WHERE role IN ('owner', 'admin') AND status = 'active');

-- ...and a human grant with a deadline is a role that quietly disappears one day, which no reader of the
-- membership row would predict. Human access here is assigned, not rented; only a key or an agent leases.
INSERT INTO qc
SELECT 'human grants carry no deadline',
       NOT EXISTS (SELECT 1 FROM permission_grants
                    WHERE subject_type = 'merchant_user' AND expires_at IS NOT NULL),
       (SELECT count(*) FROM permission_grants
          WHERE subject_type = 'merchant_user' AND expires_at IS NOT NULL)
       || ' lapsing human grant(s)';

-- D58: a favourite is a link the consumer screen renders. D50 closed the *write* door (POST
-- /api/v1/me/favorites now refuses a row the §8/§4 readers would hide), but the demo data is older than that
-- door and was loaded by the generator, so the pairing is asserted here: a saved merchant must be published, a
-- saved offering active, a saved collection publishable by §8's own rule. A seed that fails this ships a
-- bookmark whose click is a 404, which is the same §35/§D35 failure in the opposite direction.
WITH bad AS (
  SELECT f.id FROM favorites f
  LEFT JOIN merchants   m ON f.subject_type = 'merchant'   AND m.id = f.subject_id
  LEFT JOIN offerings   o ON f.subject_type = 'offering'   AND o.id = f.subject_id
  LEFT JOIN collections c ON f.subject_type = 'collection' AND c.id = f.subject_id
  WHERE (f.subject_type = 'merchant'   AND (m.id IS NULL OR m.status <> 'published'))
     OR (f.subject_type = 'offering'   AND (o.id IS NULL OR o.status <> 'active'))
     OR (f.subject_type = 'collection' AND (c.id IS NULL OR c.visibility <> 'public'
                                            OR c.published_at IS NULL
                                            OR (c.author_id IS NULL
                                                AND lower(btrim(coalesce(c.seo->>'generated_by','')))
                                                    NOT IN ('ai','editor','creator')))))
INSERT INTO qc
SELECT 'favourites point at a renderable row',
       NOT EXISTS (SELECT 1 FROM bad) AND (SELECT count(*) FROM favorites) > 0,
       (SELECT count(*) FROM bad) || ' unreachable of '
       || (SELECT count(*) FROM favorites) || ' favourite(s)';

-- ...and the vocabulary a favourite may use has to be the vocabulary the API will accept. A seeded
-- subject_type outside FavoriteBody's pattern loads cleanly and can never be re-created or fixed through
-- the door, so it is data the write path does not know about.
INSERT INTO qc
SELECT 'favourite subject_type is one the API can save',
       NOT EXISTS (SELECT 1 FROM favorites
                    WHERE subject_type NOT IN ('merchant','offering','guide','collection')),
       (SELECT count(*) FROM favorites
          WHERE subject_type NOT IN ('merchant','offering','guide','collection'))
       || ' unsavable row(s); the door accepts merchant|offering|guide|collection';

-- ============================================================ C  hard gate
\echo ''
SELECT CASE WHEN ok THEN '  PASS ' ELSE '  FAIL ' END AS status,
       rpad("check", 52, ' ') AS check, detail
FROM qc ORDER BY ok ASC, "check";

DO $$
DECLARE bad int; names text;
BEGIN
  SELECT count(*), string_agg("check", E'\n    - ') INTO bad, names FROM qc WHERE NOT ok;
  IF bad > 0 THEN
    RAISE EXCEPTION 'quality gate: % check(s) failed:\n    - %', bad, names;
  END IF;
  RAISE NOTICE 'quality gate: all % checks passed (SYNTHETIC DEMO DATA — not real businesses)',
    (SELECT count(*) FROM qc);
END $$;
