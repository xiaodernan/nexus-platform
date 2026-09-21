package com.nexus.conversation;

import com.nexus.notification.event.DomainEvents;
import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

/**
 * Read paths for conversations / messages / handoffs, plus the two write doors the platform owns.
 *
 * <p>Write ownership (STATUS.md ruling D12 — the AI service is the only writer of agent-path
 * dialogue), stated once here and in {@code package-info.java}:
 * <ul>
 *   <li>{@code ai_agent} messages, {@code user} turns the agent relays, and the agent-raised
 *       {@code handoffs} rows: written only through {@link #agentMessage}, the token-guarded and
 *       audited internal door.</li>
 *   <li>{@code merchant_user} messages: {@link #merchantReply}, for a human staff member whose
 *       {@code send_message} grant the {@code @RequiresPermission} interceptor already verified.</li>
 *   <li>{@code system} messages: only for state transitions this service really performs (thread
 *       opened, handoff resolved) — never to fake an answer.</li>
 *   <li>There is deliberately no {@code POST /conversations/{id}/message} for consumers: their turns
 *       arrive with the dialogue the AI service persists.</li>
 * </ul>
 *
 * <p>Tenant isolation lives in {@link ConversationRepository} (every statement predicates on
 * {@code tenant_id}); subject-level access (thread owner, merchant staff, platform role) is layered
 * on top here. A resource the caller may not see answers 404, never 403 (DECISIONS D5).
 */
@Service
public class ConversationService {

    public static final Set<String> CHANNELS = Set.of("web", "mcp", "ucp", "whatsapp", "email");
    public static final Set<String> MODES = Set.of("ai", "human", "hybrid");
    public static final Set<String> HANDOFF_REASONS = Set.of("low_confidence", "user_request", "policy", "refund");
    public static final Set<String> THREAD_STATUSES = Set.of("open", "handoff", "closed", "archived");
    private static final int CONTENT_MAX = 8000;
    private static final String SEND_MESSAGE = "send_message";

    private final ConversationRepository conversations;
    private final PermissionService permissions;
    private final AuditService audit;
    private final Paging paging;
    private final TenantJdbc jdbc;
    private final ApplicationEventPublisher events;

    public ConversationService(ConversationRepository conversations, PermissionService permissions,
                               AuditService audit, Paging paging, TenantJdbc jdbc,
                               ApplicationEventPublisher events) {
        this.conversations = conversations;
        this.permissions = permissions;
        this.audit = audit;
        this.paging = paging;
        this.jdbc = jdbc;
        this.events = events;
    }

    // ---------------------------------------------------------------- (b) open a thread

    public Map<String, Object> open(TenantContext tenant, HttpServletRequest request, Map<String, Object> body) {
        Principal principal = Req.principal(request);
        String channel = orDefault(Paging.enumFilter(str(body.get("channel")), sorted(CHANNELS), "channel"), "web");
        String mode = orDefault(Paging.enumFilter(str(body.get("mode")), sorted(MODES), "mode"), "ai");
        String subject = trimmed(str(body.get("subject")), 200);
        UUID merchantId = body.get("merchant_id") == null ? null : uuidOr422(body.get("merchant_id"), "merchant_id");
        if ("human".equals(mode) && merchantId == null) {
            throw ApiException.validation("A human-mode conversation must name the merchant it is for",
                    Json.map("field", "merchant_id"));
        }
        if (merchantId != null) {
            jdbc.oneForTenant(tenant, "select id from merchants where id = :id and tenant_id = :tenant_id",
                    Json.map("id", merchantId), "merchant_not_found");
        }
        Map<String, Object> row = conversations.openConversation(tenant, principal.userId(), merchantId,
                channel, mode, subject);
        UUID id = Json.uuid(row, "id");
        conversations.appendMessage(id, "system", principal.userId(), "system",
                "Conversation opened on " + channel + " (mode " + mode + ").", "text", "{}", null, null, false);
        audit.record(request, "conversation_open", "conversation", id, merchantId, null,
                Json.map("channel", channel, "mode", mode), Json.map("merchant_id", merchantId));
        if (merchantId != null) {
            // Starting a thread with a merchant is the "new lead" event §123 counts. The payload
            // carries only ids the caller really supplied — no contact detail is invented.
            events.publishEvent(new DomainEvents.LeadCaptured(tenant.tenantId(), merchantId, id,
                    displayName(principal.userId()), Json.map("channel", channel)));
        }
        return threadView(conversations.findConversation(tenant, id), paging.limit(null), 0, tenant, principal, request);
    }

