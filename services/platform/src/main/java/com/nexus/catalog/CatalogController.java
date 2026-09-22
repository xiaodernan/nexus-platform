package com.nexus.catalog;

import com.nexus.merchant.MerchantRepository;
import com.nexus.platform.ApiException;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §4 — the consumer-facing merchant reads. All of them are public and cacheable (a
 * consumer browsing a directory holds no session), all of them answer from published rows only, and
 * none of them writes: the workspace half of the same tables lives in {@code com.nexus.merchant}
 * behind {@code @RequiresPermission}.
 *
 * <p>What the handlers add over {@link CatalogRepository} is the parsing and the honesty labels:
 * <ul>
 *   <li>filters are validated before they reach SQL, so {@code ?max_price=abc} is a 422 that names the
 *       field rather than a 500 or a silently ignored clause;</li>
 *   <li>every list carries the filters it was actually applied ({@code filters}) and the instant the
 *       open/closed column was computed ({@code as_of}), because a cached page that says "open now"
 *       twelve hours later is a lie about a different moment;</li>
 *   <li>an absent sub-resource is a 404 ({@code merchant_not_found}, {@code review_summary_not_found}),
 *       never an empty 200 that a client renders as "this place has no reviews".</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v1/merchants")
public class CatalogController {

    private static final String CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
    private static final int TOP_OFFERINGS = 6;
    private static final Duration DEFAULT_AVAILABILITY_WINDOW = Duration.ofDays(7);
    private static final Duration MAX_AVAILABILITY_WINDOW = Duration.ofDays(90);
    private static final int MAX_AVAILABILITY_SLOTS = 100;

    /** Organic sorts only (§66): no fragment reads a plan, campaign, coupon or spend column. */
    private static final Map<String, String> MERCHANT_SORTS = Map.of(
            "popularity", "m.popularity_score",
            "rating", "m.rating_agg",
            "reviews", "m.review_count",
            "price", "m.avg_price_hkd",
            "updated", "m.updated_at",
            "open", "is_open");

    /**
     * The order a directory page uses when the caller named none. It is a constant, not
     * {@link #MERCHANT_SORTS} with a direction appended, because the house default for a bare token is
     * ascending and "least popular first" is not a default anyone asked for.
     */
    private static final String DEFAULT_MERCHANT_ORDER = "m.popularity_score desc nulls last";

    private static final Map<String, String> OFFERING_SORTS = Map.of(
            "popularity", "o.popularity_score",
            "price", "o.price_amount",
            "rating", "o.rating_agg",
            "name", "o.name",
            "updated", "o.created_at");

    private static final String DEFAULT_OFFERING_ORDER =
            "o.popularity_score desc nulls last, o.rating_agg desc nulls last, o.name asc";

    private static final Map<String, String> REVIEW_SORTS = Map.of(
            "recent", "r.created_at",
            "helpful", "r.helpful_count");

    private static final String DEFAULT_REVIEW_ORDER = "r.created_at desc";

    private final CatalogRepository catalog;
    private final MerchantRepository merchants;
    private final OfferingRepository offerings;
    private final Paging paging;

    public CatalogController(CatalogRepository catalog, MerchantRepository merchants, OfferingRepository offerings,
                             Paging paging) {
        this.catalog = catalog;
        this.merchants = merchants;
        this.offerings = offerings;
        this.paging = paging;
    }

    // ---- the directory ---------------------------------------------------

    @GetMapping
    public Map<String, Object> list(@RequestParam(required = false) String district,
                                    @RequestParam(required = false) String category,
                                    @RequestParam(required = false) String max_price,
                                    @RequestParam(required = false) String open_now,
                                    @RequestParam(required = false) String rating,
                                    @RequestParam(required = false) String sort,
                                    @RequestParam(required = false) String limit,
                                    @RequestParam(required = false) String cursor,
                                    HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        CatalogRepository.MerchantFilters filters = new CatalogRepository.MerchantFilters(
                text(district, "district", 60), text(category, "category", 60),
                money(max_price, "max_price"), money(rating, "rating"),
                Paging.booleanFilter(open_now));
        if (filters.minRating() != null && (filters.minRating().signum() < 0
                || filters.minRating().compareTo(BigDecimal.valueOf(5)) > 0)) {
            throw ApiException.validation("rating must be between 0 and 5", Json.map("field", "rating"));
        }
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);
        String sortToken = sortName(sort, "popularity");
        String orderBy = order(MERCHANT_SORTS, sort, DEFAULT_MERCHANT_ORDER, "popularity");

