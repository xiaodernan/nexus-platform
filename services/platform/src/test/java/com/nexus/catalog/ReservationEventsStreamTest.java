package com.nexus.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The Redis leg of the commerce wire, with the bridge ENABLED — {@code
 * nexus.events.redis-stream-enabled=true} so the request-thread listener actually
 * XADDs into {@code nexus:events}. Everything the sibling {@code ReservationApiTest}
 * asserts about the booking lane lands on the wire exactly the same in this class;
 * re-running both lanes on one fact is cheaper than two boots, and cheaper than trusting
 * that a Redis path exercised today still exists at the next migration.
 *
 * <p>The stream is asserted by the reservation's id, which is unique per test — the two
 * assertions never race each other or any other boot writing {@code nexus:events}.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:postgresql://127.0.0.1:5433/nexus_test",
        "spring.datasource.username=${NEXUS_TEST_DB_USERNAME:${NEXUS_DB_USER:nexus_app}}",
        "spring.datasource.password=${NEXUS_TEST_DB_PASSWORD:${NEXUS_DB_PASSWORD:nexus_dev_app_only}}",
        "spring.datasource.hikari.maximum-pool-size=5",
        "spring.flyway.enabled=false",
        "nexus.redis.enabled=false",
        "nexus.ratelimit.enabled=false",
        "nexus.jwt.secret=nexus-test-only-secret-0123456789abcdef",
        "nexus.permission-cache.ttl-ms=0",
        "nexus.tenant.default-slug=hong-kong",
        "NEXUS_AI_INTERNAL_TOKEN=nexus-test-ai-internal-token-1234567890",
        "nexus.events.redis-stream-enabled=true",
        "nexus.redis.url=${NEXUS_REDIS_URL:redis://127.0.0.1:6380/0}",
})
class ReservationEventsStreamTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID userId;
    private String token;
    private UUID merchant;

    @BeforeEach
    void seedBookableMerchant() {
        tenant = newTenant("events-stream");
        userId = newUser(tenant, "events-" + System.nanoTime() + "@example.test", "consumer");
        token = token(tenant, userId, "consumer");
        merchant = newMerchant(tenant, "events-" + System.nanoTime(), "published");
        newLocation(tenant, merchant, 22.31, 114.16, "Sha Tin");
    }

    private Map<String, Object> body(UUID slotId, int partySize, String phone) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("merchant_id", merchant.toString());
        body.put("slot_id", slotId.toString());
        body.put("party_size", partySize);
        Map<String, Object> contact = new LinkedHashMap<>();
        contact.put("name", "Ada Lau");
        if (phone != null) {
            contact.put("phone", phone);
        }
        body.put("contact", contact);
        return body;
    }

    private UUID slot(Tenant owner, UUID merchantId, Instant startsAt, int total, int left) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into availability_slots (id, merchant_id, starts_at, ends_at, capacity_total, capacity_left,
                                                price_amount, currency, source)
                values (:id, :m, :starts_at, :ends_at, :total, :left, 180.00, 'HKD', 'merchant')
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", id)
                .addValue("m", merchantId).addValue("starts_at", java.sql.Timestamp.from(startsAt))
                .addValue("ends_at", java.sql.Timestamp.from(startsAt.plusSeconds(5_400)))
                .addValue("total", total).addValue("left", left));
        return id;
    }

    private String idPath(JsonNode reservation) {
        return "/api/v1/reservations/" + reservation.path("reservation_id").asText();
    }

    @Test
    @DisplayName("A booking publishes ReservationChanged onto nexus:events — the dispatch plane hears commerce")
    void bookingPublishesReservationChangedEvent() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4);
        JsonNode created = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        String reservationId = created.path("reservation_id").asText();

        assertThat(streamEntries())
                .anySatisfy(e -> {
                    JsonNode payload = Json.tree(e.get("payload"));
                    assertThat(e.get("type")).isEqualTo("ReservationChanged");
                    assertThat(payload.path("reservationId").asText()).isEqualTo(reservationId);
                    assertThat(payload.path("toStatus").asText()).isEqualTo("pending");
                });
    }

    @Test
    @DisplayName("A release publishes reservation_cancelled onto nexus:events with the before-status")
    void cancelPublishesCancelledEvent() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4);
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        String reservationId = held.path("reservation_id").asText();

        Map<String, Object> patchBody = new LinkedHashMap<>();
        patchBody.put("status", "cancelled");
        patchBody.put("reason", "changed my mind");
        assertThat(exchange(org.springframework.http.HttpMethod.PATCH, tenant, token, idPath(held), patchBody).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        assertThat(streamEntries())
                .anySatisfy(e -> {
                    JsonNode payload = Json.tree(e.get("payload"));
                    assertThat(e.get("type")).isEqualTo("ReservationChanged");
                    assertThat(payload.path("reservationId").asText()).isEqualTo(reservationId);
                    assertThat(payload.path("toStatus").asText()).isEqualTo("cancelled");
                    assertThat(payload.path("fromStatus").asText()).isEqualTo("pending");
                });
    }

    /** Recent nexus:events entries, most recent first — fresh connection per assertion. */
    private List<Map<String, String>> streamEntries() {
        String url = System.getenv().getOrDefault("NEXUS_REDIS_URL", "redis://127.0.0.1:6380/0");
        io.lettuce.core.RedisClient client = io.lettuce.core.RedisClient.create(url);
        try (io.lettuce.core.api.StatefulRedisConnection<String, String> conn = client.connect()) {
            return conn.sync().xrevrange("nexus:events",
                            io.lettuce.core.Range.unbounded(),
                            io.lettuce.core.Limit.create(0L, 60L))
                    .stream()
                    .map(msg -> {
                        Map<String, String> out = new LinkedHashMap<>();
                        msg.getBody().forEach(out::put);
                        return out;
                    })
                    .toList();
        } finally {
            try { client.shutdown(); } catch (Exception ignored) { }
        }
    }
}
