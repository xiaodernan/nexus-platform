package com.nexus.seo;

import com.nexus.catalog.MerchantCards;
import com.nexus.platform.ApiException;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/seo/routes} and {@code GET /api/v1/seo/page} — the programmatic-SEO reads of
 * API_CONTRACT §8 (grammar §29, quality bar §30).
 *
 * <p>Both are public and cacheable: no {@code @RequiresAuth}, and the response says so with
 * {@code s-maxage} + {@code stale-while-revalidate}. A shared cache must never store a personalised
 * variant of a directory page, so nothing here reads the caller's session.
 *
 * <p><b>The §30 decision lives here, not in the view.</b> {@code indexable} is the four-term formula of
 * API_CONTRACT §8 — a published {@code seo_pages} row for this path, a live listing count at or above
 * {@code nexus.seo.min-listings-for-index} (default 5), the row's {@code quality_score} at or above
 * {@code nexus.seo.min-quality-score} (default 0.6), and a human {@code reviewed_by} whenever the row
 * says it was written by {@code ai_seo_agent}. A thin page is still served, because a human may want to
 * look at it, and it carries a machine-readable {@code reason} ({@code not_published},
 * {@code too_few_listings}, {@code below_quality_bar}, {@code unreviewed_ai}, {@code enough_listings})
 * plus the {@code quality_bar} inputs it was derived from, so the sitemap and the robots directive can
 * disagree with the HTTP status without inventing one. A route with <em>no</em> listings is not a thin
 * page, it is not a page: that answers 404 through the standard envelope (§1, §8 "never an empty 200").
 */
@RestController
@RequestMapping("/api/v1/seo")
public class SeoController {

    /** §8: public, cacheable, and never cookie-scoped. */
    private static final String CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";

    /** Configuration keys, echoed in the payload so nobody has to guess where a threshold came from. */
    private static final String MIN_LISTINGS_KEY = "nexus.seo.min-listings-for-index";
    private static final String MIN_SCORE_KEY = "nexus.seo.min-quality-score";

    /** {@code seo_pages.generated_by} default in V1__init.sql — the only author that needs a reviewer. */
    private static final String AI_SEO_AGENT = "ai_seo_agent";

    private final SeoRepository seo;
    private final int minListingsForIndex;
    private final BigDecimal minQualityScore;
    private final BigDecimal underBudgetHkd;

    public SeoController(SeoRepository seo,
                         @Value("${" + MIN_LISTINGS_KEY + ":5}") int minListingsForIndex,
                         @Value("${" + MIN_SCORE_KEY + ":0.6}") BigDecimal minQualityScore,
                         @Value("${nexus.seo.under-budget-hkd:200}") BigDecimal underBudgetHkd) {
        this.seo = seo;
        this.minListingsForIndex = Math.max(1, minListingsForIndex);
        this.minQualityScore = minQualityScore == null ? new BigDecimal("0.6") : minQualityScore;
        this.underBudgetHkd = underBudgetHkd == null ? new BigDecimal("200") : underBudgetHkd;
    }