        List<Map<String, Object>> rows = catalog.merchantRows(tenant, filters, asOf, orderBy, size, offset);
        long total = catalog.countMerchants(tenant, filters, asOf);
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            items.add(listItem(row, tenant.currency(), asOf));
        }

        cache(response, CACHE, tenant);
        // One synthetic row in the page is enough to earn the flag: the header is a claim about the data,
        // not about its average.
        DemoFlags.mark(response, rows.stream()
                .anyMatch(row -> DemoFlags.isDemo(Json.str(row, "data_origin"))));
        Map<String, Object> page = paging.page(items, offset, size, total);
        page.put("as_of", asOf.toString());
        page.put("filters", appliedFilters(filters));
        page.put("sort", sortToken);
        page.put("unit", "price is average HKD per person; rating is the merchant's aggregate over published reviews");
        return page;
    }

    // ---- one merchant ----------------------------------------------------

    @GetMapping("/{idOrSlug}")
    public Map<String, Object> detail(@PathVariable String idOrSlug,
                                      HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        Map<String, Object> row = requireRow(tenant, idOrSlug, asOf);
        UUID merchantId = Json.uuid(row, "id");

        List<Map<String, Object>> locations = new ArrayList<>();
        for (Map<String, Object> location : merchants.locations(tenant, merchantId)) {
            locations.add(MerchantRepository.locationView(location));
        }
        List<Map<String, Object>> hours = new ArrayList<>();
        for (Map<String, Object> day : merchants.businessHours(tenant, merchantId)) {
            hours.add(hourView(day));
        }
        List<Map<String, Object>> categories = new ArrayList<>();
        for (Map<String, Object> category : catalog.categoriesOf(tenant, merchantId)) {
            categories.add(Json.map("category_id", Json.str(category, "id"), "slug", Json.str(category, "slug"),
                    "name", Json.str(category, "name"), "name_zh", Json.str(category, "name_zh"),
                    "kind", Json.str(category, "kind"), "parent_slug", Json.str(category, "parent_slug"),
                    "parent_name", Json.str(category, "parent_name")));
        }

        Map<String, Object> out = MerchantCards.card(row, tenant.currency(), asOf);
        out.put("district", Json.str(row, "district"));
        out.put("city", Json.str(row, "city"));
        out.put("legal_name", Json.str(row, "legal_name"));
        out.put("display_name", Json.map("en", Json.str(row, "display_name"), "zh", Json.str(row, "display_name_zh")));
        out.put("category", Json.str(row, "category_primary"));
        out.put("categories", categories);
        out.put("price_band", Json.str(row, "price_band"));
        out.put("contact", Json.jsonObject(row, "contact"));
        out.put("socials", Json.jsonObject(row, "socials"));
        out.put("tags", Json.textArray(row, "tags"));
        out.put("attributes", Json.jsonObject(row, "attributes"));
        out.put("images", Json.jsonArray(row, "images"));
        out.put("ai_agent_enabled", Json.bool(row, "ai_agent_enabled"));
        out.put("data_origin", Json.str(row, "data_origin"));
        out.put("ownership_verified", Json.bool(row, "ownership_verified"));
        out.put("status", Json.str(row, "status"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        out.put("locations", locations);
        out.put("business_hours", hours);
        out.put("top_offerings", offeringViews(offerings.activeForMerchant(tenant, merchantId, TOP_OFFERINGS, 0,
                DEFAULT_OFFERING_ORDER)));
        out.put("menu_count", offerings.countActive(tenant, merchantId));
        out.put("review_summary", catalog.reviewSummaryRow(tenant, merchantId)
                .map(summary -> reviewSummaryView(summary, asOf)).orElse(null));
        out.put("review_stats", reviewStatsView(tenant, merchantId, asOf));
        // §66: the profile is served to anyone, but the merchant's subscription tier is workspace data
        // and says nothing about the listing, so `plan` is deliberately not echoed here.
        cache(response, CACHE, tenant);
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        return out;
    }

    // ---- menu ------------------------------------------------------------

    @GetMapping("/{idOrSlug}/menu")
    public Map<String, Object> menu(@PathVariable String idOrSlug,
                                    @RequestParam(required = false) String kind,
                                    @RequestParam(required = false) String sort,
                                    @RequestParam(required = false) String limit,
                                    @RequestParam(required = false) String cursor,
                                    HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        Map<String, Object> row = requireRow(tenant, idOrSlug, asOf);
        UUID merchantId = Json.uuid(row, "id");
        String offeringKind = Paging.enumFilter(kind, List.of("product", "service", "experience"), "kind");
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);
        String orderBy = order(OFFERING_SORTS, sort, DEFAULT_OFFERING_ORDER, "popularity");

        List<Map<String, Object>> rows = offerings.activeForMerchant(tenant, merchantId, offeringKind,
                size, offset, orderBy);
        long total = offerings.countActive(tenant, merchantId, offeringKind);

        cache(response, CACHE, tenant);
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        Map<String, Object> page = paging.page(offeringViews(rows), offset, size, total);
        page.put("merchant_id", merchantId.toString());
        page.put("slug", Json.str(row, "slug"));
        page.put("kind", offeringKind);
        page.put("sort", sortName(sort, "popularity"));
        page.put("status_scope", "active offerings of a published merchant");
        page.put("currency", tenant.currency());
        return page;
    }

    // ---- reviews + summary ----------------------------------------------

    @GetMapping("/{idOrSlug}/reviews")
    public Map<String, Object> reviews(@PathVariable String idOrSlug,
                                       @RequestParam(required = false) String sort,
                                       @RequestParam(required = false) String limit,
                                       @RequestParam(required = false) String cursor,
                                       HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        Map<String, Object> row = requireRow(tenant, idOrSlug, asOf);
        UUID merchantId = Json.uuid(row, "id");
        String orderBy = order(REVIEW_SORTS, sort, DEFAULT_REVIEW_ORDER, "recent");
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);

        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> review : catalog.reviewRows(tenant, merchantId, orderBy, size, offset)) {
            items.add(reviewView(review));
        }
        cache(response, CACHE, tenant);
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        Map<String, Object> page = paging.page(items, offset, size, catalog.countReviews(tenant, merchantId));
        page.put("merchant_id", merchantId.toString());
        page.put("sort", sortName(sort, "recent"));
        page.put("status_scope", "published reviews only; pending, rejected and flagged rows are not readable here");
        page.put("aggregate", reviewStatsView(tenant, merchantId, asOf));
        return page;
    }

    /**
     * The AI review summary (§55). It is read from {@code review_summaries}, which only the review agent
     * writes: where it has not run, this is a 404 rather than an empty 200, because "no summary has been
     * generated" and "this place has no reviews" are different facts. The recomputed aggregate the
     * summary would have been built from travels on {@code /reviews} and on the profile.
     */
    @GetMapping("/{idOrSlug}/reviews/summary")
    public Map<String, Object> reviewSummary(@PathVariable String idOrSlug,
                                            HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        Map<String, Object> row = requireRow(tenant, idOrSlug, asOf);
        UUID merchantId = Json.uuid(row, "id");
        cache(response, "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400", tenant);
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        return catalog.reviewSummaryRow(tenant, merchantId)
                .map(stored -> reviewSummaryView(stored, asOf))
                .orElseThrow(() -> ApiException.notFound("review_summary_not_found",
                        "No AI review summary has been generated for this merchant"));
    }

    // ---- availability ----------------------------------------------------

    @GetMapping("/{idOrSlug}/availability")
    public Map<String, Object> availability(@PathVariable String idOrSlug,
                                            @RequestParam(required = false) String starts_at,
                                            @RequestParam(required = false) String ends_at,
                                            @RequestParam(required = false) String party_size,
                                            @RequestParam(required = false) String limit,
                                            HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        Map<String, Object> row = requireRow(tenant, idOrSlug, asOf);
        UUID merchantId = Json.uuid(row, "id");

        Instant from = instant(starts_at, "starts_at", asOf);
        Instant to = instant(ends_at, "ends_at", from.plus(DEFAULT_AVAILABILITY_WINDOW));
        if (!to.isAfter(from)) {
            throw ApiException.validation("ends_at must be after starts_at",
                    Json.map("field", "ends_at", "starts_at", from.toString(), "ends_at", to.toString()));
        }
        if (Duration.between(from, to).compareTo(MAX_AVAILABILITY_WINDOW) > 0) {
            throw ApiException.validation("the availability window is capped at " + MAX_AVAILABILITY_WINDOW.toDays()
                    + " days", Json.map("field", "ends_at", "max_days", MAX_AVAILABILITY_WINDOW.toDays()));
        }
        Integer party = integer(party_size, "party_size", 1, 20);
        int size = Math.min(paging.limit(limit), MAX_AVAILABILITY_SLOTS);
        List<Map<String, Object>> rows = catalog.availabilityRows(tenant, merchantId, from, to, party, size);

        List<Map<String, Object>> slots = new ArrayList<>();
        for (Map<String, Object> slot : rows) {
            slots.add(slotView(slot));
        }
        // §20: availability is real-time. Any cache on this response would sell a seat someone else took.
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader(HttpHeaders.VARY, "X-Tenant");
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("slots", slots);
        out.put("slot_count", slots.size());
        out.put("window", Json.map("starts_at", from.toString(), "ends_at", to.toString()));
        out.put("party_size", party);
        out.put("as_of", asOf.toString());
        out.put("source", "availability_slots, capacity_left > 0");
        out.put("truncated", rows.size() == size);
        out.put("next_cursor", null);
        return out;
    }

    // ---- views -----------------------------------------------------------

    /** A directory row: the §2 card plus the two location columns a grid needs to render its own filter chips. */
    private static Map<String, Object> listItem(Map<String, Object> row, String currency, Instant asOf) {
        Map<String, Object> item = MerchantCards.card(row, currency, asOf);
        item.put("district", Json.str(row, "district"));
        item.put("city", Json.str(row, "city"));
        item.put("category", Json.str(row, "category_primary"));
        item.put("avg_price_hkd", Json.dec(row, "avg_price_hkd"));
        return item;
    }

    private static Map<String, Object> hourView(Map<String, Object> row) {
        return Json.map("weekday", Json.integer(row, "weekday"),
                "opens_at", Json.time(row, "opens_at"), "closes_at", Json.time(row, "closes_at"),
                "crosses_midnight", Json.bool(row, "crosses_midnight"), "source", Json.str(row, "source"),
                "location_id", Json.str(row, "location_id"), "updated_at", Json.ts(row, "updated_at"));
    }

    private static List<Map<String, Object>> offeringViews(List<Map<String, Object>> rows) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            out.add(OfferingRepository.view(row));
        }
        return out;
    }

    /**
     * The §5 review shape. Package-private so {@link ReviewController} can echo the row it just created
     * through the same projection the public list uses — one projection, one truth (D24). Two spellings is
     * how an author ends up seeing a field the published page does not show, or the other way round.
     */
    static Map<String, Object> reviewView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("review_id", Json.str(row, "id"));
        out.put("merchant_id", Json.str(row, "merchant_id"));
        out.put("offering_id", Json.str(row, "offering_id"));
        out.put("author", Json.map("user_id", Json.str(row, "user_id"),
                "display_name", Json.str(row, "author_name") == null
                        ? Json.str(row, "author_label") : Json.str(row, "author_name")));
        out.put("rating", Json.dec(row, "rating"));
        out.put("title", Json.str(row, "title"));
        // Review text is consumer content: untrusted input (AGENT_CONTRACT §8), so it travels as data and
        // the client renders it with no HTML.
        out.put("body", Json.str(row, "body"));
        out.put("language", Json.str(row, "language"));
        out.put("photos", Json.jsonArray(row, "photos"));
        out.put("aspects", Json.jsonObject(row, "aspects"));
        out.put("helpful_count", Json.integer(row, "helpful_count"));
        out.put("verified_purchase", Json.bool(row, "verified_purchase"));
        out.put("verified_reservation", Json.bool(row, "verified_reservation"));
        out.put("data_origin", Json.str(row, "data_origin"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("flags", Json.map("demo", DemoFlags.isDemo(Json.str(row, "data_origin")),
                "verified_visit", Boolean.TRUE.equals(Json.bool(row, "verified_purchase"))
                        || Boolean.TRUE.equals(Json.bool(row, "verified_reservation"))));
        return out;
    }

    private static Map<String, Object> slotView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", Json.str(row, "id"));
        out.put("merchant_id", Json.str(row, "merchant_id"));
        out.put("pool_id", Json.str(row, "pool_id"));
        out.put("pool", Json.str(row, "pool_id") == null ? null
                : Json.map("name", Json.str(row, "pool_name"), "kind", Json.str(row, "pool_kind"),
                        "capacity", Json.integer(row, "pool_capacity")));
        out.put("offering", Json.str(row, "offering_id") == null ? null
                : Json.map("offering_id", Json.str(row, "offering_id"), "slug", Json.str(row, "offering_slug"),
                        "name", Json.str(row, "offering_name")));
        out.put("starts_at", Json.ts(row, "starts_at"));
        out.put("ends_at", Json.ts(row, "ends_at"));
        out.put("capacity_total", Json.integer(row, "capacity_total"));
        out.put("capacity_left", Json.integer(row, "capacity_left"));
        out.put("price", Json.money(row, "price_amount", "currency"));
        out.put("source", Json.str(row, "source"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        // The slot row is its own evidence — there is no separate `facts` row for inventory, so the
        // field is null rather than a synthesised id pretending to be one (AGENT_CONTRACT §4).
        out.put("fact_id", null);
        return out;
    }

    /** The recomputed aggregate: what the review table says right now, with the instant it was read. */
    private Map<String, Object> reviewStatsView(TenantContext tenant, UUID merchantId, Instant asOf) {
        Map<String, Object> stats = catalog.reviewStats(tenant, merchantId);
        long published = Json.longOf(stats, "published_reviews") == null ? 0 : Json.longOf(stats, "published_reviews");
        List<Map<String, Object>> buckets = new ArrayList<>();
        for (Map<String, Object> bucket : catalog.ratingBuckets(tenant, merchantId)) {
            Long count = Json.longOf(bucket, "reviews");
            long n = count == null ? 0 : count;
            buckets.add(Json.map("bucket", Json.integer(bucket, "bucket"), "count", n,
                    "share", published == 0 ? null : BigDecimal.valueOf(n)
                            .divide(BigDecimal.valueOf(published), 4, java.math.RoundingMode.HALF_UP)));
        }
        return Json.map("published_reviews", published,
                "average_rating", Json.dec(stats, "average_rating"),
                "positive_reviews", Json.longOf(stats, "positive_reviews"),
                "negative_reviews", Json.longOf(stats, "negative_reviews"),
                "verified_purchase_reviews", Json.longOf(stats, "verified_purchase_reviews"),
                "verified_reservation_reviews", Json.longOf(stats, "verified_reservation_reviews"),
                "latest_review_at", Json.ts(stats, "latest_review_at"),
                "distribution", buckets,
                "computed_at", asOf.toString(),
                "source", "count(*) and avg() over reviews with status = 'published'",
                "note", "merchants.rating_agg is a denormalised column and may differ from this recomputation");
    }

    private static Map<String, Object> reviewSummaryView(Map<String, Object> row, Instant asOf) {
        List<Object> praise = Json.jsonArray(row, "praise");
        List<Object> complaints = Json.jsonArray(row, "complaints");
        return Json.map("merchant_id", Json.str(row, "merchant_id"),
                "overall", Json.dec(row, "overall"),
                "praise", praise, "complaints", complaints,
                "sample_size", Json.integer(row, "sample_size"),
                "model", Json.str(row, "model"),
                "generated_at", Json.ts(row, "generated_at"),
                "updated_at", Json.ts(row, "updated_at"),
                // §55: the point of the summary is the evidence, so the ids are lifted out of the bullets
                // into one list the client can link back to `/reviews` with.
                "evidence_review_ids", evidenceOf(praise, complaints),
                "text", null,
                "flags", Json.map("demo", DemoFlags.isDemo(Json.str(row, "data_origin")), "sponsored", false),
                "as_of", asOf.toString());
    }

    private static List<String> evidenceOf(List<Object> praise, List<Object> complaints) {
        Set<String> ids = new LinkedHashSet<>();
        for (List<Object> group : List.of(praise, complaints)) {
            for (Object entry : group) {
                if (entry instanceof Map<?, ?> point && point.get("review_ids") instanceof List<?> listed) {
                    for (Object id : listed) {
                        ids.add(String.valueOf(id));
                    }
                }
            }
        }
        return new ArrayList<>(ids);
    }

    // ---- parsing ---------------------------------------------------------

    private Map<String, Object> requireRow(TenantContext tenant, String idOrSlug, Instant asOf) {
        UUID asUuid = Json.uuidOrNull(idOrSlug);
        return catalog.merchantRow(tenant, idOrSlug, asUuid == null ? new UUID(0, 0) : asUuid, asOf)
                .orElseThrow(() -> ApiException.notFound("merchant_not_found", "No such merchant"));
    }

    /**
     * The ORDER BY fragment for a caller-supplied sort token. No token is the endpoint's own default (a
     * bare token means ascending in {@link Paging#orderBy}, so the defaults are stated in full); an
     * unknown token is a 422 listing what is allowed, and client text never reaches the SQL text.
     */
    private String order(Map<String, String> whitelist, String token, String defaultFragment, String defaultKey) {
        return token == null || token.isBlank()
                ? defaultFragment
                : paging.orderByNullsLast(whitelist, token, defaultKey);
    }

    /** The sort echoed back to the caller: what was applied, not what was typed. */
    private static String sortName(String token, String defaultKey) {
        return token == null || token.isBlank() ? defaultKey : token.trim().toLowerCase();
    }

    private static Map<String, Object> appliedFilters(CatalogRepository.MerchantFilters f) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("district", f.district());
        out.put("category", f.category());
        out.put("max_price", f.maxPrice());
        out.put("open_now", f.openNow());
        out.put("rating", f.minRating());
        return out;
    }

    private static void cache(HttpServletResponse response, String value, TenantContext tenant) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, value);
        // The payload is tenant-resolved (X-Tenant / the default market), so a shared cache must not
        // serve one market's merchants to another.
        response.setHeader(HttpHeaders.VARY, "X-Tenant");
    }

    private static String text(String raw, String field, int maxLength) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.trim();
        if (value.length() > maxLength) {
            throw ApiException.validation(field + " must be at most " + maxLength + " characters",
                    Json.map("field", field, "max_length", maxLength));
        }
        return value;
    }

    private static BigDecimal money(String raw, String field) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        BigDecimal value;
        try {
            value = new BigDecimal(raw.trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation(field + " must be a number", Json.map("field", field, "received", raw));
        }
        if (value.signum() < 0) {
            throw ApiException.validation(field + " must be >= 0", Json.map("field", field));
        }
        return value;
    }

    private static Integer integer(String raw, String field, int min, int max) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        int value;
        try {
            value = Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation(field + " must be an integer", Json.map("field", field, "received", raw));
        }
        if (value < min || value > max) {
            throw ApiException.validation(field + " must be between " + min + " and " + max,
                    Json.map("field", field, "min", min, "max", max));
        }
        return value;
    }

    private static Instant instant(String raw, String field, Instant fallback) {
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            return Instant.parse(raw.trim());
        } catch (Exception e) {
            throw ApiException.validation(field + " must be an ISO-8601 instant",
                    Json.map("field", field, "received", raw));
        }
    }
}
