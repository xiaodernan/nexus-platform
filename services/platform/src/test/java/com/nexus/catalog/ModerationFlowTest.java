package com.nexus.catalog;

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
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpEntity;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The review lifecycle end to end: a consumer writes, the queue shows it, a named reviewer publishes it, and
 * the number every card prints moves <em>with</em> the fact that cites it.
 *
 * <p>That last clause is the reason this file exists. D35 made "a rendered number carries its fact" a rule,
 * D37 queued the content that changes one, and D38 made a fact updatable at all — none of them had ever run
 * in sequence. The assertions here therefore recompute the expected mean in SQL, the way
 * {@code quality.sql} does, and compare it against both the column and the fact: if the aggregate were
 * updated without restating the citation (or the reverse), one of the two comparisons fails.
 */
class ModerationFlowTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID reviewer;
    private String token;
    private UUID adminId;
    private String adminToken;

    @BeforeEach
    void seedActors() {
        tenant = newTenant("moderation");
        reviewer = newUser(tenant, "author-" + tag(), "consumer");
        token = token(tenant, reviewer, "consumer");
        adminId = newUser(tenant, "moderator-" + tag(), "platform_admin");
        adminToken = token(tenant, adminId, "platform_admin");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    @Test
    @DisplayName("A published review moves the rating and restates the fact beside it, to the same value")
    void publishingRestatesTheClaimItCites() {
        String tag = tag();
        UUID merchant = merchant("publish-" + tag);
        UUID reviewId = postReview("publish-" + tag, "5.0");

        // Pending: invisible, and the aggregate is untouched (there is nothing published to average).
        assertThat(ratingOf("publish-" + tag).isNull()).isTrue();
        JsonNode queue = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/moderation?status=open").getBody());
        assertThat(queue.path("items")).hasSize(1);
        assertThat(queue.path("items").get(0).path("subject").path("rating").asDouble()).isEqualTo(5.0);
        assertThat(queue.path("items").get(0).path("subject").path("merchant").path("slug").asText())
                .isEqualTo("publish-" + tag);
        // A reviewer must be able to see whether the shop behind a review is on any consumer page at all.
        // Without the status, publishing content for a `pending_review` or suspended merchant looks exactly
        // like publishing content people will read.
        assertThat(queue.path("items").get(0).path("subject").path("merchant").path("status").asText())
                .isEqualTo("published");

        ResponseEntity<String> res = resolve(queue.path("items").get(0).path("case_id").asText(), "published",
                "Detailed and about the actual visit.");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode outcome = Json.tree(res.getBody());
        assertThat(outcome.path("aggregate_restated").toString()).contains("merchant rating");
        assertThat(outcome.path("after").path("review_status").asText()).isEqualTo("published");

        // The expected mean, recomputed the way the database's own gate computes it.
        Map<String, Object> expect = row("""
                select round(avg(rating), 2) as value, count(*) as n from reviews
                where merchant_id = :id and status = 'published'
                """, Map.of("id", merchant));
        JsonNode printed = ratingOf("publish-" + tag);
        assertThat(printed.path("value").asDouble())
                .isEqualTo(((BigDecimal) expect.get("value")).doubleValue());
        assertThat(printed.path("count").asInt()).isEqualTo(((Number) expect.get("n")).intValue());

        JsonNode fact = factOf("publish-" + tag, "rating");
        assertThat(fact.path("value").path("value").asDouble())
                .isEqualTo(((BigDecimal) expect.get("value")).doubleValue());
        assertThat(fact.path("value").path("count").asInt()).isEqualTo(((Number) expect.get("n")).intValue());
        assertThat(fact.path("source").asText()).isEqualTo("observed");
        assertThat(fact.path("confidence").asDouble()).isEqualTo(0.7);      // n = 1: the sample is thin
        // One row per claim, so the citation cannot be a coin toss (V5).
        assertThat(count("select count(*) from facts where subject_type = 'merchant' and subject_id = :id"
                        + " and attribute = 'rating'", Map.of("id", merchant))).isEqualTo(1);

        // The decision is on the case, on the audit trail, and reviewable by whoever comes next.
        assertThat(count("""
                select count(*) from audit_logs where action = 'moderation_resolve' and actor_id = :admin
                  and subject_type = 'moderation_case'
                """, Map.of("admin", adminId))).isEqualTo(1);
        JsonNode resolved = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/moderation?status=resolved")
                .getBody());
        assertThat(resolved.path("items").get(0).path("resolution").path("decision").asText())
                .isEqualTo("published");
    }

    @Test
    @DisplayName("A rejected review stays out of the number, and no fact is left claiming a rating")
    void rejectionLeavesNoOrphanCitation() {
        String tag = tag();
        merchant("reject-" + tag);
        postReview("reject-" + tag, "4.0");
        JsonNode queue = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/moderation").getBody());
        String caseId = queue.path("items").get(0).path("case_id").asText();

        assertThat(resolve(caseId, "rejected", "Single line, no visit described.").getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(ratingOf("reject-" + tag).isNull()).isTrue();
        assertThat(count("select count(*) from facts where attribute = 'rating' and subject_id = :id",
                Map.of("id", merchantId("reject-" + tag)))).isZero();
        assertThat(Json.tree(getRaw(tenant, null, "/api/v1/merchants/reject-" + tag + "/reviews").getBody())
                .path("items")).isEmpty();
    }

    @Test
    @DisplayName("The queue is a platform surface: a consumer is refused, and so is another market's admin")
    void queueIsRoleAndTenantScoped() {
        String tag = tag();
        merchant("scoped-" + tag);
        postReview("scoped-" + tag, "3.0");

        assertThat(getRaw(tenant, null, "/api/v1/admin/moderation").getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        ResponseEntity<String> asConsumer = getRaw(tenant, token, "/api/v1/admin/moderation");
        assertThat(asConsumer.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(Json.tree(asConsumer.getBody()).path("error").path("details").path("required_roles").toString())
                .contains("platform_admin");

        Tenant other = newTenant("moderation-other");
        UUID otherAdmin = newUser(other, "other-mod-" + tag, "platform_admin");
        JsonNode crossMarket = Json.tree(getRaw(other, token(other, otherAdmin, "platform_admin"),
                "/api/v1/admin/moderation").getBody());
        assertThat(crossMarket.path("items")).isEmpty();
        assertThat(crossMarket.path("total_estimate").asInt()).isZero();
    }

    @Test
    @DisplayName("A case is closed once, a decision names its field, and an unknown case is absent")
    void resolveIsGuardedAndFailsClosed() {
        String tag = tag();
        merchant("guards-" + tag);
        postReview("guards-" + tag, "2.0");
        String caseId = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/moderation").getBody())
                .path("items").get(0).path("case_id").asText();

        assertThat(resolve(caseId, "published", "Fine.").getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> twice = resolve(caseId, "rejected", "Changed my mind.");
        assertThat(twice.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(twice.getBody()).path("error").path("code").asText())
                .isEqualTo("case_already_resolved");

        // Only the three review states the row can hold; "approve" is a word, not a status.
        ResponseEntity<String> bad = resolve(caseId, "approve", null);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(bad.getBody()).path("error");
        assertThat(error.path("details").path("field").asText()).isEqualTo("decision");
        assertThat(error.path("details").path("allowed").toString()).contains("published");

        assertThat(resolve(UUID.randomUUID().toString(), "published", null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(resolve("not-a-uuid", "published", null).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A filter that names a status the queue cannot hold is a 422, not an empty page.
        assertThat(getRaw(tenant, adminToken, "/api/v1/admin/moderation?status=stale").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    @Test
    @DisplayName("A resolve needs the key its replay is stored under: two cases, one admin, no shared answer")
    void keylessResolveIsRefusedAndLeavesItsCaseOpen() {
        String tag = tag();
        // The last assertion here counts rows for one literal key, so the count starts from empty rather than
        // from whatever an older build of this service left behind.
        jdbc.update("delete from idempotency_keys where key = :k", Map.of("k", "moderation_resolve|null"));
        merchant("keyed-" + tag);
        merchant("keyless-" + tag);
        postReview("keyed-" + tag, "4.0");
        postReview("keyless-" + tag, "1.0");
        JsonNode open = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/moderation?status=open").getBody());
        assertThat(open.path("items")).hasSize(2);
        String first = caseOf(open, "keyed-" + tag);
        String second = caseOf(open, "keyless-" + tag);

        assertThat(resolve(first, "published", "Useful.").getStatusCode()).isEqualTo(HttpStatus.OK);

        // The route closed its case with IdempotencyService.run and never required the header, so a keyless
        // resolve did not skip idempotency — it used the literal `moderation_resolve|null`, which the call
        // above had already claimed. The second case therefore answered with the first one's JSON: a 200
        // printing `case_id: first, decision: published` while the second review stayed invisible and open.
        ResponseEntity<String> keyless = postJson(second, "rejected", null);
        assertThat(keyless.getStatusCode()).as(Json.tree(keyless.getBody()).toString())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(keyless.getBody()).path("error");
        assertThat(error.path("details").path("header").asText()).isEqualTo("Idempotency-Key");
        assertThat(error.path("details").path("scope").asText()).isEqualTo("moderation_resolve");

        // Refused means nothing happened: the case is still in the open queue, and the audit trail still
        // holds one resolve for this admin rather than two.
        JsonNode stillOpen = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/moderation?status=open").getBody());
        assertThat(stillOpen.path("items")).hasSize(1);
        assertThat(caseOf(stillOpen, "keyless-" + tag)).isEqualTo(second);
        assertThat(count("""
                select count(*) from audit_logs where action = 'moderation_resolve' and actor_id = :admin
                """, Map.of("admin", adminId))).isEqualTo(1);
        // And the row the collision needs was never written: with no marker and no guard this request created
        // a claim keyed `moderation_resolve|null`, which is the one row every keyless caller of the route
        // shares — the first writer's stored answer is what the next one is handed back.
        assertThat(count("select count(*) from idempotency_keys where key = :k",
                Map.of("k", "moderation_resolve|null")))
                .as("the shared literal claim row").isZero();
    }

    // ---------------------------------------------------------------- fixtures

    private UUID postReview(String slug, String rating) {
        Map<String, Object> body = Json.map("rating", Double.parseDouble(rating),
                "body", "The seats are deep, the room is quiet after eight, and the tea list is honest.");
        ResponseEntity<String> res = postWithKey(tenant, token, "/api/v1/merchants/" + slug + "/reviews",
                body, "rev-" + slug);
        assertThat(res.getStatusCode()).as(Json.tree(res.getBody()).toString()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString(Json.tree(res.getBody()).path("review_id").asText());
    }

    @Test
    @DisplayName("A resolve against a case that is not there is a named 404, before any decision is taken")
    void absentCaseNamesItself() {
        // D56: the queue answers 409 case_already_resolved and 422 on a bad decision, so a bare 404 here has to
        // say "no such case" rather than leave a client guessing which of the three it hit.
        ResponseEntity<String> res = resolve(java.util.UUID.randomUUID().toString(), "rejected", null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText())
                .isEqualTo("moderation_case_not_found");
    }

    private ResponseEntity<String> resolve(String caseId, String decision, String note) {
        Map<String, Object> body = note == null ? Json.map("decision", decision)
                : Json.map("decision", decision, "note", note);
        return postWithKey(tenant, adminToken, "/api/v1/admin/moderation/" + caseId + "/resolve", body,
                "res-" + caseId + "-" + System.nanoTime());
    }

    /** The open case for one merchant's review, found by slug so the queue's order does not matter. */
    private static String caseOf(JsonNode queue, String slug) {
        for (JsonNode item : queue.path("items")) {
            if (slug.equals(item.path("subject").path("merchant").path("slug").asText())) {
                return item.path("case_id").asText();
            }
        }
        throw new AssertionError("no open case for " + slug + " in " + queue);
    }

    /** The same request {@link #resolve} makes, with no {@code Idempotency-Key} header at all. */
    private ResponseEntity<String> postJson(String caseId, String decision, String note) {
        Map<String, Object> body = note == null ? Json.map("decision", decision)
                : Json.map("decision", decision, "note", note);
        return http.exchange(java.net.URI.create(url("/api/v1/admin/moderation/" + caseId + "/resolve")),
                HttpMethod.POST, new HttpEntity<>(body, json(tenant, adminToken)), String.class);
    }

    private ResponseEntity<String> postWithKey(Tenant t, String bearer, String path, Object body, String key) {        HttpHeaders headers = json(t, bearer);
        headers.add("Idempotency-Key", key);
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.POST, new HttpEntity<>(body, headers),
                String.class);
    }

    private JsonNode ratingOf(String slug) {
        return Json.tree(getRaw(tenant, null, "/api/v1/merchants/" + slug).getBody()).path("rating");
    }

    private JsonNode factOf(String slug, String attribute) {
        JsonNode facts = Json.tree(getRaw(tenant, null, "/api/v1/merchants/" + slug).getBody()).path("facts");
        for (JsonNode fact : facts) {
            if (attribute.equals(fact.path("attribute").asText())) {
                return fact;
            }
        }
        throw new AssertionError("no " + attribute + " fact in " + facts);
    }

    private UUID merchantId(String slug) {
        return (UUID) row("select id from merchants where slug = :slug and tenant_id = :t",
                Map.of("slug", slug, "t", tenant.id())).get("id");
    }

    private UUID merchant(String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, status, data_origin,
                                       avg_price_hkd, ownership_verified)
                values (:id, :t, :slug, :legal, :display, 'published', 'demo', 90.00, true)
                """, new MapSqlParameterSource("id", id).addValue("t", tenant.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug));
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng,
                                       is_primary)
                values (:id, :m, :t, '1 Queue Street', 'Hong Kong', 'Sha Tin', 22.385, 114.188, true)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", id).addValue("t", tenant.id()));
        return id;
    }
}
