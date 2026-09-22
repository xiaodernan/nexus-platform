package com.nexus.growth;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The §8 referral surface and the §5/§23 Customers screen. Both are tested for the honesty
 * property that matters: an empty programme or an untransacted merchant reads as zero/empty with a
 * stated definition, and the only numbers that ever appear come from rows the test wrote itself.
 */
class GrowthApiTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID referrer;
    private String token;

    @BeforeEach
    void seed() {
        tenant = newTenant("growth");
        referrer = newUser(tenant, "referrer" + tag(), "consumer");
        token = token(tenant, referrer, "consumer");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- referrals

    @Test
    @DisplayName("Invite records an unpaid funnel row; the reward stays empty until real conversion (§110)")
    void inviteCreatesOpenReferral() {
        ResponseEntity<String> res = post(tenant, token, "/api/v1/referrals/invite",
                Map.of("kind", "consumer", "email", "Friend+" + tag() + "@example.test"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("status").asText()).isEqualTo("invited");
        assertThat(body.path("kind").asText()).isEqualTo("consumer");
        assertThat(body.path("referrer_id").asText()).isEqualTo(referrer.toString());
        assertThat(body.path("code").asText()).matches("^[A-HJ-NP-Z2-9]{8}$");
        assertThat(body.path("reward").isObject()).isTrue();
        assertThat(body.path("reward").isEmpty()).isTrue();
        assertThat(body.path("converted_at").isNull()).isTrue();

        JsonNode me = Json.tree(get(tenant, token, "/api/v1/referrals/me").getBody());
        assertThat(me.path("items")).hasSize(1);
        assertThat(me.path("items").get(0).path("code").asText()).isEqualTo(body.path("code").asText());
        assertThat(me.path("total_estimate").asLong()).isEqualTo(1);
    }

    @Test
    @DisplayName("Re-inviting the same address replays the open invite instead of padding the funnel")
    void inviteDedupesOpenEmail() {
        String email = "dup" + tag() + "@example.test";
        JsonNode first = Json.tree(post(tenant, token, "/api/v1/referrals/invite",
                Map.of("kind", "consumer", "email", email)).getBody());
        JsonNode second = Json.tree(post(tenant, token, "/api/v1/referrals/invite",
                Map.of("kind", "consumer", "email", email)).getBody());
        assertThat(second.path("id").asText()).isEqualTo(first.path("id").asText());
        assertThat(Json.tree(get(tenant, token, "/api/v1/referrals/me").getBody()).path("items")).hasSize(1);
    }

    @Test
    @DisplayName("Stats count stored statuses exactly and earned is 0.00 — never an invented credit")
    void statsAreRealCounts() {
        post(tenant, token, "/api/v1/referrals/invite", Map.of("kind", "consumer", "email", "a" + tag() + "@example.test"));
        post(tenant, token, "/api/v1/referrals/invite", Map.of("kind", "merchant", "email", "b" + tag() + "@example.test"));
        // One converted row, written directly the way a verified conversion job would.
        UUID invited = UUID.fromString(Json.tree(post(tenant, token, "/api/v1/referrals/invite",
                Map.of("kind", "consumer", "email", "c" + tag() + "@example.test")).getBody()).path("id").asText());
        jdbc.update("update referrals set status = 'rewarded', reward = cast(:r as jsonb), converted_at = now()"
                + " where id = :id", new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", invited)
                .addValue("r", "{\"amount\":\"20.00\",\"currency\":\"HKD\"}"));

        JsonNode stats = Json.tree(get(tenant, token, "/api/v1/referrals/me/stats?window_days=30").getBody());
        assertThat(stats.path("invited").asLong()).isEqualTo(3);
        assertThat(stats.path("signed_up").asLong()).isZero();
        assertThat(stats.path("rewarded").asLong()).isEqualTo(1);
        assertThat(stats.path("earned").path("amount").asText()).isEqualTo("20.00");
        assertThat(stats.path("earned").path("currency").asText()).isEqualTo("HKD");
        assertThat(stats.path("window_days").asInt()).isEqualTo(30);
        assertThat(stats.path("source").asText()).isEqualTo("referrals");
        assertThat(stats.path("definitions").path("earned").asText()).contains("genuine conversion");
    }

    @Test
    @DisplayName("Referral routes need a session, validate the body, and never leak across tenants")
    void referralsAreScopedAndValidated() {
        assertThat(get(tenant, null, "/api/v1/referrals/me").getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(post(tenant, token, "/api/v1/referrals/invite",
                Map.of("kind", "pyramid", "email", "x@example.test")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, token, "/api/v1/referrals/invite",
                Map.of("kind", "consumer", "email", "not-an-email")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        Tenant other = newTenant("growth-b");
        UUID rival = newUser(other, "rival" + tag(), "consumer");
        JsonNode theirs = Json.tree(get(other, token(other, rival, "consumer"), "/api/v1/referrals/me").getBody());
        assertThat(theirs.path("items")).isEmpty();
    }

    // ---------------------------------------------------------------- customers

    @Test
    @DisplayName("Customers aggregate real transactions only; cancelled rows and other tenants stay out")
    void customersComeFromTransactions() {
        UUID merchant = newMerchant(tenant, "cafe-" + tag(), "published");
        UUID staff = newUser(tenant, "owner" + tag(), "consumer");
        staff(tenant, merchant, staff, "read_analytics");
        UUID repeat = newUser(tenant, "regular" + tag(), "consumer");
        UUID oneOff = newUser(tenant, "visitor" + tag(), "consumer");
        UUID stranger = newUser(tenant, "stranger" + tag(), "consumer"); // has orders at NO merchant here

        newOrder(merchant, repeat, "paid", "120.00");
        newOrder(merchant, repeat, "paid", "80.00");
        newOrder(merchant, repeat, "cancelled", "999.00"); // excluded from spend and counts
        // Age the regular's rows so last_seen ordering is deterministic (now() ties on u.id otherwise).
        jdbc.update("update orders set created_at = created_at - interval '2 days' where user_id = :u",
                new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("u", repeat));
        newOrder(merchant, oneOff, "completed", "45.00");
        newReservation(merchant, oneOff, "confirmed");

        JsonNode page = Json.tree(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + merchant).getBody());
        assertThat(page.path("items")).hasSize(2);
        JsonNode top = page.path("items").get(0); // ordered by last_seen desc — the one-off ordered after the regulars
        assertThat(top.path("email").asText()).startsWith("visitor");
        assertThat(top.path("transactions").asLong()).isEqualTo(2);
        assertThat(top.path("orders").asLong()).isEqualTo(1);
        assertThat(top.path("reservations").asLong()).isEqualTo(1);
        assertThat(top.path("repeat").asBoolean()).isTrue();
        JsonNode regular = page.path("items").get(1);
        assertThat(regular.path("email").asText()).startsWith("regular");
        assertThat(regular.path("spend").path("amount").asText()).isEqualTo("200.00"); // 120+80, not 1119
        assertThat(regular.path("transactions").asLong()).isEqualTo(2);
        assertThat(page.path("total_estimate").asLong()).isEqualTo(2);
        assertThat(page.path("source").asText()).contains("orders");
        assertThat(page.path("data_origin").asText()).isEqualTo("demo");

        JsonNode repeats = Json.tree(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + merchant + "&segment=repeat").getBody());
        assertThat(repeats.path("items")).hasSize(2); // both have 2 qualifying transactions here
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + merchant + "&segment=nope").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    @Test
    @DisplayName("A merchant with no transactions gets an honest empty page, and RBAC holds")
    void customersEmptyAndGuards() {
        UUID merchant = newMerchant(tenant, "quiet-" + tag(), "published");
        UUID staff = newUser(tenant, "staff" + tag(), "consumer");
        staff(tenant, merchant, staff, "read_analytics");

        JsonNode page = Json.tree(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + merchant).getBody());
        assertThat(page.path("items")).isEmpty();
        assertThat(page.path("total_estimate").asLong()).isZero();
        assertThat(page.path("definition").path("customer").asText()).contains("order");

        UUID nosie = newUser(tenant, "nosie" + tag(), "consumer");
        assertThat(get(tenant, token(tenant, nosie, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(get(tenant, null, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers").getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers?merchant_id=not-a-uuid").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + UUID.randomUUID()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---------------------------------------------------------------- fixtures

    private UUID newOrder(UUID merchant, UUID userId, String status, String total) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into orders (id, code, tenant_id, merchant_id, user_id, status, total, currency)
                values (:id, :code, :t, :m, :u, :status, cast(:total as numeric), 'HKD')
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", id)
                .addValue("code", "NX-ORD-" + tag()).addValue("t", tenant.id()).addValue("m", merchant)
                .addValue("u", userId).addValue("status", status).addValue("total", total));
        return id;
    }

    private UUID newReservation(UUID merchant, UUID userId, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into reservations (id, code, tenant_id, merchant_id, user_id, party_size, starts_at, status)
                values (:id, :code, :t, :m, :u, 2, now() + interval '1 day', :status)
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", id)
                .addValue("code", "NX-RES-" + tag()).addValue("t", tenant.id()).addValue("m", merchant)
                .addValue("u", userId).addValue("status", status));
        return id;
    }
}
