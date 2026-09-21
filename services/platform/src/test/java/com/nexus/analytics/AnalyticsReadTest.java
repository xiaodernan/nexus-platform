package com.nexus.analytics;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.math.BigDecimal;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The merchant funnel overview (STATUS.md ruling D15, backed by {@code v_merchant_funnel}) and the map
 * clustering payload (spec §38). Both are read-only projections, so the fixtures write the underlying
 * rows directly and assert the endpoint reports exactly those numbers — no invented traffic.
 */
class AnalyticsReadTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID merchant;
    private UUID staff;

    @BeforeEach
    void seed() {
        tenant = newTenant("analytics");
        merchant = newMerchant(tenant, "harbour-" + tag(), "published");
        staff = newUser(tenant, "analyst" + tag(), "consumer");
        staff(tenant, merchant, staff, "read_analytics");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- overview

    @Test
    @DisplayName("Overview reports the funnel view's numbers for the merchant, not guesses")
    void overviewReflectsFunnel() {
        writeEvent("view", 3);
        writeEvent("click", 2);
        writeEvent("cart_add", 1);
        UUID reservation = UUID.randomUUID();
        jdbc.update("""
                insert into reservations (id, code, tenant_id, merchant_id, party_size, starts_at, status)
                values (:id, :code, :t, :m, 2, now() + interval '2 days', 'confirmed')
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", reservation)
                .addValue("code", "NX-RES-" + tag()).addValue("t", tenant.id()).addValue("m", merchant));
        jdbc.update("""
                insert into orders (id, code, tenant_id, merchant_id, status, total, currency)
                values (:id, :code, :t, :m, 'paid', 480.00, 'HKD')
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", UUID.randomUUID())
                .addValue("code", "NX-ORD-" + tag()).addValue("t", tenant.id()).addValue("m", merchant));

        ResponseEntity<String> res = get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/businesses/" + merchant + "/overview");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("merchant_id").asText()).isEqualTo(merchant.toString());
        assertThat(body.path("slug").asText()).startsWith("harbour-");
        assertThat(body.path("funnel_source").asText()).isEqualTo("v_merchant_funnel");
        assertThat(body.path("funnel").path("views").asLong()).isEqualTo(3);
        assertThat(body.path("funnel").path("clicks").asLong()).isEqualTo(2);
        assertThat(body.path("funnel").path("actions").asLong()).isEqualTo(1);
        assertThat(body.path("funnel").path("reservations").asLong()).isEqualTo(1);
        assertThat(body.path("funnel").path("orders").asLong()).isEqualTo(1);
        assertThat(body.path("funnel").path("revenue").path("amount").asText()).isEqualTo("480.00");
        assertThat(body.path("funnel").path("revenue").path("currency").asText()).isEqualTo("HKD");
        // The view's own revenue column is fanned out by its event joins (6 events x 480 = 2880); the
        // endpoint must both avoid it and say which definition produced the number.
        assertThat(body.path("revenue_definition").asText()).contains("orders.total");
        assertThat(body.path("computed_at").asText()).isNotBlank();
        // D6: this merchant row is demo-origin data and the response says so.
        assertThat(body.path("data_origin").asText()).isEqualTo("demo");
        assertThat(res.getHeaders().getFirst("X-Demo-Data")).isEqualTo("true");
    }

    @Test
    @DisplayName("A merchant with no activity gets zeroes; other tenants and roles get 404/403")
    void overviewIsEmptyNotFake() {
        JsonNode quiet = Json.tree(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/businesses/" + merchant + "/overview").getBody());
        assertThat(quiet.path("funnel").path("views").asLong()).isZero();
        assertThat(quiet.path("funnel").path("revenue").path("amount").asText()).isEqualTo("0.00");

        UUID consumer = newUser(tenant, "browser" + tag(), "consumer");
        assertThat(get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/merchant/businesses/" + merchant + "/overview").getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        Tenant other = newTenant("analytics-b");
        UUID otherStaff = newUser(other, "rival" + tag(), "consumer");
        staff(other, newMerchant(other, "rival-cafe-" + tag(), "published"), otherStaff, "read_analytics");
        assertThat(get(other, token(other, otherStaff, "consumer"),
                "/api/v1/merchant/businesses/" + merchant + "/overview").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/businesses/" + UUID.randomUUID() + "/overview").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/businesses/not-a-uuid/overview").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ---------------------------------------------------------------- map markers

    @Test
    @DisplayName("GET /locations/geo clusters nearby published locations and reports haversine distance")
    void geoClustersMarkers() {
        UUID near1 = newMerchant(tenant, "geo-a-" + tag(), "published");
        UUID near2 = newMerchant(tenant, "geo-b-" + tag(), "published");
        UUID far = newMerchant(tenant, "geo-c-" + tag(), "published");
        newLocation(tenant, near1, 22.380000, 114.186000, "Tsim Sha Tsui");
        newLocation(tenant, near2, 22.381000, 114.187000, "Tsim Sha Tsui");
        newLocation(tenant, far, 22.520000, 114.120000, "Tsuen Wan");
        // A draft merchant's location must never appear on a public map.
        newLocation(tenant, newMerchant(tenant, "geo-draft-" + tag(), "draft"), 22.380500, 114.186500, "KLN");

        String bbox = "114.180,22.375,114.195,22.388";
        JsonNode page = Json.tree(get(tenant, null, "/api/v1/locations/geo?bbox=" + bbox + "&zoom=14").getBody());
        assertThat(page.path("total_locations").asLong()).isEqualTo(2);
        assertThat(page.path("markers")).hasSize(1);
        JsonNode cluster = page.path("markers").get(0);
        assertThat(cluster.path("count").asLong()).isEqualTo(2);
        assertThat(cluster.path("merchant_count").asLong()).isEqualTo(2);
        assertThat(cluster.path("merchant_ids")).hasSize(2);
        assertThat(cluster.path("district").asText()).isEqualTo("Tsim Sha Tsui");
        assertThat(cluster.path("sample_slug").isNull()).isTrue();
        assertThat(new BigDecimal(cluster.path("distance_m").asText("0")).longValue())
                .isBetween(0L, 200_000L);
        assertThat(page.path("truncated").asBoolean()).isFalse();
        assertThat(page.path("clustered").asBoolean()).isTrue();

        // Zooming in separates the two points; the wider box picks up the third.
        JsonNode deep = Json.tree(get(tenant, null, "/api/v1/locations/geo?bbox=" + bbox + "&zoom=17").getBody());
        assertThat(deep.path("markers")).hasSize(2);
        assertThat(deep.path("clustered").asBoolean()).isFalse();
        JsonNode wide = Json.tree(get(tenant, null,
                "/api/v1/locations/geo?bbox=114.110,22.370,114.195,22.525&zoom=13").getBody());
        assertThat(wide.path("total_locations").asLong()).isEqualTo(3);

        // Public but cacheable, and it never needs a token.
        ResponseEntity<String> res = get(tenant, null, "/api/v1/locations/geo?bbox=" + bbox + "&zoom=14");
        assertThat(res.getHeaders().getFirst("Cache-Control")).contains("max-age=120");
    }

    @Test
    @DisplayName("Malformed or over-wide bboxes are rejected; an empty box is an honest empty state")
    void geoValidatesInput() {
        assertThat(get(tenant, null, "/api/v1/locations/geo").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, null, "/api/v1/locations/geo?bbox=114.1,22.3").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, null, "/api/v1/locations/geo?bbox=114.1,22.3,abc,22.4").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, null, "/api/v1/locations/geo?bbox=114.1,22.3,114.2,95.0").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, null, "/api/v1/locations/geo?bbox=0,0,30,30&zoom=12").getBody())
                .contains("capped");
        assertThat(get(tenant, null, "/api/v1/locations/geo?bbox=114.1,22.3,114.12,22.32&zoom=0").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, null, "/api/v1/locations/geo?bbox=114.1,22.3,114.12,22.32&zoom=99").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        JsonNode empty = Json.tree(get(tenant, null,
                "/api/v1/locations/geo?bbox=113.00,22.30,113.05,22.35&zoom=12").getBody());
        assertThat(empty.path("markers")).isEmpty();
        assertThat(empty.path("total_locations").asLong()).isZero();

        // A second tenant's markers never appear in the first tenant's payload.
        Tenant other = newTenant("geo-b");
        UUID rival = newMerchant(other, "rival-geo-" + tag(), "published");
        newLocation(other, rival, 22.380200, 114.186200, "TST");
        JsonNode mine = Json.tree(get(tenant, null,
                "/api/v1/locations/geo?bbox=114.180,22.375,114.195,22.388&zoom=17").getBody());
        assertThat(mine.path("total_locations").asLong()).isZero();
        JsonNode theirs = Json.tree(get(other, null,
                "/api/v1/locations/geo?bbox=114.180,22.375,114.195,22.388&zoom=17").getBody());
        assertThat(theirs.path("total_locations").asLong()).isEqualTo(1);
    }

    // ---------------------------------------------------------------- helpers

    private void writeEvent(String name, int times) {
        for (int i = 0; i < times; i++) {
            jdbc.update("""
                    insert into events (tenant_id, actor_type, name, subject_type, subject_id, session_id)
                    values (:t, 'anonymous', :name, 'merchant', :m, :s)
                    """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("t", tenant.id())
                    .addValue("name", name).addValue("m", merchant).addValue("s", "session-" + tag()));
        }
    }
}
