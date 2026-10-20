package com.nexus.seo;

import com.nexus.catalog.MerchantCards;
import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Repository;

/**
 * The reads behind the §29 programmatic-SEO grammar.
 *
 * <p><b>Where the numbers come from.</b> {@code seo_pages} is the projection the SEO agent writes
 * (it exists in the live schema, and {@code data jsonb} is documented as "real listings backing the
 * page", the §30 anti-doorway guard). That projection can carry a page's authored content but it
 * cannot answer a <em>route listing</em>: a route needs a live count per (city, category,
 * subcategory), and a count snapshotted into jsonb is a claim about yesterday's merchant table. So:
 * <ul>
 *   <li>{@link #routeRows} counts published {@code merchants} rows through their primary
 *       {@code locations} row — every {@code listings} number is a {@code count(*)} over live rows;</li>
 *   <li>{@link #pageProjection} reads {@code seo_pages} for the same path and, when the SEO agent has
 *       published a row, the page carries that row's authored {@code h1}/description and its real
 *       {@code updated_at};</li>
 *   <li>{@link #listingRows} returns the merchants actually on the page, so every facet count is a
 *       count over the rows the payload ships (§19: a displayed number must be true of what is
 *       displayed).</li>
 * </ul>
 *
 * <p>Grammar mapping, all real columns: {@code city} is the slug of {@code locations.city}
 * ({@link #CITY_SLUG}), {@code category} is {@code merchants.category_primary}, {@code subcategory} is
 * a slug-shaped value from {@code merchants.tags}. A merchant with no {@code category_primary} answers
 * no route, and a route with no merchants is not listed rather than padded to one.
 *
 * <p>§66: the order below is organic — review aggregates and the slug for a deterministic tie-break.
 * No {@code merchants.plan}, campaign, coupon or spend column appears in any ORDER BY here, so paid
 * placement has no path into these projections.
 */
@Repository
public class SeoRepository {

    /** {@code Hong Kong} → {@code hong-kong}. A documented derivation of a real column. */
    static final String CITY_SLUG = "lower(btrim(regexp_replace(l.city, '[^A-Za-z0-9]+', '-', 'g'), '-'))";

    /** Facet slugs a URL may carry; anything else in {@code tags} stays out of the grammar. */
    static final String SLUG_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

    /** Cap on one directory page — above it the payload is a data dump, not a directory. */
    static final int MAX_LISTINGS = 200;

    /** A slug the §29 grammar can carry, or a 404: an unparsable segment is outside the grammar. */
    public static String slugOr404(String raw, String field) {
        if (raw == null || raw.isBlank()) {
            throw ApiException.validation("Parameter '" + field + "' is required", Json.map("field", field));
        }
        String value = raw.trim().toLowerCase();
        if (!value.matches(SLUG_PATTERN)) {
            throw ApiException.notFound("seo_route_not_found",
                    "'" + field + "' is not a value this directory can answer");
        }
        return value;
    }

    /** Optional segments: blank means "no subcategory", anything else must be a slug. */
    public static String optionalSlugOr404(String raw, String field) {
        return (raw == null || raw.isBlank()) ? null : slugOr404(raw, field);
    }

    private final TenantJdbc jdbc;

    public SeoRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- routes ----------------------------------------------------------

