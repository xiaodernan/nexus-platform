package com.nexus.notification;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
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

/**
 * The notification slice: generation from domain events (a lead when a thread opens, an
 * AI-could-not-answer handoff, a resolution back to the consumer), the in-app inbox with per-subject
 * visibility, and the channel preferences that gate out-of-band delivery.
 *
 * <p>The email/push providers here are the dev implementations, which report {@code live()==false};
 * the assertions therefore expect {@code status='failed'} on those rows. That is deliberate — a test
 * that passed because a fake provider said "sent" would be claiming delivery we do not have (D6).
 */
class NotificationApiTest extends NexusIntegrationTest {

    private static final String AI_TOKEN = "nexus-test-ai-internal-token-1234567890";

    private Tenant tenant;
    private UUID consumer;
    private UUID staff;
    private UUID merchant;

    @BeforeEach
    void seed() {
        tenant = newTenant("notif");
        consumer = newUser(tenant, "buyer" + tag(), "consumer");
        staff = newUser(tenant, "owner" + tag(), "consumer");
        merchant = newMerchant(tenant, "cafe-" + tag(), "published");
        staff(tenant, merchant, staff, "send_message");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    @Test
    @DisplayName("Opening a thread with a merchant generates a lead notification for that merchant")
    void leadNotificationIsGenerated() {
        createThread();
        JsonNode inbox = Json.tree(get(tenant, token(tenant, staff, "consumer"), "/api/v1/notifications").getBody());
        JsonNode lead = findTemplate(inbox, "lead_new", "in_app");
        assertThat(lead).isNotNull();
        assertThat(lead.path("audience").asText()).isEqualTo("merchant");
        assertThat(lead.path("merchant_id").asText()).isEqualTo(merchant.toString());
        assertThat(lead.path("payload").path("channel").asText()).isEqualTo("web");
        assertThat(lead.path("status").asText()).isEqualTo("sent");
        assertThat(inbox.path("unread_count").asLong()).isGreaterThan(0);

        // Email fan-out follows the staff member's own preference and address.
        JsonNode email = findTemplate(inbox, "lead_new", "email");
        assertThat(email).isNotNull();
        assertThat(email.path("status").asText()).isEqualTo("failed");
        assertThat(count("select count(*) from notifications where channel = 'email' and user_id = :u",
                Map.of("u", staff))).isEqualTo(1);
    }

    @Test
    @DisplayName("An AI-could-not-answer handoff notifies the merchant and the consumer")
    void handoffNotifiesBothSides() {
        UUID conversation = createThread();
        raiseHandoff(conversation);

        JsonNode merchantInbox = Json.tree(get(tenant, token(tenant, staff, "consumer"), "/api/v1/notifications")
                .getBody());
        JsonNode requested = findTemplate(merchantInbox, "handoff_requested", "in_app");
        assertThat(requested).isNotNull();
        assertThat(requested.path("payload").path("reason").asText()).isEqualTo("low_confidence");
        assertThat(requested.path("payload").path("handoff_id").asText()).isNotBlank();
        assertThat(requested.path("payload").path("conversation_id").asText()).isEqualTo(conversation.toString());

        JsonNode consumerInbox = Json.tree(get(tenant, token(tenant, consumer, "consumer"), "/api/v1/notifications")
                .getBody());
        assertThat(findTemplate(consumerInbox, "handoff_requested", "in_app")).isNotNull();
    }

    @Test
    @DisplayName("Resolving the handoff tells the consumer, through the same inbox route")
    void resolutionReachesConsumer() {
        UUID conversation = createThread();
        raiseHandoff(conversation);
        assertThat(post(tenant, token(tenant, staff, "consumer"),
                "/api/v1/conversations/" + conversation + "/handoff-resolve", Map.of("action", "resolved"))
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        JsonNode consumerInbox = Json.tree(get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications?unread=true").getBody());
        JsonNode resolved = findTemplate(consumerInbox, "handoff_resolved", "in_app");
        assertThat(resolved).isNotNull();
        assertThat(resolved.path("payload").path("title").asText()).contains("merchant team");

        String id = resolved.path("id").asText();
        ResponseEntity<String> read = post(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications/" + id + "/read", Map.of());
        assertThat(read.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(read.getBody()).path("read_at").asText()).isNotBlank();

        // A notification the caller cannot see is the same 404 as one that never existed (D5), and it is named:
        // "you may not read this" and "there is no such thing" would be two different repairs (D56).
        ResponseEntity<String> absent = post(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications/" + java.util.UUID.randomUUID() + "/read", Map.of());
        assertThat(absent.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(absent.getBody()).path("error").path("code").asText())
                .isEqualTo("notification_not_found");

        JsonNode after = Json.tree(get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications?unread=true").getBody());
        assertThat(findTemplate(after, "handoff_resolved", "in_app")).isNull();
        assertThat(count("select count(*) from notifications where id = :id and read_at is not null",
                Map.of("id", UUID.fromString(id)))).isEqualTo(1);
    }

    @Test
    @DisplayName("Channel preferences gate email delivery; unknown channels are a 422")
    void preferencesControlChannels() {
        assertThat(get(tenant, token(tenant, consumer, "consumer"), "/api/v1/notifications/preferences")
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode defaults = Json.tree(get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications/preferences").getBody());
        assertThat(defaults.path("email").asBoolean()).isTrue();
        assertThat(defaults.path("push").asBoolean()).isFalse();

        assertThat(put(tenant, token(tenant, consumer, "consumer"), "/api/v1/notifications/preferences",
                Map.of("email", "yes-please")).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(put(tenant, token(tenant, consumer, "consumer"), "/api/v1/notifications/preferences",
                Map.of("carrier_pigeon", true)).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        JsonNode updated = Json.tree(put(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications/preferences", Map.of("email", false, "push", false)).getBody());
        assertThat(updated.path("email").asBoolean()).isFalse();

        // Both subjects have email off from here on, so anything raised below is in-app only.
        assertThat(put(tenant, token(tenant, staff, "consumer"), "/api/v1/notifications/preferences",
                Map.of("email", false)).getStatusCode()).isEqualTo(HttpStatus.OK);
        raiseHandoff(createThread());
        assertThat(count("select count(*) from notifications where channel = 'email' and tenant_id = :t",
                Map.of("t", tenant.id()))).isZero();
        assertThat(count("select count(*) from notifications where channel = 'in_app' and user_id = :u",
                Map.of("u", consumer))).isEqualTo(1);
        // The declaration itself is persisted as declared-scope memory, not just echoed back.
        assertThat(count("select count(*) from user_preferences where user_id = :u and kind = 'notification_channel' "
                + "and source = 'declared'", Map.of("u", consumer))).isEqualTo(2);
    }

    @Test
    @DisplayName("Inbox routes are subject-scoped: anonymous is 401, another subject's row is 404")
    void inboxIsPrivate() {
        // The consumer's own row comes from the handoff notice: opening a thread notifies the merchant,
        // not the person who started it.
        raiseHandoff(createThread());
        assertThat(get(tenant, null, "/api/v1/notifications").getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        JsonNode mine = Json.tree(get(tenant, token(tenant, consumer, "consumer"), "/api/v1/notifications").getBody());
        String id = mine.path("items").get(0).path("id").asText();
        UUID otherUser = newUser(tenant, "nosy" + tag(), "consumer");
        assertThat(post(tenant, token(tenant, otherUser, "consumer"), "/api/v1/notifications/" + id + "/read",
                Map.of()).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get(tenant, token(tenant, otherUser, "consumer"), "/api/v1/notifications").getBody())
                .contains("\"items\":[]");
        Tenant elsewhere = newTenant("notif-b");
        UUID foreign = newUser(elsewhere, "foreign" + tag(), "consumer");
        staff(elsewhere, newMerchant(elsewhere, "rival-" + tag(), "published"), foreign, "send_message");
        assertThat(get(elsewhere, token(elsewhere, foreign, "consumer"), "/api/v1/notifications").getBody())
                .doesNotContain(id);
        assertThat(post(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications/" + UUID.randomUUID() + "/read", Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("read-all marks only the caller's visible rows")
    void readAllIsScoped() {
        raiseHandoff(createThread());
        long before = count("select count(*) from notifications where user_id = :u and read_at is null",
                Map.of("u", consumer));
        assertThat(before).isGreaterThan(0);
        ResponseEntity<String> res = post(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/notifications/read-all", Map.of());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(res.getBody()).path("marked_read").asLong()).isEqualTo(before);
        assertThat(count("select count(*) from notifications where user_id = :u and read_at is null",
                Map.of("u", consumer))).isZero();
        // A second call changes nothing (and is not an error).
        assertThat(post(tenant, token(tenant, consumer, "consumer"), "/api/v1/notifications/read-all", Map.of())
                .getBody()).contains("\"marked_read\":0");
    }

    // ---------------------------------------------------------------- helpers

    private UUID createThread() {
        ResponseEntity<String> res = post(tenant, token(tenant, consumer, "consumer"), "/api/v1/conversations",
                Map.of("merchant_id", merchant.toString(), "channel", "web", "mode", "ai"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString(Json.tree(res.getBody()).path("id").asText());
    }

    private void raiseHandoff(UUID conversation) {
        HttpHeaders headers = json(tenant, null);
        headers.set("X-Internal-Token", AI_TOKEN);
        ResponseEntity<String> res = http.exchange(url("/api/v1/internal/conversations/" + conversation
                        + "/agent-message"), HttpMethod.POST,
                new HttpEntity<>(Map.of("content", "I am not able to answer that confidently.",
                        "confidence", "0.19", "handoff", true, "handoff_reason", "low_confidence",
                        "evidence", Map.of("top_score", 0.11)), headers),
                String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    private static JsonNode findTemplate(JsonNode page, String template, String channel) {
        for (JsonNode item : page.path("items")) {
            if (template.equals(item.path("template").asText()) && channel.equals(item.path("channel").asText())) {
                return item;
            }
        }
        return null;
    }
}
