package com.nexus.conversation;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Data access for {@code conversations} / {@code messages} / {@code handoffs}.
 *
 * <p>Tenant discipline (DECISIONS D5, see {@link TenantJdbc}): {@code conversations} carries its own
 * {@code tenant_id}; {@code messages} and {@code handoffs} do not, so every statement that touches
 * them joins back to {@code conversations}/{@code merchants} and predicates on
 * {@code tenant_id = :tenant_id}. Inserts into the two child tables anchor on a conversation row the
 * caller has already loaded through the tenant-checked {@link #findConversation} — the pattern
 * {@link TenantJdbc} documents for child tables.
 *
 * <p>No SQL is ever assembled from client text: filters are named parameters, sort tokens go through
 * {@link Paging#orderBy}, and {@code limit}/{@code offset} are bound integers.
 */
@Repository
public class ConversationRepository {

    private final TenantJdbc jdbc;

    public ConversationRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- threads

    /** Columns every thread read returns, with the merchant/consumer labels the inbox needs. */
    private static final String THREAD_SELECT = """
            select c.id, c.tenant_id, c.user_id, c.merchant_id, c.channel, c.mode, c.subject,
                   c.state, c.status, c.last_message_at, c.created_at, c.updated_at,
                   m.slug as merchant_slug, m.display_name as merchant_name,
                   u.display_name as user_name, u.email as user_email
            from conversations c
            left join merchants m on m.id = c.merchant_id
            left join users u on u.id = c.user_id
            """;

    public Map<String, Object> findConversation(TenantContext tenant, UUID id) {
        return jdbc.firstForTenant(tenant,
                THREAD_SELECT + " where c.id = :id and c.tenant_id = :tenant_id",
                Json.map("id", id)).orElseThrow(() ->
                // Cross-tenant and non-existent are the same answer (D5: no enumeration).
                ApiException.notFound("conversation_not_found", "No such conversation"));
    }

    public Map<String, Object> openConversation(TenantContext tenant, UUID userId, UUID merchantId,
                                                String channel, String mode, String subject) {
        // conversations.tenant_id is written from the caller's TenantContext, never from the body.
        return jdbc.insertForTenant(tenant, """
                insert into conversations (tenant_id, user_id, merchant_id, channel, mode, subject, status)
                values (:tenant_id, :user_id, :merchant_id, :channel, :mode, :subject, 'open')
                returning id, created_at
                """, Json.map("user_id", userId, "merchant_id", merchantId,
                "channel", channel, "mode", mode, "subject", subject));
    }

    public int updateConversationState(TenantContext tenant, UUID id, String stateJson) {
        return jdbc.updateForTenant(tenant, """
                update conversations set state = cast(:state as jsonb)
                where id = :id and tenant_id = :tenant_id
                """, Json.map("id", id, "state", stateJson));
    }

    public int touchConversation(TenantContext tenant, UUID id, String mode, String status) {
        return jdbc.updateForTenant(tenant, """
                update conversations
                set last_message_at = now(),
                    mode = coalesce(cast(:mode as text), mode),
                    status = coalesce(cast(:status as text), status)
                where id = :id and tenant_id = :tenant_id
                """, Json.map("id", id, "mode", mode, "status", status));
    }

    /** Consumer thread list (API_CONTRACT §3 {@code GET /api/v1/me/conversations}). */
    public List<Map<String, Object>> listForUser(TenantContext tenant, UUID userId, int limit, int offset) {
        return jdbc.forTenant(tenant, THREAD_SELECT + """
                where c.tenant_id = :tenant_id and c.user_id = :user_id
                order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
                limit :limit offset :offset
                """, Json.map("user_id", userId, "limit", limit, "offset", offset));
    }

    public long countForUser(TenantContext tenant, UUID userId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from conversations c
                where c.tenant_id = :tenant_id and c.user_id = :user_id
                """, Json.map("user_id", userId));
    }

    /** Merchant inbox (API_CONTRACT §5): newest activity first, `status` filter whitelisted. */
    public List<Map<String, Object>> listForMerchant(TenantContext tenant, UUID merchantId, String status,
                                                     int limit, int offset) {
        // The optional predicate is assembled from a whitelist, never from raw client text, and each
        // fragment keeps its own separating space (`:status` glued to `order` parses as one parameter).
        Map<String, Object> params = Json.map("merchant_id", merchantId, "limit", limit, "offset", offset);
        String statusClause = "";
        if (status != null) {
            statusClause = " and c.status = :status ";
            params = Json.map("merchant_id", merchantId, "limit", limit, "offset", offset, "status", status);
        }
        String sql = THREAD_SELECT + """
                where m.tenant_id = :tenant_id and c.merchant_id = :merchant_id
                """ + statusClause + """
                order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
                limit :limit offset :offset
                """;
        return jdbc.forTenant(tenant, sql, params);
    }

    public long countForMerchant(TenantContext tenant, UUID merchantId, String status) {
        String sql = """
                select count(*)
                from conversations c join merchants m on m.id = c.merchant_id
                where m.tenant_id = :tenant_id and c.merchant_id = :merchant_id
                """ + (status == null ? "" : " and c.status = :status");
        Map<String, Object> params = status == null
                ? Json.map("merchant_id", merchantId)
                : Json.map("merchant_id", merchantId, "status", status);
        return jdbc.countForTenant(tenant, sql, params);
    }

    // ---------------------------------------------------------------- messages

    /**
     * Appends a message. The conversation anchor was already resolved through
     * {@link #findConversation} (tenant-checked, 404 otherwise), which is what
     * {@link TenantJdbc#crossTenantReturning}'s contract requires for a table with no tenant column.
     */
    public Map<String, Object> appendMessage(UUID conversationId, String senderType, UUID senderId, String role,
                                             String content, String contentType, String payloadJson,
                                             UUID agentRunId, BigDecimal confidence, boolean handoff) {
        return jdbc.crossTenantReturning("""
                insert into messages (conversation_id, sender_type, sender_id, role, content, content_type,
                                      payload, agent_run_id, confidence, handoff)
                values (:conversation_id, :sender_type, :sender_id, :role, :content, :content_type,
                        cast(:payload as jsonb), :agent_run_id, :confidence, :handoff)
                returning id, created_at
                """, Json.map("conversation_id", conversationId, "sender_type", senderType,
                "sender_id", senderId, "role", role, "content", content, "content_type", contentType,
                "payload", payloadJson, "agent_run_id", agentRunId, "confidence", confidence,
                "handoff", handoff));
    }

    public List<Map<String, Object>> messagesOf(TenantContext tenant, UUID conversationId, int limit, int offset) {
        return jdbc.forTenant(tenant, """
                select g.id, g.sender_type, g.sender_id, g.role, g.content, g.content_type, g.payload,
                       g.agent_run_id, g.confidence, g.handoff, g.created_at
                from messages g join conversations c on c.id = g.conversation_id
                where c.tenant_id = :tenant_id and g.conversation_id = :conversation_id
                order by g.created_at asc, g.id asc
                limit :limit offset :offset
                """, Json.map("conversation_id", conversationId, "limit", limit, "offset", offset));
    }

    public long countMessages(TenantContext tenant, UUID conversationId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from messages g join conversations c on c.id = g.conversation_id
                where c.tenant_id = :tenant_id and g.conversation_id = :conversation_id
                """, Json.map("conversation_id", conversationId));
    }

    // ---------------------------------------------------------------- handoffs

    public Map<String, Object> openHandoff(TenantContext tenant, UUID conversationId, UUID merchantId,
                                           String reason, String evidenceJson) {
        // merchant_id is NOT NULL on handoffs; the tenant predicate rides on merchants so a caller can
        // never open a handoff against another tenant's merchant. The bind is explicit here (rather than
        // via forTenant) because `handoffs` has no tenant_id column of its own to write.
        return jdbc.crossTenantReturning("""
                insert into handoffs (conversation_id, merchant_id, reason, status, evidence)
                select :conversation_id, m.id, :reason, 'open', cast(:evidence as jsonb)
                from merchants m
                where m.id = :merchant_id and m.tenant_id = :tenant_id
                returning id, created_at
                """, Json.map("conversation_id", conversationId, "merchant_id", merchantId,
                "reason", reason, "evidence", evidenceJson, "tenant_id", tenant.tenantId()));
    }

    /**
     * Handoffs of the given threads with the evidence that triggered them (AGENT_CONTRACT §4/§7: an
     * answer is only as good as the facts behind it, and a human taking over must see those facts).
     */
    public List<Map<String, Object>> handoffsFor(TenantContext tenant, UUID merchantId, List<UUID> conversationIds) {
        if (conversationIds.isEmpty()) {
            return List.of();
        }
        return jdbc.forTenant(tenant, """
                select h.id, h.conversation_id, h.reason, h.status, h.evidence, h.created_at, h.resolved_at,
                       t.id as trigger_message_id, t.sender_type as trigger_sender_type,
                       t.content as trigger_content, t.confidence as trigger_confidence,
                       t.agent_run_id as trigger_agent_run_id, t.created_at as trigger_created_at
                from handoffs h
                join merchants m on m.id = h.merchant_id
                left join lateral (
                    select g.id, g.sender_type, g.content, g.confidence, g.agent_run_id, g.created_at
                    from messages g
                    where g.conversation_id = h.conversation_id and g.handoff
                    order by g.created_at desc, g.id desc
                    limit 1
                ) t on true
                where m.tenant_id = :tenant_id and h.merchant_id = :merchant_id
                  and h.conversation_id in (:conversation_ids)
                order by h.created_at desc
                """, Json.map("merchant_id", merchantId, "conversation_ids", conversationIds));
    }

    public Optional<Map<String, Object>> openHandoffOf(TenantContext tenant, UUID conversationId) {
        return jdbc.firstForTenant(tenant, """
                select h.id, h.conversation_id, h.merchant_id, h.reason, h.status, h.evidence,
                       h.created_at, h.resolved_at
                from handoffs h
                join conversations c on c.id = h.conversation_id
                join merchants m on m.id = h.merchant_id
                where c.tenant_id = :tenant_id and h.conversation_id = :conversation_id
                  and h.status = 'open'
                order by h.created_at desc
                limit 1
                """, Json.map("conversation_id", conversationId));
    }

    public int resolveHandoff(TenantContext tenant, UUID handoffId, UUID merchantId, String status) {
        // Postgres spells the joined-table form of UPDATE `FROM`, not `USING`; the tenant predicate
        // rides on merchants so a caller cannot resolve another tenant's handoff by guessing its id.
        return jdbc.updateForTenant(tenant, """
                update handoffs h set status = :status, resolved_at = now()
                from merchants m
                where h.id = :id and h.merchant_id = m.id and m.tenant_id = :tenant_id
                  and h.merchant_id = :merchant_id and h.status = 'open'
                """, Json.map("id", handoffId, "merchant_id", merchantId, "status", status));
    }
}
