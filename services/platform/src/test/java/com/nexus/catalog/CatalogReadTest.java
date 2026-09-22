package com.nexus.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * API_CONTRACT §4 read over live rows: the directory list, one profile, its menu, its published
 * reviews and its reservation window.
 *
 * <p>Each test pins one thing a consumer page will be judged on and checks the platform actually
 * computes it rather than accepting it: a filter that silently does nothing, a rating averaged over
 * reviews nobody published, an {@code open} verdict without the instant it was taken, a null aggregate
 * sorting to the top of "best rated", a cacheable availability page. All of those pass a unit test and
 * mislead a person, so the assertions are on HTTP responses and the numbers inside them.
 */
class CatalogReadTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;

    @BeforeEach
    void seedTenants() {
        tenant = newTenant("catalog");
        other = newTenant("catalog-other");
    }

    /** Distinct per run: slugs are unique inside a tenant and the tests share one database. */
    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- the list

    @Test
    @DisplayName("The directory lists published merchants by district, paged and counted from the same WHERE")
    void listIsFilteredPagedAndCounted() {
        String tag = tag();
        directoryMerchant(tenant, "sha-tin-one-" + tag, "Tai Po", null);
        directoryMerchant(tenant, "sha-tin-two-" + tag, "Tai Po", null);
        directoryMerchant(tenant, "elsewhere-" + tag, "Wan Chai", null);

        JsonNode page = Json.tree(body("/api/v1/merchants?district=Tai%20Po"));
        assertThat(page.path("filters").path("district").asText()).isEqualTo("Tai Po");
        assertThat(page.path("items")).hasSize(2);
        assertThat(page.path("total_estimate").asInt()).isEqualTo(2);
        assertThat(page.path("filters").path("district").asText()).isEqualTo("Tai Po");
        // The district the page filtered on is the district the card prints.
        assertThat(page.path("items").get(0).path("district").asText()).isEqualTo("Tai Po");
        assertThat(page.path("items").get(0).path("subtitle").asText()).isEqualTo("Tai Po");

        // total_estimate is the whole result, items is the slice that was asked for.
        JsonNode first = Json.tree(body("/api/v1/merchants?district=Tai%20Po&limit=1"));
        assertThat(first.path("items")).hasSize(1);
        assertThat(first.path("total_estimate").asInt()).isEqualTo(2);
        JsonNode second = Json.tree(body("/api/v1/merchants?district=Tai%20Po&limit=1&cursor="
                + first.path("next_cursor").asText()));
        assertThat(second.path("items").get(0).path("id").asText())
                .isNotEqualTo(first.path("items").get(0).path("id").asText());
    }

    @Test
    @DisplayName("A consumer read is public, cacheable, tenant-varying and badged as synthetic")
    void listIsPublicCacheableAndDemoBadged() {
        directoryMerchant(tenant, "cacheable-" + tag(), "Sha Tin", null);
        ResponseEntity<String> res = getRaw(tenant, null, "/api/v1/merchants");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getHeaders().getCacheControl()).contains("public").contains("s-maxage")
                .contains("stale-while-revalidate");
        assertThat(res.getHeaders().getFirst(HttpHeaders.VARY)).contains("X-Tenant");
        // D6/§109: every row here was seeded, and the response says so without being asked.
        assertThat(res.getHeaders().getFirst("X-Demo-Data")).isEqualTo("true");
        assertThat(Json.tree(res.getBody()).path("items").get(0).path("flags").path("demo").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("The category filter answers the printed name, the leaf slug and the parent — never an empty page for a real one")
    void categoryFilterFollowsTheTaxonomy() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "boba-" + tag, "Sha Tin", "Bubble Tea");
        seedCategory(tenant, merchant, "boba-" + tag, "Bubble Tea", "drinks-" + tag, "Drinks");
        directoryMerchant(tenant, "other-" + tag, "Sha Tin", "Hot Pot");

        assertThat(itemIds("/api/v1/merchants?category=Bubble%20Tea")).containsExactly(merchant);
        assertThat(itemIds("/api/v1/merchants?category=boba-" + tag)).containsExactly(merchant);
        // The taxonomy name is matched case-insensitively even though `category_primary` is not.
        assertThat(itemIds("/api/v1/merchants?category=bubble%20tea")).containsExactly(merchant);
        // A parent aisle lists its children's merchants.
        assertThat(itemIds("/api/v1/merchants?category=drinks-" + tag)).containsExactly(merchant);
        // An unknown category answers honestly: an empty page, not the whole directory.
        assertThat(itemIds("/api/v1/merchants?category=underwater-basket-weaving")).isEmpty();
    }

    @Test
    @DisplayName("max_price and rating narrow the list, and an unknown price is not a cheap one")
    void numericFiltersAreComparisonsNotNullDefaults() {
        String tag = tag();
        UUID cheap = directoryMerchant(tenant, "cheap-" + tag, "Sha Tin", null, new BigDecimal("60.00"), null);
        directoryMerchant(tenant, "pricey-" + tag, "Sha Tin", null, new BigDecimal("900.00"), null);
        // No avg_price_hkd at all: "we do not know" must not satisfy "HK$200 or less".
        directoryMerchant(tenant, "unknown-" + tag, "Sha Tin", null, null, null);

        assertThat(itemIds("/api/v1/merchants?max_price=200")).containsExactly(cheap);
        // The boundary itself belongs to the result set: `<=`, not `<`.
        assertThat(itemIds("/api/v1/merchants?max_price=60")).containsExactly(cheap);

        jdbc.update("update merchants set rating_agg = 4.60, review_count = 30 where id = :id",
                new MapSqlParameterSource("id", cheap));
        assertThat(itemIds("/api/v1/merchants?rating=4.5")).containsExactly(cheap);
        assertThat(itemIds("/api/v1/merchants?rating=4.7")).isEmpty();
    }

    @Test
    @DisplayName("open_now is computed from business_hours on the tenant's clock, and the verdict says when")
    void openNowFollowsTheOpeningHours() {
        String tag = tag();
        UUID allDay = directoryMerchant(tenant, "all-day-" + tag, "Sha Tin", null);
        UUID noHours = directoryMerchant(tenant, "no-hours-" + tag, "Sha Tin", null);
        int weekday = java.time.ZonedDateTime.ofInstant(Instant.now(), ZoneId.of("Asia/Hong_Kong"))
                .getDayOfWeek().getValue() - 1;
        jdbc.update("""
                insert into business_hours (merchant_id, weekday, opens_at, closes_at, crosses_midnight)
                values (:m, :weekday, time '00:00', time '23:59', false)
                """, new MapSqlParameterSource("m", allDay).addValue("weekday", (short) weekday));

        JsonNode filtered = Json.tree(body("/api/v1/merchants?open_now=true"));
        assertThat(filtered.path("filters").path("open_now").asBoolean()).isTrue();
        assertThat(itemIds("/api/v1/merchants?open_now=true")).containsExactly(allDay);

        // Unfiltered, both are listed and the one with no hours says it is closed — it is not assumed open.
        JsonNode all = Json.tree(body("/api/v1/merchants"));
        assertThat(all.path("items")).hasSize(2);
        assertThat(cardById(all.path("items"), noHours).path("open").path("is_open").asBoolean()).isFalse();
        assertThat(cardById(all.path("items"), allDay).path("open").path("is_open").asBoolean()).isTrue();
        // The instant travels with every verdict, so a cached page cannot claim "open now" forever.
        assertThat(all.path("as_of").asText()).isNotBlank();
        assertThat(cardById(all.path("items"), allDay).path("open").path("as_of").asText())
                .isEqualTo(all.path("as_of").asText());
        assertThat(cardById(all.path("items"), allDay).path("open").path("source_fact_id").isNull()).isTrue();
    }

    @Test
    @DisplayName("Sort is a whitelist: nulls sink, an unknown token is a 422, and a paid plan moves nothing")
    void sortIsWhitelistedOrganicAndNullSafe() {
        String tag = tag();
        UUID loved = directoryMerchant(tenant, "loved-" + tag, "Sha Tin", null);
        UUID paying = directoryMerchant(tenant, "paying-" + tag, "Sha Tin", null);
        jdbc.update("update merchants set rating_agg = 4.90, review_count = 40 where id = :id",
                new MapSqlParameterSource("id", loved));
        // The loudest possible placement signal, and it changes nothing here (§66).
        jdbc.update("update merchants set plan = 'enterprise' where id = :id",
                new MapSqlParameterSource("id", paying));

        // A bare token is ascending and `-` descending, the same convention `Paging.orderBy` uses
        // everywhere else; `rating_agg` defaults to 0, so the merchant nobody rated is the "low" one.
        assertThat(itemIds("/api/v1/merchants?sort=rating")).containsExactly(paying, loved);
        assertThat(itemIds("/api/v1/merchants?sort=-rating")).containsExactly(loved, paying);
        // Neither has a published price, so an ascending price sort falls through to the slug tiebreak.
        assertThat(itemIds("/api/v1/merchants?sort=price")).containsExactly(loved, paying);
        assertThat(cardById(Json.tree(body("/api/v1/merchants?sort=rating")).path("items"), paying)
                .path("flags").path("sponsored").asBoolean()).isFalse();

        ResponseEntity<String> bad = getRaw(tenant, null, "/api/v1/merchants?sort=random_boost_please");
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(bad.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("validation_error");
        assertThat(error.path("details").path("allowed").toString()).contains("price").contains("rating");
    }

    @Test
    @DisplayName("A malformed filter is a 422 that names the field; the same page works when it is valid")
    void malformedFiltersAreRejected() {
        directoryMerchant(tenant, "validated-" + tag(), "Sha Tin", null, new BigDecimal("88.00"), null);

        assertValidation("/api/v1/merchants?max_price=cheap", "max_price");
        assertValidation("/api/v1/merchants?max_price=-5", "max_price");
        assertValidation("/api/v1/merchants?rating=-1", "rating");
        assertValidation("/api/v1/merchants?rating=6", "rating");
        assertValidation("/api/v1/merchants?limit=0", "limit");
        assertThat(getRaw(tenant, null, "/api/v1/merchants?cursor=not-a-cursor").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(getRaw(tenant, null, "/api/v1/merchants?district=" + "x".repeat(61)).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        // The valid case still works, so those 422s came from the parser and not from the endpoint.
        assertThat(Json.tree(body("/api/v1/merchants?max_price=100")).path("items")).hasSize(1);
    }

    // ---------------------------------------------------------------- one merchant

    @Test
    @DisplayName("The profile is reachable by slug or by id, and carries locations, hours, offerings and honest review fields")
    void profileAssemblesTheConsumerPage() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "full-house-" + tag, "Sha Tin", "Hot Pot",
                new BigDecimal("220.00"), null);
        // A second, non-primary outlet: the location list is ordered, and the card shows the primary.
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng,
                                       is_primary, label)
                values (:id, :m, :t, '2 Outlet Street', 'Hong Kong', 'Wan Chai', 22.278, 114.173, false, 'Outlet')
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", merchant)
                .addValue("t", tenant.id()));
        int weekday = java.time.ZonedDateTime.ofInstant(Instant.now(), ZoneId.of("Asia/Hong_Kong"))
                .getDayOfWeek().getValue() - 1;
        jdbc.update("""
                insert into business_hours (merchant_id, weekday, opens_at, closes_at, crosses_midnight)
                values (:m, :weekday, time '11:30', time '22:00', false)
                """, new MapSqlParameterSource("m", merchant).addValue("weekday", (short) weekday));
        seedOffering(tenant, merchant, "hot-pot-set-" + tag, "product", new BigDecimal("220.00"), 9, "active");
        seedOffering(tenant, merchant, "gone-tea-" + tag, "product", new BigDecimal("20.00"), 99, "archived");

        JsonNode bySlug = Json.tree(body("/api/v1/merchants/full-house-" + tag));
        assertThat(bySlug.path("id").asText()).isEqualTo(merchant.toString());
        assertThat(Json.tree(body("/api/v1/merchants/" + merchant)).path("id").asText())
                .isEqualTo(merchant.toString());

        assertThat(bySlug.path("card_type").asText()).isEqualTo("merchant");
        assertThat(bySlug.path("slug").asText()).isEqualTo("full-house-" + tag);
        assertThat(bySlug.path("title").asText()).isEqualTo("Demo full-house-" + tag);
        assertThat(bySlug.path("district").asText()).isEqualTo("Sha Tin");
        assertThat(bySlug.path("category").asText()).isEqualTo("Hot Pot");
        assertThat(bySlug.path("price").path("amount").asText()).isEqualTo("220.00");
        assertThat(bySlug.path("price").path("currency").asText()).isEqualTo("HKD");
        assertThat(bySlug.path("locations")).hasSize(2);
        assertThat(bySlug.path("locations").get(0).path("district").asText()).isEqualTo("Sha Tin");
        assertThat(bySlug.path("locations").get(0).path("is_primary").asBoolean()).isTrue();
        assertThat(bySlug.path("locations").get(0).path("geo").path("lat").asText()).isNotBlank();
        assertThat(bySlug.path("business_hours")).hasSize(1);
        assertThat(bySlug.path("business_hours").get(0).path("opens_at").asText()).isEqualTo("11:30");
        assertThat(bySlug.path("business_hours").get(0).path("weekday").asInt()).isEqualTo(weekday);
        assertThat(bySlug.path("business_hours").get(0).path("source").asText()).isEqualTo("merchant");
        // Top offerings are the active ones only, and the count agrees with the menu endpoint.
        assertThat(bySlug.path("top_offerings")).hasSize(1);
        assertThat(bySlug.path("top_offerings").get(0).path("name").asText()).isEqualTo("hot-pot-set-" + tag);
        assertThat(bySlug.path("menu_count").asInt()).isEqualTo(1);
        // A merchant nobody has reviewed has no rating, not a zero rating.
        assertThat(bySlug.path("rating").isNull()).isTrue();
        assertThat(bySlug.path("review_stats").path("published_reviews").asInt()).isEqualTo(0);
        assertThat(bySlug.path("review_stats").path("average_rating").isNull()).isTrue();
        assertThat(bySlug.path("review_stats").path("distribution")).isEmpty();
        // §55: the AI summary exists only if the review agent wrote one.
        assertThat(bySlug.path("review_summary").isNull()).isTrue();
        assertThat(bySlug.path("flags").path("demo").asBoolean()).isTrue();
        assertThat(bySlug.path("flags").path("unverified").asBoolean()).isTrue();
        // The subscription tier is workspace data and says nothing about the listing (§66), so it is not echoed.
        assertThat(bySlug.has("plan")).isFalse();
    }

    @Test
    @DisplayName("A rendered number carries the fact behind it, on the profile and on the list card alike")
    void priceAndRatingCarryTheirFacts() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "factful-" + tag, "Sha Tin", null, new BigDecimal("150.00"), null);
        seedFact(merchant, "price", "\"150.00\"", "merchant", "0.900");
        seedFact(merchant, "rating", "4.4", "imported", "0.700");

        JsonNode profile = Json.tree(body("/api/v1/merchants/factful-" + tag));
        assertThat(profile.path("facts")).hasSize(2);
        JsonNode price = factByName(profile.path("facts"), "price");
        assertThat(price.path("source").asText()).isEqualTo("merchant");
        assertThat(price.path("confidence").asDouble()).isEqualTo(0.9);
        assertThat(price.path("observed_at").asText()).isNotBlank();
        assertThat(price.path("subject_id").asText()).isEqualTo(merchant.toString());
        assertThat(factByName(profile.path("facts"), "rating").path("source").asText()).isEqualTo("imported");
        // One projection, one truth: the list card carries the same fact row, not a fresh number.
        assertThat(factByName(Json.tree(body("/api/v1/merchants?district=Sha%20Tin"))
                .path("items").get(0).path("facts"), "price").path("fact_id").asText())
                .isEqualTo(price.path("fact_id").asText());
    }

    @Test
    @DisplayName("Draft, other-tenant and unknown references all read as absent, on every §4 route")
    void unpublishedAndCrossTenantAreNotFound() {
        String tag = tag();
        directoryMerchant(tenant, "draft-" + tag, "Sha Tin", null, "draft");
        UUID foreign = directoryMerchant(other, "foreign-" + tag, "Sha Tin", null);

        assertNotFound("/api/v1/merchants/draft-" + tag, "merchant_not_found");
        assertNotFound("/api/v1/merchants/" + foreign, "merchant_not_found");
        assertNotFound("/api/v1/merchants/no-such-place", "merchant_not_found");
        // A uuid-shaped reference that is not ours must not enumerate anything either.
        assertNotFound("/api/v1/merchants/" + UUID.randomUUID(), "merchant_not_found");
        assertNotFound("/api/v1/merchants/draft-" + tag + "/menu", "merchant_not_found");
        assertNotFound("/api/v1/merchants/draft-" + tag + "/reviews", "merchant_not_found");
        assertNotFound("/api/v1/merchants/draft-" + tag + "/reviews/summary", "merchant_not_found");
        assertNotFound("/api/v1/merchants/draft-" + tag + "/availability", "merchant_not_found");
        // The list never shows them at all, whatever the filter.
        assertThat(itemIds("/api/v1/merchants")).isEmpty();
        assertThat(itemIds("/api/v1/merchants?open_now=false")).isEmpty();
    }

    // ---------------------------------------------------------------- menu

    @Test
    @DisplayName("The menu pages the active offerings, orders them organically and narrows by kind")
    void menuIsPagedKindScopedAndOrganic() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "diner-" + tag, "Sha Tin", null);
        seedOffering(tenant, merchant, "noodles-" + tag, "product", new BigDecimal("48.00"), 1, "active");
        seedOffering(tenant, merchant, "massage-" + tag, "service", new BigDecimal("600.00"), 5, "active");
        seedOffering(tenant, merchant, "workshop-" + tag, "experience", new BigDecimal("300.00"), 9, "active");
        seedOffering(tenant, merchant, "gone-" + tag, "product", new BigDecimal("10.00"), 99, "archived");
        JsonNode page = Json.tree(body("/api/v1/merchants/diner-" + tag + "/menu"));
        assertThat(page.path("items")).hasSize(3);
        assertThat(page.path("total_estimate").asInt()).isEqualTo(3);
        assertThat(page.path("status_scope").asText()).contains("active");
        // popularity_score drives the default order: 9, then 5, then 1.
        assertThat(names(page.path("items"))).containsExactly("workshop-" + tag, "massage-" + tag, "noodles-" + tag);
        // A price is an object with a currency, never a bare float (§1).
        assertThat(page.path("items").get(0).path("price").path("currency").asText()).isEqualTo("HKD");
        assertThat(page.path("items").get(0).path("merchant_id").asText()).isEqualTo(merchant.toString());

        JsonNode services = Json.tree(body("/api/v1/merchants/diner-" + tag + "/menu?kind=service"));
        assertThat(names(services.path("items"))).containsExactly("massage-" + tag);
        assertThat(services.path("total_estimate").asInt()).isEqualTo(1);
        assertThat(names(Json.tree(body("/api/v1/merchants/diner-" + tag + "/menu?sort=price")).path("items")))
                .containsExactly("noodles-" + tag, "workshop-" + tag, "massage-" + tag);
        assertThat(Json.tree(body("/api/v1/merchants/diner-" + tag + "/menu?limit=2")).path("next_cursor").isNull())
                .isFalse();
        assertValidation("/api/v1/merchants/diner-" + tag + "/menu?kind=subscriptions", "kind");
    }

    @Test
    @DisplayName("An offering carries its own price fact, and an unrated one reports no rating at all")
    void offeringsBringTheirFacts() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "priced-" + tag, "Sha Tin", null);
        UUID noodles = seedOffering(tenant, merchant, "noodles-" + tag, "product", new BigDecimal("48.00"), 1,
                "active");
        seedOffering(tenant, merchant, "sandwich-" + tag, "product", new BigDecimal("38.00"), 2, "active");
        jdbc.update("update offerings set rating_agg = 4.7, review_count = 11 where id = :id",
                new MapSqlParameterSource("id", noodles));
        seedOfferingFact(merchant, noodles, "price",
                "{\"amount\": \"48.00\", \"currency\": \"HKD\", \"model\": \"fixed\"}", "merchant", "0.980");
        seedOfferingFact(merchant, noodles, "capacity", "{\"max_party_size\": 8, \"duration_minutes\": 90}",
                "imported", "0.700");

        JsonNode items = Json.tree(body("/api/v1/merchants/priced-" + tag + "/menu")).path("items");
        assertThat(items).hasSize(2);
        JsonNode priced = items.get(0);
        assertThat(priced.path("name").asText()).isEqualTo("sandwich-" + tag);
        // No fact row, so no facts array — and no invented fact_id to stand in for one.
        assertThat(priced.path("facts")).isEmpty();
        assertThat(priced.path("rating").isNull()).isTrue();

        JsonNode rated = items.get(1);
        assertThat(rated.path("rating").path("value").asDouble()).isEqualTo(4.7);
        assertThat(rated.path("rating").path("count").asInt()).isEqualTo(11);
        assertThat(rated.path("facts")).hasSize(2);
        JsonNode fact = factByName(rated.path("facts"), "price");
        assertThat(fact.path("subject_type").asText()).isEqualTo("offering");
        assertThat(fact.path("subject_id").asText()).isEqualTo(noodles.toString());
        assertThat(fact.path("source").asText()).isEqualTo("merchant");
        assertThat(fact.path("confidence").asDouble()).isEqualTo(0.98);
        assertThat(fact.path("value").path("amount").asText()).isEqualTo("48.00");
        assertThat(fact.path("value").path("currency").asText()).isEqualTo("HKD");
        // The `capacity` fact is the one behind the party-size and duration columns a reservation form shows.
        assertThat(factByName(rated.path("facts"), "capacity").path("value").path("max_party_size").asInt())
                .isEqualTo(8);
        // The profile's top offerings use the same projection, so the two pages cannot disagree (§19).
        // Same default order (popularity desc), so index 1 is the noodles on both responses.
        JsonNode profileOffering = Json.tree(body("/api/v1/merchants/priced-" + tag))
                .path("top_offerings").get(1);
        assertThat(profileOffering.path("offering_id").asText()).isEqualTo(rated.path("offering_id").asText());
        assertThat(factByName(profileOffering.path("facts"), "price").path("fact_id").asText())
                .isEqualTo(fact.path("fact_id").asText());
    }

    // ---------------------------------------------------------------- reviews

    @Test
    @DisplayName("Only published reviews are readable, and the aggregate counts exactly those rows")
    void reviewsArePublishedOnlyAndAggregated() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "reviewed-" + tag, "Sha Tin", null);
        seedReview(merchant, "5.0", "published", 12, true, "demo");
        seedReview(merchant, "4.0", "published", 3, false, "user");
        seedReview(merchant, "1.0", "pending", 99, false, "user");
        seedReview(merchant, "1.0", "flagged", 99, false, "user");

        JsonNode page = Json.tree(body("/api/v1/merchants/reviewed-" + tag + "/reviews"));
        assertThat(page.path("items")).hasSize(2);
        assertThat(page.path("total_estimate").asInt()).isEqualTo(2);
        assertThat(page.path("status_scope").asText()).contains("published");
        // The default order is newest first, and the 4-star row was written most recently.
        assertThat(ratings(page.path("items"))).containsExactly("4.0", "5.0");
        assertThat(page.path("items").get(0).path("body").asText()).isEqualTo("A real review body.");
        assertThat(page.path("items").get(0).path("flags").path("demo").asBoolean()).isFalse();
        assertThat(page.path("items").get(1).path("flags").path("demo").asBoolean()).isTrue();
        assertThat(page.path("items").get(1).path("flags").path("verified_visit").asBoolean()).isTrue();

        // The aggregate is recomputed over the rows it can show, not the denormalised column.
        JsonNode aggregate = page.path("aggregate");
        assertThat(aggregate.path("published_reviews").asInt()).isEqualTo(2);
        assertThat(aggregate.path("average_rating").asDouble()).isEqualTo(4.5);
        assertThat(aggregate.path("positive_reviews").asInt()).isEqualTo(2);
        assertThat(aggregate.path("negative_reviews").asInt()).isEqualTo(0);
        assertThat(aggregate.path("verified_purchase_reviews").asInt()).isEqualTo(1);
        assertThat(aggregate.path("latest_review_at").asText()).isNotBlank();
        assertThat(aggregate.path("source").asText()).contains("published");
        assertThat(aggregate.path("distribution")).hasSize(2);
        assertThat(aggregate.path("distribution").get(0).path("bucket").asInt()).isEqualTo(5);
        assertThat(aggregate.path("distribution").get(0).path("share").asDouble()).isEqualTo(0.5);
        assertThat(aggregate.path("computed_at").asText()).isNotBlank();

        // Same convention as every other sort token: bare is ascending, `-` is descending.
        assertThat(Json.tree(body("/api/v1/merchants/reviewed-" + tag + "/reviews?sort=helpful"))
                .path("items").get(0).path("helpful_count").asInt()).isEqualTo(3);
        assertThat(Json.tree(body("/api/v1/merchants/reviewed-" + tag + "/reviews?sort=-helpful"))
                .path("items").get(0).path("helpful_count").asInt()).isEqualTo(12);
        ResponseEntity<String> bogus = getRaw(tenant, null,
                "/api/v1/merchants/reviewed-" + tag + "/reviews?sort=bogus");
        assertThat(bogus.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(bogus.getBody()).path("error").path("code").asText()).isEqualTo("validation_error");
    }

    @Test
    @DisplayName("The AI summary is a 404 until the review agent writes one, then it carries its evidence")
    void reviewSummaryAppearsOnlyWhenGenerated() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "summarised-" + tag, "Sha Tin", null);
        UUID reviewOne = seedReview(merchant, "5.0", "published", 4, true, "user");
        UUID reviewTwo = seedReview(merchant, "4.0", "published", 1, false, "user");

        assertNotFound("/api/v1/merchants/summarised-" + tag + "/reviews/summary", "review_summary_not_found");

        jdbc.update("""
                insert into review_summaries (merchant_id, overall, praise, complaints, sample_size, model)
                values (:m, 4.50, cast(:praise as jsonb), cast(:complaints as jsonb), 2, 'mock')
                """, new MapSqlParameterSource("m", merchant)
                .addValue("praise", "[{\"label\":\"份量足\",\"evidence_count\":2,\"review_ids\":[\"" + reviewOne
                        + "\",\"" + reviewTwo + "\"]}]")
                .addValue("complaints", "[{\"label\":\"輪候長\",\"evidence_count\":1,\"review_ids\":[\"" + reviewTwo
                        + "\"]}]"));

        JsonNode summary = Json.tree(body("/api/v1/merchants/summarised-" + tag + "/reviews/summary"));
        assertThat(summary.path("overall").asDouble()).isEqualTo(4.5);
        assertThat(summary.path("sample_size").asInt()).isEqualTo(2);
        assertThat(summary.path("model").asText()).isEqualTo("mock");
        assertThat(summary.path("praise")).hasSize(1);
        assertThat(summary.path("complaints")).hasSize(1);
        // §55: the bullets' review ids are lifted into one evidence list the client can link back to.
        assertThat(stringList(summary.path("evidence_review_ids")))
                .containsExactlyInAnyOrder(reviewOne.toString(), reviewTwo.toString());
        assertThat(summary.path("generated_at").asText()).isNotBlank();
        assertThat(summary.path("flags").path("demo").asBoolean()).isTrue();
        // And it now rides on the profile too, so the page does not need a second request to show it.
        assertThat(Json.tree(body("/api/v1/merchants/summarised-" + tag)).path("review_summary")
                .path("sample_size").asInt()).isEqualTo(2);
    }

    // ---------------------------------------------------------------- availability

    @Test
    @DisplayName("Availability is a real-time window over the slot rows: never cached, never a full table")
    void availabilityIsLiveWindowedAndCapacityChecked() {
        String tag = tag();
        UUID merchant = directoryMerchant(tenant, "bookable-" + tag, "Sha Tin", null);
        Instant now = Instant.now();
        seedSlot(merchant, now.plusSeconds(3_600), 8, 6);
        seedSlot(merchant, now.plusSeconds(7_200), 8, 2);
        seedSlot(merchant, now.plusSeconds(10_800), 8, 0);
        // Outside the default seven-day window.
        seedSlot(merchant, now.plus(Duration.ofDays(30)), 8, 8);

        ResponseEntity<String> res = getRaw(tenant, null, "/api/v1/merchants/bookable-" + tag + "/availability");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        // §20: a seat is a claim about a moment someone else may take a second later.
        assertThat(res.getHeaders().getCacheControl()).isEqualTo("no-store");
        JsonNode page = Json.tree(res.getBody());
        assertThat(page.path("slots")).hasSize(2);
        assertThat(page.path("slot_count").asInt()).isEqualTo(2);
        assertThat(page.path("slots").get(0).path("capacity_left").asInt()).isEqualTo(6);
        assertThat(page.path("slots").get(0).path("starts_at").asText()).isNotBlank();
        assertThat(page.path("slots").get(0).path("price").path("currency").asText()).isEqualTo("HKD");
        assertThat(page.path("source").asText()).contains("capacity_left");
        assertThat(page.path("as_of").asText()).isNotBlank();
        assertThat(page.path("window").path("starts_at").asText()).isNotBlank();

        // A party of five does not fit a leftover of four, whatever the pool's total capacity was.
        JsonNode partyOfFive = Json.tree(body("/api/v1/merchants/bookable-" + tag + "/availability?party_size=5"));
        assertThat(partyOfFive.path("slots")).hasSize(1);
        assertThat(partyOfFive.path("party_size").asInt()).isEqualTo(5);

        // An explicit window is honoured, and finds the slot the default one excludes.
        JsonNode wide = Json.tree(body("/api/v1/merchants/bookable-" + tag + "/availability?starts_at="
                + now.minusSeconds(60).toString() + "&ends_at=" + now.plus(Duration.ofDays(45)).toString()));
        assertThat(wide.path("slots")).hasSize(3);

        assertValidation("/api/v1/merchants/bookable-" + tag + "/availability?starts_at=yesterday", "starts_at");
        assertValidation("/api/v1/merchants/bookable-" + tag + "/availability?party_size=0", "party_size");
        assertThat(getRaw(tenant, null, "/api/v1/merchants/bookable-" + tag + "/availability?starts_at="
                + now.plus(Duration.ofDays(2)).toString() + "&ends_at=" + now.toString()).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ---------------------------------------------------------------- helpers

    private String body(String path) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private void assertValidation(String path, String field) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(res.getBody()).path("error");
        assertThat(error.path("code").asText()).as(path).isEqualTo("validation_error");
        assertThat(error.path("details").path("field").asText()).as(path).isEqualTo(field);
    }

    private void assertNotFound(String path, String code) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).isEqualTo(code);
    }

    private List<UUID> itemIds(String path) {
        return ids(Json.tree(body(path)).path("items"));
    }

    private static List<UUID> ids(JsonNode items) {
        List<UUID> out = new ArrayList<>();
        items.forEach(node -> out.add(UUID.fromString(node.path("id").asText())));
        return out;
    }

    private static List<String> names(JsonNode items) {
        List<String> out = new ArrayList<>();
        items.forEach(node -> out.add(node.path("name").asText()));
        return out;
    }

    private static List<String> ratings(JsonNode items) {
        List<String> out = new ArrayList<>();
        items.forEach(node -> out.add(node.path("rating").asText()));
        return out;
    }

    private static List<String> stringList(JsonNode array) {
        return StreamSupport.stream(array.spliterator(), false).map(JsonNode::asText).toList();
    }

    private static JsonNode cardById(JsonNode cards, UUID id) {
        for (JsonNode card : cards) {
            if (id.toString().equals(card.path("id").asText())) {
                return card;
            }
        }
        throw new AssertionError("no card for " + id);
    }

    private static JsonNode factByName(JsonNode facts, String attribute) {
        for (JsonNode fact : facts) {
            if (attribute.equals(fact.path("attribute").asText())) {
                return fact;
            }
        }
        throw new AssertionError("no " + attribute + " fact in " + facts);
    }

    private UUID directoryMerchant(Tenant owner, String slug, String district, String category) {
        return directoryMerchant(owner, slug, district, category, null, null, "published");
    }

    private UUID directoryMerchant(Tenant owner, String slug, String district, String category, String status) {
        return directoryMerchant(owner, slug, district, category, null, null, status);
    }

    private UUID directoryMerchant(Tenant owner, String slug, String district, String category, BigDecimal avgPrice,
                                   Integer popularity) {
        return directoryMerchant(owner, slug, district, category, avgPrice, popularity, "published");
    }

    private UUID directoryMerchant(Tenant owner, String slug, String district, String category, BigDecimal avgPrice,
                                   Integer popularity, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, category_primary, status,
                                       data_origin, avg_price_hkd, popularity_score, ownership_verified, tags)
                values (:id, :t, :slug, :legal, :display, :category, :status, 'demo', :price,
                        coalesce(:popularity, 0), false, '{}'::text[])
                """, new MapSqlParameterSource("id", id).addValue("t", owner.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug)
                .addValue("category", category).addValue("status", status).addValue("price", avgPrice)
                .addValue("popularity", popularity));
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng, is_primary)
                values (:id, :m, :t, '1 Catalog Road', 'Hong Kong', :district, 22.385, 114.188, true)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", id).addValue("t", owner.id())
                .addValue("district", district));
        return id;
    }

    /** A taxonomy leaf with its parent, attached to the merchant: the shape that makes D23 possible. */
    private void seedCategory(Tenant owner, UUID merchant, String slug, String name, String parentSlug,
                              String parentName) {
        UUID parentId = UUID.randomUUID();
        UUID leafId = UUID.randomUUID();
        jdbc.update("""
                insert into categories (id, tenant_id, slug, name, kind)
                values (:id, :t, :slug, :name, 'merchant')
                """, new MapSqlParameterSource("id", parentId).addValue("t", owner.id())
                .addValue("slug", parentSlug).addValue("name", parentName));
        jdbc.update("""
                insert into categories (id, tenant_id, slug, name, kind, parent_id)
                values (:id, :t, :slug, :name, 'merchant', :parent)
                """, new MapSqlParameterSource("id", leafId).addValue("t", owner.id())
                .addValue("slug", slug).addValue("name", name).addValue("parent", parentId));
        jdbc.update("insert into merchant_categories (merchant_id, category_id) values (:m, :c) on conflict do nothing",
                new MapSqlParameterSource("m", merchant).addValue("c", leafId));
    }

    private void seedFact(UUID merchant, String attribute, String value, String source, String confidence) {
        jdbc.update("""
                insert into facts (subject_type, subject_id, merchant_id, attribute, value, source, confidence)
                values ('merchant', :m, :m, :attribute, cast(:value as jsonb), :source, cast(:confidence as numeric))
                """, new MapSqlParameterSource("m", merchant).addValue("attribute", attribute)
                .addValue("value", value).addValue("source", source).addValue("confidence", confidence));
    }

    private void seedOfferingFact(UUID merchant, UUID offering, String attribute, String value, String source,
                                  String confidence) {
        jdbc.update("""
                insert into facts (subject_type, subject_id, merchant_id, attribute, value, source, confidence)
                values ('offering', :o, :m, :attribute, cast(:value as jsonb), :source, cast(:confidence as numeric))
                """, new MapSqlParameterSource("o", offering).addValue("m", merchant).addValue("attribute", attribute)
                .addValue("value", value).addValue("source", source).addValue("confidence", confidence));
    }

    private UUID seedOffering(Tenant owner, UUID merchant, String slug, String kind, BigDecimal price,
                              int popularity, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into offerings (id, merchant_id, tenant_id, kind, slug, name, price_amount, price_model,
                                       popularity_score, status)
                values (:id, :m, :t, :kind, :slug, :name, :price, 'fixed', :popularity, :status)
                """, new MapSqlParameterSource("id", id).addValue("m", merchant).addValue("t", owner.id())
                .addValue("kind", kind).addValue("slug", slug).addValue("name", slug).addValue("price", price)
                .addValue("popularity", popularity).addValue("status", status));
        return id;
    }

    private UUID seedReview(UUID merchant, String rating, String status, int helpful, boolean verified,
                            String dataOrigin) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into reviews (id, tenant_id, merchant_id, rating, title, body, data_origin, status,
                                     helpful_count, verified_purchase, created_at)
                values (:id, :t, :m, cast(:rating as numeric), :title, 'A real review body.', :origin, :status,
                        :helpful, :verified, cast(:when as timestamptz))
                """, new MapSqlParameterSource("id", id).addValue("t", tenant.id()).addValue("m", merchant)
                .addValue("rating", rating).addValue("title", "Review " + rating).addValue("origin", dataOrigin)
                .addValue("status", status).addValue("helpful", helpful).addValue("verified", verified)
                .addValue("when", Timestamp.from(Instant.now().minusSeconds(60L * helpful))));
        return id;
    }

    private void seedSlot(UUID merchant, Instant startsAt, int total, int left) {
        jdbc.update("""
                insert into availability_slots (merchant_id, starts_at, ends_at, capacity_total, capacity_left,
                                                price_amount, currency, source)
                values (:m, :starts_at, :ends_at, :total, :left, 180.00, 'HKD', 'merchant')
                """, new MapSqlParameterSource("m", merchant)
                .addValue("starts_at", Timestamp.from(startsAt))
                .addValue("ends_at", Timestamp.from(startsAt.plusSeconds(5_400)))
                .addValue("total", total).addValue("left", left));
    }
}
