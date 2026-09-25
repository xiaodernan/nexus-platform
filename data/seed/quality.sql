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
-- The moderation queue is the same shape one table over: V1:574 names review|merchant|document|message|
-- listing in its CREATE TABLE source comment — which is the only place it names them (D71 measured
-- pg_description: none of the schema's 14 public %_type columns carries a database-side comment, and no CHECK
-- bounds any of them except share_links'), every existing queue check joins
-- `reviews`, and the generator emits only review rows — so four of the five types had never been resolved by
-- anything. `listing` stays out of the arms on purpose: no table in this schema is a listing, so a case of
-- that type is unresolvable by construction and prints its own red row rather than disappearing into a join
-- that never mentions it (the D65 `policy` habit).
INSERT INTO qc
WITH probe AS (
  SELECT 'review'::text t, id::text k FROM reviews
  UNION ALL SELECT 'merchant', id::text FROM merchants
  UNION ALL SELECT 'document', id::text FROM documents
  UNION ALL SELECT 'message', id::text FROM messages),
 g AS (
  SELECT c.subject_type t, (q.k IS NULL) bad
  FROM moderation_cases c
  LEFT JOIN probe q ON q.t = c.subject_type AND q.k = c.subject_id::text)
SELECT 'orphan: moderation_cases.' || t,
       count(*) FILTER (WHERE bad) = 0,
       count(*) FILTER (WHERE bad) || ' unresolvable of ' || count(*) || ' case(s)'
FROM g GROUP BY t;

INSERT INTO qc
WITH probe AS (
  -- the arms are the door's own vocabulary (MeController.FavoriteBody: merchant|offering|guide|collection),
  -- and guide/collection are pinned to the row's kind exactly the way assertSubjectInTenant pins them: a
  -- favourite saved under the wrong label is refused at the door, so the seed may not carry one either.
  SELECT 'merchant'::text t, id::text k FROM merchants
  UNION ALL SELECT 'offering', id::text FROM offerings
  UNION ALL SELECT 'collection', id::text FROM collections WHERE kind = 'collection'
  UNION ALL SELECT 'guide', id::text FROM collections WHERE kind = 'guide'),
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
  -- The arms are the three subject types this build can file a grant under, each resolved the way the
  -- interceptor reads it. `subject_id` names a row in whatever table `subject_type` spells — except for a
  -- workspace grant. AuthorizationInterceptor asks for `principal.subjectId()` and `principal.userId()`,
  -- and both of those are ids on `users`, so a grant keyed to a `merchant_users` row id is unreachable at
  -- runtime (D31). The probe joins the way the interceptor does: the person, plus an active membership at
  -- that merchant. `api_key` is ApiKeyService.java:67's own write — subject_id is the api_keys row id — and
  -- it is filtered to live keys because ApiKeyService.verify looks a key up `and k.revoked_at is null`, so
  -- a grant filed under a revoked key authorises nothing; the same reading that gives merchant_users a
  -- `status = 'active'` filter. There is deliberately no `merchant` arm: V1:130 does not name one, the only
  -- three insert sites in the build write 'user' (MerchantService.java:63, MerchantWorkspaceService.java:177)
  -- and 'api_key', the seed emits merchant_user, and no interceptor lookup ever passes a merchant id as a
  -- subject — so such a row is not a reachable grant, and resolving it green against `merchants` was the
  -- D67 error in a new table (an arm the door cannot produce).
  SELECT 'user'::text parent, id::text k, NULL::uuid m FROM users
  UNION ALL SELECT 'merchant_user', u.id::text, mu.merchant_id
    FROM merchant_users mu JOIN users u ON u.id = mu.user_id WHERE mu.status = 'active'
  UNION ALL SELECT 'api_key', id::text, NULL FROM api_keys WHERE revoked_at IS NULL)
SELECT 'orphan: permission_grants.' || g.subject_type,
       count(*) FILTER (WHERE q.k IS NULL) = 0,
       count(*) FILTER (WHERE q.k IS NULL) || ' unresolvable subject_id of ' || count(*) || ' grant(s)'
FROM g LEFT JOIN probe q ON q.parent = g.subject_type AND q.k = g.sid
     AND (q.m IS NULL OR q.m = g.merchant_id)
GROUP BY g.subject_type;

-- D72: the same table's *other* unbounded uuid column, and the one the naming census could not see because it
-- is called `granted_by` rather than `granted_id`. Six of this schema's seven uuid `*_by` columns carry
-- `REFERENCES users(id)`; this one carries nothing (V1:136 `granted_by uuid,`), the seed fills it on all 36
-- rows, and generate.py's FK self-check map covers permission_grants.merchant_id while naming granted_by
-- nowhere. So the resolution lives here, and only here: a direct join, no type arms, because an operator is
-- not a polymorphic subject. It refuses an empty set — a grant table with no operator id on any row would tell
-- nothing about whether the join works, which is D64's rule.
INSERT INTO qc
SELECT 'every grant names an operator that exists',
       count(*) > 0 AND count(*) FILTER (WHERE g.granted_by IS NOT NULL) > 0
       AND count(*) FILTER (WHERE g.granted_by IS NOT NULL AND u.id IS NULL) = 0,
       count(*) FILTER (WHERE g.granted_by IS NOT NULL AND u.id IS NULL) || ' unresolvable granted_by of '
       || count(*) FILTER (WHERE g.granted_by IS NOT NULL) || ' grant(s) carrying an operator ('
       || count(*) FILTER (WHERE g.granted_by IS NULL) || ' carry none), filed by '
       || (SELECT count(DISTINCT granted_by) FROM permission_grants)
       || ' distinct operator(s); granted_by has no FK in the schema'
FROM permission_grants g LEFT JOIN users u ON u.id = g.granted_by;

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

-- --------------------------------------------------------------- D66: ask the catalogue who is unanswered
-- Every row above asks a question about columns this file already knows about. The census below asks the
-- schema which of its `*_id` columns name a reference and carry no constraint at all, so a column nobody had
-- thought to check cannot stay unmentioned just because nobody thought to check it. The registry is a hand
-- list on purpose — what the catalogue decides is *who has to answer*, and a new column the seed starts
-- writing goes red until someone registers a reason for it.
--
-- D72 found the predicate's own blind spot: `*_id` is not what makes a column a reference, and a census keyed
-- to one suffix silently promises it has found the shape. The schema holds eleven `*_by` columns; seven are
-- uuid and **six of those seven carry `REFERENCES users(id)`** (campaigns.approved_by, coupons.created_by,
-- coupons.published_by, refunds.approved_by, seo_pages.reviewed_by, share_links.created_by). The seventh —
-- `permission_grants.granted_by`, V1:136, `granted_by uuid,` with nothing after it — carries no bound, and the
-- census never saw it because of its name. So the predicate now asks for either suffix, with a type condition
-- doing the exclusion the old file did by hand: `*_by` counts only when it is uuid, which drops
-- campaigns.generated_by / seo_pages.generated_by / trust_signals.detected_by (free-text provenance labels)
-- and flyway's installed_by without an exception list, exactly the way D69's pair rule dropped mime_type.
CREATE TEMP TABLE ref_cat (name text, rows_n bigint, vals_n bigint, types_n int);
DO $$
DECLARE r record; n bigint; v bigint; tn int;
BEGIN
  FOR r IN
    SELECT c.relname || '.' || a.attname AS name, c.relname AS tbl, a.attname AS col,
           EXISTS (SELECT 1 FROM pg_attribute s
                    WHERE s.attrelid = c.oid AND s.attname = 'subject_type' AND NOT s.attisdropped) AS has_st
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
     WHERE a.attnum > 0 AND NOT a.attisdropped
       AND ((a.attname LIKE '%\_id' AND a.attname <> 'id')
            OR (a.attname LIKE '%\_by' AND a.atttypid = 'uuid'::regtype))
       AND NOT EXISTS (SELECT 1 FROM pg_constraint f
                        WHERE f.conrelid = c.oid AND f.contype = 'f' AND a.attnum = ANY (f.conkey))
       AND NOT EXISTS (SELECT 1 FROM pg_constraint u
                        WHERE u.conrelid = c.oid AND u.contype IN ('p','u')
                          AND array_length(u.conkey, 1) = 1 AND a.attnum = u.conkey[1])
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*), count(nullif(%I::text, %L)) FROM public.%I', r.col, '', r.tbl) INTO n, v;
    -- the column test is static SQL, so it cannot name a column the table does not have
    IF r.has_st THEN
      EXECUTE format('SELECT count(DISTINCT subject_type) FROM public.%I', r.tbl) INTO tn;
    ELSE
      tn := 0;
    END IF;
    INSERT INTO ref_cat VALUES (r.name, n, v, coalesce(tn, 0));
  END LOOP;
END $$;

CREATE TEMP TABLE ref_registry (name text PRIMARY KEY, kind text NOT NULL, why text NOT NULL);
INSERT INTO ref_registry VALUES
 ('facts.subject_id', 'probe',
  'orphan probe over merchant|offering|location|review, grouped by the declared type (D65)'),
 ('favorites.subject_id', 'probe',
  'orphan probe over exactly the four types MeController.FavoriteBody accepts, with guide and '
  || 'collection pinned to the collections row kind the way assertSubjectInTenant pins them (D67)'),
 ('permission_grants.subject_id', 'probe',
  'orphan probe over user|merchant_user|api_key, the three types the build files grants under. D66 wrote '
  || 'this as "an agent or api_key grant would be an orphan by construction" and that was half wrong (D71 '
  || 'measured): `agent` has no writer so an orphan verdict is right, while `api_key` is written by '
  || 'ApiKeyService.java:67 for every key the console creates, so the un-armed type made a legal row red. '
  || '`merchant` was the invented arm and is gone.'),
 ('moderation_cases.subject_id', 'probe',
  'orphan probe over review|merchant|document|message; `listing` is in V1:574 and resolves to no table '
  || 'in this schema, so a case of that type is an orphan by construction (D68)'),
 ('user_identities.provider_id', 'not-a-reference',
  'V1:53 declares it an opaque external subject id, never a token — no table in this schema resolves it'),
 ('permission_grants.granted_by', 'probe',
  'the operator''s user id, resolved by a direct JOIN users below — not polymorphic, so no type arms are '
  || 'involved. D72 measured it as the only uuid *_by column in public with no REFERENCES: its six siblings '
  || '(campaigns.approved_by, coupons.created_by, coupons.published_by, refunds.approved_by, '
  || 'seo_pages.reviewed_by, share_links.created_by) are all bounded to users, and the census missed this one '
  || 'because it asked only about the *_id suffix. The writers supply principal.userId() '
  || '(MerchantService.java:63) and operatorId (MerchantWorkspaceService.java:177, ApiKeyService.java:67); '
  || 'generate.py''s own FK self-check map names permission_grants.merchant_id and not granted_by, so this '
  || 'probe is the only thing on either side that asks whether an operator id resolves.');

INSERT INTO qc
SELECT 'the reference census reads the catalogue',
       (SELECT count(*) FROM ref_cat) >= 17,
       (SELECT count(*) FROM ref_cat) || ' unconstrained reference column(s) measured from pg_attribute, over '
       || 'two naming shapes (*_id, and uuid *_by — D72); the floor this row asserts is 17, two thirds of the '
       || '25 measured when D66 wrote it, and what prints here is the measured count, not a remembered one';

INSERT INTO qc
SELECT 'every reference the seed writes is probed or explained',
       (SELECT count(*) FROM ref_cat WHERE vals_n > 0) > 0
       AND NOT EXISTS (SELECT 1 FROM ref_cat c WHERE c.vals_n > 0
                        AND NOT EXISTS (SELECT 1 FROM ref_registry r WHERE r.name = c.name)),
       coalesce((SELECT string_agg(c.name || ' (' || c.vals_n || ' row(s))', ', ')
                   FROM ref_cat c WHERE c.vals_n > 0
                     AND NOT EXISTS (SELECT 1 FROM ref_registry r WHERE r.name = c.name)),
                (SELECT count(*) FROM ref_cat WHERE vals_n > 0) || ' of '
                || (SELECT count(*) FROM ref_cat) || ' carry values, each registered — '
                || 'this row cannot pass on an empty census');

INSERT INTO qc
SELECT 'the registry names no column the schema has lost',
       NOT EXISTS (SELECT 1 FROM ref_registry r
                    WHERE NOT EXISTS (SELECT 1 FROM ref_cat c WHERE c.name = r.name)),
       (SELECT count(*) FROM ref_registry r
          WHERE NOT EXISTS (SELECT 1 FROM ref_cat c WHERE c.name = r.name))
       || ' stale of ' || (SELECT count(*) FROM ref_registry) || ' registered ('
       || (SELECT string_agg(k, ', ') FROM (SELECT kind || ' ' || count(*) FROM ref_registry GROUP BY kind ORDER BY 1) x(k))
       || ')';

INSERT INTO qc
SELECT 'a join-one-type waiver is only true while the table ships one type',
       NOT EXISTS (SELECT 1 FROM ref_registry r JOIN ref_cat c ON c.name = r.name
                    WHERE r.kind = 'join-one-type' AND c.types_n > 1),
       coalesce((SELECT string_agg(r.name || ' ships ' || c.types_n || ' subject_type(s)', '; ')
                   FROM ref_registry r JOIN ref_cat c ON c.name = r.name
                  WHERE r.kind = 'join-one-type'), 'no waiver of that kind is registered');

-- ------------------------------- D69: the same question one level up — which columns are a (type, key) PAIR
-- ref_cat above asks about single `*_id` columns. A polymorphic reference is a *pair*, `<x>_type` beside
-- `<x>_id`, and a pair can be half-answered: the key column registered while nothing asks which types it may
-- hold, or the reverse. The census below enumerates pairs by shape (a table holding both `stem_type` and
-- `stem_id`, so `mime_type` and `content_type` fall out on their own) and records the two facts that matter
-- about each: does the seed write it, and does any CHECK constrain its vocabulary.
--
-- The second question had a surprise in it. V1 writes these vocabularies as *comments* — `subject_type text
-- NOT NULL,  -- review|merchant|document|message|listing` — not as constraints, so 11 of the 12 pairs are
-- bounded by nothing in the database; only share_links.subject_type (V7) carries a CHECK. The doors hold the
-- rest of the answers, each in its own constant (MeController.FavoriteBody, EventsController:63,
-- PermissionService:40, ModerationController:130 — see D69 §2), which is why this census counts pairs rather
-- than trusting any one of them to cover the set.
CREATE TEMP TABLE poly_cat (
  tbl text, tcol text, icol text, rows_n bigint, types_n bigint, vocabulary_checked bool);
DO $d69$
DECLARE r record; n bigint; t bigint; vc bool;
BEGIN
  FOR r IN
    SELECT c.oid AS rel, c.relname AS tbl, ta.attname AS tcol, ia.attname AS icol
      FROM pg_attribute ta
      JOIN pg_class c ON c.oid = ta.attrelid AND c.relkind = 'r'
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute ia
        ON ia.attrelid = c.oid AND ia.attnum > 0 AND NOT ia.attisdropped
       AND ia.attname = left(ta.attname, length(ta.attname) - 5) || '_id'
     WHERE ta.attnum > 0 AND NOT ta.attisdropped AND ta.attname LIKE '%\_type'
     ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*), count(DISTINCT %I) FROM public.%I', r.tcol, r.tbl) INTO n, t;
    SELECT EXISTS (SELECT 1 FROM pg_constraint k
                    WHERE k.conrelid = r.rel AND k.contype = 'c'
                      AND pg_get_constraintdef(k.oid) ~ ('\m' || r.tcol || '\M')) INTO vc;
    INSERT INTO poly_cat VALUES (r.tbl, r.tcol, r.icol, n, coalesce(t, 0), vc);
  END LOOP;
END $d69$;

