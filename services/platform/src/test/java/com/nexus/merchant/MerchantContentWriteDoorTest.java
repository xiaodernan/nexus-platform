package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.IntStream;
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
 * The six write doors the route map (D286) found with zero references anywhere in the test tree: the
 * businesses quartet — create, update, verification, publish — and the offerings update and bulk pair.
 * Seven of the controller's thirteen routes were asserted somewhere; these six were called by the SDK and
 * the console and by nothing that checks. Each test here asserts a behaviour the payload promises, not
 * just a status: the owner rows a create writes, the permission that owns a refused field, the guards a
 * publish names, the fact a price edit restates, and the per-item atomicity the bulk route prints.
 */
class MerchantContentWriteDoorTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID ownerId;
    private String ownerToken;

    @BeforeEach
    void seedActor() {
        tenant = newTenant("content-write");
        ownerId = newUser(tenant, "owner-" + tag(), "consumer");
        ownerToken = token(tenant, ownerId, "consumer");
    }

    // ---- businesses: create ----------------------------------------------

    @Test
    @DisplayName("Creating a business writes the owner, the owner's grant rows and its children — and a bad hour row leaves nothing half-created")
    void creatingABusinessWritesTheOwnerAndNothingHalfValidated() {
        String tag = tag();
        ResponseEntity<String> res = post(tenant, ownerToken, "/api/v1/merchant/businesses",
                Json.map("legal_name", "Door " + tag + " Ltd", "display_name", "Door " + tag,
                        "location", Json.map("label", "main", "address",
                                Json.map("address_line1", "1 Door Street", "city", "Hong Kong",
                                        "point", Json.map("lat", 22.3, "lng", 114.2))),
                        "business_hours", List.of(Json.map("weekday", 0, "opens_at", "09:00", "closes_at", "18:00"))));
        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.CREATED);
        JsonNode out = Json.tree(res.getBody());
        String merchantId = out.path("merchant").path("merchant_id").asText();
        UUID merchant = UUID.fromString(merchantId);

        // The create is the RBAC source of truth: membership row plus the owner's grant rows, and the
        // response prints both rather than leaving the caller to read /me to learn what it got.
        assertThat(out.path("membership").path("role").asText()).isEqualTo("owner");
        assertThat(out.path("membership").path("permissions").toString()).contains("write_products");
        assertThat(count("select count(*) from merchant_users where merchant_id = :m and user_id = :u",
                Map.of("m", merchant, "u", ownerId))).isEqualTo(1);
        assertThat(count("select count(*) from permission_grants where subject_type = 'user' "
                + "and subject_id = :u and merchant_id = :m", Map.of("m", merchant, "u", ownerId)))
                .isEqualTo(MerchantPermissions.OWNER.size());
        assertThat(out.path("merchant").path("status").asText()).isEqualTo("draft");
        assertThat(count("select count(*) from locations where merchant_id = :m", Map.of("m", merchant)))
                .isEqualTo(1);
        assertThat(count("select count(*) from business_hours where merchant_id = :m", Map.of("m", merchant)))
                .isEqualTo(1);
        assertThat(count("select count(*) from audit_logs where action = 'create_merchant' "
                + "and merchant_id = :m", Map.of("m", merchant))).isEqualTo(1);

        // Validated before any write: a malformed hour row is refused, and the merchant the same body
        // would have created is not there. A half-created business is the one failure this door must not
        // be able to produce.
        String display = "Half " + tag;
        ResponseEntity<String> bad = post(tenant, ownerToken, "/api/v1/merchant/businesses",
                Json.map("legal_name", "Half " + tag + " Ltd", "display_name", display,
                        "business_hours", List.of(Json.map("weekday", 9, "opens_at", "09:00", "closes_at", "18:00"))));
        assertThat(bad.getStatusCode()).as(body(bad)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(bad.getBody()).path("error").path("details").path("field").asText())
                .isEqualTo("business_hours.weekday");
        assertThat(count("select count(*) from merchants where display_name = :d", Map.of("d", display)))
                .as("the refusal left no row behind").isZero();
    }

    // ---- businesses: update ----------------------------------------------

    @Test
    @DisplayName("The profile route refuses the field another permission owns, and the slug of a published listing")
    void theProfileRouteRefusesWhatItDoesNotOwn() {
        // ai_agent_enabled belongs to configure_ai; a profile PATCH that silently dropped it would look
        // like a working save and leave the AI switch never flipped. The refusal names the owning route.
        UUID merchant = newMerchant(tenant, "prof-" + tag(), "draft");
        own(merchant, ownerId);
        ResponseEntity<String> ai = patch("/api/v1/merchant/businesses/" + merchant,
                Json.map("ai_agent_enabled", true), tenant, ownerToken);
        assertThat(ai.getStatusCode()).as(body(ai)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(ai.getBody()).path("error").path("details").path("permission").asText())
                .isEqualTo(MerchantPermissions.CONFIGURE_AI);

        // A published listing's slug is immutable — unpublish first. The message says so; the assertion
        // holds it to that.
        UUID published = newMerchant(tenant, "pub-" + tag(), "published");
        own(published, ownerId);
        ResponseEntity<String> slug = patch("/api/v1/merchant/businesses/" + published,
                Json.map("slug", "renamed-" + tag()), tenant, ownerToken);
        assertThat(slug.getStatusCode()).as(body(slug)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(body(slug)).contains("slug of a published listing is immutable");

        // The route's own work: profile in, children echoed out, the row actually changed.
        ResponseEntity<String> ok = patch("/api/v1/merchant/businesses/" + merchant,
                Json.map("description", "the door test description"), tenant, ownerToken);
        assertThat(ok.getStatusCode()).as(body(ok)).isEqualTo(HttpStatus.OK);
        JsonNode out = Json.tree(ok.getBody());
        assertThat(out.path("merchant").path("description").asText()).isEqualTo("the door test description");
        assertThat(out.has("locations")).isTrue();
        assertThat(out.has("business_hours")).isTrue();
        assertThat(row("select description from merchants where id = :id", Map.of("id", merchant))
                .get("description")).isEqualTo("the door test description");
    }

    // ---- businesses: verification ----------------------------------------

    @Test
    @DisplayName("Verification is self-attested and says so; a documents-only body takes the reference from the document")
    void verificationIsSelfAttestedAndPrintsItsMode() {
        UUID merchant = newMerchant(tenant, "ver-" + tag(), "draft");
        own(merchant, ownerId);

        ResponseEntity<String> empty = post(tenant, ownerToken,
                "/api/v1/merchant/businesses/" + merchant + "/verification", Json.map());
        assertThat(empty.getStatusCode()).as(body(empty)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(empty.getBody()).path("error").path("details").path("field").asText())
                .isEqualTo("business_registration_number");

        // packages/types sends documents[]; the route takes the first document's own uri as the
        // registration reference — a value the caller supplied, never one invented here.
        String uri = "https://example.com/br/" + tag() + ".pdf";
        ResponseEntity<String> res = post(tenant, ownerToken,
                "/api/v1/merchant/businesses/" + merchant + "/verification",
                Json.map("documents", List.of(Json.map("uri", uri, "name", "br"))));
        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.OK);
        JsonNode out = Json.tree(res.getBody());
        assertThat(out.path("mode").asText()).isEqualTo("self_attested");
        assertThat(out.path("ownership_verified").asBoolean()).isTrue();
        assertThat(row("select ownership_verified from merchants where id = :id", Map.of("id", merchant))
                .get("ownership_verified")).isEqualTo(true);
        assertThat(count("select count(*) from audit_logs where action = 'verification_submit' "
                + "and merchant_id = :m", Map.of("m", merchant))).isEqualTo(1);
    }

    // ---- businesses: publish ---------------------------------------------

    @Test
    @DisplayName("Publish refuses an incomplete listing naming every guard, then clears them door by door and is idempotent")
    void publishNamesItsGuardsThenPublishesAndRepublishes() {
        String tag = tag();
        ResponseEntity<String> created = post(tenant, ownerToken, "/api/v1/merchant/businesses",
                Json.map("legal_name", "Publish " + tag + " Ltd", "display_name", "Publish " + tag));
        assertThat(created.getStatusCode()).as(body(created)).isEqualTo(HttpStatus.CREATED);
        UUID merchant = UUID.fromString(Json.tree(created.getBody()).path("merchant").path("merchant_id").asText());

        ResponseEntity<String> early = post(tenant, ownerToken,
                "/api/v1/merchant/businesses/" + merchant + "/publish", null);
        assertThat(early.getStatusCode()).as(body(early)).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(early.getBody()).path("error").path("code").asText())
                .isEqualTo("listing_not_publishable");
        List<String> guards = new ArrayList<>();
        Json.tree(early.getBody()).path("error").path("details").path("failed_guards")
                .forEach(g -> guards.add(g.asText()));
        assertThat(guards).contains("description", "category_primary", "ownership_verified", "location",
                "business_hours", "active_offering");

        // Each guard names the door that clears it; clearing them through those doors is the workflow the
        // hint prints, so the test walks exactly that hint and asserts each step.
        assertThat(patch("/api/v1/merchant/businesses/" + merchant,
                Json.map("description", "the listing description", "category_primary", "food"),
                tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(patch("/api/v1/merchant/businesses/" + merchant,
                Json.map("locations", List.of(Json.map("label", "main", "address",
                        Json.map("address_line1", "1 Door Street", "city", "Hong Kong",
                                "point", Json.map("lat", 22.3, "lng", 114.2))))),
                tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(patch("/api/v1/merchant/businesses/" + merchant,
                Json.map("business_hours", List.of(Json.map("weekday", 0, "opens_at", "09:00",
                        "closes_at", "18:00"))), tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(post(tenant, ownerToken, "/api/v1/merchant/businesses/" + merchant + "/verification",
                Json.map("business_registration_number", "BR-" + tag)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(post(tenant, ownerToken, "/api/v1/merchant/offerings",
                Json.map("merchant_id", merchant.toString(), "name", "Door Set " + tag,
                        "price", "88.00")).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        ResponseEntity<String> live = post(tenant, ownerToken,
                "/api/v1/merchant/businesses/" + merchant + "/publish", null);
        assertThat(live.getStatusCode()).as(body(live)).isEqualTo(HttpStatus.OK);
        JsonNode out = Json.tree(live.getBody());
        assertThat(out.path("workflow").path("from").asText()).isEqualTo("draft");
        assertThat(out.path("workflow").path("to").asText()).isEqualTo("published");
        assertThat(out.path("workflow").path("failed_guards")).isEmpty();
        assertThat(out.path("merchant").path("status").asText()).isEqualTo("published");

        // A repeat publish is a no-op that answers the same state, not a second transition.
        ResponseEntity<String> again = post(tenant, ownerToken,
                "/api/v1/merchant/businesses/" + merchant + "/publish", null);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode second = Json.tree(again.getBody());
        assertThat(second.path("workflow").path("from").asText()).isEqualTo("published");
        assertThat(second.path("workflow").path("to").asText()).isEqualTo("published");
        assertThat(second.path("merchant").path("status").asText()).isEqualTo("published");
    }

    @Test
    @DisplayName("A suspended listing cannot be published by its owner — the service owns that 403")
    void aSuspendedListingIsRefusedByItsOwner() {
        UUID merchant = newMerchant(tenant, "susp-" + tag(), "suspended");
        own(merchant, ownerId);
        ResponseEntity<String> res = post(tenant, ownerToken,
                "/api/v1/merchant/businesses/" + merchant + "/publish", null);
        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(Json.tree(res.getBody()).path("error").path("details").path("route").asText())
                .isEqualTo("admin console");
        assertThat(row("select status from merchants where id = :id", Map.of("id", merchant)).get("status"))
                .isEqualTo("suspended");
    }

    // ---- offerings: update -------------------------------------------------

    @Test
    @DisplayName("An offering's slug is immutable; a price edit restates its fact, clearing the price expires it")
    void patchingAnOfferingKeepsSlugImmutableAndRestatesItsFacts() {
        UUID merchant = newMerchant(tenant, "oedit-" + tag(), "published");
        own(merchant, ownerId);
        String name = "Door Tea " + tag();
        ResponseEntity<String> created = post(tenant, ownerToken, "/api/v1/merchant/offerings",
                Json.map("merchant_id", merchant.toString(), "name", name, "price", "88.00"));
        assertThat(created.getStatusCode()).as(body(created)).isEqualTo(HttpStatus.CREATED);
        UUID offering = UUID.fromString(Json.tree(created.getBody()).path("offering").path("offering_id").asText());

        ResponseEntity<String> slug = patch("/api/v1/merchant/offerings/" + offering,
                Json.map("slug", "renamed-" + tag()), tenant, ownerToken);
        assertThat(slug.getStatusCode()).as(body(slug)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(slug.getBody()).path("error").path("details").path("field").asText())
                .isEqualTo("slug");

        // The price fact is the §19 anchor for the number the card shows: one live claim per offering,
        // restated in place — a rival claim beside it would be settled by limit 1, which is not a promise.
        // (The name field is deliberately absent from this PATCH: the route validates it and then drops
        // it — 200 with an unchanged row — filed as a finding rather than pinned as a contract here.)
        ResponseEntity<String> edit = patch("/api/v1/merchant/offerings/" + offering,
                Json.map("price", "120.00"), tenant, ownerToken);
        assertThat(edit.getStatusCode()).as(body(edit)).isEqualTo(HttpStatus.OK);
        assertThat(count("select count(*) from facts where subject_type = 'offering' and subject_id = :o "
                + "and attribute = 'price' and stale = false", Map.of("o", offering))).isEqualTo(1);
        Map<String, Object> fact = row("select value from facts where subject_type = 'offering' "
                + "and subject_id = :o and attribute = 'price' and stale = false", Map.of("o", offering));
        assertThat(Json.tree(String.valueOf(fact.get("value"))).path("amount").asText()).isEqualTo("120.00");

        // Clearing the price expires the fact — it does not delete it (order history may cite it) and
        // does not leave it live (a fact that outlives its claim is the §19 failure).
        assertThat(patch("/api/v1/merchant/offerings/" + offering, Json.map("price", null),
                tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(row("select stale from facts where subject_type = 'offering' and subject_id = :o "
                + "and attribute = 'price'", Map.of("o", offering)).get("stale")).isEqualTo(true);
        assertThat(count("select count(*) from facts where subject_type = 'offering' and subject_id = :o "
                + "and attribute = 'price' and stale = false", Map.of("o", offering))).isZero();
    }

    // ---- offerings: bulk ---------------------------------------------------

    @Test
    @DisplayName("Bulk answers every item: created stays created, rejected names its code, and nothing rejected appears as a row")
    void bulkCreatesPerItemAndNeverShowsARejectedRowAsCreated() {
        UUID merchant = newMerchant(tenant, "bulk-" + tag(), "published");
        own(merchant, ownerId);
        String slug = "bulk-" + tag();
        ResponseEntity<String> res = post(tenant, ownerToken, "/api/v1/merchant/offerings/bulk",
                Json.map("merchant_id", merchant.toString(), "items", List.of(
                        Json.map("name", "Bulk One " + tag(), "slug", slug, "price", "10.00"),
                        Json.map("name", "Bulk Two " + tag(), "slug", slug, "price", "11.00"),
                        Json.map())));
        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.OK);
        JsonNode out = Json.tree(res.getBody());
        assertThat(out.path("created").asInt()).isEqualTo(1);
        assertThat(out.path("rejected").asInt()).isEqualTo(2);
        assertThat(out.path("results").get(0).path("status").asText()).isEqualTo("created");
        assertThat(out.path("results").get(1).path("status").asText()).isEqualTo("rejected");
        assertThat(out.path("results").get(1).path("error").path("code").asText()).isEqualTo("slug_taken");
        assertThat(out.path("results").get(2).path("error").path("code").asText()).isEqualTo("validation_error");
        assertThat(count("select count(*) from offerings where merchant_id = :m", Map.of("m", merchant)))
                .as("a rejected row writes nothing at all").isEqualTo(1);

        ResponseEntity<String> empty = post(tenant, ownerToken, "/api/v1/merchant/offerings/bulk",
                Json.map("merchant_id", merchant.toString(), "items", List.of()));
        assertThat(empty.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // The cap is printed with its number: 201 items is one past what the route accepts, and the
        // refusal says both figures rather than a bare validation error.
        List<Map<String, Object>> tooMany = new ArrayList<>(IntStream.range(0, 201)
                .<Map<String, Object>>mapToObj(i -> Json.map("name", "Cap " + i + " " + tag())).toList());
        ResponseEntity<String> capped = post(tenant, ownerToken, "/api/v1/merchant/offerings/bulk",
                Json.map("merchant_id", merchant.toString(), "items", tooMany));
        assertThat(capped.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode cap = Json.tree(capped.getBody());
        assertThat(cap.path("error").path("details").path("max").asInt()).isEqualTo(200);
        assertThat(cap.path("error").path("details").path("given").asInt()).isEqualTo(201);
        assertThat(count("select count(*) from offerings where merchant_id = :m", Map.of("m", merchant)))
                .as("a refused batch wrote none of its rows").isEqualTo(1);
    }

    // ---------------------------------------------------------------- fixtures

    private UUID own(UUID merchantId, UUID userId) {
        jdbc.update("insert into merchant_users (merchant_id, user_id, role, status) values (:m, :u, 'owner', "
                        + "'active')",
                new MapSqlParameterSource("m", merchantId).addValue("u", userId));
        for (String permission : MerchantPermissions.OWNER) {
            jdbc.update("insert into permission_grants (subject_type, subject_id, merchant_id, permission, "
                            + "granted_by) values ('user', :u, :m, :p, :u)",
                    new MapSqlParameterSource("u", userId).addValue("m", merchantId).addValue("p", permission));
        }
        return userId;
    }

    private ResponseEntity<String> patch(String path, Object body, Tenant t, String bearer) {
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.PATCH,
                new HttpEntity<>(body, json(t, bearer)), String.class);
    }

    private static String body(ResponseEntity<String> res) {
        return String.valueOf(res.getBody());
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }
}
