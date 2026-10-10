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
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The §23 merchant console over HTTP: the booking inbox (§5 {@code GET /api/v1/merchant/reservations}),
 * the §107 export, and what a soft-deleted offering leaves behind in the audit trail.
 *
 * <p>The inbox is the one screen in this project whose whole job is <em>somebody's evening</em>, so the
 * properties pinned here are the ones a form handler gets wrong: a booking appears because a real person
 * made it (the write path and the read path are the same test, so neither can pass on seeded rows), the
 * page is ordered by when the guest arrives rather than by whatever the client asked for, a filter that
 * cannot match is refused instead of quietly returning nothing, and the merchant sees the phone number it
 * needs without ever seeing the platform's own user id.
 */
class MerchantConsoleTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID merchant;
    private UUID booker;
    private UUID manager;
    private String bookerToken;
    private String staffToken;

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("console");
        merchant = newMerchant(tenant, "inbox-" + tag(), "published");
        newLocation(tenant, merchant, 22.28, 114.15, "Sheung Wan");
        booker = newUser(tenant, "booker" + tag(), "consumer");
        bookerToken = token(tenant, booker, "consumer");
        manager = newUser(tenant, "manager" + tag(), "consumer");
        staff(tenant, merchant, manager, "read_orders", "read_products", "write_products");
        staffToken = token(tenant, manager, "consumer");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
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

    /** A booking through the consumer route, because that is where an inbox row comes from. */
    private JsonNode book(UUID slotId, int partySize, String phone) {
        ResponseEntity<String> res = post(tenant, bookerToken, "/api/v1/reservations", Map.of(
                "merchant_id", merchant.toString(), "slot_id", slotId.toString(), "party_size", partySize,
                "contact", Map.of("name", "Ada Lau", "phone", phone), "notes", "One high chair, please"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return Json.tree(res.getBody());
    }

    private ResponseEntity<String> inbox(String query) {
        return get(tenant, staffToken, "/api/v1/merchant/reservations?" + query);
    }

    // ------------------------------------------------------------------ the booking inbox (§23)

    @Test
    @DisplayName("A booking the consumer route took appears in the merchant's inbox — with a phone, not a user id")
    void inboxReadsTheBookingThatWasMade() {
        UUID slotId = slot(Instant.now().plusSeconds(7_200), 6);
        JsonNode booking = book(slotId, 3, "2345 6789");

        ResponseEntity<String> res = inbox("merchant_id=" + merchant);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(res.getBody());
        assertThat(page.path("items")).hasSize(1);
        JsonNode item = page.path("items").get(0);
        assertThat(item.path("reservation_id").asText()).isEqualTo(booking.path("reservation_id").asText());
        assertThat(item.path("code").asText()).isEqualTo(booking.path("code").asText());
        assertThat(item.path("status").asText()).isEqualTo("pending");
        assertThat(item.path("source").asText()).isEqualTo("consumer");
        assertThat(item.path("party_size").asInt()).isEqualTo(3);
        // The slot's price is the booking's price: 180.00 for the table, not 180.00 x party, and never a
        // number the client sent.
        assertThat(item.path("price").path("amount").asText()).isEqualTo("180.00");
        assertThat(item.path("contact").path("phone").asText()).isEqualTo("2345 6789");
        assertThat(item.path("notes").asText()).isEqualTo("One high chair, please");
        assertThat(item.path("slot_id").asText()).isEqualTo(slotId.toString());

        // Read the whole body, not one field: the inbox's guest-facing keys stop at the contact the merchant
        // was given. Our own subject id must not appear anywhere on the screen.
        assertThat(res.getBody()).doesNotContain(booker.toString());
        assertThat(item.has("user_id")).isFalse();

        assertThat(page.path("total_estimate").asLong()).isEqualTo(1);
        assertThat(page.path("next_cursor").isNull()).isTrue();
        assertThat(page.path("sort").asText()).isEqualTo("starts_at asc");
        assertThat(page.path("filters").path("status").isNull()).isTrue();
        // D26 built the accept route and rewrote this sentence with it — the old text ("this route never
        // moves a booking into it") was the honesty of the era before the route existed. The assertion
        // keeps its point: the payload defines the state by naming what moves a booking into it.
        assertThat(page.path("definitions").path("confirmed").asText()).contains("moves a booking here");
    }

    @Test
    @DisplayName("An inbox with no bookings is reported as empty, and says why nothing is seeded")
    void inboxIsEmptyUntilSomeoneBooks() {
        JsonNode page = Json.tree(inbox("merchant_id=" + merchant).getBody());
        assertThat(page.path("items")).isEmpty();
        assertThat(page.path("total_estimate").asLong()).isZero();
        assertThat(page.path("notice").asText()).contains("no reservations are seeded");
    }

    @Test
    @DisplayName("The page is ordered by arrival, and the status filter can separate a hold from an acceptance")
    void inboxOrdersByArrivalAndFiltersStatus() {
        UUID later = slot(Instant.now().plusSeconds(86_400), 4);
        UUID sooner = slot(Instant.now().plusSeconds(3_600), 4);
        book(sooner, 2, "1111 1111");
        book(later, 2, "2222 2222");
        // Acceptance is the merchant's act and no route here performs it (D26), so this is how a
        // 'confirmed' row can exist at all: somebody who owns the booking system wrote it.
        jdbc.update("update reservations set status = 'confirmed' where slot_id = :s",
                new MapSqlParameterSource("s", sooner));

        JsonNode all = Json.tree(inbox("merchant_id=" + merchant).getBody());
        assertThat(all.path("items").get(0).path("slot_id").asText()).isEqualTo(sooner.toString());
        assertThat(all.path("items").get(1).path("slot_id").asText()).isEqualTo(later.toString());

        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&status=confirmed").getBody()).path("items"))
                .hasSize(1);
        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&status=pending").getBody()).path("items"))
                .hasSize(1);
        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&status=cancelled").getBody()).path("items"))
                .isEmpty();
        // A status the column cannot hold is a complaint, not an empty page: silence here would look like
        // a quiet week.
        assertThat(inbox("merchant_id=" + merchant + "&status=maybe").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    @Test
    @DisplayName("from/to bound the arrival window half-open, and a window that cannot match is refused")
    void inboxWindowIsHalfOpenAndValidated() {
        Instant starts = Instant.now().plusSeconds(7_200);
        book(slot(starts, 4), 2, "3333 3333");

        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&from=" + starts.minusSeconds(60)).getBody())
                .path("items")).hasSize(1);
        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&from=" + starts.plusSeconds(60)).getBody())
                .path("items")).isEmpty();
        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&to=" + starts.plusSeconds(60)).getBody())
                .path("items")).hasSize(1);
        assertThat(Json.tree(inbox("merchant_id=" + merchant + "&to=" + starts.minusSeconds(60)).getBody())
                .path("items")).isEmpty();

        assertThat(inbox("merchant_id=" + merchant + "&from=" + starts.plusSeconds(600) + "&to=" + starts)
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(inbox("merchant_id=" + merchant + "&from=yesterday").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(inbox("merchant_id=" + merchant + "&from=" + starts).getBody())
                .contains("\"from\":\"" + starts.toString() + "\"");
    }

    @Test
    @DisplayName("read_orders is what stands between a stranger and the guest list, and the denial is audited")
    void inboxRequiresReadOrders() {
        book(slot(Instant.now().plusSeconds(3_600), 4), 2, "4444 4444");

        UUID nosy = newUser(tenant, "nosy" + tag(), "consumer");
        assertThat(get(tenant, token(tenant, nosy, "consumer"), "/api/v1/merchant/reservations?merchant_id="
                + merchant).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' "
                        + "and merchant_id = :m and tenant_id = :t",
                Map.of("m", merchant, "t", tenant.id()))).isEqualTo(1);

        assertThat(get(tenant, null, "/api/v1/merchant/reservations?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(inbox("").getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(inbox("merchant_id=not-a-uuid").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // Another tenant's merchant is absent, not forbidden — the route must not confirm that a workspace
        // exists on the other side of the boundary.
        Tenant other = newTenant("console-other");
        UUID theirs = newMerchant(other, "elsewhere-" + tag(), "published");
        assertThat(inbox("merchant_id=" + theirs).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // The holder of the booking can read it, and still cannot see the inbox: two different grants, and
        // a consumer token has neither of the second kind.
        assertThat(get(tenant, bookerToken, "/api/v1/merchant/reservations?merchant_id=" + merchant)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    @DisplayName("The cursor walks the inbox by arrival without double-counting or dropping a booking")
    void inboxPaginates() {
        for (int i = 1; i <= 3; i++) {
            book(slot(Instant.now().plusSeconds(3_600L * i), 4), 2, "0000 000" + i);
        }
        JsonNode first = Json.tree(inbox("merchant_id=" + merchant + "&limit=2").getBody());
        assertThat(first.path("items")).hasSize(2);
        assertThat(first.path("total_estimate").asLong()).isEqualTo(3);
        String cursor = first.path("next_cursor").asText();

        JsonNode second = Json.tree(inbox("merchant_id=" + merchant + "&limit=2&cursor=" + cursor).getBody());
        assertThat(second.path("items")).hasSize(1);
        assertThat(second.path("next_cursor").isNull()).isTrue();
        assertThat(second.path("items").get(0).path("contact").path("phone").asText()).isEqualTo("0000 0003");
        assertThat(second.path("total_estimate").asLong()).isEqualTo(3);

        assertThat(inbox("merchant_id=" + merchant + "&cursor=not-a-cursor").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ------------------------------------------------------------------ export (§107) + soft delete

    @Test
    @DisplayName("A merchant export carries this workspace's rows and says what it deliberately leaves out")
    void exportIsTheMerchantsOwnRows() {
        UUID sibling = newMerchant(tenant, "sibling-" + tag(), "published");
        staff(tenant, sibling, manager, "write_products");
        String mine = createOffering(merchant, "Cold Brew").path("name").asText();
        String theirs = createOffering(sibling, "Filter Coffee").path("name").asText();

        JsonNode bundle = Json.tree(get(tenant, staffToken,
                "/api/v1/merchant/export?merchant_id=" + merchant).getBody());
        assertThat(bundle.path("merchant_id").asText()).isEqualTo(merchant.toString());
        assertThat(bundle.path("owner").asText()).isEqualTo("merchant");
        assertThat(bundle.path("offerings")).hasSize(1);
        assertThat(bundle.path("offerings").get(0).path("name").asText()).isEqualTo(mine);
        assertThat(bundle.path("offerings").get(0).path("name").asText()).isNotEqualTo(theirs);
        assertThat(bundle.path("offerings_total").asLong()).isEqualTo(1);
        assertThat(bundle.path("notice").asText()).contains("consumer-side personal data");
    }

    @Test
    @DisplayName("Archiving an offering records the status it replaced, against the merchant that owns it")
    void archiveAuditsWhatItReplaced() {
        JsonNode offering = createOffering(merchant, "Pastry");
        String offeringId = offering.path("offering_id").asText();
        assertThat(offering.path("status").asText()).isEqualTo("active");

        assertThat(exchange(HttpMethod.DELETE, tenant, staffToken,
                "/api/v1/merchant/offerings/" + offeringId, null).getStatusCode()).isEqualTo(HttpStatus.OK);

        // The point of a before-image is the difference it shows. Read after the update, both sides would
        // say 'archived' and the audit row would document nothing — so `before` is asserted, not assumed.
        assertThat(count("select count(*) from audit_logs where action = 'archive_offering' "
                        + "and subject_id = cast(:id as uuid) and merchant_id = :m "
                        + "and before ->> 'status' = 'active' and after ->> 'status' = 'archived' "
                        + "and metadata ->> 'source' = 'merchant_workspace'",
                Map.of("id", offeringId, "m", merchant))).isEqualTo(1);
        assertThat(row("select status from offerings where id = cast(:id as uuid)", Map.of("id", offeringId))
                .get("status")).isEqualTo("archived");
        // Archived, not destroyed: the row an order history points at still exists.
        assertThat(count("select count(*) from offerings where id = cast(:id as uuid)",
                Map.of("id", offeringId))).isEqualTo(1);
    }

    @Test
    @DisplayName("One payload, two framings: a streamed body authorises and parses like a length-declared one")
    void bodyFramingDoesNotDecideWhetherTheRequestWorks() {
        // The bug this pins: with no `Content-Length` the body was never cached, the `body:merchant_id`
        // permission read consumed it to EOF, and the controller answered 422 "Request could not be
        // parsed" for valid JSON. A Map body goes through the Jackson converter, which streams the body
        // without declaring its length; a String body declares it. Those two framings must not disagree —
        // chunked is what an SDK that streams produces, and the client did nothing wrong.
        String name = "Framing " + tag();
        ResponseEntity<String> streamed = post(tenant, staffToken, "/api/v1/merchant/offerings",
                Map.of("merchant_id", merchant.toString(), "name", name, "price_amount", "24.00"));
        ResponseEntity<String> declared = exchangeWithLength("{\"merchant_id\":\"" + merchant
                + "\",\"name\":\"" + name + " b\",\"price_amount\":\"24.00\"}");

        assertThat(streamed.getStatusCode()).withFailMessage("streamed body said: " + streamed.getBody())
                .isEqualTo(HttpStatus.CREATED);
        assertThat(declared.getStatusCode()).withFailMessage("length-declared body said: " + declared.getBody())
                .isEqualTo(HttpStatus.CREATED);
        assertThat(Json.tree(streamed.getBody()).path("offering").path("merchant_id").asText())
                .isEqualTo(merchant.toString());
    }

    @Test
    @DisplayName("A body over the read cap is refused with its limit, not with a fake parse error")
    void oversizedBodyStatesTheLimit() {
        // Chunked and over the cap: the filter must stop reading and say where the line is. The old
        // behaviour was to stream it through, let the permission read eat it, and blame the client's JSON.
        ResponseEntity<String> streamed = post(tenant, staffToken, "/api/v1/merchant/offerings",
                Map.of("merchant_id", merchant.toString(), "name", "x".repeat(300 * 1024)));
        assertThat(streamed.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(streamed.getBody()).contains("request_body_too_large").contains("262144");

        ResponseEntity<String> declared = exchangeWithLength("{\"merchant_id\":\"" + merchant + "\",\"name\":\""
                + "y".repeat(300 * 1024) + "\"}");
        assertThat(declared.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(declared.getBody()).contains("request_body_too_large");
    }

    /** A JSON body with an explicit {@code Content-Length}, which is what makes it a different framing. */
    private ResponseEntity<String> exchangeWithLength(String json) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setContentLength(json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        headers.set("X-Tenant", tenant.slug());
        headers.setBearerAuth(staffToken);
        return http.exchange(java.net.URI.create(url("/api/v1/merchant/offerings")), HttpMethod.POST,
                new org.springframework.http.HttpEntity<>(json, headers), String.class);
    }

    /** A product written through the §5 workspace surface, returning its `offering` view. */
    private JsonNode createOffering(UUID forMerchant, String name) {
        ResponseEntity<String> res = post(tenant, staffToken, "/api/v1/merchant/offerings",
                Map.of("merchant_id", forMerchant.toString(), "name", name + " " + tag(),
                        "price_amount", "24.00"));
        // The envelope is quoted in the failure: a 422 without its message is a puzzle, not a report.
        assertThat(res.getStatusCode()).withFailMessage("offerings said: " + res.getBody())
                .isEqualTo(HttpStatus.CREATED);
        return Json.tree(res.getBody()).path("offering");
    }
}