    /**
     * The route grammar a city can answer: {@code [{city, category, subcategory, listings}]}. Every
     * {@code listings} is a {@code count(*)} over published merchants (see {@link SeoRepository}), so a
     * category with no merchants never appears — the city landing cannot advertise an empty aisle.
     */
    @GetMapping("/routes")
    public Map<String, Object> routes(@RequestParam(required = false) String city,
                                      HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        String scopedCity = SeoRepository.optionalSlugOr404(city, "city");
        List<Map<String, Object>> rows = seo.routeRows(tenant, scopedCity);

        List<Map<String, Object>> routes = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            routes.add(Json.map("city", Json.str(row, "city"),
                    "category", Json.str(row, "category"),
                    "subcategory", Json.str(row, "subcategory"),
                    "listings", Json.longOf(row, "listings")));
        }
        Map<String, Object> payload = Json.map("city", scopedCity, "routes", routes, "route_count", routes.size());
        cacheable(response, payload);
        return payload;
    }

    /**
     * One directory page in the §29 grammar. {@code subcategory} is optional; a (city, category) pair
     * with no published merchant behind it — or a segment the grammar cannot carry — is a 404.
     */
    @GetMapping("/page")
    public Map<String, Object> page(@RequestParam(required = false) String city,
                                    @RequestParam(required = false) String category,
                                    @RequestParam(required = false) String subcategory,
                                    HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        String citySlug = SeoRepository.slugOr404(city, "city");
        String categorySlug = SeoRepository.slugOr404(category, "category");
        String subcategorySlug = SeoRepository.optionalSlugOr404(subcategory, "subcategory");

        Instant asOf = Instant.now();
        List<Map<String, Object>> rows = seo.listingRows(tenant, citySlug, categorySlug, subcategorySlug,
                asOf, tenant.timezone(), SeoRepository.MAX_LISTINGS);
        if (rows.isEmpty()) {
            throw ApiException.notFound("seo_route_not_found",
                    "This directory has no listings for that route");
        }

        // Authored content, when the SEO agent has published a page for this exact path (§28). Its
        // `updated_at` is a real column; the listings above are still counted live.
        String path = "/" + citySlug + "/" + categorySlug + (subcategorySlug == null ? "" : "/" + subcategorySlug);
        Optional<Map<String, Object>> projection = seo.pageProjection(tenant, path);

        List<Map<String, Object>> listings = new ArrayList<>();
        List<Map<String, Object>> cards = new ArrayList<>();
        List<BigDecimal> prices = new ArrayList<>();
        Map<String, Integer> districtCounts = new LinkedHashMap<>();
        int openNow = 0;
        int underBudget = 0;
        boolean anyDemo = false;
        Instant newestRow = null;

        for (Map<String, Object> row : rows) {
            boolean demo = DemoFlags.isDemo(Json.str(row, "data_origin"));
            anyDemo |= demo;
            BigDecimal price = Json.dec(row, "avg_price_hkd");
            String district = blankToNull(Json.str(row, "district"));
            // The same facts the card carries, so the listing row and the card on it can never cite
            // different provenance for the same number (§19).
            List<Map<String, Object>> facts = MerchantCards.factsOf(row);

            if (Boolean.TRUE.equals(Json.bool(row, "is_open"))) {
                openNow++;
            }
            if (price != null) {
                prices.add(price);
                if (price.compareTo(underBudgetHkd) <= 0) {
                    underBudget++;
                }
            }
            if (district != null) {
                districtCounts.merge(district, 1, Integer::sum);
            }
            Instant updatedAt = instantOf(Json.ts(row, "updated_at"));
            if (updatedAt != null && (newestRow == null || updatedAt.isAfter(newestRow))) {
                newestRow = updatedAt;
            }

            listings.add(Json.map(
                    "slug", Json.str(row, "slug"),
                    "name", Json.str(row, "display_name"),
                    "district", district,
                    "category", Json.str(row, "category_primary"),
                    "subcategory", MerchantCards.firstTag(Json.textArray(row, "tags")),
                    "avg_price", Json.money(price, tenant.currency()),
                    "rating", MerchantCards.rating(Json.dec(row, "rating_agg"), Json.integer(row, "review_count")),
                    "price_fact_id", factId(facts, "price"),
                    "rating_fact_id", factId(facts, "rating"),
                    "facts", facts,
                    "demo", demo));

            cards.add(MerchantCards.card(row, tenant.currency(), asOf));
        }

        // ---- §30: the indexability verdict, computed here and nowhere else ------------------
        // Exactly the formula of docs/API_CONTRACT.md §8, evaluated in the order §8 states it:
        //   indexable = status = 'published' AND listings >= <tenant threshold>
        //               AND (quality_score IS NULL OR quality_score >= 0.6)
        //               AND (generated_by <> 'ai_seo_agent' OR reviewed_by IS NOT NULL)
        // A missing `seo_pages` row is *not* a pass — absence is reported as `not_published`, while
        // the listings themselves still render, because a human may still want to look at the page.
        Map<String, Object> authored = projection.orElse(null);
        String projectionStatus = authored == null ? null : Json.str(authored, "status");
        boolean published = "published".equals(projectionStatus);
        BigDecimal qualityScore = authored == null ? null : Json.dec(authored, "quality_score");
        String generatedBy = authored == null ? null : Json.str(authored, "generated_by");
        String reviewedBy = authored == null ? null : Json.str(authored, "reviewed_by");
        boolean indexable;
        String reason;
        if (!published) {
            indexable = false;
            reason = "not_published";
        } else if (listings.size() < minListingsForIndex) {
            indexable = false;
            reason = "too_few_listings";
        } else if (qualityScore != null && qualityScore.compareTo(minQualityScore) < 0) {
            indexable = false;
            reason = "below_quality_bar";
        } else if (AI_SEO_AGENT.equals(generatedBy) && reviewedBy == null) {
            indexable = false;
            reason = "unreviewed_ai";
        } else {
            indexable = true;
            reason = "enough_listings";
        }

        Map<String, Object> body = new LinkedHashMap<>();
        String heading;
        String intro;
        String updatedAt;
        if (published) {
            heading = firstNonBlank(Json.str(authored, "h1"), Json.str(authored, "title"));
            intro = Json.str(authored, "description") == null ? "" : Json.str(authored, "description");
            updatedAt = Json.ts(authored, "updated_at");
        } else {
            // A draft/absent projection has not been published for the world, so its copy is not served;
            // the page is built from the slugs and the merchants' own timestamps instead.
            heading = fallbackHeading(citySlug, categorySlug, subcategorySlug);
            intro = "";
            updatedAt = newestRow == null ? null : newestRow.toString();
        }
        if (heading == null) {
            heading = fallbackHeading(citySlug, categorySlug, subcategorySlug);
        }
        if (updatedAt == null) {
            // No published seo_pages row and no merchant timestamp: there is nothing honest to say
            // about when this page changed, so this is an error, not a guessed timestamp.
            throw ApiException.internal("seo page has no updated_at source", null);
        }

        DemoFlags.mark(response, anyDemo);
        body.put("city", citySlug);
        body.put("category", categorySlug);
        body.put("subcategory", subcategorySlug);
        body.put("heading", heading);
        body.put("intro", intro);
        body.put("listings", listings);
        body.put("cards", cards);
        body.put("facets", Json.map(
                "open_now_count", openNow,
                "under_budget_count", underBudget,
                // The ceiling travels with the count so the page can state it (§19).
                "under_budget_hkd", underBudgetHkd,
                "districts", orderedByFrequency(districtCounts),
                "price_range", priceRange(prices)));
        body.put("updated_at", updatedAt);
        body.put("indexable", indexable);
        body.put("reason", reason);
        // The inputs of the verdict, so a reviewer can re-derive it from the payload alone.
        body.put("quality_bar", Json.map(
                "min_listings", minListingsForIndex,
                "min_quality_score", minQualityScore,
                "listings", listings.size(),
                "projection_status", projectionStatus,
                "quality_score", qualityScore,
                "generated_by", generatedBy,
                "reviewed_by", reviewedBy,
                "threshold_sources", Json.map("min_listings", MIN_LISTINGS_KEY, "min_quality_score", MIN_SCORE_KEY)));
        cacheable(response, body);
        return body;
    }

    // ---- helpers ----------------------------------------------------------

    private static void cacheable(HttpServletResponse response, Object payload) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, CACHE_CONTROL);
        response.setHeader(HttpHeaders.VARY, "X-Tenant");
        String etag = etagOf(payload);
        if (etag != null) {
            response.setHeader(HttpHeaders.ETAG, etag);
        }
    }

    /** §11: a strong function of the body we are about to send, so a cached copy can be revalidated. */
    private static String etagOf(Object payload) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(Json.write(payload).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return "W/\"" + java.util.HexFormat.of().formatHex(digest, 0, 8) + "\"";
        } catch (Exception e) {
            return null;
        }
    }

    /** The id of the fact backing one rendered number, or null when no fact backs it. */
    private static String factId(List<Map<String, Object>> facts, String attribute) {
        for (Map<String, Object> fact : facts) {
            if (attribute.equals(fact.get("attribute"))) {
                return fact.get("fact_id") == null ? null : String.valueOf(fact.get("fact_id"));
            }
        }
        return null;
    }

    private static List<String> orderedByFrequency(Map<String, Integer> counts) {
        return counts.entrySet().stream()
                .sorted(Comparator.<Map.Entry<String, Integer>>comparingInt(Map.Entry::getValue).reversed()
                        .thenComparing(Map.Entry::getKey))
                .map(Map.Entry::getKey)
                .toList();
    }

    private static Map<String, Object> priceRange(List<BigDecimal> prices) {
        if (prices.isEmpty()) {
            return null;
        }
        BigDecimal min = prices.stream().min(BigDecimal::compareTo).orElse(null);
        BigDecimal max = prices.stream().max(BigDecimal::compareTo).orElse(null);
        return Json.map("min", min, "max", max);
    }

    /**
     * Fallback H1 when no SEO agent has authored a page for this path: the slugs themselves, in the
     * grammar's own order. A translation belongs in the view's dictionary, which is exactly where the
     * consumer app renders one — the platform does not invent localised copy.
     */
    private static String fallbackHeading(String city, String category, String subcategory) {
        return subcategory == null ? category + " in " + city : subcategory + " " + category + " in " + city;
    }

    private static Instant instantOf(String iso) {
        if (iso == null) {
            return null;
        }
        try {
            return Instant.parse(iso.endsWith("Z") || iso.contains("+") ? iso : iso + "Z");
        } catch (Exception e) {
            return null;
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static String firstNonBlank(String first, String second) {
        String value = blankToNull(first);
        return value != null ? value : blankToNull(second);
    }
}
