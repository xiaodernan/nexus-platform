package com.nexus.platform;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Writes {@code audit_logs}. Never fails the request it is annotating (a broken audit write is
 * logged loudly, not swallowed, but must not turn a successful action into a 500 — except for
 * permission denials, where the audit row is part of the contract: those use {@link #denied}).
 */
@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);

    private final NamedParameterJdbcTemplate jdbc;

    public AuditService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void record(TenantContext tenant, String actorType, UUID actorId, String action,
                       String subjectType, UUID subjectId, UUID merchantId,
                       Map<String, Object> before, Map<String, Object> after, Map<String, Object> metadata,
                       String ip, String userAgent) {
        try {
            jdbc.update("""
                    insert into audit_logs (tenant_id, actor_type, actor_id, action, subject_type, subject_id,
                                           merchant_id, ip, user_agent, before, after, metadata)
                    values (:tenant_id, :actor_type, :actor_id, :action, :subject_type, :subject_id,
                            :merchant_id, cast(:ip as inet), :user_agent,
                            cast(:before as jsonb), cast(:after as jsonb), cast(:metadata as jsonb))
                    """, new MapSqlParameterSource()
                    .addValue("tenant_id", tenant == null ? null : tenant.tenantId())
                    .addValue("actor_type", actorType == null ? "system" : actorType)
                    .addValue("actor_id", actorId)
                    .addValue("action", action)
                    .addValue("subject_type", subjectType)
                    .addValue("subject_id", subjectId)
                    .addValue("merchant_id", merchantId)
                    .addValue("ip", ip)
                    .addValue("user_agent", truncate(userAgent, 512))
                    .addValue("before", before == null ? null : Json.write(before))
                    .addValue("after", after == null ? null : Json.write(after))
                    .addValue("metadata", Json.write(withRequest(metadata))));
        } catch (Exception e) {
            log.error("audit_write_failed action={} message={}", action, e.toString());
        }
    }

    /** Convenience: derive actor/ip/UA from the request. */
    public void record(HttpServletRequest request, String action, String subjectType, UUID subjectId,
                       UUID merchantId, Map<String, Object> before, Map<String, Object> after,
                       Map<String, Object> metadata) {
        Principal p = Req.principalOrNull(request);
        record(Req.tenant(request), p == null ? "anonymous" : p.subjectType(),
                p == null ? null : p.subjectId(), action, subjectType, subjectId, merchantId,
                before, after, metadata, Req.clientIp(request), request.getHeader("User-Agent"));
    }

    /** AGENT_CONTRACT §8: every permission denial writes {@code action='permission_denied'}. */
    public void denied(HttpServletRequest request, String permission, UUID merchantId, String reason) {
        Principal p = Req.principalOrNull(request);
        record(Req.tenant(request), p == null ? "anonymous" : p.subjectType(),
                p == null ? null : p.subjectId(), "permission_denied",
                "permission", null, merchantId, null, null,
                Json.map("permission", permission, "reason", reason, "path", request.getRequestURI(),
                        "method", request.getMethod()),
                Req.clientIp(request), request.getHeader("User-Agent"));
    }

    public void record(TenantContext tenant, String action, String subjectType, UUID subjectId,
                       Map<String, Object> metadata) {
        record(tenant, "system", null, action, subjectType, subjectId, null, null, null, metadata, null, null);
    }

    private static Map<String, Object> withRequest(Map<String, Object> metadata) {
        Map<String, Object> out = metadata == null ? new java.util.LinkedHashMap<>() : new java.util.LinkedHashMap<>(metadata);
        out.putIfAbsent("request_id", RequestIds.current());
        return out;
    }

    private static String truncate(String v, int max) {
        if (v == null) {
            return null;
        }
        return v.length() <= max ? v : v.substring(0, max);
    }
}