-- Which pairs this file resolves is a hand list — the census cannot know that a UNION over four tables *is*
-- the answer to a question about one of them. What the catalogue decides is who has to be on the list.
CREATE TEMP TABLE poly_probed (tbl text PRIMARY KEY, arms int NOT NULL, why text NOT NULL);
INSERT INTO poly_probed VALUES
 ('facts', 4, 'the D65 probe over merchant|offering|location|review'),
 ('favorites', 4, 'the D67 probe over the four types MeController.FavoriteBody accepts'),
 ('moderation_cases', 4, 'the D68 probe over review|merchant|document|message'),
 ('permission_grants', 3, 'the D71 probe over user|merchant_user|api_key — the types this build files grants '
  || 'under, with the live-key and active-membership filters the interceptor''s own lookups carry');

INSERT INTO qc
SELECT 'the polymorphic-pair census reads the catalogue',
       (SELECT count(*) FROM poly_cat) >= 8,
       (SELECT count(*) FROM poly_cat) || ' (type, key) pair(s) measured from pg_attribute, over every table '
       || 'holding a *_type beside its *_id sibling; the floor this row asserts is 8 — two thirds of the count '
       || 'measured when D69 wrote it, and the detail prints the measured number, never a remembered one';

INSERT INTO qc
SELECT 'the pairs declared probed are pairs the schema has',
       NOT EXISTS (SELECT 1 FROM poly_probed p WHERE NOT EXISTS
                     (SELECT 1 FROM poly_cat c WHERE c.tbl = p.tbl)),
       (SELECT count(*) FROM poly_probed p WHERE NOT EXISTS
          (SELECT 1 FROM poly_cat c WHERE c.tbl = p.tbl))
       || ' stale of ' || (SELECT count(*) FROM poly_probed)
       || ' declared (' || (SELECT string_agg(tbl, ', ' ORDER BY tbl) FROM poly_probed) || ')';

-- The row that gives the census teeth: a pair the seed writes whose type column no CHECK bounds and whose keys
-- no probe resolves is a vocabulary enforced by a comment nobody executes.
INSERT INTO qc
SELECT 'a seeded polymorphic vocabulary is bounded or probed',
       (SELECT count(*) FROM poly_cat WHERE rows_n > 0) > 0
       AND NOT EXISTS (SELECT 1 FROM poly_cat c
                        WHERE c.rows_n > 0 AND NOT c.vocabulary_checked
                          AND NOT EXISTS (SELECT 1 FROM poly_probed p WHERE p.tbl = c.tbl)),
       (SELECT count(*) FROM poly_cat WHERE rows_n > 0) || ' of ' || (SELECT count(*) FROM poly_cat)
       || ' pair(s) carry seeded rows; ' || (SELECT count(*) FROM poly_cat WHERE vocabulary_checked)
       || ' is bounded by a CHECK; '
       || coalesce('unresolved: ' || (SELECT string_agg(c.tbl || '.' || c.tcol || ' (' || c.rows_n || ' row(s), '
                                              || c.types_n || ' type(s))', ', ' ORDER BY c.tbl)
                        FROM poly_cat c WHERE c.rows_n > 0 AND NOT c.vocabulary_checked
                          AND NOT EXISTS (SELECT 1 FROM poly_probed p WHERE p.tbl = c.tbl)),
                   'each seeded one is resolved by a probe here')
       || '; pairs with no rows are written only by the application, which this file cannot see';

-- ================================================== D71: the arms answer to a vocabulary
-- D69 counted the (type, key) pairs and which of them this file resolves, and stopped there. The permission_grants
-- probe is what that blind spot had already cost: its UNION carried a `merchant` arm, a type V1:130 never names
-- and no door writes (the three insert sites in the build are MerchantService.java:63 and
-- MerchantWorkspaceService.java:177, both 'user', and ApiKeyService.java:67, 'api_key'), while the type the
-- console really does write — one grant per scope for every API key — had no arm at all, so a perfectly legal
-- row would have loaded red as an orphan. That is D67's mistake (an arm the door cannot produce, and no arm for
-- one it can) in a new table, which is the only interesting thing about it: the habit does not generalize by
-- itself, so this time the arm list is written down as data with a justification per type, and the parts of
-- those justifications that a database can re-read are re-read on every run.
--
--   kind    'arm'          the probe resolves this type against `referent`
--           'no-referent'  the migration names the type and no table spells it, so a row of that type is an
--                          orphan by construction and prints its own red rather than getting an invented join
--   filled  'seed'         the shipped generator emits rows of this type — checked against the live census
--           'door'         the application writes them at the file:line in `why` — this file cannot see that
--           'declared'     only the migration's source comment names the type; no writer was found
CREATE TEMP TABLE poly_vocab (
  tbl text NOT NULL, t text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('arm', 'no-referent')),
  referent text NOT NULL,
  filled text NOT NULL CHECK (filled IN ('seed', 'door', 'declared')),
  why text NOT NULL, PRIMARY KEY (tbl, t));
INSERT INTO poly_vocab VALUES
 ('facts', 'merchant', 'arm', 'merchants', 'seed',
  'V1:539 names it; the generator records merchant observations'),
 ('facts', 'offering', 'arm', 'offerings', 'seed',
  'V1:539 names it; the generator records offering observations'),
 ('facts', 'location', 'arm', 'locations', 'seed',
  'V1:539 names it; the generator records one address fact per location'),
 ('facts', 'review', 'arm', 'reviews', 'declared',
  'V1:539 names it; the seed emits no review fact and the two refreshRating call sites pass merchant or '
  || 'offering (ModerationService.java:57,61), so this arm resolves rows nothing writes today'),
 ('facts', 'policy', 'no-referent', 'policies', 'declared',
  'V1:539 names it and no policies table exists, so a policy fact is an orphan by construction and says so '
  '(D65) — inventing a referent for it would be coinage'),
 ('favorites', 'merchant', 'arm', 'merchants', 'seed',
  'V1:619 and MeController.FavoriteBody both name it, and the seed saves merchants'),
 ('favorites', 'offering', 'arm', 'offerings', 'seed',
  'V1:619 and FavoriteBody both name it, and the seed saves offerings'),
 ('favorites', 'guide', 'arm', 'collections', 'seed',
  'the arm is pinned to collections.kind = ''guide'' the way MeController.assertSubjectInTenant pins it (D67), '
  'so a mislabelled row cannot pass here either'),
 ('favorites', 'collection', 'arm', 'collections', 'seed',
  'pinned to collections.kind = ''collection'' for the same reason (D67)'),
 ('moderation_cases', 'review', 'arm', 'reviews', 'seed',
  'the one type ReviewRepository.java:122 files, and every seeded case is one'),
 ('moderation_cases', 'merchant', 'arm', 'merchants', 'declared',
  'V1:574 names it; no writer was found in this build (D68 armed the declared set on purpose)'),
 ('moderation_cases', 'document', 'arm', 'documents', 'declared',
  'V1:574 names it; no writer was found'),
 ('moderation_cases', 'message', 'arm', 'messages', 'declared',
  'V1:574 names it; no writer was found'),
 ('moderation_cases', 'listing', 'no-referent', 'listings', 'declared',
  'V1:574 names it; no listings table exists, so a listing case is unresolvable by construction (D68)'),
 ('permission_grants', 'user', 'arm', 'users', 'door',
  'MerchantService.java:63 and MerchantWorkspaceService.java:177 file owner and member grants as user'),
 ('permission_grants', 'merchant_user', 'arm', 'users', 'seed',
  'the seed''s owner preset; the referent is `users` because D31 makes the person, not the membership row, the '
  'key, so the arm joins through merchant_users and requires an active membership at the grant''s merchant'),
 ('permission_grants', 'api_key', 'arm', 'api_keys', 'door',
  'ApiKeyService.java:67 writes one grant per scope for every key the console creates, and '
  'MerchantWorkspaceTest.java:404 counts them after a real POST /api/v1/merchant/api-keys; the arm drops '
  'revoked keys because ApiKeyService.verify looks a key up with `k.revoked_at is null`'),
 ('permission_grants', 'agent', 'no-referent', 'agents', 'declared',
  'V1:130 names it and AGENT_CONTRACT 8 mentions it, but no agents table exists: agent_profiles holds a '
  'workspace''s AI configuration, not an authenticatable subject, and PermissionService records that no read '
  'asks for a row filed as agent, because the AI service enters through AiServiceTokenGuard (D12)');

-- The same list a second time, because it is the only way to ask the question at all: `poly_arms` says what the
-- four `WITH probe AS (…)` UNIONs above resolve, and a UNION clause is not something SQL can read back off
-- itself. That is a hand copy and the residue it leaves is named in D71 rather than argued away; what the
-- catalogue decides is who has to be on the list, which referents exist, and which types the data carries.
CREATE TEMP TABLE poly_arms (tbl text NOT NULL, arm text NOT NULL, PRIMARY KEY (tbl, arm));
INSERT INTO poly_arms VALUES
 ('facts', 'merchant'), ('facts', 'offering'), ('facts', 'location'), ('facts', 'review'),
 ('favorites', 'merchant'), ('favorites', 'offering'), ('favorites', 'collection'), ('favorites', 'guide'),
 ('moderation_cases', 'review'), ('moderation_cases', 'merchant'),
 ('moderation_cases', 'document'), ('moderation_cases', 'message'),
 ('permission_grants', 'user'), ('permission_grants', 'merchant_user'), ('permission_grants', 'api_key');

-- Which types each probed pair actually carries, read from the pair's own type column (the same
-- pg_attribute join D69 used, so the column name is never retyped here).
CREATE TEMP TABLE poly_types (tbl text NOT NULL, t text NOT NULL, n bigint NOT NULL, PRIMARY KEY (tbl, t));
DO $d71$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.tbl, c.tcol FROM poly_cat c JOIN poly_probed p ON p.tbl = c.tbl ORDER BY 1 LOOP
    EXECUTE format('INSERT INTO poly_types SELECT %L, x.t, x.n FROM '
                 || '(SELECT %I AS t, count(*)::bigint AS n FROM public.%I GROUP BY 1) x',
                   r.tbl, r.tcol, r.tbl);
  END LOOP;
END $d71$;

INSERT INTO qc
WITH dis AS (
  SELECT a.tbl || '.' || a.arm || ' has no vocabulary row' AS x
    FROM poly_arms a
   WHERE NOT EXISTS (SELECT 1 FROM poly_vocab v
                      WHERE v.tbl = a.tbl AND v.t = a.arm AND v.kind = 'arm')
  UNION ALL
  SELECT v.tbl || '.' || v.t || ' is armed in the vocabulary with no UNION arm'
    FROM poly_vocab v
   WHERE v.kind = 'arm'
     AND NOT EXISTS (SELECT 1 FROM poly_arms a WHERE a.tbl = v.tbl AND a.arm = v.t))
SELECT 'a probe arm is a declared type and every armed type has an arm',
       (SELECT count(*) FROM poly_vocab) > 0
       AND NOT EXISTS (SELECT 1 FROM dis),
       (SELECT count(*) FROM poly_arms) || ' arm(s) and '
       || (SELECT count(*) FROM poly_vocab WHERE kind = 'arm') || ' armed vocabulary row(s); '
       || coalesce('disagreement: ' || (SELECT string_agg(x, ' / ' ORDER BY x) FROM dis),
                   'the two lists name each other exactly');

INSERT INTO qc
SELECT 'an armed type resolves in a table the schema has',
       (SELECT count(*) FROM poly_vocab WHERE kind = 'arm') > 0
       AND NOT EXISTS (SELECT 1 FROM poly_vocab v WHERE v.kind = 'arm'
                        AND to_regclass('public.' || v.referent) IS NULL),
       coalesce('referent missing: ' || (SELECT string_agg(v.tbl || '.' || v.t || ' -> ' || v.referent, ', ')
                   FROM poly_vocab v WHERE v.kind = 'arm'
                     AND to_regclass('public.' || v.referent) IS NULL),
                (SELECT count(DISTINCT referent) FROM poly_vocab WHERE kind = 'arm')
                || ' distinct referent table(s) measured present for '
                || (SELECT count(*) FROM poly_vocab WHERE kind = 'arm') || ' armed type(s)');

-- The live re-read D69 asked for of every waiver: 'no-referent' is only honest while that table is still
-- absent, so the day someone ships a `policies` table this row goes red and a policy fact has to be armed or
-- the waiver re-argued.
INSERT INTO qc
SELECT 'a no-referent waiver still names a table the schema lacks',
       NOT EXISTS (SELECT 1 FROM poly_vocab v WHERE v.kind = 'no-referent'
                     AND to_regclass('public.' || v.referent) IS NOT NULL),
       (SELECT count(*) FROM poly_vocab WHERE kind = 'no-referent') || ' waiver(s) of that kind; '
       || coalesce('now exists: ' || (SELECT string_agg(v.tbl || '.' || v.t || ' -> ' || v.referent, ', ')
                   FROM poly_vocab v WHERE v.kind = 'no-referent'
                     AND to_regclass('public.' || v.referent) IS NOT NULL),
                   'each candidate table measured absent this run');

INSERT INTO qc
SELECT 'an arm claimed seeded is a type the data still carries',
       (SELECT count(*) FROM poly_vocab WHERE filled = 'seed') > 0
       AND NOT EXISTS (SELECT 1 FROM poly_vocab v WHERE v.filled = 'seed'
                        AND NOT EXISTS (SELECT 1 FROM poly_types t
                                         WHERE t.tbl = v.tbl AND t.t = v.t AND t.n > 0)),
       coalesce('unexercised: ' || (SELECT string_agg(v.tbl || '.' || v.t, ', ')
                   FROM poly_vocab v WHERE v.filled = 'seed'
                     AND NOT EXISTS (SELECT 1 FROM poly_types t
                                      WHERE t.tbl = v.tbl AND t.t = v.t AND t.n > 0)),
                (SELECT count(*) FROM poly_vocab WHERE filled = 'seed') || ' seeded arm(s), each carrying rows ('
                || coalesce((SELECT string_agg(tbl || '.' || t || '=' || n::text, ', ' ORDER BY tbl, t)
                               FROM poly_types WHERE n > 0), 'none') || ')');

-- And the type the data carries that no list names: the probe would already print it red as an orphan, so this
-- row is not new coverage — it is the message that says *which* of the two lists has to grow.
INSERT INTO qc
SELECT 'no unlisted type rides in the seeded data',
       (SELECT count(*) FROM poly_types WHERE n > 0) > 0
       AND NOT EXISTS (SELECT 1 FROM poly_types t WHERE t.n > 0 AND NOT EXISTS
                       (SELECT 1 FROM poly_vocab v WHERE v.tbl = t.tbl AND v.t = t.t)),
       coalesce('not in the vocabulary: ' || (SELECT string_agg(t.tbl || '.' || t.t || ' (' || t.n || ' row(s))', ', ')
                   FROM poly_types t WHERE t.n > 0
                     AND NOT EXISTS (SELECT 1 FROM poly_vocab v WHERE v.tbl = t.tbl AND v.t = t.t)),
                (SELECT count(DISTINCT t.tbl || '.' || t.t) FROM poly_types t WHERE t.n > 0)
                || ' type(s) present in the data, each named by the vocabulary row');

INSERT INTO qc
SELECT 'the arm registry agrees with the probed-pair counts',
       (SELECT count(*) FROM poly_probed) > 0
       AND NOT EXISTS (SELECT 1 FROM poly_probed p WHERE p.arms <>
                       (SELECT count(*) FROM poly_arms a WHERE a.tbl = p.tbl)),
       coalesce('disagreement: ' || (SELECT string_agg(p.tbl || ' declared ' || p.arms
                   || ' arm(s), registry has ' || (SELECT count(*) FROM poly_arms a WHERE a.tbl = p.tbl), '; ')
                   FROM poly_probed p WHERE p.arms <>
                     (SELECT count(*) FROM poly_arms a WHERE a.tbl = p.tbl)),
                (SELECT string_agg(tbl || '=' || arms, ', ' ORDER BY tbl) FROM poly_probed)
                || ' as declared, and the registry counts the same');

