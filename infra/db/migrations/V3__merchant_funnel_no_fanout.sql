-- NEXUS V3 — fix the v_merchant_funnel revenue double-count (docs/STATUS.md ruling D15, spec §56).
--
-- THE DEFECT (V1__init.sql:1006-1018, immutable and left untouched; this migration replaces the view)
-- V1 aggregates four different cardinalities out of ONE left-joined row set:
--
--   FROM merchants m
--   LEFT JOIN events e       ON e.subject_type='merchant' AND e.subject_id = m.id
--   LEFT JOIN reservations r ON r.merchant_id = m.id AND r.status IN ('confirmed','completed')
--   LEFT JOIN orders o       ON o.merchant_id = m.id AND o.status NOT IN ('cancelled','refunded')
--
-- Those three joins are mutually independent, so a merchant's group is the CARTESIAN PRODUCT of its
-- event rows x reservation rows x order rows. `count(DISTINCT ...)` absorbs that for reservations and
-- orders, but `coalesce(sum(o.total),0)` does not: every order is added once per (event x reservation)
-- pair. MEASURED on the seeded demo tenant (data/seed/out, tenant 0000...0001, merchant
-- alder-bar-0458) with 6 merchant events, 2 confirmed reservations and ONE HK$480.00 order:
--
--   joined_rows = 12  (= 6 events x 2 reservations x 1 order; the order repeats 12 times)
--   v_merchant_funnel.revenue = 5760.00   ground truth sum(orders.total) = 480.00   -> 12x inflation
--   v_merchant_funnel.views/clicks/actions = 6/4/2 vs ground truth 3/2/1            -> 2x inflation
--
-- so the event counters are inflated too, by (reservations x orders). The merchant dashboard (§56,
-- D15) reads this view; services/platform currently papers over it by re-aggregating revenue from
-- `orders` in AnalyticsRepository.merchantFunnel(). With this view fixed, that subquery and the view
-- column agree, so no application change is required.
--
-- THE FIX: aggregate each source to one row per merchant BEFORE joining, so every join below is 1:1
-- and no row can be counted twice. Same tables, same filters, same eight columns in the same order
-- with the same types — the view's contract (docs/DATABASE.md §analytics views, packages/types
-- MerchantFunnel) is unchanged; only the arithmetic is. No table is re-created (DECISIONS D17) and
-- chunks.embedding stays vector(1024).
--
-- The three grouped scans are already index-supported by V1: events_subject_idx (subject_type,
-- subject_id), reservations_merchant_idx (merchant_id, starts_at), orders_merchant_idx
-- (merchant_id, created_at). No new index is added here.

CREATE OR REPLACE VIEW v_merchant_funnel AS
WITH merchant_events AS (            -- §56 exposure counters, one row per merchant
  SELECT e.subject_id                       AS merchant_id,
         count(*) FILTER (WHERE e.name = 'view')                         AS views,
         count(*) FILTER (WHERE e.name = 'click')                        AS clicks,
         count(*) FILTER (WHERE e.name = 'reserve' OR e.name = 'cart_add') AS actions
  FROM events e
  WHERE e.subject_type = 'merchant'
  GROUP BY e.subject_id
), merchant_reservations AS (        -- §20: only live/completed reservations count as a lead taken
  SELECT r.merchant_id, count(*) AS reservations
  FROM reservations r
  WHERE r.status IN ('confirmed','completed')
  GROUP BY r.merchant_id
), merchant_orders AS (              -- a cancelled or refunded order earned nothing (§56, API_CONTRACT §1)
  SELECT o.merchant_id,
         count(*)                        AS orders,
         coalesce(sum(o.total), 0)       AS revenue
  FROM orders o
  WHERE o.status NOT IN ('cancelled','refunded')
  GROUP BY o.merchant_id
)
SELECT m.tenant_id,
       m.id                              AS merchant_id,
       coalesce(ev.views,        0)      AS views,
       coalesce(ev.clicks,       0)      AS clicks,
       coalesce(ev.actions,      0)      AS actions,
       coalesce(res.reservations, 0)     AS reservations,
       coalesce(ord.orders,       0)     AS orders,
       coalesce(ord.revenue,      0)     AS revenue
FROM merchants m
LEFT JOIN merchant_events        ev  ON ev.merchant_id  = m.id
LEFT JOIN merchant_reservations  res ON res.merchant_id = m.id
LEFT JOIN merchant_orders        ord ON ord.merchant_id = m.id;
