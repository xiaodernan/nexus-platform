package com.nexus.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * §6's consumer review write, tested the way the rest of this module is tested: what the route answers, and
 * what the database was left holding.
 *
 * <p>The three things worth asserting are not "it inserts a row". A review that a consumer can post must
 * (1) not reach anyone's screen until a human says so — §55/§127, and this build has no automated filter;
 * (2) not move a rendered number, because the rating and the {@code rating} fact beside it are defined over
 * published rows only (D35); and (3) carry visit badges the caller cannot claim for themselves. A route that
 * published immediately, nudged the aggregate, or trusted {@code verified_visit: true} from the request body
 * would pass a naive "201 and a row exists" test.
 */
class ReviewWriteTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;
    private UUID reviewer;
    private String token;

    @BeforeEach
    void seedTenants() {
        tenant = newTenant("reviews");
        other = newTenant("reviews-other");
        reviewer = newUser(tenant, "reviewer-" + tag(), "consumer");
        token = token(tenant, reviewer, "consumer");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- the happy path, honestly queued

    @Test
    @DisplayName("A posted review is pending, is nobody's published content, and moves no number")
    void postedReviewWaitsForAHuman() {
        String tag = tag();
        UUID merchant = merchant("queued-" + tag);

        ResponseEntity<String> res = postWithKey(tenant, token, "/api/v1/merchants/queued-" + tag + "/reviews",
                Json.map("rating", 4.5, "body",
                        "Quiet on weekday afternoons, and the tea list is longer than it looks"),
                "queued-" + tag);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("status").asText()).isEqualTo("pending");
        assertThat(body.path("data_origin").asText()).isEqualTo("user");
        assertThat(body.path("aggregate_changed").asBoolean()).isFalse();
        assertThat(body.path("flags").path("demo").asBoolean()).isFalse();
        assertThat(body.path("rating").asDouble()).isEqualTo(4.5);
        assertThat(body.path("merchant").path("slug").asText()).isEqualTo("queued-" + tag);

        // Stored, and queued where a person will actually find it.
        assertThat(count("select count(*) from reviews where id = :id and status = 'pending' and data_origin = 'user'",
                Map.of("id", UUID.fromString(body.path("review_id").asText())))).isEqualTo(1);
        assertThat(count("""
                select count(*) from moderation_cases where subject_type = 'review' and subject_id = :id
                  and status = 'open' and auto_action = 'none'
                """, Map.of("id", UUID.fromString(body.path("review_id").asText())))).isEqualTo(1);

        // Invisible to the public page, and to the aggregate the page prints.
        JsonNode page = Json.tree(getRaw(tenant, null, "/api/v1/merchants/queued-" + tag + "/reviews").getBody());
        assertThat(page.path("items")).isEmpty();
        // Nothing published, so the card prints no rating at all rather than a 0.0 one (D35).
        assertThat(ratingOf(merchant).isNull()).isTrue();
    }

    @Test
    @DisplayName("The rating a page prints is the mean of published rows, so a queued one cannot vote")
    void queuedReviewLeavesTheRatingAndItsFactAlone() {
        String tag = tag();
        UUID merchant = merchant("aggregate-" + tag);
        seedPublishedReview(merchant, "5.0");
        seedPublishedReview(merchant, "3.0");
        BigDecimal before = (BigDecimal) row("select rating_agg from merchants where id = :id",
                Map.of("id", merchant)).get("rating_agg");

        ResponseEntity<String> queued = postWithKey(tenant, token,
                "/api/v1/merchants/aggregate-" + tag + "/reviews",
                Json.map("rating", 1.0,
                        "body", "A one-star review that nobody has read yet, and must not be counted."),
                "aggregate-" + tag);
        assertThat(queued.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(Json.tree(queued.getBody()).path("aggregate_changed").asBoolean()).isFalse();

        Map<String, Object> after = row("select rating_agg, review_count from merchants where id = :id",
                Map.of("id", merchant));
        assertThat(after.get("rating_agg")).isEqualTo(before);
        assertThat(((Number) after.get("review_count")).intValue()).isEqualTo(2);
        JsonNode rating = Json.tree(getRaw(tenant, null, "/api/v1/merchants/aggregate-" + tag).getBody())
                .path("rating");
        assertThat(rating.path("count").asInt()).isEqualTo(2);
        assertThat(rating.path("value").asDouble()).isEqualTo(4.0);
    }

    // ---------------------------------------------------------------- the badges are derived

    @Test
    @DisplayName("Visit badges come from this caller's own rows, and a request cannot assert them")
    void verifiedFlagsAreDerivedNotDeclared() {
        String tag = tag();
        merchant("badge-" + tag);
        // The body claims both badges. The server ignores the claim and looks at its own tables instead.
        JsonNode unbacked = Json.tree(postWithKey(tenant, token, "/api/v1/merchants/badge-" + tag + "/reviews",
                Json.map("rating", 4.0, "body", "I never booked and never bought, whatever the JSON says.",
                        "verified_reservation", true, "verified_purchase", true, "data_origin", "demo"),
                "badge-" + tag).getBody());
        assertThat(unbacked.path("verified_reservation").asBoolean()).isFalse();
        assertThat(unbacked.path("verified_purchase").asBoolean()).isFalse();
        assertThat(unbacked.path("data_origin").asText()).isEqualTo("user");
        // And the response says which predicate it used, so a tick is never a mystery to the reader.
        assertThat(unbacked.path("verification_basis").path("verified_reservation").asText())
                .contains("confirmed").contains("completed");

        // A second place, where this caller really does have a completed booking and a paid order.
        merchant("attended-" + tag);
        UUID merchant = merchantId("attended-" + tag);
        jdbc.update("""
                insert into reservations (code, tenant_id, merchant_id, user_id, party_size, starts_at, ends_at,
                                          status, contact)
                values (:code, :t, :m, :u, 2, now() - interval '2 day', now() - interval '1 day', 'completed',
                        '{}'::jsonb)
                """, new MapSqlParameterSource("code", "NX-TEST-" + tag).addValue("t", tenant.id())
                .addValue("m", merchant).addValue("u", reviewer));
        jdbc.update("""
                insert into orders (code, tenant_id, merchant_id, user_id, status, subtotal, total, currency)
                values (:code, :t, :m, :u, 'completed', 88.00, 88.00, 'HKD')
                """, new MapSqlParameterSource("code", "NX-ORD-" + tag).addValue("t", tenant.id())
                .addValue("m", merchant).addValue("u", reviewer));

        JsonNode backed = Json.tree(postWithKey(tenant, token, "/api/v1/merchants/attended-" + tag + "/reviews",
                Json.map("rating", 5.0, "body", "Booked it, ate there, paid, and it was worth the walk."),
                "attended-" + tag).getBody());
        assertThat(backed.path("verified_reservation").asBoolean()).isTrue();
        assertThat(backed.path("verified_purchase").asBoolean()).isTrue();

        // Somebody else, same merchant, no rows of their own: the badge belongs to a person, not to a place.
        UUID stranger = newUser(tenant, "stranger-" + tag, "consumer");
        JsonNode other = Json.tree(postWithKey(tenant, token(tenant, stranger, "consumer"),
                "/api/v1/merchants/attended-" + tag + "/reviews",
                Json.map("rating", 4.0, "body", "I turned up with no booking and no receipt, and said so."),
                "stranger-" + tag).getBody());
        assertThat(other.path("verified_reservation").asBoolean()).isFalse();
        assertThat(other.path("verified_purchase").asBoolean()).isFalse();
    }

    // ---------------------------------------------------------------- the doors

    @Test
    @DisplayName("Anonymous is 401, a missing Idempotency-Key is 422, and both name the reason")
    void authAndIdempotencyAreEnforced() {
        String tag = tag();
        merchant("doors-" + tag);
        Map<String, Object> body = Json.map("rating", 4.0,
                "body", "Long enough to be worth reading, which is the point of a minimum.");

        ResponseEntity<String> anon = post(tenant, null, "/api/v1/merchants/doors-" + tag + "/reviews", body);
        assertThat(anon.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(anon.getBody()).path("error").path("code").asText()).isEqualTo("unauthorized");

        ResponseEntity<String> replay = postWithKey(tenant, token,
                "/api/v1/merchants/doors-" + tag + "/reviews", body, "review-" + tag);
        assertThat(replay.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        UUID reviewId = UUID.fromString(Json.tree(replay.getBody()).path("review_id").asText());

        // The same key again: the same row, not a second one, and not the 409 the next key would meet.
        ResponseEntity<String> again = postWithKey(tenant, token,
                "/api/v1/merchants/doors-" + tag + "/reviews", body, "review-" + tag);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(Json.tree(again.getBody()).path("review_id").asText()).isEqualTo(reviewId.toString());
        assertThat(count("select count(*) from reviews where merchant_id = :m and user_id = :u",
                Map.of("m", merchantId("doors-" + tag), "u", reviewer))).isEqualTo(1);

        // A key already used by somebody else is refused rather than quietly replayed as their review.
        UUID stranger = newUser(tenant, "stranger-" + tag, "consumer");
        ResponseEntity<String> stolen = postWithKey(tenant, token(tenant, stranger, "consumer"),
                "/api/v1/merchants/doors-" + tag + "/reviews", body, "review-" + tag);
        assertThat(stolen.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(stolen.getBody()).path("error").path("code").asText())
                .isEqualTo("idempotency_key_conflict");
    }

    @Test
    @DisplayName("Every rejected input names its own field, and nothing is written on the way")
    void validationRefusesInsteadOfGuessing() {
        String tag = tag();
        merchant("strict-" + tag);
        String path = "/api/v1/merchants/strict-" + tag + "/reviews";

        assertField(path, Json.map("rating", 0, "body", "Long enough to satisfy the body rule, still refused."),
                "rating");
        assertField(path, Json.map("rating", 6, "body", "Long enough to satisfy the body rule, still refused."),
                "rating");
        // 4.37 cannot be stored; rounding it silently would make the review say one thing and the row another.
        assertField(path, Json.map("rating", 4.37, "body", "Long enough to satisfy the body rule, still fine."),
                "rating");
        assertField(path, Json.map("rating", 4.0, "body", "too short"), "body");
        assertField(path, Json.map("rating", 4.0), "body");
        assertField(path, Json.map("rating", 4.0, "body", "x".repeat(2001), "language", "en"), "body");
        assertField(path, Json.map("rating", 4.0, "body", "Long enough and real, but the locale is invented.",
                "language", "fr-FR"), "language");
        assertField(path, Json.map("rating", 4.0, "body", "Long enough and real, but that is not a uuid.",
                "offering_id", "not-a-uuid"), "offering_id");
        // An offering from another merchant would render a citation that goes nowhere.
        UUID foreign = merchant("other-shop-" + tag);
        UUID foreignOffering = offering(foreign, "dish-" + tag);
        assertField(path, Json.map("rating", 4.0,
                "body", "Long enough and real, but the dish belongs to somebody else's menu.",
                "offering_id", foreignOffering.toString()), "offering_id");

        assertThat(count("select count(*) from reviews where merchant_id = :m",
                Map.of("m", merchantId("strict-" + tag)))).isZero();
    }

    @Test
    @DisplayName("One voice per person per place, until a rejection frees it")
    void secondOpenReviewIsAConflictNotASecondVote() {
        String tag = tag();
        UUID merchant = merchant("once-" + tag);
        String path = "/api/v1/merchants/once-" + tag + "/reviews";
        ResponseEntity<String> first = postWithKey(tenant, token, path,
                Json.map("rating", 4.0, "body", "The first honest account of a quiet Tuesday lunch."), "k1-" + tag);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        ResponseEntity<String> second = postWithKey(tenant, token, path,
                Json.map("rating", 1.0, "body", "The same person, changed their mind, wants a second ballot."),
                "k2-" + tag);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        JsonNode error = Json.tree(second.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("review_exists");
        assertThat(error.path("details").path("review_id").asText())
                .isEqualTo(Json.tree(first.getBody()).path("review_id").asText());
        assertThat(error.path("details").path("status").asText()).isEqualTo("pending");

        // A rejected review is about that text, not a permanent silence: the same person may try again.
        jdbc.update("update reviews set status = 'rejected' where id = :id",
                new MapSqlParameterSource("id", UUID.fromString(Json.tree(first.getBody())
                        .path("review_id").asText())));
        ResponseEntity<String> retry = postWithKey(tenant, token, path,
                Json.map("rating", 3.0, "body", "Rewritten after the first version was rejected on moderation."),
                "k3-" + tag);
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    @Test
    @DisplayName("Another market's merchant is absent here too, on the write as on the read")
    void crossTenantIsNotFoundNotForbidden() {
        String tag = tag();
        merchantIn(other, "elsewhere-" + tag);
        ResponseEntity<String> res = postWithKey(tenant, token, "/api/v1/merchants/elsewhere-" + tag + "/reviews",
                Json.map("rating", 4.0, "body", "Trying to review a shop in a market this session is not in."),
                "elsewhere-" + tag);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).isEqualTo("merchant_not_found");
        // A draft merchant is absent from the consumer surface, so it cannot be reviewed either (D24).
        draftMerchant("draft-" + tag);
        assertThat(postWithKey(tenant, token, "/api/v1/merchants/draft-" + tag + "/reviews",
                Json.map("rating", 4.0, "body", "A draft listing is not on any consumer page, in either direction."),
                "draft-" + tag).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("A synthetic row in your name does not spend your one voice")
    void demoRowsDoNotBlockARealReview() {
        String tag = tag();
        UUID merchant = merchant("synthetic-" + tag);
        // The seeded corpus attributes published reviews to the very demo accounts a session can log in as.
        // If those counted against the one-voice rule, no demo user could post anywhere in the dataset —
        // an honest route nobody can reach is still a dead route.
        seedPublishedReview(merchant, "4.5", reviewer, "demo");

        ResponseEntity<String> res = postWithKey(tenant, token,
                "/api/v1/merchants/synthetic-" + tag + "/reviews",
                Json.map("rating", 3.0,
                        "body", "The person behind that account may say their own piece."),
                "synthetic-" + tag);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(Json.tree(res.getBody()).path("status").asText()).isEqualTo("pending");
        // The synthetic row keeps its place in the aggregate; the real one waits for a human.
        assertThat(ratingOf(merchant).path("count").asInt()).isEqualTo(1);
    }

    // ---------------------------------------------------------------- helpers

    private void assertField(String path, Map<String, Object> body, String field) {
        ResponseEntity<String> res = postWithKey(tenant, token, path, body, "v-" + field + "-" + System.nanoTime());
        assertThat(res.getStatusCode()).as(Json.write(body)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(res.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("validation_error");
        assertThat(error.path("details").path("field").asText()).isEqualTo(field);
    }

    private ResponseEntity<String> postWithKey(Tenant t, String bearer, String path, Object body, String key) {
        HttpHeaders headers = json(t, bearer);
        headers.add("Idempotency-Key", key);
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.POST, new HttpEntity<>(body, headers),
                String.class);
    }

    private UUID merchant(String slug) {
        return merchantIn(tenant, slug);
    }

    private void draftMerchant(String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, status, data_origin)
                values (:id, :t, :slug, :legal, :display, 'draft', 'demo')
                """, new MapSqlParameterSource("id", id).addValue("t", tenant.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug));
    }

    private UUID merchantIn(Tenant owner, String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, status, data_origin)
                values (:id, :t, :slug, :legal, :display, 'published', 'demo')
                """, new MapSqlParameterSource("id", id).addValue("t", owner.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug));
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng,
                                       is_primary)
                values (:id, :m, :t, '1 Review Road', 'Hong Kong', 'Sha Tin', 22.385, 114.188, true)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", id).addValue("t", owner.id()));
        return id;
    }

    private UUID offering(UUID merchant, String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into offerings (id, merchant_id, tenant_id, kind, slug, name, price_amount, price_model,
                                       status)
                values (:id, :m, :t, 'product', :slug, :name, 48.00, 'fixed', 'active')
                """, new MapSqlParameterSource("id", id).addValue("m", merchant).addValue("t", tenant.id())
                .addValue("slug", slug).addValue("name", slug));
        return id;
    }

    private UUID merchantId(String slug) {
        return (UUID) row("select id from merchants where slug = :slug and tenant_id = :t",
                Map.of("slug", slug, "t", tenant.id())).get("id");
    }

    /** A published row, plus the aggregate refresh the real read model depends on (D35). */
    private void seedPublishedReview(UUID merchant, String rating) {
        seedPublishedReview(merchant, rating, null, "demo");
    }

    private void seedPublishedReview(UUID merchant, String rating, UUID author, String origin) {
        jdbc.update("""
                insert into reviews (tenant_id, merchant_id, user_id, rating, body, language, data_origin, status,
                                     created_at)
                values (:t, :m, :u, :rating, 'A published review that the aggregate is allowed to count.', 'en',
                        :origin, 'published', now() - interval '3 day')
                """, new MapSqlParameterSource("t", tenant.id()).addValue("m", merchant)
                .addValue("u", author).addValue("rating", new BigDecimal(rating)).addValue("origin", origin));
        int n = (int) count("select count(*) from reviews where merchant_id = :m and status = 'published'",
                Map.of("m", merchant));
        BigDecimal avg = (BigDecimal) row("""
                select round(avg(rating), 2) as avg from reviews
                where merchant_id = :m and status = 'published'
                """, Map.of("m", merchant)).get("avg");
        jdbc.update("update merchants set rating_agg = :avg, review_count = :n where id = :id",
                new MapSqlParameterSource("avg", avg).addValue("n", n).addValue("id", merchant));
    }

    private JsonNode ratingOf(UUID merchant) {
        return Json.tree(getRaw(tenant, null, "/api/v1/merchants/" + merchant).getBody()).path("rating");
    }
}
