package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The §56 analytics window over HTTP, witnessed against rows this test wrote — the door the adoption of
 * {@code MerchantAnalyticsController} has to pass, because the pair ships with no test of its own.
 *
 * <p>The read's own honesty rules are what the assertions pin: a window with no rows answers zeros and says
 * {@code degraded:false} (measured on a past window, so setup noise cannot reach it), the counts are measured
 * over the window and named per event with their session counts, a booking made through the consumer route is
 * the reservation the window counts, and the refusal table (unknown metric, inverted window, over-cap window,
 * a stranger's merchant, a caller without the grant) is a refusal and never an empty payload.
 */
class MerchantAnalyticsDoorTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID merchant;
    private UUID booker;
    private UUID manager;
    private String staffToken;
    private String bookerToken;

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("analytics");
        merchant = newMerchant(tenant, "an-" + tag(), "published");
        booker = newUser(tenant, "booker" + tag(), "consumer");
        bookerToken = token(tenant, booker, "consumer");
        manager = newUser(tenant, "manager" + tag(), "consumer");
        staff(tenant, merchant, manager, "read_analytics");
        staffToken = token(tenant, manager, "consumer");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private ResponseEntity<String> window(String query) {
        return get(tenant, staffToken, "/api/v1/merchant/analytics?" + query);
    }

    private void writeEvent(String name, int times) {
        for (int i = 0; i < times; i++) {
            jdbc.update("""
                    insert into events (tenant_id, actor_type, name, subject_type, subject_id, session_id)
                    values (:t, 'anonymous', :name, 'merchant', :m, :s)
                    """, new MapSqlParameterSource("t", tenant.id())
                    .addValue("name", name).addValue("m", merchant).addValue("s", "session-" + tag()));
        }
    }

    private UUID slot(Instant startsAt, int capacity) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into availability_slots (id, merchant_id, starts_at, ends_at, capacity_total, capacity_left,
                                                price_amount, currency, source)
                values (:id, :m, :starts_at, :ends_at, :total, :total, 180.00, 'HKD', 'merchant')
                """, new MapSqlParameterSource("id", id).addValue("m", merchant)
                .addValue("starts_at", Timestamp.from(startsAt))
                .addValue("ends_at", Timestamp.from(startsAt.plusSeconds(5_400))).addValue("total", capacity));
        return id;
    }

    @Test
    @DisplayName("A past window answers zeros and calls itself healthy; the present window measures what this test wrote")
    void theWindowMeasuresWhatTheTestWrote() {
        // A window entirely in the past: setup wrote nothing then, and the answer must be a real zero that
        // still calls itself undegraded — "no traffic" is a fact, not a failure.
        Instant pastTo = Instant.now().minusSeconds(86_400);
        JsonNode past = Json.tree(window("merchant_id=" + merchant
                + "&from=" + pastTo.minusSeconds(3_600) + "&to=" + pastTo).getBody());
        assertThat(past.path("metrics").path("views").asLong()).isZero();
        assertThat(past.path("metrics").path("revenue").path("amount").asText()).isEqualTo("0.00");
        assertThat(past.path("degraded").asBoolean()).isFalse();
        assertThat(past.path("source").asText()).isNotBlank();
        assertThat(past.path("note").asText()).contains("real zero");

        // The present window: three views, two clicks, two actions (cart_add and share are both §56 actions),
        // each in its own session, and one booking through the consumer route with the slot's own price.
        writeEvent("view", 3);
        writeEvent("click", 2);
        writeEvent("cart_add", 1);
        writeEvent("share", 1);
        UUID slotId = slot(Instant.now().plusSeconds(7_200), 4);
        ResponseEntity<String> booked = post(tenant, bookerToken, "/api/v1/reservations", Map.of(
                "merchant_id", merchant.toString(), "slot_id", slotId.toString(), "party_size", 2,
                "contact", Map.of("name", "Ada Lau", "phone", "2345 6789")));
        assertThat(booked.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        Instant from = Instant.now().minusSeconds(3_600);
        Instant to = Instant.now().plusSeconds(3_600);
        JsonNode page = Json.tree(window("merchant_id=" + merchant
                + "&from=" + from + "&to=" + to).getBody());

        assertThat(page.path("window").path("metric").asText()).isEqualTo("all");
        assertThat(page.path("metrics").path("views").asLong()).isEqualTo(3);
        assertThat(page.path("metrics").path("clicks").asLong()).isEqualTo(2);
        assertThat(page.path("metrics").path("actions").asLong()).isEqualTo(2);
        assertThat(page.path("metrics").path("reservations").asLong()).isEqualTo(1);
        assertThat(page.path("metrics").path("orders").asLong()).isZero();
        assertThat(page.path("reservations_detail").path("booked_value").path("amount").asText())
                .isEqualTo("180.00");

        JsonNode byEvent = page.path("by_event");
        assertThat(byEvent).hasSize(4);
        for (JsonNode row : byEvent) {
            assertThat(row.path("events").asLong()).isEqualTo(row.path("sessions").asLong());
        }
        assertThat(page.path("degraded").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("A bare date is a UTC day boundary, the metric is echoed rather than filtering, and every refusal is a refusal")
    void theRefusalTableIsARefusal() {
        // Bare dates: `to` is end-of-day, `from` is start-of-day — so these two days span exactly 2 days.
        JsonNode dates = Json.tree(window("merchant_id=" + merchant
                + "&from=2026-01-01&to=2026-01-02").getBody());
        assertThat(dates.path("window").path("from").asText()).isEqualTo("2026-01-01T00:00:00Z");
        assertThat(dates.path("window").path("to").asText()).isEqualTo("2026-01-03T00:00:00Z");
        assertThat(dates.path("window").path("days").asInt()).isEqualTo(2);

        // The metric is validated and echoed; the block still carries every metric it measured (characterised,
        // not endorsed: the parameter narrows nothing in this payload).
        JsonNode narrowed = Json.tree(window("merchant_id=" + merchant + "&metric=views").getBody());
        assertThat(narrowed.path("window").path("metric").asText()).isEqualTo("views");
        assertThat(narrowed.path("metrics").has("revenue")).isTrue();

        assertThat(window("merchant_id=" + merchant + "&metric=bogus").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(window("merchant_id=" + merchant
                + "&from=2026-02-02T00:00:00Z&to=2026-02-01T00:00:00Z").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(window("merchant_id=" + merchant
                + "&from=2025-01-01T00:00:00Z&to=" + Instant.now()).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(window("merchant_id=not-a-uuid").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        Tenant other = newTenant("analytics-other");
        UUID theirs = newMerchant(other, "elsewhere-" + tag(), "published");
        assertThat(window("merchant_id=" + theirs).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(get(tenant, null, "/api/v1/merchant/analytics?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // read_analytics is what stands between a stranger and the numbers: the holder of a booking may not
        // read them, and the denial is audited (exactly once — this is the only 403 in the test).
        assertThat(get(tenant, bookerToken, "/api/v1/merchant/analytics?merchant_id=" + merchant)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(1);
        assertThat(get(tenant, staffToken, "/api/v1/merchant/analytics?merchant_id=" + merchant)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }
}