    /**
     * One row per routable {@code (city, category[, subcategory])} with the real count of published
     * merchants behind it, ordered so a city landing lists its categories by size then name.
     */
    public List<Map<String, Object>> routeRows(TenantContext tenant, String city) {
        String cityFilter = city == null ? "" : " and " + CITY_SLUG + " = :city";
        String sql = String.join("\n",
                "with listed as (",
                "  select distinct on (m.id)",
                "         m.id as merchant_id,",
                "         " + CITY_SLUG + " as city_slug,",
                "         nullif(btrim(coalesce(m.category_primary, '')), '') as category,",
                "         coalesce(m.tags, '{}'::text[]) as tags",
                "  from locations l",
                "  join merchants m on m.id = l.merchant_id",
                "  where l.tenant_id = :tenant_id",
                "    and m.status = 'published'",
                "    and l.city is not null and btrim(l.city) <> ''",
                cityFilter,
                "  order by m.id, l.is_primary desc, l.created_at",
                "),",
                "routes as (",
                "  select city_slug as city, category, null::text as subcategory, count(*) as listings",
                "  from listed",
                "  where category is not null",
                "  group by city_slug, category",
                "  union all",
                "  select city_slug, category, tag, count(*)",
                "  from listed cross join lateral unnest(tags) as tag",
                "  where category is not null and tag ~ :slug_pattern",
                "  group by city_slug, category, tag",
                ") select city, category, subcategory, listings from routes",
                " order by city, listings desc, category, subcategory nulls first",
                " limit 500");
        return jdbc.forTenant(tenant, sql, Json.map("city", city, "slug_pattern", SLUG_PATTERN));
    }

    // ---- page ------------------------------------------------------------

    /**
     * The {@code seo_pages} row for this exact path, whatever its status. Only authored content is
     * taken from it (heading, description, {@code updated_at}), and only when it is published; the
     * listings and counts below it stay live (§30: the page must be backed by real merchants at read
     * time). The status is returned so the handler can state the §30 reason rather than guess it.
     */
    public Optional<Map<String, Object>> pageProjection(TenantContext tenant, String path) {
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select sp.id, sp.path, sp.kind, sp.title, sp.title_zh, sp.description, sp.h1, sp.body,",
                "       sp.canonical, sp.lang, sp.status, sp.quality_score, sp.generated_by, sp.reviewed_by,",
                "       sp.updated_at, sp.published_at",
                "from seo_pages sp",
                "where sp.tenant_id = :tenant_id and sp.path = :path",
                // A published row beats a draft row for the same path; then the locale the directory
                // serves; then the newest edit. A missing row is a real state, and §30 treats it as
                // "no pass", so the handler needs the status it did find (or none).
                "order by (sp.status = 'published') desc, (sp.lang = 'zh-HK') desc, sp.updated_at desc",
                "limit 1"), Json.map("path", path));
    }

    /**
     * The merchants behind one directory route, as the shared card rows
     * ({@link com.nexus.catalog.MerchantCards}). An empty list means the route is not routable at all,
     * and the handler answers 404 rather than rendering an empty page.
     *
     * <p>§66: the ORDER BY is review aggregate, review volume and the slug for a deterministic
     * tie-break — no {@code plan}, campaign, coupon or spend column appears, so paid placement has no
     * path into the listing order.
     */
    public List<Map<String, Object>> listingRows(TenantContext tenant, String city, String category,
                                                 String subcategory, Instant asOf, String timezone, int limit) {
        String tagFilter = subcategory == null ? "" : " and :tag = any(coalesce(m.tags, '{}'::text[]))";
        String sql = String.join("\n",
                "with scoped as (",
                "  select distinct on (m.id) m.id as merchant_id",
                "  from locations l",
                "  join merchants m on m.id = l.merchant_id",
                "  where m.tenant_id = :tenant_id",
                "    and m.status = 'published'",
                "    and " + CITY_SLUG + " = :city",
                "    and nullif(btrim(coalesce(m.category_primary, '')), '') = :category",
                tagFilter,
                "  order by m.id, l.is_primary desc, l.created_at",
                ")",
                "select " + MerchantCards.COLUMNS,
                "from scoped s",
                "join merchants m on m.id = s.merchant_id",
                MerchantCards.LATERAL_JOINS,
                "order by m.rating_agg desc, m.review_count desc, m.slug asc",
                "limit :limit");
        Map<String, Object> params = new LinkedHashMap<>(MerchantCards.openStateParams(asOf, timezone));
        params.put("city", city);
        params.put("category", category);
        params.put("tag", subcategory);
        params.put("limit", limit);
        return jdbc.forTenant(tenant, sql, params);
    }
}