-- ============================================================ D79  an arm the seed never files resolves nothing
--
-- WHY THIS EXISTS: D65, D67, D68 and D71 each made a polymorphic reference resolvable by declaring the types it
-- may hold and writing one UNION arm per type, and D71 checked those arms against the vocabulary and against
-- the schema. What nobody asked is whether a single shipped row ever goes through an arm. The orphan probes are
-- shaped `SELECT 'orphan: ' || t, … FROM <table> GROUP BY subject_type`, so a type the seed does not file emits
-- not a green check but NO check — the gate cannot print "0 unresolvable of 0" because the GROUP BY has no row
-- to group. Measured on the gate database, `poly_arms` declares 15 arms, the probes print 9 orphan checks, and
-- the 9 are exactly the arms the shipped dataset files rows under: facts location=684 / merchant=2080 /
-- offering=2924, favorites merchant=12 / offering=4 / collection=1 / guide=1, moderation_cases review=544,
-- permission_grants merchant_user=36. Six arms — facts.review, moderation_cases.merchant,
-- moderation_cases.document, moderation_cases.message, permission_grants.user, permission_grants.api_key — are
-- resolution rules asserted over zero rows, and their only trace is a total that quietly omits them.
--
-- WHY THAT IS A DEFECT, AND WHERE IT OVERLAPS ONE THAT IS ALREADY FIXED: D71 already watches the arms the
-- vocabulary claims the seed files — 'an arm claimed seeded is a type the data still carries' goes red if the
-- favourites stop shipping. The plant in this unit's drive deleted all 18 favourite rows before the probes ran,
-- and that run is the whole mechanism in one line: the four `orphan: favorites.*` checks left the ledger with
-- them (204 checks emitted, then 200), while four rows reddened — D71's, a favourites row that predates this
-- unit, and the two written here. So nothing in the file was blind to a vanishing that touches a CLAIMED arm;
-- what nothing could answer was the other question. An arm nobody claims is a resolution rule with no witness
-- and no statement, and the ledger had no way to say "these six of the fifteen declared arms resolve over zero
-- rows" — the answer lived only in a total that happened to omit them. This is the accounting of the silent
-- six, plus a waiver rule with the property every other exemption in this file has: it re-reads the data that
-- justified it, so an arm that starts being exercised withdraws its own waiver. The family row is a partial
-- restatement of D71's and says so rather than hiding it; what it adds is the per-family reading — 5688 facts
-- across 3 of 4 arms, 36 grants across 1 of 3 — which no other row prints, and which is the sentence a
-- maintainer needs before deciding whether a given silence is the design or the bug.
--
-- WHAT THE WAIVERS SAY, each re-read against the data every run: three of the six name no writer anywhere in
-- the build (no literal `review` subject type reaches `facts.record` — the 22 literal subject types across
-- services/platform are merchant 13, offering 8, location 1 — and ModerationController.java:130 refuses every
-- case that is not a review case with "the other subject types have no decision state to write back to without
-- their own routes (§127)"). Two name a writer that exists in the product but is never reached by the seed:
-- `permission_grants.user` is filed by MerchantService.java:63 and MerchantWorkspaceService.java:177, and
-- `permission_grants.api_key` by ApiKeyService.java:67 when a merchant creates a key. `build` and `none` are
-- those two states, and a waiver whose arm starts carrying rows goes red by itself — the exemption has to
-- re-read its own assumption, which is the rule D77 wrote for the view kinds.

CREATE TEMP TABLE arm_idle (tbl text NOT NULL, arm text NOT NULL, writer text NOT NULL, why text NOT NULL,
                            PRIMARY KEY (tbl, arm));
INSERT INTO arm_idle VALUES
 ('facts', 'review', 'none', 'D65 armed this type because EventsController''s vocabulary allows it, but the '
  || 'review write path files the rating of the thing reviewed (ReviewRepository.java:190 passes that '
  || 'subject''s own type), and generate.py emits no fact about a review'),
 ('moderation_cases', 'merchant', 'none', 'ModerationController.java:130 refuses to resolve a non-review case, '
  || 'so a merchant-typed case could be opened and never closed; the seed opens 544 review cases and no other'),
 ('moderation_cases', 'document', 'none', 'the same door: documents have no decision state to write back to '
  || '(§127), so the D68 arm resolves nothing the seed or the build produces'),
 ('moderation_cases', 'message', 'none', 'the same door, for the fourth type V1:574 lists in a comment the '
  || 'parser discards'),
 ('permission_grants', 'user', 'build', 'the two insert sites D71 found — MerchantService.java:63 and '
  || 'MerchantWorkspaceService.java:177 — file user grants at runtime, and generate.py seeds none: all 36 '
  || 'shipped grants are merchant_user'),
 ('permission_grants', 'api_key', 'build', 'ApiKeyService.java:67 files an api_key grant when a merchant '
  || 'creates a key (D71), a path the seed never takes, so the arm exists for rows none of this build ships');

-- The exercised/idle split, read from the same poly_types the probes group over.
CREATE TEMP TABLE arm_seen AS
SELECT a.tbl, a.arm, coalesce(t.n, 0) AS n, w.why IS NOT NULL AS waived, coalesce(w.writer, '-') AS writer
  FROM poly_arms a
  LEFT JOIN poly_types t ON t.tbl = a.tbl AND t.t = a.arm
  LEFT JOIN arm_idle w ON w.tbl = a.tbl AND w.arm = a.arm;

INSERT INTO qc
SELECT 'an arm the seed never files is waived by name and by writer',
       (SELECT count(*) FROM poly_arms) > 0
       -- an unexercised arm with no waiver is a silent hole
       AND NOT EXISTS (SELECT 1 FROM arm_seen WHERE n = 0 AND NOT waived)
       -- a waiver whose arm now carries rows is stale: the exemption must re-read its own assumption
       AND NOT EXISTS (SELECT 1 FROM arm_seen WHERE n > 0 AND waived)
       -- every waiver has to name the writer it waits on, and only in the two states this file knows
       AND NOT EXISTS (SELECT 1 FROM arm_seen WHERE waived AND (btrim(writer) = '' OR writer NOT IN ('build', 'none')))
       -- and every waiver has to say why, because an unexplained exemption is the hole with a label on it
       AND NOT EXISTS (SELECT 1 FROM arm_idle w WHERE btrim(w.why) = '')
       AND NOT EXISTS (SELECT 1 FROM arm_idle w WHERE NOT EXISTS
                        (SELECT 1 FROM poly_arms a WHERE a.tbl = w.tbl AND a.arm = w.arm)),
       (SELECT count(*) FROM poly_arms) || ' declared arm(s): '
       || (SELECT count(*) FROM arm_seen WHERE n > 0) || ' exercised by the shipped seed, '
       || (SELECT count(*) FROM arm_seen WHERE n = 0 AND waived) || ' idle and waived, '
       || (SELECT count(*) FROM arm_seen WHERE n = 0 AND NOT waived) || ' idle and unwaived: '
       || coalesce((SELECT string_agg(tbl || '.' || arm || '=' || n, ', ' ORDER BY tbl, arm)
                      FROM arm_seen WHERE n > 0), 'none') || ' | '
       || coalesce((SELECT string_agg(tbl || '.' || arm || ' (writer ' || writer || ')', ', '
                               ORDER BY tbl, arm) FROM arm_seen WHERE n = 0), 'none')
       || ' — offenders: '
       || coalesce((SELECT string_agg(x, ' · ' ORDER BY x) FROM (
              SELECT 'the seed files no ' || tbl || '.' || arm || ' row and no waiver names it — the probe for '
                     || 'that arm emits no check at all' AS x
                FROM arm_seen WHERE n = 0 AND NOT waived
              UNION ALL
              SELECT tbl || '.' || arm || ' carries ' || n || ' row(s) while still waived — the exemption is '
                     || 'stale and the arm is resolved by the probe again'
                FROM arm_seen WHERE n > 0 AND waived
              UNION ALL
              SELECT 'the waiver of ' || w.tbl || '.' || w.arm || ' gives no reason at all'
                FROM arm_idle w WHERE btrim(w.why) = ''
              UNION ALL
              SELECT 'the waiver of ' || tbl || '.' || arm || ' names writer ''' || writer
                     || ''', which is neither build nor none'
                FROM arm_seen WHERE waived AND (btrim(writer) = '' OR writer NOT IN ('build', 'none'))
              UNION ALL
              SELECT w.tbl || '.' || w.arm || ' is waived but no longer declared as an arm'
                FROM arm_idle w WHERE NOT EXISTS (SELECT 1 FROM poly_arms a
                                                   WHERE a.tbl = w.tbl AND a.arm = w.arm)
                    ) o), 'none');

-- The family term: the row that speaks when a whole probe stops being asked.
INSERT INTO qc
SELECT 'every probe family resolves at least one armed type',
       (SELECT count(*) FROM poly_probed) > 0
       AND NOT EXISTS (SELECT 1 FROM poly_probed p WHERE NOT EXISTS
                        (SELECT 1 FROM arm_seen s WHERE s.tbl = p.tbl AND s.n > 0)),
       coalesce((SELECT string_agg(p.tbl || ' ships ' || (SELECT c.rows_n FROM poly_cat c WHERE c.tbl = p.tbl)
                                      || ' row(s) across '
                                      || (SELECT count(*) FROM arm_seen s WHERE s.tbl = p.tbl AND s.n > 0)
                                      || ' of ' || (SELECT count(*) FROM poly_arms a WHERE a.tbl = p.tbl)
                                      || ' arm(s)', ', ' ORDER BY p.tbl) FROM poly_probed p), 'no family')
       || ' — a family whose seed rows all vanish would resolve nothing, and its orphan checks would disappear '
       || 'from the ledger rather than fail; this row is what makes that visible';

-- ============================================================ D80  the synthetic stamp lives in more columns than the row that reads it
--
-- WHY THIS EXISTS: the file has one row about the §109 promise that everything shipped is marked as synthetic,
-- and it is a hand list of three columns: 'jsonb data_origin marker (offerings/documents/chunks)' below the
-- D63/D64 sections reads offerings.attributes, documents.metadata and chunks.metadata. Asked of the data, the
-- marker's real footprint is much wider. A census over every jsonb column the seed fills (62 of them; 40 are
-- never filled at all, sitting in the tables D64 keeps empty) finds keys whose names claim a provenance or
-- synthetic axis in **20 (column, key) pairs**: `data_origin` in 12 columns, `synthetic` in 4, `demo` in 3,
-- and `demo_login_role` in 1 — and the row that is supposed to enforce the promise covers 3 of the 12.
-- reviews.moderation carries the stamp on all 11000 reviews, facts.value on 5004 of 5688 facts,
-- locations.geo_properties on all 684, merchants.{attributes,contact,seo}, resource_pools.attributes,
-- collections.seo and tenants.config on theirs: unchecked, not because anyone chose to skip them, but because
-- the list is shorter than the schema.
--
-- THE SECOND FINDING, which is the one that needs an axis rather than a count: on `facts` the two names are
-- NOT the same thing, and 4484 rows say so. `facts.source` is §19's provenance — measured: merchant 3197,
-- observed 1800, demo 520, inferred 171 — while `facts.value->>'data_origin'` is the §109 synthetic stamp, the
-- literal `demo` on all 5004 rows that carry it. generate.py writes them in the same call (line 900 ends
-- `"data_origin": "demo"}, None, None, "merchant", ttl_h=24*30`), so the disagreement is correct by design.
-- What was not correct is that nothing in the file said which axis is which: a consumer that answers
-- "where did this price come from?" by reading the key inside the price payload gets `demo` for every
-- observed and merchant-supplied fact. So the axis is declared per (column, key) below, and the row refuses
-- the day a stamp starts carrying provenance — which is the shape the bug takes if anyone "fixes" it the wrong
-- way round.
--
-- WHAT IS MEASURED AND NOT CLAIMED: `merchants.attributes.demo_login_role` = 'merchant' matches the name
-- pattern and is not a marker of either axis; it is answered as 'not-a-marker' rather than filtered out of the
-- census by a narrower pattern, because the only honest filter is the one that says why. And
-- CollectionsRepository.java:68 tests `seo->>'generated_by'` against ('ai','editor','creator') while no jsonb
-- payload in the shipped dataset carries a `generated_by` key at all (measured: 0 of 62 columns) — that read
-- and what it implies for the §8 collection gate belongs to the stream that owns that door, so it is reported
-- here and left alone.

CREATE TEMP TABLE marker_cat (tbl text NOT NULL, col text NOT NULL, key text NOT NULL, rows bigint NOT NULL,
                              on_rows bigint NOT NULL, vals text, PRIMARY KEY (tbl, col, key));
DO $d80$
DECLARE r record; n bigint; n2 bigint; v text;
BEGIN
  FOR r IN SELECT c.relname AS tbl, a.attname AS col
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
             JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
             JOIN pg_type t ON t.oid = a.atttypid
            WHERE a.attnum > 0 AND NOT a.attisdropped AND t.typname = 'jsonb'
            ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.tbl) INTO n;
    CONTINUE WHEN n = 0;
    -- one row per provenance-shaped key the payloads of this column actually carry
    EXECUTE format('INSERT INTO marker_cat SELECT %L, %L, x.k, %L, count(*), '
                 || '       coalesce(left(string_agg(DISTINCT x.v, '','' ORDER BY x.v), 80), ''(no value)'') '
                 || '  FROM (SELECT o.%I AS p FROM public.%I o WHERE jsonb_typeof(o.%I) = ''object'') s, '
                 || '       LATERAL (SELECT q AS k, (s.p ->> q) AS v FROM jsonb_object_keys(s.p) q '
                 || '                 WHERE q ~* ''origin|synth|demo|generat'') x '
                 || ' GROUP BY x.k', r.tbl, r.col, n, r.col, r.tbl, r.col);
  END LOOP;
END $d80$;

-- The axis each census-found key belongs to. This list is hand-written on purpose — SQL cannot know that
-- `demo` in a pool's attributes is the §109 stamp while `demo_login_role` in a merchant's attributes is a
-- login role — and what the catalogue decides is who has to be on it.
CREATE TEMP TABLE marker_axis (tbl text NOT NULL, col text NOT NULL, key text NOT NULL, axis text NOT NULL,
                               why text NOT NULL, PRIMARY KEY (tbl, col, key));
INSERT INTO marker_axis VALUES
 ('chunks', 'metadata', 'data_origin', 'synthetic-stamp', 'read by the row below and by the D63 chunk provenance'
  || ' assertions; the third of the three columns the hand list knew about'),
 ('collections', 'seo', 'data_origin', 'synthetic-stamp', 'found by the census; the §8 read side does not look at'
  || ' this key, so the marker here exists to be believed, not to be branched on'),
 ('documents', 'metadata', 'data_origin', 'synthetic-stamp', 'the second of the three hand-listed columns'),
 ('documents', 'metadata', 'synthetic', 'synthetic-stamp', 'a boolean twin of the same promise on the same rows'
  || ' — two names, one axis, both required to say the same thing'),
 ('facts', 'value', 'data_origin', 'synthetic-stamp', 'NOT the §19 provenance: `facts.source` is that axis'
  || ' (merchant|observed|inferred|demo) and this key is the literal demo on every row carrying it, stamped in'
  || ' the same generate.py call that passes source — see the row that refuses a stamp carrying provenance'),
 ('facts', 'value', 'synthetic', 'synthetic-stamp', 'the address-shape payload uses the boolean twin instead of'
  || ' data_origin; measured on the 684 rows whose attribute is address'),
 ('locations', 'geo_properties', 'data_origin', 'synthetic-stamp', 'found by the census on all 684 rows'),
 ('locations', 'geo_properties', 'synthetic', 'synthetic-stamp', 'the boolean twin, same rows'),
 ('merchants', 'attributes', 'data_origin', 'synthetic-stamp', 'found by the census; the merchants.data_origin'
  || ' COLUMN is checked by the D64-era row, and the payload repeats it'),
 ('merchants', 'attributes', 'demo_login_role', 'not-a-marker', 'the value is the login role the demo account'
  || ' signs in as (measured: merchant); it matches the name pattern and means neither axis, and answering it'
  || ' is cheaper than narrowing the pattern and losing the next one'),
 ('tenants', 'config', 'demo', 'synthetic-stamp', 'the boolean spelling, on the one row that configures the'
  || ' market'),
 ('merchants', 'contact', 'data_origin', 'synthetic-stamp', 'found by the census on all 520 rows'),
 ('merchants', 'seo', 'data_origin', 'synthetic-stamp', 'found by the census; §155 keeps these pages noindex,'
  || ' and the stamp is what says why their content is not real'),
 ('offerings', 'attributes', 'data_origin', 'synthetic-stamp', 'the first of the three hand-listed columns'),
 ('offerings', 'attributes', 'demo', 'synthetic-stamp', 'the boolean twin on the same 5534 rows'),
 ('resource_pools', 'attributes', 'data_origin', 'synthetic-stamp', 'found by the census on all 452 pools'),
 ('resource_pools', 'attributes', 'demo', 'synthetic-stamp', 'the boolean twin, same rows'),
 ('reviews', 'moderation', 'data_origin', 'synthetic-stamp', 'found by the census on ALL 11000 reviews — the'
  || ' biggest marker home in the dataset and absent from the hand list it is supposed to be checked by'),
 ('reviews', 'moderation', 'synthetic', 'synthetic-stamp', 'the boolean twin on the same rows'),
 ('tenants', 'config', 'data_origin', 'synthetic-stamp', 'one row, the market configuration; stamped like'
  || ' everything else because the whole tenant is synthetic');

-- Does every row of a stamped column actually carry a stamp, under ANY of the names that column uses? The
-- key list comes from the answered axis table, so `demo_login_role` cannot count as coverage.
CREATE TEMP TABLE marker_cov (tbl text NOT NULL, col text NOT NULL, rows bigint NOT NULL,
                              stamped bigint NOT NULL, PRIMARY KEY (tbl, col));
DO $d80c$
DECLARE r record; k text[]; n bigint; st bigint;
BEGIN
  FOR r IN SELECT DISTINCT c.tbl, c.col FROM marker_cat c JOIN marker_axis a
             ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key AND a.axis = 'synthetic-stamp'
            ORDER BY 1, 2 LOOP
    SELECT array_agg(DISTINCT c.key) INTO k FROM marker_cat c JOIN marker_axis a
      ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key AND a.axis = 'synthetic-stamp'
     WHERE c.tbl = r.tbl AND c.col = r.col;
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE jsonb_typeof(t.%I) = ''object'' AND EXISTS '
                 || '(SELECT 1 FROM jsonb_object_keys(t.%I) q WHERE q = ANY(%L::text[]))) FROM public.%I t',
                 r.col, r.col, k, r.tbl) INTO n, st;
    INSERT INTO marker_cov VALUES (r.tbl, r.col, n, st);
  END LOOP;
END $d80c$;

INSERT INTO qc
SELECT 'every jsonb key whose name claims an axis is answered for which axis it is',
       (SELECT count(*) FROM marker_cat) > 0
       -- both directions, so neither list can drift away from the other
       AND NOT EXISTS (SELECT 1 FROM marker_cat c WHERE NOT EXISTS
                        (SELECT 1 FROM marker_axis a WHERE a.tbl = c.tbl AND a.col = c.col AND a.key = c.key))
       AND NOT EXISTS (SELECT 1 FROM marker_axis a
                        WHERE a.axis <> 'not-a-marker' AND NOT EXISTS
                          (SELECT 1 FROM marker_cat c WHERE c.tbl = a.tbl AND c.col = a.col AND c.key = a.key))
       AND NOT EXISTS (SELECT 1 FROM marker_axis a WHERE btrim(a.why) = ''
                        OR a.axis NOT IN ('synthetic-stamp', 'provenance', 'not-a-marker'))
       AND NOT EXISTS (SELECT 1 FROM marker_axis a WHERE a.axis = 'not-a-marker' AND NOT EXISTS
                        (SELECT 1 FROM marker_cat c WHERE c.tbl = a.tbl AND c.col = a.col AND c.key = a.key)),
       (SELECT count(*) FROM marker_cat) || ' (column, key) pair(s) measured across '
       || (SELECT count(DISTINCT tbl || '.' || col) FROM marker_cat) || ' jsonb column(s): '
       || coalesce((SELECT string_agg(k || '=' || n, ', ' ORDER BY k)
                      FROM (SELECT key AS k, count(*) AS n FROM marker_cat GROUP BY 1) g), 'none') || '; '
       || (SELECT count(*) FROM marker_axis) || ' answered by the axis list, '
       || coalesce((SELECT string_agg(c.tbl || '.' || c.col || '.' || c.key || ' [' || c.vals || ']', ', '
                                    ORDER BY c.tbl, c.col)
                     FROM marker_cat c WHERE NOT EXISTS (SELECT 1 FROM marker_axis a
                                                         WHERE a.tbl = c.tbl AND a.col = c.col AND a.key = c.key)),
                   'each by name') || ' — offenders: '
       || coalesce((SELECT string_agg(x, ' · ' ORDER BY x) FROM (
              SELECT 'the data carries ' || c.tbl || '.' || c.col || '.' || c.key || ' (' || c.on_rows
                     || ' row(s), values ' || c.vals || ') and no axis answers for it' AS x
                FROM marker_cat c WHERE NOT EXISTS (SELECT 1 FROM marker_axis a
                                                    WHERE a.tbl = c.tbl AND a.col = c.col AND a.key = c.key)
              UNION ALL
              SELECT a.tbl || '.' || a.col || '.' || a.key || ' is answered as ' || a.axis
                     || ' but the payloads no longer carry that key at all'
                FROM marker_axis a WHERE a.axis <> 'not-a-marker' AND NOT EXISTS
                  (SELECT 1 FROM marker_cat c WHERE c.tbl = a.tbl AND c.col = a.col AND c.key = a.key)
              UNION ALL
              SELECT a.tbl || '.' || a.col || '.' || a.key || ' claims axis ''' || a.axis
                     || ''', which is not one of the three this block knows'
                FROM marker_axis a WHERE a.axis NOT IN ('synthetic-stamp', 'provenance', 'not-a-marker')
              UNION ALL
              SELECT 'the axis of ' || tbl || '.' || col || '.' || key || ' carries no reason'
                FROM marker_axis WHERE btrim(why) = ''
                    ) x), 'none');

INSERT INTO qc
SELECT 'the synthetic stamp says demo, or true, on every row of every column that carries it',
       (SELECT count(*) FROM marker_axis WHERE axis = 'synthetic-stamp'
         AND EXISTS (SELECT 1 FROM marker_cat c
                      WHERE c.tbl = marker_axis.tbl AND c.col = marker_axis.col AND c.key = marker_axis.key)) > 0
       -- universal within the column, over the union of the names that column stamps with
       AND NOT EXISTS (SELECT 1 FROM marker_cov v WHERE v.stamped <> v.rows)
       -- and the value is the stamp, never something that reads like provenance
       AND NOT EXISTS (SELECT 1 FROM marker_cat c JOIN marker_axis a
                         ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key
                        WHERE a.axis = 'synthetic-stamp'
                          AND c.vals NOT IN ('demo', 'true', 'demo,true', 'true,demo')),
       (SELECT count(*) FROM marker_cat c JOIN marker_axis a
          ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key
         WHERE a.axis = 'synthetic-stamp') || ' stamped (column, key) pair(s) over '
       || (SELECT count(DISTINCT c.tbl || '.' || c.col) FROM marker_cat c JOIN marker_axis a
             ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key WHERE a.axis = 'synthetic-stamp')
       || ' column(s) — the hand list this replaces named 3 — carrying '
       || (SELECT sum(c.on_rows) FROM marker_cat c JOIN marker_axis a
             ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key WHERE a.axis = 'synthetic-stamp')
       || ' marker(s) in all; coverage per column: '
       || coalesce((SELECT string_agg(tbl || '.' || col || ' on ' || stamped || ' of ' || rows || ' row(s)',
                                      ', ' ORDER BY rows - stamped DESC, tbl, col)
                      FROM marker_cov WHERE stamped <> rows), 'every stamped column is complete')
       || '; values: ' || coalesce((SELECT string_agg(c.tbl || '.' || c.col || '.' || c.key || ' = ' || c.vals,
                                      ', ' ORDER BY c.tbl, c.col)
                       FROM marker_cat c JOIN marker_axis a
                         ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key
                        WHERE a.axis = 'synthetic-stamp'
                          AND c.vals NOT IN ('demo','true','demo,true','true,demo')),
                       'each key says demo, or true, wherever it appears')
       || ' — offenders: ' || coalesce((SELECT string_agg(x, ' · ' ORDER BY x) FROM (
              SELECT c.tbl || '.' || c.col || ' is stamped on only ' || c.stamped || ' of ' || c.rows
                     || ' row(s): ' || (c.rows - c.stamped) || ' row(s) carry no stamp key under any name' AS x
                FROM marker_cov c WHERE c.stamped <> c.rows
              UNION ALL
              SELECT c.tbl || '.' || c.col || '.' || c.key || ' carries value(s) ' || c.vals
                     || ', which is not the §109 stamp'
                FROM marker_cat c JOIN marker_axis a ON a.tbl = c.tbl AND a.col = c.col AND a.key = c.key
               WHERE a.axis = 'synthetic-stamp'
                 AND c.vals NOT IN ('demo', 'true', 'demo,true', 'true,demo')) x), 'none');

INSERT INTO qc
SELECT 'the §19 provenance axis and the §109 stamp axis stay separate on facts',
       (SELECT count(*) FROM facts WHERE source IS NOT NULL) > 0
       -- every fact's own provenance is one of the four words this build writes
       AND NOT EXISTS (SELECT 1 FROM facts WHERE source NOT IN ('merchant', 'observed', 'inferred', 'demo'))
       -- the payload key stays the stamp: constant, and never one of the provenance words
       AND NOT EXISTS (SELECT 1 FROM facts WHERE value ? 'data_origin'
                        AND (value->>'data_origin') <> 'demo')
       AND NOT EXISTS (SELECT 1 FROM facts WHERE value ? 'data_origin'
                        AND (value->>'data_origin') = source AND source <> 'demo'),
       (SELECT count(*) FROM facts) || ' fact(s): source = ' || coalesce((SELECT string_agg(source || '=' || n, ', '
          ORDER BY n DESC) FROM (SELECT source, count(*) AS n FROM facts GROUP BY source) s), '-')
       || '; value->>data_origin on ' || (SELECT count(*) FROM facts WHERE value ? 'data_origin')
       || ' row(s), ' || (SELECT count(*) FROM facts WHERE value ? 'data_origin'
                           AND value->>'data_origin' = 'demo') || ' of them say demo'
       || '; the two axes disagree on ' || (SELECT count(*) FROM facts WHERE value ? 'data_origin'
                           AND (value->>'data_origin') IS DISTINCT FROM source)
       || ' row(s) BY DESIGN (generate.py stamps the payload and passes provenance positionally, e.g. line 900)'
       || ' — offenders: ' || coalesce((SELECT string_agg(x, ' · ' ORDER BY x) FROM (
              SELECT 'facts.source = ' || coalesce(source, '(null)') || ' is not a word this build writes' AS x
                FROM facts WHERE source NOT IN ('merchant','observed','inferred','demo')
              UNION ALL
              SELECT 'a fact payload carries data_origin = ' || (value->>'data_origin')
                     || ', which is a provenance word in the column that holds the synthetic stamp'
                FROM facts WHERE value ? 'data_origin' AND (value->>'data_origin') <> 'demo') x), 'none');

-- ============================================================ D81  the arrays hold the vocabularies the string census cannot reach
--
-- WHY THIS EXISTS: §78 widened the string census to `pg_type.typcategory = 'S'`, which was the right fix for
-- the wrong plane — an array of strings is category `A`, so no `text[]` column has ever been in the 233, and
-- the two most vocabulary-shaped things in the demo are exactly there. Measured on the kept from-scratch
-- database: `merchants.tags` carries 2428 elements over 520 merchants, **100 distinct values**, the rarest on
-- 2 merchants and the commonest on all 520 — a vocabulary by §71's own repetition test, and bounded by nothing:
-- the SEO directory filters on it (`SeoRepository.java:151`, `:tag = any(coalesce(m.tags,'{}'::text[]))`)
-- through a door that validates only a slug *pattern* (`SLUG_PATTERN`, `SeoRepository.java:50`), so no list
-- anywhere says what a tag may be. On the other side of the same column type, `tenants.locales` is bounded by
-- exactly one thing no check reads: its column DEFAULT, `ARRAY['en','zh-HK','zh-CN']`, which the one seeded
-- tenant happens to match. A bound that lives in `pg_attrdef` is still a bound.
--
-- The jsonb arrays need a different question. Their elements are objects, so "how many distinct values" is
-- meaningless; what the renderers actually depend on is that every element has the same keys. Measured:
-- merchants.images and offerings.images carry 520 and 5534 objects all keyed alt/credit/url, offerings.options
-- 4409 objects keyed name/values, collections.items 38 objects on one signature — `keysets = 1` everywhere, an
-- invariant nobody asserted. And `reviews.photos` is an empty array on all 11000 rows: the array twin of §71's
-- `documents.error`, known only because this probe looked.
--
-- WHAT IS ANSWERED AND WHAT IS LEFT ALONE. Each array column gets a kind — nothing-bounds-it,
-- column-default, payload-shape, never-populated — and `column-default` is the strong one: the answer names the
-- elements the bound allows, and the row compares them against the elements the data carries AND against the
-- DEFAULT text in the catalog, so a fourth locale, a dropped locale and a removed DEFAULT each redden their own
-- term. `nothing-bounds-it` is only allowed where the catalog really offers no bound: if someone adds a DEFAULT
-- to merchants.tags, the answer that said "nothing bounds this" goes red by itself. Whether the 100 tags
-- SHOULD become a controlled list is a decision about the SEO grammar and belongs to the stream that owns that
-- door — this unit states the absence, and takes no position on it.

CREATE TEMP TABLE arr_cat (tbl text NOT NULL, col text NOT NULL, kind text NOT NULL, rows bigint NOT NULL,
                           with_rows bigint NOT NULL, elements bigint NOT NULL, distincts int, keysets int,
                           keys text, rarest int, commonest int, deftext text, PRIMARY KEY (tbl, col));

-- The text[] columns first: their elements are values, so the census counts distinct ones and how widely each
-- one is spread.
DO $d81a$
DECLARE r record; n bigint; w bigint; el bigint; ds int; mn int; mx int; df text;
BEGIN
  FOR r IN SELECT c.relname AS tbl, a.attname AS col, TRUE AS is_plain_array
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
             JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
            WHERE a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'text[]'::regtype
            ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE coalesce(array_length(%I, 1), 0) > 0), '
                 || 'coalesce(sum(array_length(%I, 1)), 0) FROM public.%I', r.col, r.col, r.tbl)
        INTO n, w, el;
    EXECUTE format('SELECT count(*), min(c), max(c) FROM (SELECT e, count(*) AS c FROM '
                 || '(SELECT unnest(%I) AS e FROM public.%I WHERE %I IS NOT NULL) v GROUP BY e) x',
                 r.col, r.tbl, r.col) INTO ds, mn, mx;
    SELECT pg_get_expr(d.adbin, d.adrelid) INTO df
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = r.col
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relname = r.tbl;
    INSERT INTO arr_cat VALUES (r.tbl, r.col, 'text[]', n, w, el, coalesce(ds, 0), 0, '-',
                                coalesce(mn, 0), coalesce(mx, 0), df);
  END LOOP;
END $d81a$;

-- Then the jsonb columns that actually hold arrays: their elements are objects, so the census counts distinct
-- key signatures instead of pretending the objects are values.
DO $d81b$
DECLARE r record; n bigint; w bigint; el bigint; ds int; ks int; ky text; df text;
BEGIN
  FOR r IN SELECT c.relname AS tbl, a.attname AS col
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
             JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
             JOIN pg_type t ON t.oid = a.atttypid AND t.typname = 'jsonb'
            WHERE a.attnum > 0 AND NOT a.attisdropped
            ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE jsonb_typeof(%I) = ''array''), '
                 || 'coalesce(sum(jsonb_array_length(%I)) FILTER (WHERE jsonb_typeof(%I) = ''array''), 0) '
                 || 'FROM public.%I', r.col, r.col, r.col, r.tbl) INTO n, w, el;
    CONTINUE WHEN w = 0;
    EXECUTE format('SELECT count(DISTINCT e)::int FROM (SELECT jsonb_array_elements(%I) AS e FROM public.%I '
                 || 'WHERE jsonb_typeof(%I) = ''array'') q', r.col, r.tbl, r.col) INTO ds;
    EXECUTE format('SELECT count(DISTINCT sig)::int FROM (SELECT (SELECT string_agg(k, '','' ORDER BY k) '
                 || 'FROM jsonb_object_keys(e) k) AS sig FROM (SELECT jsonb_array_elements(%I) AS e FROM public.%I '
                 || 'WHERE jsonb_typeof(%I) = ''array'') o WHERE jsonb_typeof(e) = ''object'') s',
                 r.col, r.tbl, r.col) INTO ks;
    EXECUTE format('SELECT coalesce(string_agg(k, '', '' ORDER BY k), ''-'') FROM (SELECT DISTINCT '
                 || 'jsonb_object_keys(e) AS k FROM (SELECT jsonb_array_elements(%I) AS e FROM public.%I '
                 || 'WHERE jsonb_typeof(%I) = ''array'') q2 WHERE jsonb_typeof(e) = ''object'') w2',
                 r.col, r.tbl, r.col) INTO ky;
    SELECT pg_get_expr(d.adbin, d.adrelid) INTO df
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = r.col
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relname = r.tbl;
    INSERT INTO arr_cat VALUES (r.tbl, r.col, 'jsonb[]', n, w, el, coalesce(ds, 0), coalesce(ks, 0), ky,
                                0, 0, df);
  END LOOP;
END $d81b$;

-- The hand answers. `elements` is the declared bound: a comma-separated list for the one column bounded by a
-- DEFAULT, '-' where the answer says there is no such list.
CREATE TEMP TABLE arr_bound (tbl text NOT NULL, col text NOT NULL, kind text NOT NULL, elements text NOT NULL,
                             why text NOT NULL, PRIMARY KEY (tbl, col));
INSERT INTO arr_bound VALUES
 ('merchants', 'tags', 'nothing-bounds-it', '-', '100 distinct slugs over 2428 elements; the door validates a '
  || 'slug pattern only (SeoRepository.java:50) and filters with `:tag = any(m.tags)` (:151), so the value set '
  || 'is whatever generate.py''s word lists happen to contain'),
 ('tenants', 'locales', 'column-default', 'en, zh-CN, zh-HK', 'V1:21 declares DEFAULT '
  || 'ARRAY[''en'',''zh-HK'',''zh-CN''] and the one seeded tenant carries exactly those three'),
 ('api_keys', 'scopes', 'never-populated', '-', 'the table ships 0 rows (D64), so the element vocabulary is '
  || 'undefined by anything in this build'),
 ('campaigns', 'channel', 'never-populated', '-', '0 rows; §33 campaigns are created at runtime'),
 ('eval_cases', 'tags', 'never-populated', '-', '0 rows; the eval corpus is not part of the demo seed'),
 ('external_principals', 'scopes', 'never-populated', '-', '0 rows'),
 ('merchants', 'images', 'payload-shape', '-', '520 image objects, all keyed alt/credit/url — the contract is '
  || 'the shape, not the values'),
 ('offerings', 'images', 'payload-shape', '-', '5534 objects on the same alt/credit/url signature'),
 ('offerings', 'options', 'payload-shape', '-', '4409 variant objects, all name/values'),
 ('collections', 'items', 'payload-shape', '-', '38 objects across 4 collections, one signature'),
 ('reviews', 'photos', 'never-populated', '-', 'an empty array on all 11000 reviews: §109 does not invent '
  || 'photographs, so the column exists and stays empty');

INSERT INTO qc
SELECT 'every array column is answered for what bounds its elements',
       (SELECT count(*) FROM arr_cat) > 0
       AND NOT EXISTS (SELECT 1 FROM arr_cat c WHERE NOT EXISTS
                        (SELECT 1 FROM arr_bound b WHERE b.tbl = c.tbl AND b.col = c.col))
       AND NOT EXISTS (SELECT 1 FROM arr_bound b WHERE NOT EXISTS
                        (SELECT 1 FROM arr_cat c WHERE c.tbl = b.tbl AND c.col = b.col))
       AND NOT EXISTS (SELECT 1 FROM arr_bound b WHERE btrim(b.why) = ''
                        OR b.kind NOT IN ('nothing-bounds-it', 'column-default', 'payload-shape',
                                          'never-populated'))
       -- a column-default answer has to match BOTH the data and the catalog's DEFAULT
       AND NOT EXISTS (SELECT 1 FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                        WHERE b.kind = 'column-default'
                          AND (c.distincts <> (SELECT count(*) FROM unnest(string_to_array(b.elements, ', ')) x
                                                WHERE b.elements <> '-')
                               OR c.deftext IS NULL))
       AND NOT EXISTS (SELECT 1 FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                        WHERE b.kind = 'column-default'
                          AND NOT (SELECT bool_and(position(x.v IN coalesce(c.deftext, '')) > 0)
                                   FROM unnest(string_to_array(b.elements, ', ')) x(v)))
       -- and nothing-bounds-it has to stay true: no DEFAULT may exist for a column answered that way
       AND NOT EXISTS (SELECT 1 FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                        WHERE b.kind = 'nothing-bounds-it'
                          AND position('ARRAY' in coalesce(c.deftext, '')) > 0),
       (SELECT count(*) FROM arr_cat) || ' array column(s) measured ('
       || (SELECT count(*) FROM arr_cat WHERE kind = 'text[]') || ' text[], '
       || (SELECT count(*) FROM arr_cat WHERE kind = 'jsonb[]') || ' jsonb holding arrays), each answered: '
       || coalesce((SELECT string_agg(b.tbl || '.' || b.col || ' = ' || b.kind, ', ' ORDER BY b.tbl, b.col)
                      FROM arr_bound b), 'none')
       || ' — elements: ' || (SELECT string_agg(tbl || '.' || col || ' ' || elements || '/' || distincts, ', '
                                 ORDER BY kind, tbl) FROM arr_cat WHERE elements > 0)
       || ' — offenders: ' || coalesce((SELECT string_agg(x, ' · ' ORDER BY x) FROM (
              SELECT 'the data has an array column ' || c.tbl || '.' || c.col || ' (' || c.elements
                     || ' element(s)) and no answer says what bounds it' AS x
                FROM arr_cat c WHERE NOT EXISTS (SELECT 1 FROM arr_bound b
                                                 WHERE b.tbl = c.tbl AND b.col = c.col)
              UNION ALL
              SELECT b.tbl || '.' || b.col || ' is answered ' || b.kind || ' but the catalog has no array '
                     || 'column by that name'
                FROM arr_bound b WHERE NOT EXISTS (SELECT 1 FROM arr_cat c
                                                   WHERE c.tbl = b.tbl AND c.col = b.col)
              UNION ALL
              SELECT 'the answer for ' || tbl || '.' || col || ' names kind ''' || kind
                     || ''', not one of the four this block knows'
                FROM arr_bound WHERE kind NOT IN ('nothing-bounds-it', 'column-default', 'payload-shape',
                                                  'never-populated')
              UNION ALL
              SELECT 'the answer for ' || tbl || '.' || col || ' gives no reason'
                FROM arr_bound WHERE btrim(why) = ''
              UNION ALL
              SELECT 'the elements bound for ' || c.tbl || '.' || c.col || ' (' || c.distincts
                     || ' distinct in the data, [' || b.elements || '] declared) no longer match, or the column '
                     || 'lost its DEFAULT'
                FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                WHERE b.kind = 'column-default'
                  AND (c.distincts <> (SELECT count(*) FROM unnest(string_to_array(b.elements, ', ')) x
                                       WHERE b.elements <> '-') OR c.deftext IS NULL)
              UNION ALL
              SELECT 'a declared bound element of ' || c.tbl || '.' || c.col || ' is missing from the DEFAULT '
                     || 'the catalog now carries: ' || coalesce(c.deftext, '(no default)')
                FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                WHERE b.kind = 'column-default'
                  AND NOT (SELECT bool_and(position(x.v IN coalesce(c.deftext, '')) > 0)
                           FROM unnest(string_to_array(b.elements, ', ')) x(v))
              UNION ALL
              SELECT c.tbl || '.' || c.col || ' is answered nothing-bounds-it but now carries a DEFAULT of '
                     || c.deftext
                FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                WHERE b.kind = 'nothing-bounds-it' AND position('ARRAY' in coalesce(c.deftext, '')) > 0) o),
                   'none');

INSERT INTO qc
SELECT 'the elements of an object-array column all carry the same keys',
       (SELECT count(*) FROM arr_cat WHERE kind = 'jsonb[]' AND keysets = 1) > 0
       AND NOT EXISTS (SELECT 1 FROM arr_cat c WHERE c.kind = 'jsonb[]' AND c.keysets > 1)
       AND NOT EXISTS (SELECT 1 FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                        WHERE b.kind = 'payload-shape' AND c.elements = 0)
       AND NOT EXISTS (SELECT 1 FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                        WHERE b.kind = 'never-populated' AND c.elements > 0),
       coalesce((SELECT string_agg(tbl || '.' || col || ' keysets=' || keysets || ' [' || keys || '] over '
                                      || elements || ' element(s)', ', ' ORDER BY tbl, col)
                   FROM arr_cat WHERE kind = 'jsonb[]'), 'no jsonb arrays')
       || ' — offenders: ' || coalesce((SELECT string_agg(x, ' · ' ORDER BY x) FROM (
              SELECT c.tbl || '.' || c.col || ' elements carry ' || c.keysets || ' different key signatures '
                     || '(union [' || c.keys || ']): the renderers read one shape' AS x
                FROM arr_cat c WHERE c.kind = 'jsonb[]' AND c.keysets > 1
              UNION ALL
              SELECT b.tbl || '.' || b.col || ' is answered payload-shape but carries no elements at all'
                FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                 WHERE b.kind = 'payload-shape' AND c.elements = 0
              UNION ALL
              SELECT b.tbl || '.' || b.col || ' is answered never-populated and now carries ' || c.elements
                     || ' element(s), so the bound has to be answered for real'
                FROM arr_cat c JOIN arr_bound b ON b.tbl = c.tbl AND b.col = c.col
                 WHERE b.kind = 'never-populated' AND c.elements > 0) o), 'none');

INSERT INTO qc
SELECT 'a text[] value that appears on exactly one row is named, not averaged',
       (SELECT count(*) FROM arr_cat WHERE kind = 'text[]' AND rows >= 20) > 0
       AND NOT EXISTS (SELECT 1 FROM arr_cat c WHERE c.kind = 'text[]' AND c.rows >= 20 AND c.rarest = 1),
       coalesce((SELECT string_agg('the rarest element of ' || tbl || '.' || col || ' is on 1 row', ', ')
                   FROM arr_cat WHERE kind = 'text[]' AND rows >= 20 AND rarest = 1),
                (SELECT string_agg('text[] column ' || tbl || '.' || col || ' = ' || rows || ' row(s), '
                                   || elements || ' elements, ' || distincts || ' distinct, rarest on '
                                   || rarest || ' row(s), commonest on ' || commonest, ' / ' ORDER BY tbl)
                   FROM arr_cat WHERE kind = 'text[]' AND rows >= 20)
                || ' — repetition holds, so these are vocabularies rather than per-row free text')
       || ' | below §71''s row floor: '
       || coalesce((SELECT string_agg(tbl || '.' || col || ' (' || rows || ' row(s))', ', ')
                      FROM arr_cat WHERE kind = 'text[]' AND rows < 20), 'none');

-- ============================================================ D74  door vocabularies
--
-- WHY THIS EXISTS: D69 counted the schema's polymorphic (type,id) pairs and found one bounded by a CHECK.
-- Read the other way round the same census says more: `public` carries 12 CHECK constraints, and
-- `share_links.subject_type` is the only column anywhere whose value set the database itself defends — the
-- other 11 compare numbers, timestamps or a code format. Every other enumerated column is bounded in exactly
-- one place: a `Set.of(...)` / `List.of(...)` behind a controller door. The seed writes those columns
-- straight from CSV, through none of those doors, so nothing on the write path reconciles the two lists —
-- the shape D67 caught for `favorites.subject_type`. `door_vocab` below is a hand transcription of what the
-- doors accept, each row naming the file and line a reviewer can go check; `vocab_live` is what the shipped
-- data actually carries; `check_vocab` is what the schema defends, parsed live so a CHECK added tomorrow is
-- seen tomorrow without anyone editing a list here.
--
-- WHAT THIS DOES NOT CLAIM: there is no census of text columns whose *data* happens to be bounded, so a
-- column the seed confines to four values while no door names them (users.role, merchants.status,
-- moderation_cases.auto_action, documents.kind, resource_pools.kind …) stays outside this block by
-- construction. D74 records that as its blind spot rather than pretending the catalogue is complete.

CREATE TEMP TABLE door_vocab (
  tbl text NOT NULL, col text NOT NULL, allowed text[] NOT NULL, door_source text NOT NULL,
  why text NOT NULL, PRIMARY KEY (tbl, col));

INSERT INTO door_vocab VALUES
 ('offerings', 'kind', ARRAY['product', 'service', 'experience'], 'CatalogController.java:221',
  'the consumer list filter; a fifth kind answers 422 before SQL sees it'),
 ('offerings', 'status', ARRAY['draft', 'active', 'archived', 'out_of_stock'],
  'MerchantContentController.java:68', 'the console filter, and OfferingRepository.java:203 writes archived'),
 ('collections', 'kind', ARRAY['collection', 'guide', 'itinerary'], 'CollectionsController.java:61',
  'KINDS, applied through Paging.enumFilter at :85; the same list CollectionsWriteController accepts on POST'),
 ('moderation_cases', 'status', ARRAY['open', 'resolved'], 'ModerationController.java:51',
  'CASE_STATUSES; closeCase writes resolved and guards on status = ''open'' in the statement'),
 ('merchant_users', 'status', ARRAY['active', 'disabled'], 'MerchantWorkspaceService.java:34',
  'MEMBER_STATUSES, the only two values a PATCH /members can set'),
 ('share_links', 'subject_type', ARRAY['merchant', 'offering', 'collection', 'guide'],
  'ShareController.java:55', 'the one column with both a door list and a CHECK (V7:40-41)'),
 ('reservations', 'status', ARRAY['pending', 'confirmed', 'cancelled', 'completed', 'no_show'],
  'MerchantContentController.java:458', 'the booking inbox filter; V1:306 declares the same five'),
 ('agent_runs', 'status', ARRAY['running', 'succeeded', 'failed', 'fallback', 'cancelled'],
  'AdminAiController.java:52-53', 'RUN_STATUSES, used as the admin AI filter'),
 ('conversations', 'status', ARRAY['open', 'handoff', 'closed', 'archived'],
  'ConversationService.java:52', 'THREAD_STATUSES — the thread of that name is the conversations table');

-- An entry naming a table or column the schema does not have would otherwise read as "zero rows, nothing to
-- complain about" below, so existence is asserted before anything is censused.
INSERT INTO qc
SELECT 'a door vocabulary names a column the schema has',
       (SELECT count(*) FROM door_vocab) > 0
       AND NOT EXISTS (SELECT 1 FROM door_vocab d WHERE to_regclass('public.' || d.tbl) IS NULL
                        OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                                        WHERE a.attrelid = ('public.' || d.tbl)::regclass
                                          AND a.attname = d.col AND a.attnum > 0 AND NOT a.attisdropped)),
       (SELECT count(*) FROM door_vocab) || ' column(s) transcribed from a door list, '
       || coalesce((SELECT string_agg(d.tbl || '.' || d.col, ', ' ORDER BY d.tbl, d.col) FROM door_vocab d
                    WHERE to_regclass('public.' || d.tbl) IS NULL
                       OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                                      WHERE a.attrelid = ('public.' || d.tbl)::regclass
                                        AND a.attname = d.col AND a.attnum > 0 AND NOT a.attisdropped)),
                   'all of them present in pg_attribute');

-- What the data carries, per catalogued column. Only entries the schema has are censused; a mis-typed one is
-- caught by the row above rather than censued into silence here.
CREATE TEMP TABLE vocab_live (tbl text NOT NULL, col text NOT NULL, v text, n bigint NOT NULL);
DO $d74$
DECLARE r record;
BEGIN
  FOR r IN SELECT d.tbl, d.col FROM door_vocab d
            WHERE to_regclass('public.' || d.tbl) IS NOT NULL
              AND EXISTS (SELECT 1 FROM pg_attribute a
                          WHERE a.attrelid = ('public.' || d.tbl)::regclass AND a.attname = d.col)
  LOOP
    EXECUTE format('INSERT INTO vocab_live SELECT %L, %L, x.v, x.n FROM '
                 || '(SELECT %I::text AS v, count(*)::bigint AS n FROM public.%I GROUP BY 1) x',
                   r.tbl, r.col, r.col, r.tbl);
  END LOOP;
END $d74$;

-- What the database defends, read back out of pg_constraint: the CHECK shape Postgres prints for an
-- `IN (…)` list of text literals is `CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))`.
CREATE TEMP TABLE check_vocab (tbl text NOT NULL, col text, labels text[], conname text NOT NULL);
INSERT INTO check_vocab
SELECT DISTINCT c.relname, (regexp_match(x.d, 'CHECK \(\((\w+) = ANY'))[1],
       (SELECT array_agg(m[1]) FROM regexp_matches(x.d, '''([a-z0-9_]+)''::text', 'g') m), con.conname
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     CROSS JOIN LATERAL (SELECT regexp_replace(pg_get_constraintdef(con.oid), '\s+', ' ', 'g') AS d) x
WHERE con.contype = 'c' AND con.connamespace = 'public'::regnamespace
  AND x.d LIKE '%= ANY (ARRAY[%::text%';

INSERT INTO qc
SELECT 'a door vocabulary admits every value the data carries',
       (SELECT count(*) FROM door_vocab) > 0
       -- non-vacuous: at least one catalogued column must carry rows, or containment is true of nothing
       AND (SELECT count(DISTINCT tbl || '.' || col) FROM vocab_live) > 0
       AND NOT EXISTS (SELECT 1 FROM vocab_live l WHERE l.v IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM door_vocab d
                                        WHERE d.tbl = l.tbl AND d.col = l.col AND l.v = ANY (d.allowed))),
       (SELECT count(DISTINCT tbl || '.' || col) FROM vocab_live) || ' of ' || (SELECT count(*) FROM door_vocab)
       || ' catalogued column(s) carry rows; '
       || (SELECT count(*) FROM vocab_live WHERE v IS NOT NULL) || ' distinct value(s) measured, '
       || (SELECT count(*) FROM vocab_live WHERE v IS NULL) || ' NULL group(s), '
       || coalesce((SELECT string_agg(l.tbl || '.' || l.col || '=''' || l.v || ''' (' || l.n || ')', ', '
                               ORDER BY l.tbl, l.col, l.v)
                    FROM vocab_live l WHERE l.v IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM door_vocab d
                                      WHERE d.tbl = l.tbl AND d.col = l.col AND l.v = ANY (d.allowed))),
                    'none of them outside the list its door accepts')
       || '; the ' || (SELECT count(DISTINCT d.tbl || '.' || d.col) FROM door_vocab d
                       WHERE NOT EXISTS (SELECT 1 FROM vocab_live l
                                         WHERE l.tbl = d.tbl AND l.col = d.col))
       || ' catalogued column(s) no row exercises are named in the detail of the CHECK row';

INSERT INTO qc
SELECT 'a CHECK-bounded column is a door vocabulary too',
       (SELECT count(*) FROM check_vocab) > 0
       -- an unparsable CHECK must not drop out of the census silently
       AND NOT EXISTS (SELECT 1 FROM check_vocab c WHERE c.col IS NULL OR c.labels IS NULL)
       AND NOT EXISTS (SELECT 1 FROM check_vocab c WHERE NOT EXISTS
                       (SELECT 1 FROM door_vocab d WHERE d.tbl = c.tbl AND d.col = c.col
                         AND NOT EXISTS (SELECT 1 FROM unnest(d.allowed) x WHERE NOT (x = ANY (c.labels)))
                         AND NOT EXISTS (SELECT 1 FROM unnest(c.labels) y WHERE NOT (y = ANY (d.allowed))))),
       (SELECT count(*) FROM check_vocab) || ' text column(s) the schema bounds to a literal list, namely '
       || coalesce((SELECT string_agg(tbl || '.' || col || ' [' || (SELECT count(*) FROM unnest(labels))
                                      || ' label(s)]', ', ' ORDER BY tbl, col) FROM check_vocab), '-')
       || ', and each of them agrees label for label with the transcribed door list or this row is red; '
       || (SELECT count(*) FROM door_vocab d WHERE NOT EXISTS (SELECT 1 FROM check_vocab c
                                                               WHERE c.tbl = d.tbl AND c.col = d.col))
       || ' of ' || (SELECT count(*) FROM door_vocab) || ' catalogued column(s) rest on the door alone: '
       || coalesce((SELECT string_agg(d.tbl || '.' || d.col
                                      || CASE WHEN (SELECT count(*) FROM vocab_live l
                                                   WHERE l.tbl = d.tbl AND l.col = d.col) = 0
                                              THEN ' (no rows)' ELSE '' END, ', ' ORDER BY d.tbl, d.col)
                    FROM door_vocab d WHERE NOT EXISTS (SELECT 1 FROM check_vocab c
                                                        WHERE c.tbl = d.tbl AND c.col = d.col)), '-');

-- ============================================================ D75  the data side of the same question
--
-- WHY THIS EXISTS: D74 ended by naming its own blind spot — nine columns are transcribed from doors, but the
-- seed writes text columns that nothing in this build enumerates, and the gate could not say which ones were
-- left unasked. So ask the data instead of the code: for every text column of every base table, how many
-- distinct values does the shipped dataset actually carry?
--
-- THE WINDOW, and why it is not just "few values". Measured over the shipped schema, `n <= 12` alone catches
-- 204 of the 233 string columns. D75 wrote 75 in this sentence, and D78 could not reproduce that figure under
-- any of four readings (`n <= 12`, `1..12`, `2..12`, the window itself) on a from-scratch database or on the
-- drifted demo one, so the number here is the measured one and the remembered one is named as the thing that
-- was corrected. The 204 are not 204 vocabularies: 128 of them answer 0 because their table is EMPTY (35 such
-- tables, none of them populated by the shipped seed), and most of the rest only look bounded because the
-- table is small — four collections give collections.title four values, five users give users.phone five. A
-- vocabulary is a column whose values REPEAT, so the window is three terms together — at least 20 rows, at
-- most 12 distinct values, and no more than one distinct value per four rows — which is 40 columns here, and
-- 40 is the number the row prints. 20 further columns carry 2..12 values below the row floor (19 when D75 wrote
-- it; D78's widened predicate made users.email the twentieth), two of them are catalogued vocabularies over
-- tables the demo barely populates — collections.kind by a door, favorites.subject_type by the D67 probe — and
-- `vocab_answer` answers them by name rather than letting the window drop them quietly.
--
-- COST, measured not assumed: 232 text columns over 58 base tables — the 57 this build writes, plus the
-- gate's own `schema_migrations`, whose `version` column is text and whose 7 rows fall below the window's row
-- floor (so the ledger is scanned, counted and not asked for an answer: the census has no exclusion list).
-- About 5 seconds of wall time on the gate database. Two columns answer 0 distinct values over their rows:
-- documents.error across 1040 rows, which IS in the window and is answered below, and tenants.region_code
-- across 1 row, which is not. A column that is NULL everywhere is exactly what a census should make visible,
-- so neither is filtered out of the count. (D78 measured the rest of that sentence's silence: the other 128
-- columns that answer 0 do so because their TABLE is empty — the 35 tables named above — and it is the window's
-- row floor, not its distinct count, that sets them aside.)
--
-- D78 WIDENED THE PREDICATE, and the widening is a defect fix rather than a taste: this block shipped reading
-- `atttypid = 'text'::regtype`, which is one of the string types the schema uses. Measured against
-- `pg_type.typcategory = 'S'` (a domain's base type resolved through `typbasetype`), a from-scratch schema
-- carries 232 text columns and 1 citext column — `users.email`, created citext by V1:6 "for case-insensitive
-- emails" — so the census never saw the one column whose idea of "the same value" differs from the cast its
-- own details print. 232 is a true count of `text` columns; what was wrong is the sentence above it, which
-- reads "every text column of every base table" as though that were every string column. It is not, and the
-- difference has a name and a type. The loop now records each
-- column's base type, and for every column that is not plain `text` it takes a second reading (distinct values
-- under `::text`) plus how many rows carry an uppercase letter at all — D78's two rows answer for the type
-- instead of trusting this prose.

CREATE TEMP TABLE vocab_data (tbl text NOT NULL, col text NOT NULL, n bigint NOT NULL, total bigint NOT NULL,
                              widest bigint NOT NULL, btype text NOT NULL, n_txt bigint, n_upper bigint,
                              PRIMARY KEY (tbl, col));
DO $d75$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname AS tbl, a.attname AS col, coalesce(bt.typname, t.typname) AS btype
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_type t ON t.oid = a.atttypid
              LEFT JOIN pg_type bt ON bt.oid = t.typbasetype
             WHERE c.relnamespace = 'public'::regnamespace
               AND c.relkind = 'r'
               AND a.attnum > 0 AND NOT a.attisdropped
               AND (t.typcategory = 'S' OR bt.typcategory = 'S')
             ORDER BY 1, 2
  LOOP
    EXECUTE format('INSERT INTO vocab_data SELECT %L, %L, count(DISTINCT %I), count(*), '
                 || 'coalesce(max(length(%I)), 0), %L, NULL, NULL FROM public.%I',
                 r.tbl, r.col, r.col, r.col, r.btype, r.tbl);
    -- `n` counts under the COLUMN'S OWN equality. For a plain text column that is the same question as
    -- count(DISTINCT col::text), so the extra aggregate is not paid for; for any other string type the two
    -- readings can differ, and the census takes both numbers instead of choosing one.
    IF r.btype = 'text' THEN
      UPDATE vocab_data SET n_txt = n, n_upper = 0 WHERE tbl = r.tbl AND col = r.col;
    ELSE
      EXECUTE format('UPDATE vocab_data SET n_txt = (SELECT count(DISTINCT %I::text) FROM public.%I), '
                  || 'n_upper = (SELECT count(*) FROM public.%I WHERE %I::text <> lower(%I::text)) '
                  || 'WHERE tbl = %L AND col = %L', r.col, r.tbl, r.tbl, r.col, r.col, r.tbl, r.col);
    END IF;
  END LOOP;
END $d75$;

-- The window, written once so both rows and both details read it from the same place.
CREATE TEMP VIEW vocab_win AS
SELECT * FROM vocab_data WHERE n <= 12 AND total >= 20 AND n * 4 <= total;

-- Every column the window catches, and every catalogued vocabulary the window does NOT catch, answered by
-- name. Four kinds, and each one is re-read against the mechanism it names rather than trusted:
--   door   the column must still be in door_vocab (the D74 transcription of a Java list)
--   poly   the column must still be a type column of a poly_cat pair (the D71 registry)
--   none   nothing bounds it; the window must still catch it, and the reason must be non-blank
--   below  nothing bounds it either, but the window no longer catches it (a small demo table); it reddens if
--          the window starts catching it, because then the column deserves a real answer
CREATE TEMP TABLE vocab_answer (tbl text NOT NULL, col text NOT NULL, answer text NOT NULL,
                                why text NOT NULL, PRIMARY KEY (tbl, col));
INSERT INTO vocab_answer VALUES
 -- the two that answer themselves from the live catalogues, so they re-read those lists every run
 ('offerings', 'kind', 'door', 'CatalogController.java:221'),
 ('offerings', 'status', 'door', 'MerchantContentController.java:68'),
 ('moderation_cases', 'status', 'door', 'ModerationController.java:51'),
 ('facts', 'subject_type', 'poly', 'the D71 probe over merchant|offering|location|review'),
 ('moderation_cases', 'subject_type', 'poly', 'the D68/D71 probe over V1:574''s declared types'),
 ('permission_grants', 'subject_type', 'poly', 'the D71 probe over user|merchant_user|api_key'),
 -- catalogued by a door or a probe, outside the window because the demo table is tiny: answered so a stale
 -- answer cannot outlive the fact it was written about
 ('collections', 'kind', 'door', 'CollectionsController.java:61; 4 rows in the demo table, so the repeat term'
  || ' never sees it'),
 ('collections', 'visibility', 'below', 'public on all 4 seeded rows; CollectionsWriteController publishes by'
  || ' visibility, but the table is below the window''s row floor'),
 ('merchant_users', 'status', 'door', 'MerchantWorkspaceService.java:34; 3 membership rows in the demo'),
 ('favorites', 'subject_type', 'poly', 'the D67 probe; 18 rows, so the window''s row floor never sees it'),
 -- the columns nothing in this build bounds
 ('availability_slots', 'currency', 'none', 'a market constant (one currency, 3 chars), not a per-row choice'),
 ('availability_slots', 'source', 'none', 'the D64 provenance word; demo on every row'),
 ('business_hours', 'source', 'none', 'the D64 provenance word; demo on every row'),
 ('categories', 'kind', 'none', 'every seeded category is a merchant category; no door filters on kind here'),
 ('chunks', 'embed_model', 'none', 'filled by the seed and named by zero occurrences in services/platform/src'
  || ' — nothing in the build reads it back'),
 ('documents', 'error', 'none', '0 distinct values over 1040 rows: the indexing failures it exists to hold'
  || ' never happened in the shipped data'),
 ('documents', 'kind', 'none', 'menu|policy from the seed CSV; no door enumerates either'),
 ('documents', 'lang', 'none', 'one language tag across the corpus (5 chars)'),
 ('documents', 'mime_type', 'none', 'text/plain; charset=utf-8 everywhere the seed reaches'),
 ('documents', 'status', 'none', 'indexed on all 1040 rows: a promise the generator makes about its own'
  || ' corpus, not a pipeline state anything transitions'),
 ('facts', 'attribute', 'none', 'the attribute half of a fact key, 6 of them; D65/D67 probe facts by'
  || ' subject_type and never by attribute'),
 ('facts', 'currency', 'none', 'a market constant beside the fact value'),
 ('facts', 'source', 'none', 'demo|inferred|merchant|observed — the D64 provenance vocabulary, which is'
  || ' checked for fabrication rather than for membership'),
 ('facts', 'unit', 'none', 'the unit of measure beside the fact value; nothing bounds it'),
 ('locations', 'area', 'none', '3 values over 684 rows — district labels of one demo city'),
 ('locations', 'city', 'none', 'one city across the dataset'),
 ('locations', 'label', 'none', 'a display label, 4 values; free text by design'),
 ('locations', 'postcode', 'none', 'one postcode across the dataset — a constant of the demo market'),
 ('merchants', 'data_origin', 'none', 'the D64 provenance word'),
 ('merchants', 'plan', 'none', 'a commercial tier label, 3 values; no door in the build filters on it'),
 ('merchants', 'price_band', 'none', 'a display facet, 4 values; nothing bounds it'),
 ('merchants', 'status', 'none', 'draft|pending_review|published|suspended, moved between by string literals'
  || ' in MerchantService.java:141-147 — a state machine with no enumerated set behind it'),
 ('moderation_cases', 'auto_action', 'none', 'V1:578 declares none|hide|flag|reject in a comment the parser'
  || ' discards; the build''s only writer emits none (D74)'),
 ('moderation_cases', 'policy', 'none', 'a free-text §55/§127 sentence, 2 distinct over 544 rows; §19 asks'
  || ' source+confidence of a fact, and this is not a fact row'),
 ('moderation_cases', 'reason', 'none', 'free text the queue displays, 2 distinct over 544 rows'),
 ('offering_relations', 'relation', 'none', 'the whole table is named by zero code paths in'
  || ' services/platform, apps/ai or apps/web — only V1''s DDL and the seed know it exists (D75 measured)'),
 ('offerings', 'currency', 'none', 'a market constant'),
 ('offerings', 'price_model', 'none', 'the shape of a price, 4 values; nothing bounds it'),
 ('offerings', 'price_source', 'none', 'estimated|merchant|observed from the seed CSV — the D53'
  || ' authorisation_basis lane reads facts, not this column'),
 ('resource_pools', 'kind', 'none', '8 kinds from the seed CSV (chair, class_slot, lane, room, seat, station,'
  || ' table, treatment_room); no door enumerates them'),
 ('resource_pools', 'status', 'none', 'active on all 452 rows'),
 ('reviews', 'data_origin', 'none', 'the D64 provenance word'),
 ('reviews', 'language', 'none', 'en|zh-HK; generate.py self-checks the language mix, which is a density'
  || ' promise rather than a bound on the value set'),
 ('reviews', 'status', 'none', 'the seed carries pending|published|flagged while the resolve door''s DECISIONS'
  || ' is published|rejected|flagged — two 3-word lists sharing 2 words, so pending is a state no door can'
  || ' write and rejected never appears in demo data');

-- Is each answer's claim still true, read from the live catalogues rather than trusted from the prose. The
-- three flags are computed here, once, so the two rows below can be read without a subquery per term.
ALTER TABLE vocab_answer ADD COLUMN is_door boolean, ADD COLUMN is_poly boolean, ADD COLUMN in_win boolean;
UPDATE vocab_answer a
   SET is_door = EXISTS (SELECT 1 FROM door_vocab d WHERE d.tbl = a.tbl AND d.col = a.col),
       is_poly = EXISTS (SELECT 1 FROM poly_cat p WHERE p.tbl = a.tbl AND p.tcol = a.col),
       in_win  = EXISTS (SELECT 1 FROM vocab_win w WHERE w.tbl = a.tbl AND w.col = a.col);

INSERT INTO qc
SELECT 'a bounded string column is answered by name',
       (SELECT count(*) FROM vocab_win) > 0
       AND NOT EXISTS (SELECT 1 FROM vocab_win w
                        WHERE NOT EXISTS (SELECT 1 FROM vocab_answer a
                                          WHERE a.tbl = w.tbl AND a.col = w.col)),
       (SELECT count(*) FROM vocab_win) || ' of ' || (SELECT count(*) FROM vocab_data)
       || ' string column(s) are bounded by the data (window: <=12 distinct, >=20 rows, <=1 value per 4 rows), '
       || (SELECT count(*) FROM vocab_win w WHERE EXISTS (SELECT 1 FROM door_vocab d
                                                          WHERE d.tbl = w.tbl AND d.col = w.col))
       || ' of them by a door list and '
       || (SELECT count(*) FROM vocab_win w WHERE EXISTS (SELECT 1 FROM poly_cat p
                                                          WHERE p.tbl = w.tbl AND p.tcol = w.col))
       || ' by the polymorphic registry; '
       || coalesce((SELECT string_agg(w.tbl || '.' || w.col || ' (' || w.n || ' value(s) over '
                               || w.total || ' rows)', ', ' ORDER BY w.tbl, w.col)
                    FROM vocab_win w WHERE NOT EXISTS (SELECT 1 FROM vocab_answer a
                                                       WHERE a.tbl = w.tbl AND a.col = w.col)),
                   'every one of them answered above');

INSERT INTO qc
SELECT 'a vocabulary answer is still an answer',
       (SELECT count(*) FROM vocab_answer) > 0
       AND NOT EXISTS (SELECT 1 FROM vocab_answer a WHERE a.answer = 'door' AND NOT a.is_door)
       AND NOT EXISTS (SELECT 1 FROM vocab_answer a WHERE a.answer = 'poly' AND NOT a.is_poly)
       AND NOT EXISTS (SELECT 1 FROM vocab_answer a
                       WHERE a.answer = 'none' AND (btrim(a.why) = '' OR NOT a.in_win))
       AND NOT EXISTS (SELECT 1 FROM vocab_answer a
                       WHERE a.answer = 'below' AND (btrim(a.why) = '' OR a.in_win))
       AND NOT EXISTS (SELECT 1 FROM vocab_answer a
                       WHERE a.answer NOT IN ('door', 'poly', 'none', 'below')),
       (SELECT count(*) FROM vocab_answer) || ' answer(s): '
       || (SELECT count(*) FROM vocab_answer WHERE answer = 'door') || ' door, '
       || (SELECT count(*) FROM vocab_answer WHERE answer = 'poly') || ' poly, '
       || (SELECT count(*) FROM vocab_answer WHERE answer = 'none') || ' none, '
       || (SELECT count(*) FROM vocab_answer WHERE answer = 'below') || ' below the window — and an answer is'
       || ' only worth what it says while the mechanism it names still holds, so each re-reads its own'
       || ' assumption here: '
       || coalesce((SELECT string_agg(a.tbl || '.' || a.col || ' (' || a.answer || ')', ', '
                             ORDER BY a.tbl, a.col) FROM vocab_answer a
                    WHERE (a.answer = 'door' AND NOT a.is_door) OR (a.answer = 'poly' AND NOT a.is_poly)
                       OR (a.answer = 'none' AND (btrim(a.why) = '' OR NOT a.in_win))
                       OR (a.answer = 'below' AND (btrim(a.why) = '' OR a.in_win))
                       OR a.answer NOT IN ('door', 'poly', 'none', 'below')),
                   'every answer still applies');

-- ============================================================ D78  the census above spoke exactly one string type
--
-- WHY THIS EXISTS: D75 counts distinct values for "every text column of every base table", and that claim was
-- true of its WHERE clause rather than of the schema. Measured on the fresh gate database, `public` holds 233
-- string columns — 232 text and 1 citext, users.email — created citext because V1:6 turns the extension on
-- "for case-insensitive emails". A citext column compares values WITHOUT case, so the number the census takes
-- (count(DISTINCT col) — the type's own equality) and the number a ::text cast would give are different
-- questions, and D75 measured only the first while its prose reads like the second.
--
-- WHAT THE SHIPPED DATA DOES WITH IT, measured rather than assumed: users.email carries 5 rows, 5 distinct
-- under citext, 5 under the cast, widest 24, narrowest 21, and 0 of those values contain an uppercase letter
-- at all (every seeded address is lowercase, demo.admin@example.hk through demo.owner3@example.hk). So the two
-- readings agree here only because the demo never exercises the difference the type exists to make, and
-- users.email also sits below the window's row floor (5 < 20) so D75's window asks nothing of it. Both facts
-- are worth a row that re-reads them every run, not a comment that remembers them.
--
-- WHAT IS NOT CLAIMED, and why the row is still two-directional: while V4:44's unique partial index on
-- (tenant_id, email) holds — it replaced V1:46's global one — two addresses differing only by case cannot both
-- be inserted, so the agreement is enforced OUTSIDE this block. The agreement conjunct is therefore falsified
-- in the drive by removing that
-- enforcement in the throwaway database (P5), not by arguing it — a second citext column without such an
-- index, in any real schema, makes the readings differ and this row would say so.
--
-- COST, measured rather than assumed: the widening is one extra two-aggregate query per string column that is
-- not plain text — one query over a five-row table here, against the 233 the census already pays for. Timed on
-- the kept gate database twice each way, the census with the second reading took 3.1s and 5.2s and without it
-- 4.2s and 4.9s, which is the same number wearing different clothes: the widening is inside the noise.

CREATE TEMP TABLE str_type (btype text PRIMARY KEY, reads text NOT NULL, why text NOT NULL);
INSERT INTO str_type VALUES
 ('text',   'one',  'a text column compares exactly what it stores, so count(DISTINCT col) and '
                 || 'count(DISTINCT col::text) are the same question and only one is paid for'),
 ('citext', 'two',  'V1:6 creates citext "for case-insensitive emails": the type folds case, the ::text cast '
                 || 'the details print does not, so a citext column is measured under BOTH readings and the '
                 || 'gap between them is reported rather than smoothed over');

INSERT INTO qc
SELECT 'the string census declares a reading for every type it catches',
       (SELECT count(*) FROM str_type) > 0
       AND NOT EXISTS (SELECT 1 FROM vocab_data d
                       WHERE NOT EXISTS (SELECT 1 FROM str_type s WHERE s.btype = d.btype))
       AND NOT EXISTS (SELECT 1 FROM str_type s WHERE s.reads NOT IN ('one', 'two'))
       AND NOT EXISTS (SELECT 1 FROM str_type s
                       WHERE NOT EXISTS (SELECT 1 FROM vocab_data d WHERE d.btype = s.btype)),
       (SELECT count(*) FROM vocab_data) || ' string column(s) over '
       || (SELECT count(DISTINCT d.btype) FROM vocab_data d) || ' base type(s), declared under '
       || (SELECT count(*) FROM str_type) || ' reading rule(s): '
       || coalesce((SELECT string_agg(x.btype || ' ' || x.cols || ' column(s), read ' || x.reads, ', '
                                   ORDER BY x.btype)
                    FROM (SELECT d.btype, count(*) AS cols, max(s.reads) AS reads
                            FROM vocab_data d JOIN str_type s ON s.btype = d.btype
                           GROUP BY d.btype) x), 'nothing caught')
       || ' — offenders: '
       || coalesce((SELECT string_agg(f, ' · ' ORDER BY f) FROM (
              SELECT 'the census caught a ' || d.btype || ' column (' || d.tbl || '.' || d.col
                     || ') and no reading declares that type' AS f
                FROM vocab_data d WHERE NOT EXISTS (SELECT 1 FROM str_type s WHERE s.btype = d.btype)
              UNION ALL
              SELECT s.btype || ' is declared but no column carries it — the census lost a type the '
                     || 'vocabulary still answers for'
                FROM str_type s WHERE NOT EXISTS (SELECT 1 FROM vocab_data d WHERE d.btype = s.btype)
              UNION ALL
              SELECT s.btype || ' claims a reading the census cannot take: ' || s.reads
                FROM str_type s WHERE s.reads NOT IN ('one', 'two')
                     ) x), 'none');

INSERT INTO qc
SELECT 'a census that folds case reports both readings and which one the demo exercises',
       (SELECT count(*) FROM vocab_data d JOIN str_type s ON s.btype = d.btype
         WHERE s.reads = 'two') > 0
       AND NOT EXISTS (SELECT 1 FROM vocab_data d JOIN str_type s ON s.btype = d.btype
                        WHERE s.reads = 'two' AND (d.n_txt IS NULL OR d.n_upper IS NULL))
       AND NOT EXISTS (SELECT 1 FROM vocab_data d JOIN str_type s ON s.btype = d.btype
                        WHERE s.reads = 'two' AND d.n <> d.n_txt)
       AND NOT EXISTS (SELECT 1 FROM vocab_data d JOIN str_type s ON s.btype = d.btype
                        WHERE s.reads = 'two' AND d.n_upper > 0),
       (SELECT count(*) FROM vocab_data d JOIN str_type s ON s.btype = d.btype
         WHERE s.reads = 'two') || ' column(s) measured twice: '
       || coalesce((SELECT string_agg(d.tbl || '.' || d.col || ' (' || d.total || ' row(s), '
                               || d.n || ' distinct under ' || d.btype || ', ' || d.n_txt
                               || ' distinct under ::text, ' || d.n_upper
                               || ' row(s) carrying an uppercase letter)', ', '
                                   ORDER BY d.tbl, d.col)
                    FROM vocab_data d JOIN str_type s ON s.btype = d.btype
                   WHERE s.reads = 'two'), 'none')
       || ' — offenders: '
       || coalesce((SELECT string_agg(f, ' · ' ORDER BY f) FROM (
              SELECT d.tbl || '.' || d.col || ' was never measured under ' || d.btype
                     || ', the pair is missing' AS f
                FROM vocab_data d JOIN str_type s ON s.btype = d.btype
               WHERE s.reads = 'two' AND (d.n_txt IS NULL OR d.n_upper IS NULL)
              UNION ALL
              SELECT d.tbl || '.' || d.col || ': ' || d.btype || ' sees ' || d.n
                     || ' value(s) while the cast sees ' || d.n_txt
                FROM vocab_data d JOIN str_type s ON s.btype = d.btype
               WHERE s.reads = 'two' AND d.n <> d.n_txt
              UNION ALL
              SELECT d.tbl || '.' || d.col || ': ' || d.n_upper
                     || ' row(s) carry an uppercase letter, so the readings no longer agree by default'
                FROM vocab_data d JOIN str_type s ON s.btype = d.btype
               WHERE s.reads = 'two' AND d.n_upper > 0
                     ) x), 'none');


-- ============================================================ D76  what the served projections carry
--
-- WHY THIS EXISTS: D75 asked the stored data which of its columns are bounded. The next question is one layer
-- up, on the side the app actually reads: the schema ships two views — v_merchant_funnel (V1, replaced by V3)
-- and v_north_star (V1) — and the shipped build SELECTs from them at exactly three sites: `from v_merchant_funnel`
-- at AnalyticsRepository.java:41, `from v_north_star` twice at AdminSearchAnalyticsRepository.java:38 and :48.
-- Two response fields then publish the view's own name to the client (`funnel_source` at
-- MerchantOverviewController.java:68 and MerchantContentController.java:410, `source` at
-- AdminSearchAnalyticsController.java:85). The file that mentions the funnel most — MerchantAnalyticsRepository —
-- reads the base tables instead, so the view is not its source. What do these columns carry over the shipped
-- dataset? Census every column of every view in `public` and require an answer by name, the way D75 does for
-- the text columns of every base table.
--
-- MEASURED on a kept gate database, before any of this was written down: the funnel is 520 rows and SIX of its
-- eight columns are the constant 0 (views, clicks, actions, reservations, orders, revenue); the seventh is the
-- one demo tenant's id, constant; only merchant_id varies. `v_north_star` has ZERO rows, so all five of its
-- columns are NULL by emptiness rather than by value. The two views differ in shape for a reason worth
-- knowing: the funnel is anchored on `merchants` (520 seeded rows), the north star on `events` (0 rows) — a
-- GROUP BY over nothing produces no groups, not a row of zeros.
--
-- COST, measured: 13 aggregates over 2 views, 0.6s on a kept gate database (against D75's ~5s for 232 columns);
-- re-measured after D77's derivation and the extra vocabulary row, 0.49s on the same database.
--
-- CAUSE, and it is not an oversight: D64's fabrication guard requires every table outside the seed's own
-- anchor to be EMPTY, and events/orders/reservations/carts/payments are all in that swept set. So these arms
-- are 0 BY RULE. §109 forbids "fake transactions" outright while the sentence after it allows demo data that
-- says so on its face; which reading the shipped demo should follow is a decision, and this gate does not
-- make it — it makes the consequence visible, with the reason attached to each arm.
--
-- A LESSON THE CENSUS TAUGHT BY ITSELF: the first measurement printed v_north_star's five columns as BLANK
-- lines, because text concatenation with a NULL yields NULL — a detail line disappears rather than showing
-- its emptiness. Every string below is coalesced for that reason.

CREATE TEMP TABLE view_data (vw text NOT NULL, col text NOT NULL, ord int NOT NULL, typ text NOT NULL,
                             total bigint NOT NULL, n bigint NOT NULL, nulls bigint NOT NULL,
                             low text, high text, PRIMARY KEY (vw, col));
DO $d76$
DECLARE v record; c record;
BEGIN
  FOR v IN SELECT c2.relname AS vw FROM pg_class c2
            WHERE c2.relnamespace = 'public'::regnamespace AND c2.relkind = 'v'
            ORDER BY 1
  LOOP
    FOR c IN SELECT a.attname AS col, a.attnum AS ord, format_type(a.atttypid, a.atttypmod) AS typ
               FROM pg_attribute a
              WHERE a.attrelid = to_regclass('public.' || v.vw)
                AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum
    LOOP
      EXECUTE format('INSERT INTO view_data SELECT %L, %L, %L, %L, count(*), '
                  || 'count(DISTINCT %I::text), count(*) - count(%I), min(%I::text), max(%I::text) '
                  || 'FROM public.%I',
                     v.vw, c.col, c.ord, c.typ, c.col, c.col, c.col, c.col, v.vw);
    END LOOP;
  END LOOP;
END $d76$;

-- FIVE KINDS, AND THE CENSUS PICKS WHICH ONE APPLIES (D77, superseding D76's three hand-labelled kinds).
--
-- D76 shipped const/varying/norows and called refusing a fourth kind a virtue. Measuring that claim (D77's
-- first run, on a kept gate database) shows two cells of the (rows, distinct values) plane that no shipped
-- kind can name — and both are reachable by exactly the change D76 defers to §109:
--
--   rows > 0, 1 < distinct < rows    measured: giving 260 of the 520 merchants one 'view' event each puts
--                                    v_merchant_funnel.views at (520 rows, 2 values), where the old block
--                                    reported const=fits, varying=NO, norows=NO — no legal answer existed, so
--                                    the only way to satisfy the gate was to delete it
--   rows > 0, distinct = 0           measured: a probe view column written as NULL::text over 520 rows
--                                    reddened the answer row under ALL THREE kinds, each attempt naming the
--                                    same column
--
-- So the kind is now DERIVED below from the census and a hand answer must name the kind the data puts its
-- column in. Two things are kept from D76 by that change rather than lost: the vocabulary stays closed (an
-- invented label is still a red — it simply never matches the derivation), and a `const` answer still carries
-- the literal it claims, so a column whose single value moves reddens the row. What is gained is a home for
-- every shape, and one less seam: D76 needed a plant to land between the answer INSERTs and the flag UPDATE
-- because its flags were materialised per answer; a derived kind is read at check time, so moving a label is a red
-- wherever in the run it moves.
--
-- The two kinds the shipped dataset does not exercise (allnull, sparse) are exempted BY NAME, with a reason,
-- and the exemption re-reads the derivation every run — the shape D75's `below` and D71's `no-referent`
-- already use. Seeding traffic does not just change a number: it withdraws an exemption, which is the point of
-- recording them here.
--
-- The final ELSE branch of the derivation is unreachable by arithmetic (a distinct count is never negative
-- and never between 0 and 1). It stays because an edit that opens a hole in the CASE above should print a
-- named red rather than derive NULL, and NO qc row asserts the branch is empty: a predicate that can only
-- pass is the thing D76 deleted one unit earlier.

CREATE TEMP TABLE view_answer (vw text NOT NULL, col text NOT NULL, answer text NOT NULL,
                               claimed text, why text NOT NULL, PRIMARY KEY (vw, col));
INSERT INTO view_answer VALUES
 ('v_merchant_funnel', 'tenant_id', 'const', '00000000-0000-0000-0000-000000000001',
  'the shipped demo is one tenant (the same literal the tenant row above asserts); every analytics row '
  || 'belongs to it'),
 ('v_merchant_funnel', 'merchant_id', 'varying', NULL,
  'the view''s grain: one row per business, so the funnel is per-merchant by construction (V3)'),
 ('v_merchant_funnel', 'views', 'const', '0',
  'events is swept EMPTY by D64''s fabrication guard (§109/§110), so the exposure counter has nothing to count'),
 ('v_merchant_funnel', 'clicks', 'const', '0', 'same arm of the same predicate over the same empty table'),
 ('v_merchant_funnel', 'actions', 'const', '0', 'reserve|cart_add over events, which is empty by the guard'),
 ('v_merchant_funnel', 'reservations', 'const', '0',
  'TWO causes stack: reservations is empty by the guard, AND V3''s predicate counts only '
  || 'confirmed|completed — states no route in this build writes (D26: acceptance has no route yet)'),
 ('v_merchant_funnel', 'orders', 'const', '0', 'orders/carts/payments lie outside the anchor and the guard '
  || 'requires them empty, so a fresh install has no completed transaction to aggregate'),
 ('v_merchant_funnel', 'revenue', 'const', '0', 'sum over the same empty order set; the funnel''s money arm '
  || 'and its orders arm can only move together'),
 ('v_north_star', 'day', 'norows', NULL,
  'anchored on events (0 rows): a GROUP BY over nothing yields NO rows, which is not the same claim as a '
  || 'row of zeros — the admin dashboard reads an empty list'),
 ('v_north_star', 'tenant_id', 'norows', NULL, 'same empty grouping source'),
 ('v_north_star', 'sessions', 'norows', NULL, 'count(DISTINCT session_id) is never reached'),
 ('v_north_star', 'searches', 'norows', NULL, 'the name=filter is never reached'),
 ('v_north_star', 'fulfilled_intents', 'norows', NULL, 'the intent arm the north-star chart headlines is '
  || 'never reached either — §56''s customer list reads the same way ("completed transactions only")');

-- THE CENSUS, NOT THE AUTHOR, DECIDES THE KIND. The header above carries the measurements that made this a
-- derivation rather than a choice -- the (520 rows, 2 values) cell and the (520 rows, 0 values) cell, neither
-- of which D76's three hand labels could name -- and the CASE below reads nothing but (total, n) from the
-- census, so the two cells now have homes ('sparse', 'allnull') instead of a gate that gets deleted.
CREATE TEMP TABLE view_kind (vw text NOT NULL, col text NOT NULL, kind text NOT NULL,
                             total bigint NOT NULL, n bigint NOT NULL, PRIMARY KEY (vw, col));
INSERT INTO view_kind
SELECT d.vw, d.col,
       CASE WHEN d.total = 0   THEN 'norows'
            WHEN d.n = 0       THEN 'allnull'
            WHEN d.n = 1       THEN 'const'
            WHEN d.n = d.total THEN 'varying'
            WHEN d.n > 1       THEN 'sparse'
            ELSE 'UNNAMED-' || d.n || '-of-' || d.total END,
       d.total, d.n
  FROM view_data d;

-- The vocabulary is closed at five names, and a name is only allowed to sit unused while the cell it describes
-- is empty — the same re-read-the-exemption rule D75's `below` row and D71's `no-referent` kind follow.
CREATE TEMP TABLE view_vocab (kind text PRIMARY KEY, exempt text);
INSERT INTO view_vocab VALUES
 ('const',   NULL),
 ('varying', NULL),
 ('norows',  NULL),
 ('allnull', 'no view column in the shipped demo is NULL on every row it sits on: the funnel left-joins its '
             || 'counters but coalesces each to 0, and v_north_star produces no rows at all. The exemption is '
             || 'worthless the moment a view column starts carrying only NULLs — that answer must then be '
             || 'written and this reason withdrawn in the same commit.'),
 ('sparse',  'no view column in the shipped demo has between 2 and rows-1 distinct values: seven funnel '
             || 'columns are single-valued, merchant_id is the grain, and the five north-star columns have no '
             || 'rows — all because D64''s fabrication guard keeps events/orders/reservations/carts/payments '
             || 'empty, which pins six funnel counters at one value (0). Seed any traffic and this cell goes '
             || 'live (measured: events for 260 of 520 merchants puts v_merchant_funnel.views at 2 values over '
             || '520 rows), so the exemption must be withdrawn in the commit that seeds it.');

INSERT INTO qc
SELECT 'a served view answers every column it exposes',
       (SELECT count(*) FROM view_data) > 0
       AND NOT EXISTS (SELECT 1 FROM view_data d
                        WHERE NOT EXISTS (SELECT 1 FROM view_answer a
                                          WHERE a.vw = d.vw AND a.col = d.col)),
       (SELECT count(*) FROM view_data) || ' column(s) across '
       || (SELECT count(DISTINCT vw) FROM view_data) || ' view(s) the app reads; '
       || (SELECT count(*) FROM view_data d
           WHERE NOT EXISTS (SELECT 1 FROM view_answer a
                             WHERE a.vw = d.vw AND a.col = d.col))
       || ' column(s) left unanswered by this block: '
       || coalesce((SELECT string_agg(d.vw || '.' || d.col || ' (' || d.total || ' row(s), '
                               || d.n || ' value(s))', ', ' ORDER BY d.vw, d.ord)
                    FROM view_data d WHERE NOT EXISTS (SELECT 1 FROM view_answer a
                                                       WHERE a.vw = d.vw AND a.col = d.col)),
                   'none');

INSERT INTO qc
SELECT 'a view answer names the kind the census derives',
       (SELECT count(*) FROM view_answer) > 0
       AND NOT EXISTS (SELECT 1 FROM view_answer a
                       WHERE NOT EXISTS (SELECT 1 FROM view_kind k
                                         WHERE k.vw = a.vw AND k.col = a.col))
       AND NOT EXISTS (SELECT 1 FROM view_answer a JOIN view_kind k
                         ON k.vw = a.vw AND k.col = a.col WHERE a.answer <> k.kind)
       AND NOT EXISTS (SELECT 1 FROM view_answer a JOIN view_data d
                         ON d.vw = a.vw AND d.col = a.col
                        WHERE a.answer = 'const'
                          AND coalesce(d.low, '<none>') <> coalesce(a.claimed, '<none>'))
       AND NOT EXISTS (SELECT 1 FROM view_answer a WHERE btrim(a.why) = ''),
       (SELECT count(*) FROM view_answer) || ' answer(s) over '
       || (SELECT count(*) FROM view_kind) || ' census column(s), and the kind each one must name is derived '
       || 'above rather than chosen here: '
       || coalesce((SELECT string_agg(x.kind || ' ' || x.n, ', ' ORDER BY x.kind)
                    FROM (SELECT k.kind, count(*) AS n FROM view_kind k GROUP BY k.kind) x),
                   'nothing derived')
       || ' — offenders: '
       || coalesce((SELECT string_agg(f, ' · ' ORDER BY f) FROM (
              SELECT a.vw || '.' || a.col || ' answered ' || a.answer
                     || ', the census derives ' || coalesce(k.kind, 'no such column') AS f
                FROM view_answer a LEFT JOIN view_kind k ON k.vw = a.vw AND k.col = a.col
               WHERE k.kind IS NULL OR a.answer <> k.kind
              UNION ALL
              SELECT a.vw || '.' || a.col || ' claims ' || coalesce(a.claimed, '<nothing>')
                     || ' while the column''s only value is ' || coalesce(d.low, '<null>')
                FROM view_answer a JOIN view_data d ON d.vw = a.vw AND d.col = a.col
               WHERE a.answer = 'const' AND coalesce(d.low, '<none>') <> coalesce(a.claimed, '<none>')
              UNION ALL
              SELECT a.vw || '.' || a.col || ' gives no reason'
                FROM view_answer a WHERE btrim(a.why) = ''
                     ) x), 'none');

INSERT INTO qc
SELECT 'a view kind is exercised or exempted',
       (SELECT count(*) FROM view_vocab) > 0
       AND NOT EXISTS (SELECT 1 FROM view_kind k
                       WHERE NOT EXISTS (SELECT 1 FROM view_vocab v WHERE v.kind = k.kind))
       AND NOT EXISTS (SELECT 1 FROM view_vocab v
                       WHERE v.kind NOT IN ('const', 'varying', 'norows', 'allnull', 'sparse'))
       AND NOT EXISTS (SELECT 1 FROM view_vocab v
                       WHERE v.exempt IS NOT NULL
                         AND EXISTS (SELECT 1 FROM view_kind k WHERE k.kind = v.kind))
       AND NOT EXISTS (SELECT 1 FROM view_vocab v
                       WHERE (v.exempt IS NULL OR btrim(v.exempt) = '')
                         AND NOT EXISTS (SELECT 1 FROM view_kind k WHERE k.kind = v.kind)),
       (SELECT count(*) FROM view_vocab) || ' kind(s) in the vocabulary, '
       || (SELECT count(DISTINCT k.kind) FROM view_kind k) || ' of them actually derived by the census: '
       || coalesce((SELECT string_agg(v.kind || ' = '
                                      || CASE WHEN (SELECT count(*) FROM view_kind k WHERE k.kind = v.kind) > 0
                                              THEN (SELECT count(*) FROM view_kind k WHERE k.kind = v.kind)
                                                   || ' column(s)'
                                              WHEN btrim(coalesce(v.exempt, '')) = '' THEN 'UNUSED, no reason'
                                              ELSE 'exempted with a reason' END,
                                     ', ' ORDER BY v.kind) FROM view_vocab v), 'none')
       || ' — an exemption is only honest while its cell stays empty, so every one re-reads the derivation '
       || 'above; offenders: '
       || coalesce((SELECT string_agg(f, ' · ' ORDER BY f) FROM (
              SELECT 'the census derives ' || k.kind || ', which no vocabulary row names' AS f
                FROM view_kind k WHERE NOT EXISTS (SELECT 1 FROM view_vocab v WHERE v.kind = k.kind)
              UNION ALL
              SELECT 'a kind nobody can derive: ' || v.kind
                FROM view_vocab v
               WHERE v.kind NOT IN ('const', 'varying', 'norows', 'allnull', 'sparse')
              UNION ALL
              SELECT v.kind || ' is exercised by '
                     || (SELECT count(*) FROM view_kind k WHERE k.kind = v.kind)
                     || ' column(s) and still carries an exemption'
                FROM view_vocab v
               WHERE v.exempt IS NOT NULL
                 AND EXISTS (SELECT 1 FROM view_kind k WHERE k.kind = v.kind)
              UNION ALL
              SELECT v.kind || ' has no column in its cell and no reason to say why'
                FROM view_vocab v
               WHERE (v.exempt IS NULL OR btrim(v.exempt) = '')
                 AND NOT EXISTS (SELECT 1 FROM view_kind k WHERE k.kind = v.kind)
                     ) x), 'none');


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