    // ---------------------------------------------------------------- reads

    /** {@code GET /api/v1/conversations/{id}} — owner, the merchant's staff, or platform role. */
    public Map<String, Object> thread(TenantContext tenant, HttpServletRequest request, UUID id, int limit, int offset) {
        Principal principal = Req.principal(request);
        Map<String, Object> conv = conversations.findConversation(tenant, id);
        requireReadAccess(tenant, principal, conv);
        return threadView(conv, limit, offset, tenant, principal, request);
    }

    /** {@code GET /api/v1/me/conversations}. */
    public Map<String, Object> myThreads(TenantContext tenant, HttpServletRequest request, int limit, int offset) {
        UUID userId = Req.userId(request);
        List<Map<String, Object>> rows = conversations.listForUser(tenant, userId, limit, offset);
        long total = conversations.countForUser(tenant, userId);
        return paging.page(rows.stream().map(r -> summary(r)).toList(), offset, limit, total);
    }

    /**
     * Merchant inbox (§5). Each thread carries its handoffs with the evidence that triggered them, so
     * the human taking over sees the facts and the confidence the agent had (AGENT_CONTRACT §4).
     */
    public Map<String, Object> merchantInbox(TenantContext tenant, HttpServletRequest request, UUID merchantId,
                                             String statusFilter, int limit, int offset) {
        String status = statusFilter == null ? null
                : Paging.enumFilter(statusFilter, sorted(THREAD_STATUSES), "status");
        List<Map<String, Object>> rows = conversations.listForMerchant(tenant, merchantId, status, limit, offset);
        long total = conversations.countForMerchant(tenant, merchantId, status);
        List<UUID> ids = rows.stream().map(r -> Json.uuid(r, "id")).filter(java.util.Objects::nonNull).toList();
        Map<UUID, List<Map<String, Object>>> byThread = new LinkedHashMap<>();
        for (Map<String, Object> h : conversations.handoffsFor(tenant, merchantId, ids)) {
            byThread.computeIfAbsent(Json.uuid(h, "conversation_id"), k -> new ArrayList<>()).add(h);
        }
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> out = summary(r);
            out.put("handoffs", byThread.getOrDefault(Json.uuid(r, "id"), List.of()).stream()
                    .map(ConversationService::handoffView).toList());
            items.add(out);
        }
        return paging.page(items, offset, limit, total);
    }

    // ---------------------------------------------------------------- (c) human merchant reply

    public Map<String, Object> merchantReply(TenantContext tenant, HttpServletRequest request, UUID conversationId,
                                             Map<String, Object> body) {
        Principal principal = Req.principal(request);
        Map<String, Object> conv = conversations.findConversation(tenant, conversationId);
        UUID merchantId = scopeMerchant(request, conv);
        String content = requireText(body.get("content"), "content");
        String contentType = orDefault(Paging.enumFilter(str(body.get("content_type")),
                List.of("text", "cards", "comparison", "form"), "content_type"), "text");

        Map<String, Object> message = conversations.appendMessage(conversationId, "merchant_user",
                principal.userId(), "assistant", content, contentType, "{}", null, null, false);
        // A human answering moves the thread out of pure-agent mode; "hybrid" once both have spoken.
        boolean agentAlreadySpoke = conversations.messagesOf(tenant, conversationId, 100, 0).stream()
                .anyMatch(m -> "ai_agent".equals(Json.str(m, "sender_type")));
        conversations.touchConversation(tenant, conversationId, agentAlreadySpoke ? "hybrid" : "human", "open");
        audit.record(request, "conversation_reply", "conversation", conversationId, merchantId, null,
                Json.map("message_id", Json.uuid(message, "id")), Json.map("content_type", contentType));

        UUID openHandoff = conversations.openHandoffOf(tenant, conversationId)
                .map(h -> Json.uuid(h, "id")).orElse(null);
        events.publishEvent(new DomainEvents.HandoffResolved(tenant.tenantId(), Json.uuid(conv, "user_id"),
                merchantId, conversationId, openHandoff,
                Json.map("title", "A team member replied to your question.", "reply_content_type", contentType)));
        return Json.map("conversation_id", conversationId.toString(),
                "message_id", Json.uuid(message, "id").toString(),
                "created_at", Json.ts(message, "created_at"),
                "mode", agentAlreadySpoke ? "hybrid" : "human");
    }

    // ---------------------------------------------------------------- (d) handoff resolve

    public Map<String, Object> resolveHandoff(TenantContext tenant, HttpServletRequest request, UUID conversationId,
                                              Map<String, Object> body) {
        Principal principal = Req.principal(request);
        Map<String, Object> conv = conversations.findConversation(tenant, conversationId);
        UUID merchantId = scopeMerchant(request, conv);
        String action = orDefault(Paging.enumFilter(str(body.get("action")), List.of("accepted", "resolved"),
                "action"), "resolved");
        String note = trimmed(str(body.get("note")), 2000);
        Map<String, Object> handoff = conversations.openHandoffOf(tenant, conversationId)
                .orElseThrow(() -> ApiException.conflict("no_open_handoff",
                        "This conversation has no handoff waiting for a human",
                        Json.map("conversation_id", conversationId.toString())));
        UUID handoffId = Json.uuid(handoff, "id");
        conversations.resolveHandoff(tenant, handoffId, merchantId, action);
        conversations.appendMessage(conversationId, "system", principal.userId(), "system",
                "Handoff " + action + " by the merchant team" + (note == null ? "." : ": " + note),
                "text", "{}", null, null, false);
        conversations.touchConversation(tenant, conversationId, "human",
                "resolved".equals(action) ? "closed" : "open");
        audit.record(request, "conversation_handoff_resolve", "conversation", conversationId, merchantId,
                Json.map("handoff_id", handoffId, "status", Json.str(handoff, "status")),
                Json.map("action", action, "note", note), Json.map("reason", Json.str(handoff, "reason")));
        events.publishEvent(new DomainEvents.HandoffResolved(tenant.tenantId(), Json.uuid(conv, "user_id"),
                merchantId, conversationId, handoffId,
                Json.map("title", "Your question was answered by the merchant team.")));
        return Json.map("handoff_id", handoffId.toString(), "conversation_id", conversationId.toString(),
                "status", action, "resolved_at", java.time.OffsetDateTime.now().toInstant().toString());
    }

    // ---------------------------------------------------------------- (e) the AI service's write door

    /**
     * One audited door for the AI service's dialogue writes (D12), called only after
     * {@link AiServiceTokenGuard} accepted the service token. Returns the persisted message id and,
     * when the message raised one, the handoff id.
     */
    public Map<String, Object> agentMessage(TenantContext tenant, HttpServletRequest request, UUID conversationId,
                                            Map<String, Object> body) {
        Map<String, Object> conv = conversations.findConversation(tenant, conversationId);
        String senderType = orDefault(Paging.enumFilter(str(body.get("sender_type")), List.of("ai_agent", "system"),
                "sender_type"), "ai_agent");
        String role = orDefault(Paging.enumFilter(str(body.get("role")), List.of("assistant", "tool", "system"),
                "role"), "ai_agent".equals(senderType) ? "assistant" : "system");
        String content = requireText(body.get("content"), "content");
        String contentType = orDefault(Paging.enumFilter(str(body.get("content_type")),
                List.of("text", "cards", "comparison", "form"), "content_type"), "text");
        Map<String, Object> payload = body.get("payload") instanceof Map<?, ?> m ? asMap(m) : Map.of();
        UUID agentRunId = body.get("agent_run_id") == null ? null : uuidOr422(body.get("agent_run_id"), "agent_run_id");
        BigDecimal confidence = decimalOrNull(body.get("confidence"), "confidence");
        boolean handoff = Boolean.TRUE.equals(body.get("handoff"));

        Map<String, Object> message = conversations.appendMessage(conversationId, senderType,
                Json.uuidOrNull(str(body.get("agent_subject_id"))), role, content, contentType,
                Json.write(payload), agentRunId, confidence, handoff);
        conversations.touchConversation(tenant, conversationId, null, handoff ? "handoff" : null);

        Map<String, Object> out = new LinkedHashMap<>();
        UUID messageId = Json.uuid(message, "id");
        out.put("conversation_id", conversationId.toString());
        out.put("message_id", messageId.toString());
        out.put("created_at", Json.ts(message, "created_at"));
        out.put("handoff_id", null);

        if (handoff) {
            UUID merchantId = Json.uuid(conv, "merchant_id");
            if (merchantId == null) {
                throw ApiException.validation("A handoff needs a merchant to hand off to; this conversation has none",
                        Json.map("field", "handoff", "conversation_id", conversationId.toString()));
            }
            String reason = orDefault(Paging.enumFilter(str(body.get("handoff_reason")), sorted(HANDOFF_REASONS),
                    "handoff_reason"), "low_confidence");
            Map<String, Object> evidence = new LinkedHashMap<>(
                    body.get("evidence") instanceof Map<?, ?> m ? asMap(m) : Map.of());
            evidence.put("trigger_message_id", messageId.toString());
            if (confidence != null) {
                evidence.put("confidence", confidence);
            }
            if (agentRunId != null) {
                evidence.put("agent_run_id", agentRunId.toString());
            }
            if (payload.get("fact_ids") instanceof List<?> facts) {
                evidence.put("fact_ids", facts);
            }
            Map<String, Object> created = conversations.openHandoff(tenant, conversationId, merchantId, reason,
                    Json.write(evidence));
            UUID handoffId = Json.uuid(created, "id");
            out.put("handoff_id", handoffId.toString());
            audit.record(request, "conversation_agent_handoff", "conversation", conversationId, merchantId, null,
                    Json.map("handoff_id", handoffId, "reason", reason), Json.map("agent_run_id", agentRunId));
            events.publishEvent(new DomainEvents.HandoffRequested(tenant.tenantId(), Json.uuid(conv, "user_id"),
                    merchantId, conversationId, handoffId, reason,
                    Json.map("title", "The AI agent could not answer and handed the conversation to you.",
                            "reason", reason)));
        }
        return out;
    }

    // ---------------------------------------------------------------- access

    private void requireReadAccess(TenantContext tenant, Principal principal, Map<String, Object> conv) {
        UUID userId = principal.userId();
        if (userId != null && userId.equals(Json.uuid(conv, "user_id"))) {
            return;
        }
        if (principal.hasPlatformRole("platform_admin", "platform_ops")) {
            return;
        }
        UUID merchantId = Json.uuid(conv, "merchant_id");
        if (merchantId != null && isMerchantStaff(tenant, principal, merchantId)) {
            return;
        }
        // Identical to a nonexistent id: the caller must not learn the thread exists.
        throw ApiException.notFound("conversation_not_found", "No such conversation");
    }

    /**
     * The {@code @RequiresPermission(merchant="conversation:id")} interceptor already proved the
     * caller's {@code send_message} grant and resolved the tenant-checked merchant; this reads that
     * decision back rather than re-deciding it, and fails closed if the attribute is missing.
     */
    private UUID scopeMerchant(HttpServletRequest request, Map<String, Object> conv) {
        Object scope = request.getAttribute("nexus.merchant_scope");
        UUID merchantId = Json.uuid(conv, "merchant_id");
        if (merchantId == null) {
            throw ApiException.notFound("merchant_not_found", "This conversation is not with a merchant");
        }
        if (scope == null) {
            throw ApiException.internal("Merchant scope was not resolved for a guarded conversation write", null);
        }
        if (!merchantId.toString().equals(String.valueOf(scope))) {
            throw ApiException.notFound("conversation_not_found", "No such conversation");
        }
        return merchantId;
    }

    private boolean isMerchantStaff(TenantContext tenant, Principal principal, UUID merchantId) {
        return permissions.has(tenant, "merchant_user", principal.subjectId(), merchantId, SEND_MESSAGE)
                || (principal.userId() != null
                    && permissions.has(tenant, "user", principal.userId(), merchantId, SEND_MESSAGE));
    }

    // ---- views -----------------------------------------------------------

    private Map<String, Object> summary(Map<String, Object> conv) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", String.valueOf(Json.uuid(conv, "id")));
        out.put("user_id", asString(Json.uuid(conv, "user_id")));
        out.put("consumer_name", Json.str(conv, "user_name"));
        out.put("merchant_id", asString(Json.uuid(conv, "merchant_id")));
        out.put("merchant_name", Json.str(conv, "merchant_name"));
        out.put("merchant_slug", Json.str(conv, "merchant_slug"));
        out.put("channel", Json.str(conv, "channel"));
        out.put("mode", Json.str(conv, "mode"));
        out.put("subject", Json.str(conv, "subject"));
        out.put("status", Json.str(conv, "status"));
        out.put("state", Json.jsonObject(conv, "state"));
        out.put("last_message_at", Json.ts(conv, "last_message_at"));
        out.put("created_at", Json.ts(conv, "created_at"));
        return out;
    }

    private Map<String, Object> threadView(Map<String, Object> conv, int limit, int offset, TenantContext tenant,
                                           Principal principal, HttpServletRequest request) {
        UUID id = Json.uuid(conv, "id");
        Map<String, Object> out = new LinkedHashMap<>(summary(conv));
        List<Map<String, Object>> messages = conversations.messagesOf(tenant, id, limit, offset).stream()
                .map(ConversationService::messageView).toList();
        out.put("messages", messages);
        out.put("message_total", conversations.countMessages(tenant, id));
        out.put("next_cursor", paging.nextCursor(offset, messages.size(), limit));
        out.put("limit", limit);
        UUID merchantId = Json.uuid(conv, "merchant_id");
        out.put("can_reply", merchantId != null && isMerchantStaff(tenant, principal, merchantId));
        out.put("handoffs", merchantId == null ? List.of()
                : conversations.handoffsFor(tenant, merchantId, List.of(id)).stream()
                        .map(ConversationService::handoffView).toList());
        out.put("request_id", Req.requestId(request));
        return out;
    }

    private static Map<String, Object> messageView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", String.valueOf(Json.uuid(row, "id")));
        out.put("sender_type", Json.str(row, "sender_type"));
        out.put("sender_id", asString(Json.uuid(row, "sender_id")));
        out.put("role", Json.str(row, "role"));
        out.put("content", Json.str(row, "content"));
        out.put("content_type", Json.str(row, "content_type"));
        out.put("payload", Json.jsonObject(row, "payload"));
        out.put("agent_run_id", asString(Json.uuid(row, "agent_run_id")));
        out.put("confidence", Json.dec(row, "confidence"));
        out.put("handoff", Boolean.TRUE.equals(Json.bool(row, "handoff")));
        out.put("created_at", Json.ts(row, "created_at"));
        return out;
    }

    /** Handoff + the message that raised it, so the evidence is never separated from the escalation. */
    private static Map<String, Object> handoffView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", String.valueOf(Json.uuid(row, "id")));
        out.put("conversation_id", String.valueOf(Json.uuid(row, "conversation_id")));
        out.put("reason", Json.str(row, "reason"));
        out.put("status", Json.str(row, "status"));
        out.put("evidence", Json.jsonObject(row, "evidence"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("resolved_at", Json.ts(row, "resolved_at"));
        Map<String, Object> trigger = new LinkedHashMap<>();
        trigger.put("message_id", asString(Json.uuid(row, "trigger_message_id")));
        trigger.put("sender_type", Json.str(row, "trigger_sender_type"));
        trigger.put("content", Json.str(row, "trigger_content"));
        trigger.put("confidence", Json.dec(row, "trigger_confidence"));
        trigger.put("agent_run_id", asString(Json.uuid(row, "trigger_agent_run_id")));
        trigger.put("created_at", Json.ts(row, "trigger_created_at"));
        out.put("trigger", trigger);
        return out;
    }

    // ---- validation ------------------------------------------------------

    private static List<String> sorted(Set<String> values) {
        return values.stream().sorted().toList();
    }

    private static String asString(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static String orDefault(String v, String fallback) {
        return v == null ? fallback : v;
    }

    private static String requireText(Object v, String field) {
        String s = trimmed(str(v), CONTENT_MAX);
        if (s == null || s.isBlank()) {
            throw ApiException.validation(field + " is required and must not be blank",
                    Json.map("field", field, "max_length", CONTENT_MAX));
        }
        return s;
    }

    private static String trimmed(String v, int max) {
        if (v == null) {
            return null;
        }
        String s = v.trim();
        if (s.length() > max) {
            throw ApiException.validation("Value is longer than " + max + " characters",
                    Json.map("max_length", max, "actual_length", s.length()));
        }
        return s.isEmpty() ? null : s;
    }

    private static UUID uuidOr422(Object v, String field) {
        UUID parsed = Json.uuidOrNull(str(v));
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }

    private static BigDecimal decimalOrNull(Object v, String field) {
        if (v == null || str(v).isBlank()) {
            return null;
        }
        BigDecimal d;
        try {
            d = new BigDecimal(str(v).trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation(field + " must be a number between 0 and 1", Json.map("field", field));
        }
        if (d.compareTo(BigDecimal.ZERO) < 0 || d.compareTo(BigDecimal.ONE) > 0) {
            throw ApiException.validation(field + " must be between 0 and 1", Json.map("field", field));
        }
        return d.setScale(3, RoundingMode.HALF_UP);
    }

    private static Map<String, Object> asMap(Map<?, ?> m) {
        Map<String, Object> out = new LinkedHashMap<>();
        m.forEach((k, v) -> out.put(String.valueOf(k), v));
        return out;
    }

    private String displayName(UUID userId) {
        return userId == null ? null
                : jdbc.crossTenantFirst("select display_name from users where id = :id", Json.map("id", userId))
                        .map(r -> Json.str(r, "display_name")).orElse(null);
    }
}
