package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The §27 campaign surface over HTTP, witnessed end-to-end through its own doors — the coverage the
 * adoption of {@code MerchantCampaignController} needs, because the pair ships with no test of its own.
 *
 * <p>The pinned property is who may say "live": a draft is written by the literal this route writes (a
 * request carrying {@code status:"live"} is refused, not ignored), only {@code approve-publish} moves a
 * campaign out of {@code draft}, and that move is a named human's act — stamped once, idempotent on a
 * second call, {@code scheduled} rather than {@code live} when the start is still ahead, and carried
 * together with the coupons it advertises, so a live campaign never advertises a draft offer.
 */
class MerchantCampaignDoorTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID merchant;
    private UUID manager;
    private UUID drafter;
    private UUID booker;
    private String staffToken;
    private String bookerToken;
    private Instant pastStart;
    private Instant futureStart;
    private Instant farEnd;

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("campaign");
        merchant = newMerchant(tenant, "cp-" + tag(), "published");
        manager = newUser(tenant, "manager" + tag(), "consumer");
        staff(tenant, merchant, manager, "create_draft_campaign", "publish_campaign");
        staffToken = token(tenant, manager, "consumer");
        drafter = newUser(tenant, "drafter" + tag(), "consumer");
        staff(tenant, merchant, drafter, "create_draft_campaign");
        booker = newUser(tenant, "booker" + tag(), "consumer");
        bookerToken = token(tenant, booker, "consumer");
        pastStart = Instant.now().minusSeconds(86_400);
        futureStart = Instant.now().plusSeconds(7 * 86_400);
        farEnd = Instant.now().plusSeconds(30 * 86_400);
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    /** A draft coupon through its own door, with a code unique to this call. */
    private JsonNode coupon(String code) {
        ResponseEntity<String> res = post(tenant, staffToken, "/api/v1/merchant/coupons",
                Json.map("merchant_id", merchant.toString(), "code", code, "kind", "percent",
                        "value", 10, "starts_at", pastStart.toString(), "ends_at", farEnd.toString()));
        assertThat(res.getStatusCode()).as(res.getBody()).isEqualTo(HttpStatus.CREATED);
        return Json.tree(res.getBody()).path("coupon");
    }

    private JsonNode campaign(String title, List<String> couponIds, Instant startsAt) {
        Map<String, Object> body = Json.map("merchant_id", merchant.toString(), "title", title,
                "channel", List.of("email", "push"));
        if (couponIds != null) {
            body.put("coupon_ids", couponIds);
        }
        if (startsAt != null) {
            body.put("starts_at", startsAt.toString());
        }
        ResponseEntity<String> res = post(tenant, staffToken, "/api/v1/merchant/campaigns", body);
        assertThat(res.getStatusCode()).as(res.getBody()).isEqualTo(HttpStatus.CREATED);
        return Json.tree(res.getBody()).path("campaign");
    }

    @Test
    @DisplayName("A draft publishes only through approve-publish, once, carrying its coupons out of draft")
    void aDraftPublishesOnlyThroughTheHumanDoor() {
        JsonNode coupon = coupon("SAVE10");
        assertThat(coupon.path("status").asText()).isEqualTo("draft");
        assertThat(coupon.path("published_at").isNull()).isTrue();

        JsonNode campaign = campaign("October set-menu push", List.of(coupon.path("coupon_id").asText()), null);
        assertThat(campaign.path("status").asText()).isEqualTo("draft");
        assertThat(campaign.path("generated_by").asText()).isEqualTo("human");

        // The human act: approved to run is stamped once, and the coupon the campaign advertises leaves
        // draft with it — a live campaign never advertises a draft offer.
        ResponseEntity<String> publish = post(tenant, staffToken,
                "/api/v1/merchant/campaigns/" + campaign.path("campaign_id").asText() + "/approve-publish",
                Map.of());
        assertThat(publish.getStatusCode()).as(publish.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode done = Json.tree(publish.getBody());
        assertThat(done.path("changed").asBoolean()).isTrue();
        assertThat(done.path("campaign").path("status").asText()).isEqualTo("live");
        assertThat(done.path("campaign").path("approved_by").asText()).isEqualTo(manager.toString());
        assertThat(done.path("coupons_published").asInt()).isEqualTo(1);
        assertThat(row("select status from coupons where id = cast(:id as uuid)",
                Map.of("id", UUID.fromString(coupon.path("coupon_id").asText())))
                .get("status")).isEqualTo("active");

        // A double-click does not rewrite when the decision was made.
        ResponseEntity<String> second = post(tenant, staffToken,
                "/api/v1/merchant/campaigns/" + campaign.path("campaign_id").asText() + "/approve-publish",
                Map.of());
        JsonNode again = Json.tree(second.getBody());
        assertThat(again.path("changed").asBoolean()).isFalse();
        assertThat(again.path("previous_status").asText()).isEqualTo("live");
        assertThat(again.path("coupons_published").asInt()).isZero();

        // Approved to run is not the same claim as running: a future start is scheduled, not live.
        JsonNode later = campaign("Next month", List.of(), futureStart);
        ResponseEntity<String> sched = post(tenant, staffToken,
                "/api/v1/merchant/campaigns/" + later.path("campaign_id").asText() + "/approve-publish",
                Map.of());
        assertThat(Json.tree(sched.getBody()).path("campaign").path("status").asText())
                .isEqualTo("scheduled");

        assertThat(count("select count(*) from audit_logs where action = 'publish_campaign' "
                + "and merchant_id = :m", Map.of("m", merchant))).isEqualTo(2);
        assertThat(count("select count(*) from audit_logs where action = 'create_draft_campaign' "
                + "and merchant_id = :m", Map.of("m", merchant))).isEqualTo(3);
    }

    @Test
    @DisplayName("A caller cannot claim live, advertise a stranger's coupon, or take a taken code")
    void theRefusalTableIsARefusal() {
        coupon("TAKE-01");
        assertThat(post(tenant, staffToken, "/api/v1/merchant/coupons",
                Json.map("merchant_id", merchant.toString(), "code", "TAKE-01", "kind", "percent",
                        "value", 10, "starts_at", pastStart.toString(), "ends_at", farEnd.toString()))
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(post(tenant, staffToken, "/api/v1/merchant/coupons",
                Json.map("merchant_id", merchant.toString(), "code", "PCT150", "kind", "percent",
                        "value", 150, "starts_at", pastStart.toString(), "ends_at", farEnd.toString()))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, staffToken, "/api/v1/merchant/coupons",
                Json.map("merchant_id", merchant.toString(), "code", "BACKWARDS", "kind", "percent",
                        "value", 10, "starts_at", farEnd.toString(), "ends_at", pastStart.toString()))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A status field in the request is a complaint, not a quiet overwrite: the route writes the
        // literal that makes a row a draft.
        assertThat(post(tenant, staffToken, "/api/v1/merchant/campaigns",
                Json.map("merchant_id", merchant.toString(), "title", "Pretend live", "status", "live"))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A campaign cannot advertise a stranger's offer: the coupon is resolved to this merchant
        // before anything is written, so a coupon the other merchant owns is a 422 naming the field.
        Tenant other = newTenant("campaign-other");
        UUID theirs = newMerchant(other, "elsewhere-" + tag(), "published");
        UUID otherOwner = newUser(other, "owner-" + tag(), "consumer");
        staff(other, theirs, otherOwner, "create_draft_campaign");
        String otherToken = token(other, otherOwner, "consumer");
        ResponseEntity<String> theirCoupon = post(other, otherToken, "/api/v1/merchant/coupons",
                Json.map("merchant_id", theirs.toString(), "code", "THEIRS1", "kind", "percent",
                        "value", 5, "starts_at", pastStart.toString(), "ends_at", farEnd.toString()));
        assertThat(theirCoupon.getStatusCode()).as(theirCoupon.getBody()).isEqualTo(HttpStatus.CREATED);
        String foreignCouponId = Json.tree(theirCoupon.getBody()).path("coupon").path("coupon_id").asText();
        // The repository's own rule (D5): a coupon this merchant does not own is the same 404 the workspace
        // gives for anything it does not own. The controller's comment promises a 422 naming the field; the
        // code 404s with coupon_not_found, and this test pins the code, because the code is what answers.
        ResponseEntity<String> strangerOffer = post(tenant, staffToken, "/api/v1/merchant/campaigns",
                Json.map("merchant_id", merchant.toString(), "title", "Borrowed offer",
                        "coupon_ids", List.of(foreignCouponId)));
        assertThat(strangerOffer.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(strangerOffer.getBody()).path("error").path("code").asText())
                .isEqualTo("coupon_not_found");

        // The cross-tenant read: another merchant's campaign id is absent, not forbidden.
        assertThat(post(tenant, staffToken, "/api/v1/merchant/campaigns/"
                + UUID.randomUUID() + "/approve-publish", Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(post(tenant, null, "/api/v1/merchant/coupons", Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // Three grants, three denials, all audited: create on both doors for a caller with neither, and
        // publish for the drafter who may write drafts but not publish them. The bodies carry a valid
        // merchant_id — the grant check runs after the resolver, and a body it cannot resolve is a 422
        // before permission is even considered.
        assertThat(post(tenant, bookerToken, "/api/v1/merchant/coupons",
                Json.map("merchant_id", merchant.toString())).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(post(tenant, bookerToken, "/api/v1/merchant/campaigns",
                Json.map("merchant_id", merchant.toString())).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        String drafterToken = token(tenant, drafter, "consumer");
        JsonNode draft = campaign("Drafter's own", List.of(), pastStart);
        assertThat(post(tenant, drafterToken,
                "/api/v1/merchant/campaigns/" + draft.path("campaign_id").asText() + "/approve-publish",
                Map.of()).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(3);
    }
}
