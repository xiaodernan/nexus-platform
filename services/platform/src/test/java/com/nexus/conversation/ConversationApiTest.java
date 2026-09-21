package com.nexus.conversation;

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
 * The conversation/handoff slice: consumer thread creation, the AI service's single audited write door,
 * the merchant inbox (with handoff evidence), human replies, handoff resolution, and the RBAC +
 * tenant-isolation boundaries around all of it.
 */
class ConversationApiTest extends NexusIntegrationTest {

    private static final String AI_TOKEN = "nexus-test-ai-internal-token-1234567890";

    private Tenant tenant;
    private Tenant other;
    private UUID consumer;
    private UUID merchant;
    private UUID staff;
    private UUID stranger;

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("conv");
        other = newTenant("conv-other");
        consumer = newUser(tenant, "shopper" + tag(), "consumer");
        staff = newUser(tenant, "manager" + tag(), "consumer");
        stranger = newUser(other, "other" + tag(), "consumer");
        merchant = newMerchant(tenant, "lung-yuen-" + tag(), "published");
        staff(tenant, merchant, staff, "send_message", "read_analytics");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- (b) open a thread

    @Test
    @DisplayName("POST /conversations opens a tenant-scoped thread and requires a subject")
    void opensThread() {
        ResponseEntity<String> anon = post(tenant, null, "/api/v1/conversations",
                Map.of("merchant_id", merchant.toString(), "channel", "web", "mode", "ai"));
        assertThat(anon.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        ResponseEntity<String> created = post(tenant, token(tenant, consumer, "consumer"), "/api/v1/conversations",
                Map.of("merchant_id", merchant.toString(), "channel", "web", "mode", "ai",
                        "subject", "Saturday table for two"));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode body = Json.tree(created.getBody());
        assertThat(body.path("id").asText()).isNotBlank();
        assertThat(body.path("merchant_id").asText()).isEqualTo(merchant.toString());
        assertThat(body.path("mode").asText()).isEqualTo("ai");
        assertThat(body.path("status").asText()).isEqualTo("open");
        assertThat(body.path("messages")).hasSize(1);
        assertThat(body.path("messages").get(0).path("sender_type").asText()).isEqualTo("system");

        long rows = count("select count(*) from conversations where tenant_id = :t", Map.of("t", tenant.id()));
        assertThat(rows).isEqualTo(1);
    }

    @Test
    @DisplayName("Unknown enums and blank content are 422, never silently defaulted")
    void validatesInput() {
        String jwt = token(tenant, consumer, "consumer");
        assertThat(post(tenant, jwt, "/api/v1/conversations", Map.of("channel", "telepathy")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, jwt, "/api/v1/conversations", Map.of("merchant_id", "not-a-uuid"))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        ResponseEntity<String> human = post(tenant, jwt, "/api/v1/conversations", Map.of("mode", "human"));
        assertThat(human.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(human.getBody()).contains("merchant_id");
        // A merchant in another tenant must read as absent, not forbidden.
        assertThat(post(tenant, jwt, "/api/v1/conversations", Map.of("merchant_id", UUID.randomUUID().toString()))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---------------------------------------------------------------- (e) the internal agent door

    @Test
    @DisplayName("The internal agent door refuses callers without the service token")
    void internalDoorNeedsServiceToken() {
        UUID conversation = openThread();
        Map<String, Object> message = Map.of("content", "The chef recommends the char siu.", "role", "assistant");

        ResponseEntity<String> missing = exchange(HttpMethod.POST, tenant, null,
                "/api/v1/internal/conversations/" + conversation + "/agent-message", message);
        assertThat(missing.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(missing.getBody()).contains("internal_token_missing");

        HttpHeaders headers = json(tenant, null);
        headers.set("X-Internal-Token", "guessed-token-value-0000000000");
        ResponseEntity<String> wrong = http.exchange(url("/api/v1/internal/conversations/" + conversation
                        + "/agent-message"), HttpMethod.POST, new HttpEntity<>(message, headers), String.class);
        assertThat(wrong.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(wrong.getBody()).contains("internal_token_invalid");

        // Nothing was written: the thread still holds only the system row that opening it produced.
        assertThat(count("select count(*) from messages where conversation_id = :c", Map.of("c", conversation)))
                .isEqualTo(1);
        assertThat(count("select count(*) from messages where conversation_id = :c and sender_type = 'ai_agent'",
                Map.of("c", conversation))).isZero();
    }

    @Test
    @DisplayName("An agent message with handoff=true opens a handoff carrying its evidence")
    void agentMessageRaisesHandoff() {
        UUID conversation = openThread();
        Map<String, Object> payload = Map.of(
                "content", "I could not confirm the private-room policy from the merchant's documents.",
                "sender_type", "ai_agent",
                "role", "assistant",
                "confidence", "0.31",
                "handoff", true,
                "handoff_reason", "low_confidence",
                "agent_run_id", UUID.randomUUID().toString(),
                "payload", Map.of("fact_ids", java.util.List.of(UUID.randomUUID().toString()), "sources", 2),
                "evidence", Map.of("retrieved_documents", 3, "top_score", 0.21));
        ResponseEntity<String> res = aiPost(conversation, payload);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("message_id").asText()).isNotBlank();
        assertThat(body.path("handoff_id").asText()).isNotBlank();

        Map<String, Object> conv = row("select status from conversations where id = :id", Map.of("id", conversation));
        assertThat(conv.get("status")).isEqualTo("handoff");
        Map<String, Object> msg = row("select sender_type, confidence, handoff, agent_run_id from messages "
                + "where conversation_id = :c and sender_type = 'ai_agent'", Map.of("c", conversation));
        assertThat(msg.get("sender_type")).isEqualTo("ai_agent");
        assertThat(String.valueOf(msg.get("confidence"))).isEqualTo("0.310");
        assertThat(msg.get("handoff")).isEqualTo(true);

        // The escalation is auditable end to end: one audit row naming the handoff.
        assertThat(count("select count(*) from audit_logs where action = 'conversation_agent_handoff' "
                + "and subject_id = :c", Map.of("c", conversation))).isEqualTo(1);
    }

    // ---------------------------------------------------------------- (a) merchant inbox + evidence

    @Test
    @DisplayName("Merchant inbox lists the thread and the handoff evidence that triggered it")
    void merchantInboxCarriesEvidence() {
        UUID conversation = openThread();
        aiPost(conversation, Map.of("content", "I cannot answer that with confidence.", "confidence", "0.28",
                "handoff", true, "handoff_reason", "low_confidence",
                "evidence", Map.of("retrieved_documents", 1, "top_score", 0.19),
                "payload", Map.of("fact_ids", java.util.List.of(UUID.randomUUID().toString()))));

        ResponseEntity<String> inbox = get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/conversations?merchant_id=" + merchant + "&status=handoff");
        assertThat(inbox.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(inbox.getBody());
        assertThat(page.path("items")).hasSize(1);
        JsonNode thread = page.path("items").get(0);
        assertThat(thread.path("id").asText()).isEqualTo(conversation.toString());
        assertThat(thread.path("status").asText()).isEqualTo("handoff");
        JsonNode handoff = thread.path("handoffs").get(0);
        assertThat(handoff.path("reason").asText()).isEqualTo("low_confidence");
        assertThat(handoff.path("status").asText()).isEqualTo("open");
        assertThat(handoff.path("evidence").path("retrieved_documents").asInt()).isEqualTo(1);
        assertThat(handoff.path("evidence").path("confidence").asText()).startsWith("0.28");
        assertThat(handoff.path("evidence").path("trigger_message_id").asText()).isNotBlank();
        assertThat(handoff.path("trigger").path("content").asText()).isEqualTo("I cannot answer that with confidence.");
        assertThat(handoff.path("trigger").path("confidence").asText()).startsWith("0.28");
        assertThat(handoff.path("trigger").path("agent_run_id").isNull()).isTrue();

        // Filtering by a merchant the caller is not staff of is a 403 + audit denial, never a listing.
        ResponseEntity<String> denied = get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/merchant/conversations?merchant_id=" + merchant);
        assertThat(denied.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' and actor_id = :u",
                Map.of("u", consumer))).isEqualTo(1);
        // Another tenant's merchant id does not exist here at all.
        assertThat(get(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/conversations?merchant_id=" + UUID.randomUUID()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---------------------------------------------------------------- (c) reply, (d) resolve

    @Test
    @DisplayName("A human merchant reply is stored as merchant_user and resolving closes the handoff")
    void replyAndResolve() {
        UUID conversation = openThread();
        aiPost(conversation, Map.of("content", "Uncertain answer, escalating.", "confidence", "0.22",
                "handoff", true, "handoff_reason", "user_request"));

        ResponseEntity<String> reply = post(tenant, token(tenant, staff, "consumer"),
                "/api/v1/conversations/" + conversation + "/reply", Map.of("content", "Yes, we have a quiet room."));
        assertThat(reply.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode replyBody = Json.tree(reply.getBody());
        assertThat(replyBody.path("mode").asText()).isEqualTo("hybrid");
        Map<String, Object> stored = row("select sender_type, role, content from messages where id = :id",
                Map.of("id", UUID.fromString(replyBody.path("message_id").asText())));
        assertThat(stored.get("sender_type")).isEqualTo("merchant_user");
        assertThat(stored.get("role")).isEqualTo("assistant");
        assertThat(stored.get("content")).isEqualTo("Yes, we have a quiet room.");

        // The consumer whose thread it is may not answer as merchant staff: same tenant, no grant, so
        // the honest answer is 403 (404 is reserved for resources outside the caller's tenant).
        assertThat(post(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/conversations/" + conversation + "/reply", Map.of("content", "mine")).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        // A staff member of a different tenant cannot reach it either (no enumeration).
        UUID otherMerchant = newMerchant(other, "other-mine-" + tag(), "published");
        staff(other, otherMerchant, stranger, "send_message");
        assertThat(post(other, token(other, stranger, "consumer"),
                "/api/v1/conversations/" + conversation + "/reply", Map.of("content", "cross")).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<String> resolved = post(tenant, token(tenant, staff, "consumer"),
                "/api/v1/merchant/conversations/" + conversation + "/handoff-resolve",
                Map.of("action", "resolved", "note", "Answered by phone."));
        assertThat(resolved.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(resolved.getBody()).path("status").asText()).isEqualTo("resolved");

        Map<String, Object> handoff = row("select status, resolved_at is not null as resolved from handoffs "
                + "where conversation_id = :c", Map.of("c", conversation));
        assertThat(handoff.get("status")).isEqualTo("resolved");
        assertThat(handoff.get("resolved")).isEqualTo(true);
        assertThat(row("select status from conversations where id = :id", Map.of("id", conversation)).get("status"))
                .isEqualTo("closed");

        // Resolving twice is a conflict, not a silent no-op.
        assertThat(post(tenant, token(tenant, staff, "consumer"),
                "/api/v1/conversations/" + conversation + "/handoff-resolve", Map.of("action", "resolved"))
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // The consumer can read their own thread and sees the resolution trail.
        JsonNode thread = Json.tree(get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/conversations/" + conversation).getBody());
        assertThat(thread.path("messages")).hasSize(4);
        assertThat(thread.path("can_reply").asBoolean()).isFalse();
        assertThat(thread.path("handoffs").get(0).path("status").asText()).isEqualTo("resolved");
    }

    @Test
    @DisplayName("Thread reads are limited to the owner, the merchant's staff, and platform roles")
    void threadReadAuthorization() {
        UUID conversation = openThread();
        String threadPath = "/api/v1/conversations/" + conversation;
        assertThat(get(tenant, token(tenant, consumer, "consumer"), threadPath).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(get(tenant, token(tenant, staff, "consumer"), threadPath).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(get(tenant, token(tenant, newUser(tenant, "random" + tag(), "consumer"), "consumer"), threadPath)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get(other, token(other, stranger, "consumer"), threadPath).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        UUID admin = newUser(tenant, "admin" + tag(), "platform_admin");
        assertThat(get(tenant, token(tenant, admin, "platform_admin"), threadPath).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        // Revoking the grant removes staff visibility of the thread too.
        revokeAll(merchant, staff, "send_message");
        assertThat(get(tenant, token(tenant, staff, "consumer"), threadPath).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("List endpoints clamp limit to 100 and return the cursor envelope")
    void paginationIsCapped() {
        for (int i = 0; i < 3; i++) {
            openThread();
        }
        JsonNode page = Json.tree(get(tenant, token(tenant, consumer, "consumer"),
                "/api/v1/conversations?limit=1000").getBody());
        assertThat(page.path("items").size()).isEqualTo(3);
        assertThat(page.path("next_cursor").isNull()).isTrue();
        assertThat(page.path("total_estimate").asLong()).isEqualTo(3);
        assertThat(get(tenant, token(tenant, consumer, "consumer"), "/api/v1/conversations?limit=0").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(get(tenant, token(tenant, consumer, "consumer"), "/api/v1/conversations?cursor=zzz")
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ---------------------------------------------------------------- helpers

    private UUID openThread() {
        ResponseEntity<String> res = post(tenant, token(tenant, consumer, "consumer"), "/api/v1/conversations",
                Map.of("merchant_id", merchant.toString(), "channel", "web", "mode", "ai"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString(Json.tree(res.getBody()).path("id").asText());
    }

    private ResponseEntity<String> aiPost(UUID conversation, Map<String, Object> body) {
        HttpHeaders headers = json(tenant, null);
        headers.set("X-Internal-Token", AI_TOKEN);
        return http.exchange(url("/api/v1/internal/conversations/" + conversation + "/agent-message"),
                HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
    }
}
