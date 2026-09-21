-- NEXUS seed — the first tenant (market boundary), docs/DECISIONS.md D2/D8, API_CONTRACT §1 X-Tenant.
--
-- STABLE TENANT UUID: 00000000-0000-0000-0000-000000000001  ("hong-kong")
-- Every seed script, fixture and Playwright test references this literal UUID — never a generated
-- one — so `make db-reset && make seed` reproduces an identical tenant id across machines/CI.
--
-- Idempotent (ON CONFLICT DO NOTHING then UPDATE) so `make seed` can run repeatedly.

INSERT INTO tenants (id, slug, name, country_code, region_code, timezone, currency, locales, status, config)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'hong-kong',
  'Hong Kong',
  'HK',
  NULL,
  'Asia/Hong_Kong',                                        -- AGENT_CONTRACT §12
  'HKD',
  ARRAY['en','zh-HK','zh-CN'],                             -- zh-HK is the default locale (§111)
  'active',
  jsonb_build_object(
    'default_locale', 'zh-HK',
    'primary_locale', 'zh-HK',
    'fallback_locale', 'en',
    'currency', 'HKD',
    'timezone', 'Asia/Hong_Kong',
    'geo_bbox', jsonb_build_array(22.14, 113.82, 22.56, 114.43),  -- HK region bbox for geo prefilter (D3)
    'districts', jsonb_build_array(
      'Central and Western','Wan Chai','Eastern','Southern','Islands','Yau Tsim Mong','Sham Shui Po',
      'Kowloon City','Wong Tai Sin','Kwun Tong','Tsuen Wan','Tuen Mun','Yuen Long','North','Tai Po',
      'Sha Tin','Kwai Tsing'),
    'compliance', jsonb_build_object('pdpo', true, 'store_card_data', false),  -- §42, §128
    'demo', true                                            -- §109: this tenant is seeded/demo data
  )
)
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  name = EXCLUDED.name,
  country_code = EXCLUDED.country_code,
  timezone = EXCLUDED.timezone,
  currency = EXCLUDED.currency,
  locales = EXCLUDED.locales,
  status = EXCLUDED.status,
  config = EXCLUDED.config,
  updated_at = now();

-- Verification helper: prints exactly one row when the seed worked.
SELECT id, slug, currency, timezone, status FROM tenants WHERE slug = 'hong-kong';
