package com.nexus.seo;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The §29 route grammar and the §30 quality bar, read over live merchant rows.
 *
 * <p>Every assertion here is about honesty of the number: the count must equal the rows we wrote, the
 * indexability verdict must follow the four terms of API_CONTRACT §8 (and flip when the underlying
 * column changes), a route the platform cannot fill must be a 404 rather than an empty 200, and
 * {@code updated_at} must be somebody's column.
 */
class SeoReadTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;

    @BeforeEach
    void seedTenants() {
        tenant = newTenant("seo");
        other = newTenant("seo-other");
    }

    /** Distinct per test run: tags are tenant-wide in the grammar, so a shared name would leak counts. */
    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- routes

    @Test
    @DisplayName("routes lists only routable (city, category, tag) triples, counted from real merchants")
    void routeListingIsCountedFromMerchants() {
        String tag = tag();
        for (int i = 0; i < 6; i++) {
            directoryMerchant(tenant, "restaurant-" + i + "-" + tag, "restaurants",
                    i < 2 ? List.of("quiet") : List.of(), "published", new BigDecimal("180.00"));
        }
        directoryMerchant(tenant, "draft-one-" + tag, "restaurants", List.of(), "draft", new BigDecimal("90.00"));
        directoryMerchant(tenant, "shop-one-" + tag, "shopping", List.of(), "published", new BigDecimal("60.00"));
        directoryMerchant(tenant, "uncategorised-" + tag, null, List.of(), "published", null);

        ResponseEntity<String> res = get(tenant, null, "/api/v1/seo/routes?city=hong-kong");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode routes = Json.tree(res.getBody()).path("routes");

        // The draft merchant and the merchant with no category answer no route at all.
        assertThat(route(routes, "restaurants", null)).isEqualTo(6);
        assertThat(route(routes, "restaurants", "quiet")).isEqualTo(2);
        assertThat(route(routes, "shopping", null)).isEqualTo(1);
        assertThat(hasRoute(routes, "no-such-category", null)).isFalse();
        // No empty aisle is advertised: a category with no merchants simply is not in the payload.
        assertThat(hasRoute(routes, "entertainment", null)).isFalse();
        // The city the caller asked for is the city that comes back, in slug form.
        assertThat(Json.tree(res.getBody()).path("city").asText()).isEqualTo("hong-kong");
        assertThat(Json.tree(res.getBody()).path("route_count").asInt()).isEqualTo(routes.size());

        // §8: public, cacheable, and it never wants a session.
        assertThat(res.getHeaders().getCacheControl()).contains("s-maxage").contains("stale-while-revalidate");
        assertThat(res.getHeaders().getFirst(HttpHeaders.ETAG)).isNotBlank();
    }

    @Test
    @DisplayName("A directory read never sees another tenant's merchants")
    void routesAreTenantScoped() {
        directoryMerchant(tenant, "only-here-" + tag(), "restaurants", List.of(), "published",
                new BigDecimal("100.00"));

        JsonNode mine = Json.tree(get(tenant, null, "/api/v1/seo/routes?city=hong-kong").getBody()).path("routes");
        assertThat(mine).hasSize(1);
        // Same city string, different tenant: nothing to list, and the page is a 404 rather than empty.
        assertThat(Json.tree(get(other, null, "/api/v1/seo/routes?city=hong-kong").getBody()).path("routes")).isEmpty();
        assertThat(get(other, null, "/api/v1/seo/page?city=hong-kong&category=restaurants").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---------------------------------------------------------------- page + §30 gate

    @Test
    @DisplayName("A published page over the §30 bar is indexable, and its facets count its own listings")
    void richPageIsIndexable() {
        String tag = tag();
        for (int i = 0; i < 5; i++) {
            directoryMerchant(tenant, "diner-" + i + "-" + tag, "restaurants", List.of(), "published",
                    new BigDecimal(i < 3 ? "120.00" : "900.00"));
        }
        // The human-reviewed, published projection: without it §30 says "absence is not a pass".
        UUID reviewer = newUser(tenant, "seo-reviewer-" + tag + "@example.test", "platform_ops");
        seedProjectionPage("/hong-kong/restaurants", "香港餐廳", reviewer);
        jdbc.update("update seo_pages set status = 'published' where tenant_id = :t and path = '/hong-kong/restaurants'",
                new MapSqlParameterSource("t", tenant.id()));

        JsonNode page = Json.tree(body("/api/v1/seo/page?city=hong-kong&category=restaurants"));
        assertThat(page.path("indexable").asBoolean()).isTrue();
        assertThat(page.path("reason").asText()).isEqualTo("enough_listings");
        assertThat(page.path("listings")).hasSize(5);
        assertThat(page.path("cards")).hasSize(5);
        // under_budget_hkd travels with its count (§19): 3 of the 5 merchants are at or below HK$200.
        assertThat(page.path("facets").path("under_budget_count").asInt()).isEqualTo(3);
        assertThat(page.path("facets").path("under_budget_hkd").asInt()).isEqualTo(200);
        assertThat(page.path("facets").path("price_range").path("min").asInt()).isEqualTo(120);
        assertThat(page.path("facets").path("price_range").path("max").asInt()).isEqualTo(900);
        assertThat(page.path("facets").path("districts").get(0).asText()).isEqualTo("Sha Tin");
        // A merchant with zero reviews has no rating to show.
        assertThat(page.path("listings").get(0).path("rating").isNull()).isTrue();
        assertThat(page.path("listings").get(0).path("avg_price").path("currency").asText()).isEqualTo("HKD");
        assertThat(page.path("listings").get(0).path("facts")).isEmpty();
        assertThat(page.path("listings").get(0).path("demo").asBoolean()).isTrue();
        // The bars the verdict used are stated, so nobody has to guess where they came from.
        assertThat(page.path("quality_bar").path("min_listings").asInt()).isEqualTo(5);
        assertThat(page.path("quality_bar").path("threshold_sources").path("min_listings").asText())
                .isEqualTo("nexus.seo.min-listings-for-index");
        assertThat(page.path("quality_bar").path("threshold_sources").path("min_quality_score").asText())
                .isEqualTo("nexus.seo.min-quality-score");
        // §8: a public, cacheable read; D6/§109: the synthetic origin of these rows is announced twice.
        ResponseEntity<String> res = get(tenant, null, "/api/v1/seo/page?city=hong-kong&category=restaurants");
        assertThat(res.getHeaders().getCacheControl()).contains("s-maxage").contains("stale-while-revalidate");
        assertThat(res.getHeaders().getFirst(HttpHeaders.VARY)).contains("X-Tenant");
        assertThat(res.getHeaders().getFirst(HttpHeaders.ETAG)).isNotBlank();
        assertThat(res.getHeaders().getFirst("X-Demo-Data")).isEqualTo("true");
    }

    @Test
    @DisplayName("A thin page is still served, and says why it must not be indexed")
    void thinPageIsServedButNotIndexed() {
        String tag = tag();
        directoryMerchant(tenant, "solo-" + tag, "restaurants", List.of(), "published", new BigDecimal("150.00"));
        UUID reviewer = newUser(tenant, "thin-reviewer-" + tag + "@example.test", "platform_ops");
        seedProjectionPage("/hong-kong/restaurants", "香港餐廳", reviewer);
        jdbc.update("update seo_pages set status = 'published' where tenant_id = :t and path = '/hong-kong/restaurants'",
                new MapSqlParameterSource("t", tenant.id()));

        ResponseEntity<String> res = get(tenant, null, "/api/v1/seo/page?city=hong-kong&category=restaurants");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(res.getBody());
        assertThat(page.path("indexable").asBoolean()).isFalse();
        assertThat(page.path("reason").asText()).isEqualTo("too_few_listings");
        assertThat(page.path("listings")).hasSize(1);
        // The same bar as the rich page: only the count moved.
        assertThat(page.path("quality_bar").path("listings").asInt()).isEqualTo(1);
        assertThat(page.path("quality_bar").path("min_listings").asInt()).isGreaterThan(1);
    }

    @Test
    @DisplayName("Each §30 term is its own reason, and the verdict follows the columns")
    void everyGateTermFlipsTheVerdict() {
        String tag = tag();
        for (int i = 0; i < 6; i++) {
            directoryMerchant(tenant, "bar-" + i + "-" + tag, "bars", List.of(), "published", null);
        }
        UUID reviewer = newUser(tenant, "bar-reviewer-" + tag + "@example.test", "platform_ops");
        seedProjectionPage("/hong-kong/bars", "香港酒吧", reviewer);

        // 1. A row that is not published is not a pass, however many listings back it.
        assertGate("draft", null, reviewer, false, "not_published");
        // 2. Published, AI-written, nobody reviewed it.
        assertGate("published", null, null, false, "unreviewed_ai");
        // 3. Published and reviewed: indexable on the merits of the six real merchants.
        assertGate("published", null, reviewer, true, "enough_listings");
        // 4. The row's own quality_score says the copy is thin.
        assertGate("published", new BigDecimal("0.420"), reviewer, false, "below_quality_bar");
        // 5. Both the score and the review are missing: §8's order answers with the score.
        assertGate("published", new BigDecimal("0.420"), null, false, "below_quality_bar");
        // 6. A null score is not a failure — the gate is `score IS NULL OR score >= 0.6`.
        assertGate("published", null, reviewer, true, "enough_listings");
        // 7. Below the listing bar again, everything else in order: the count decides on its own.
        jdbc.update("update merchants set status = 'suspended' where tenant_id = :t and slug in (:a, :b)",
                new MapSqlParameterSource("t", tenant.id())
                        .addValue("a", "bar-3-" + tag).addValue("b", "bar-4-" + tag));
        assertGate("published", null, reviewer, false, "too_few_listings");
        // The draft page is served from the slugs, not from copy the SEO agent never published.
        assertGate("draft", null, reviewer, false, "not_published");
        JsonNode page = Json.tree(body("/api/v1/seo/page?city=hong-kong&category=bars"));
        assertThat(page.path("heading").asText()).isEqualTo("bars in hong-kong");
        assertThat(page.path("intro").asText()).isEmpty();
    }

    @Test
    @DisplayName("updated_at is a real column: the newest merchant row, then the published projection row")
    void updatedAtAndHeadingComeFromColumns() {
        String tag = tag();
        // `merchants.updated_at` is trigger-maintained on UPDATE, so the timestamps below are written on
        // insert — which also proves the page reads the column instead of calling now() itself.
        directoryMerchant(tenant, "authored-" + tag, "cafes", List.of(), "published", new BigDecimal("40.00"),
                Instant.parse("2026-01-05T02:03:04Z"));

        // No projection row yet: the page still ships, and its timestamp is the merchant's own column.
        JsonNode unauthored = Json.tree(body("/api/v1/seo/page?city=hong-kong&category=cafes"));
        assertThat(unauthored.path("updated_at").asText()).startsWith("2026-01-05T02:03:04");
        assertThat(unauthored.path("heading").asText()).isEqualTo("cafes in hong-kong");
        assertThat(unauthored.path("reason").asText()).isEqualTo("not_published");

        // The stamp moves with the newest row on the page.
        directoryMerchant(tenant, "newer-" + tag, "cafes", List.of(), "published", new BigDecimal("55.00"),
                Instant.parse("2026-01-09T10:00:00Z"));
        assertThat(Json.tree(body("/api/v1/seo/page?city=hong-kong&category=cafes")).path("updated_at").asText())
                .startsWith("2026-01-09T10:00:00");

        // Now the SEO agent has published a reviewed page for this path: its columns win.
        UUID reviewer = newUser(tenant, "cafe-reviewer-" + tag + "@example.test", "platform_ops");
        seedProjectionPage("/hong-kong/cafes", "香港咖啡室", reviewer);
        jdbc.update("update seo_pages set status = 'published' where tenant_id = :t and path = '/hong-kong/cafes'",
                new MapSqlParameterSource("t", tenant.id()));
        Timestamp projected = (Timestamp) row("""
                select updated_at from seo_pages where tenant_id = :t and path = '/hong-kong/cafes'
                """, Map.of("t", tenant.id())).get("updated_at");

        JsonNode page = Json.tree(body("/api/v1/seo/page?city=hong-kong&category=cafes"));
        assertThat(page.path("heading").asText()).isEqualTo("香港咖啡室");
        assertThat(page.path("intro").asText()).isEqualTo("A real description");
        // Literally the projection row's timestamp — not the merchant's, not a call to now().
        assertThat(page.path("updated_at").asText()).isEqualTo(projected.toInstant().toString());
        assertThat(page.path("updated_at").asText()).doesNotStartWith("2026-01-09");
        assertThat(page.path("indexable").asBoolean()).isFalse();
        assertThat(page.path("reason").asText()).isEqualTo("too_few_listings");
        // The listing count is live, not the snapshot the projection was written with.
        assertThat(page.path("listings")).hasSize(2);
    }

    // ---------------------------------------------------------------- 404 outside the grammar

    @Test
    @DisplayName("Anything outside the §29 grammar is a 404 in the standard envelope, never an empty 200")
    void outsideGrammarIsNotFound() {
        directoryMerchant(tenant, "grammar-" + tag(), "restaurants", List.of(), "published", null);

        // Unknown category / unknown subcategory / unknown city.
        assertNotFound("/api/v1/seo/page?city=hong-kong&category=nonsense");
        assertNotFound("/api/v1/seo/page?city=hong-kong&category=restaurants&subcategory=nope");
        assertNotFound("/api/v1/seo/page?city=tokyo&category=restaurants");
        // A segment the grammar cannot carry is not a probe of what we do have.
        assertNotFound("/api/v1/seo/page?city=hong-kong&category=%3Cscript%3E");
        assertNotFound("/api/v1/seo/routes?city=%2A%2A");
        // A missing required segment is a 422, not a silently empty page.
        assertThat(get(tenant, null, "/api/v1/seo/page?category=restaurants").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(get(tenant, null, "/api/v1/seo/page?category=restaurants").getBody())
                .path("error").path("code").asText()).isEqualTo("validation_error");
        // A route with one merchant behind it is a page, not a 404.
        assertThat(get(tenant, null, "/api/v1/seo/page?city=hong-kong&category=restaurants").getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    // ---------------------------------------------------------------- §66 / open state / subcategory

    @Test
    @DisplayName("Listing order is organic: subscription plan cannot move a merchant up the page")
    void paidPlanDoesNotReorder() {
        String tag = tag();
        UUID loved = directoryMerchant(tenant, "loved-" + tag, "parks", List.of(), "published", null);
        UUID paying = directoryMerchant(tenant, "paying-" + tag, "parks", List.of(), "published", null);
        jdbc.update("update merchants set rating_agg = 4.8, review_count = 20 where id = :id",
                new MapSqlParameterSource("id", loved));
        // The paid tier is the loudest possible placement signal; it must change nothing here (§66).
        jdbc.update("update merchants set plan = 'enterprise' where id = :id",
                new MapSqlParameterSource("id", paying));

        JsonNode cards = Json.tree(body("/api/v1/seo/page?city=hong-kong&category=parks")).path("cards");
        assertThat(cards).hasSize(2);
        assertThat(cards.get(0).path("id").asText()).isEqualTo(loved.toString());
        assertThat(cards.get(0).path("flags").path("sponsored").asBoolean()).isFalse();
        assertThat(cards.get(1).path("id").asText()).isEqualTo(paying.toString());
    }

    @Test
    @DisplayName("open_now_count is computed from business_hours for the tenant's local instant")
    void openNowIsComputedNotGuessed() {
        String tag = tag();
        UUID open24 = directoryMerchant(tenant, "all-day-" + tag, "diners", List.of(), "published", null);
        directoryMerchant(tenant, "closed-shop-" + tag, "diners", List.of(), "published", null);
        int weekday = java.time.ZonedDateTime.ofInstant(Instant.now(), ZoneId.of("Asia/Hong_Kong"))
                .getDayOfWeek().getValue() - 1;
        jdbc.update("""
                insert into business_hours (merchant_id, weekday, opens_at, closes_at, crosses_midnight)
                values (:m, :weekday, time '00:00', time '23:59', false)
                """, new MapSqlParameterSource("m", open24).addValue("weekday", (short) weekday));

        JsonNode page = Json.tree(body("/api/v1/seo/page?city=hong-kong&category=diners"));
        assertThat(page.path("facets").path("open_now_count").asInt()).isEqualTo(1);
        assertThat(cardById(page.path("cards"), open24).path("open").path("is_open").asBoolean()).isTrue();
        assertThat(cardById(page.path("cards"), open24).path("open").path("as_of").asText()).isNotBlank();
        assertThat(cardById(page.path("cards"), open24).path("open").path("source_fact_id").isNull()).isTrue();
    }

    @Test
    @DisplayName("A subcategory route is a real tag filter, and the listing echoes its own tag")
    void subcategoryRouteFiltersByTag() {
        String tag = tag();
        UUID quietOne = directoryMerchant(tenant, "quiet-room-" + tag, "restaurants",
                List.of("quiet", "date-night"), "published", new BigDecimal("300.00"));
        directoryMerchant(tenant, "loud-room-" + tag, "restaurants", List.of("lively"), "published",
                new BigDecimal("300.00"));

        ResponseEntity<String> res = get(tenant, null,
                "/api/v1/seo/page?city=hong-kong&category=restaurants&subcategory=quiet");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(res.getBody());
        assertThat(page.path("subcategory").asText()).isEqualTo("quiet");
        assertThat(page.path("listings")).hasSize(1);
        assertThat(page.path("cards").get(0).path("id").asText()).isEqualTo(quietOne.toString());
        assertThat(page.path("listings").get(0).path("subcategory").asText()).isEqualTo("quiet");
        assertThat(page.path("heading").asText()).isEqualTo("quiet restaurants in hong-kong");
    }

    // ---------------------------------------------------------------- helpers

    private String body(String path) {
        ResponseEntity<String> res = get(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** Reads the gate and asserts the verdict plus the inputs it says it used. */
    private void assertGate(String status, BigDecimal qualityScore, UUID reviewer, boolean indexable, String reason) {
        jdbc.update("""
                update seo_pages set status = :status, quality_score = cast(:score as numeric(4,3)),
                       reviewed_by = cast(:reviewer as uuid)
                where tenant_id = :t and path = '/hong-kong/bars'
                """, new MapSqlParameterSource("t", tenant.id()).addValue("status", status)
                .addValue("score", qualityScore)
                .addValue("reviewer", reviewer));

        ResponseEntity<String> res = get(tenant, null, "/api/v1/seo/page?city=hong-kong&category=bars");
        assertThat(res.getStatusCode()).as("a served page below the bar is a 200, not a 404")
                .isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(res.getBody());
        assertThat(page.path("indexable").asBoolean()).as("indexable for " + status + "/" + qualityScore
                + "/" + reviewer).isEqualTo(indexable);
        assertThat(page.path("reason").asText()).isEqualTo(reason);
        assertThat(page.path("quality_bar").path("projection_status").asText()).isEqualTo(status);
        assertThat(page.path("quality_bar").path("generated_by").asText()).isEqualTo("ai_seo_agent");
        assertThat(page.path("quality_bar").path("reviewed_by").isNull()).isEqualTo(reviewer == null);
    }

    private void assertNotFound(String path) {
        ResponseEntity<String> res = get(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).isEqualTo("seo_route_not_found");
    }

    private static JsonNode cardById(JsonNode cards, UUID id) {
        for (JsonNode card : cards) {
            if (id.toString().equals(card.path("id").asText())) {
                return card;
            }
        }
        throw new AssertionError("no card for " + id);
    }

    private static int route(JsonNode routes, String category, String subcategory) {
        for (JsonNode node : routes) {
            boolean sameSub = subcategory == null ? node.path("subcategory").isNull()
                    : subcategory.equals(node.path("subcategory").asText());
            if (category.equals(node.path("category").asText()) && sameSub) {
                return node.path("listings").asInt();
            }
        }
        return -1;
    }

    private static boolean hasRoute(JsonNode routes, String category, String subcategory) {
        return route(routes, category, subcategory) >= 0;
    }

    /** A published merchant in `Hong Kong` / `Sha Tin` — the slug derivation the routes endpoint uses. */
    private UUID directoryMerchant(Tenant owner, String slug, String category, List<String> tags, String status,
                                   BigDecimal avgPrice) {
        return directoryMerchant(owner, slug, category, tags, status, avgPrice, null);
    }

    /**
     * Same, with the merchant's {@code updated_at} fixed: {@code set_updated_at} rewrites the column on
     * every UPDATE, so a stored timestamp can only be written at insert — which is exactly what makes it
     * a useful thing to assert the page echoes.
     */
    private UUID directoryMerchant(Tenant owner, String slug, String category, List<String> tags, String status,
                                   BigDecimal avgPrice, Instant updatedAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, category_primary, status,
                                       data_origin, avg_price_hkd, tags, updated_at)
                values (:id, :t, :slug, :legal, :display, :category, :status, 'demo', :price,
                        cast(:tags as text[]), coalesce(cast(:when as timestamptz), now()))
                """, new MapSqlParameterSource("id", id).addValue("t", owner.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug)
                .addValue("category", category).addValue("status", status)
                .addValue("price", avgPrice)
                .addValue("tags", tags.toArray(new String[0]))
                .addValue("when", updatedAt == null ? null : Timestamp.from(updatedAt)));
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng, is_primary)
                values (:id, :m, :t, '1 Directory Road', 'Hong Kong', 'Sha Tin', 22.385, 114.188, true)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", id).addValue("t", owner.id()));
        return id;
    }

    /**
     * A real {@code seo_pages} row for one path: authored copy, an AI author, and the reviewer column
     * the §30 gate reads. Inserted as a draft so each test moves the specific column it is about.
     */
    private void seedProjectionPage(String path, String h1, UUID reviewer) {
        jdbc.update("""
                insert into seo_pages (tenant_id, path, kind, title, h1, description, status, lang,
                                       generated_by, reviewed_by, quality_score, updated_at)
                values (:t, :path, 'category', :title, :h1, 'A real description', 'draft', 'zh-HK',
                        'ai_seo_agent', cast(:reviewer as uuid), null,
                        cast(:when as timestamptz))
                """, new MapSqlParameterSource("t", tenant.id()).addValue("path", path)
                .addValue("title", "Seo title of " + path)
                .addValue("h1", h1)
                .addValue("reviewer", reviewer)
                .addValue("when", Timestamp.from(Instant.parse("2026-03-03T00:00:00Z"))));
    }
}
