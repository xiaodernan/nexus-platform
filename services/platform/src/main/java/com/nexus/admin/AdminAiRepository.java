package com.nexus.admin;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Repository;

/**
 * The read side of the §9 AI observability screens ({@code /admin/ai/runs}, {@code /admin/ai/costs})
 * and the aggregate engine behind {@code POST /admin/ai/ask} (§126).
 *
 * <p>Three rules, the same three {@link AdminListRepository} enforces by construction:
 * <ul>
 *   <li><b>Tenant-scoped.</b> Every statement goes through {@link TenantJdbc#forTenant}, which refuses
 *       SQL without a {@code tenant_id = :tenant_id} predicate. {@code agent_runs} carries its own
 *       {@code tenant_id}; {@code llm_calls} does not, so this class reads the run-level roll-up rather
 *       than inventing a join that would need the escape hatch.</li>
 *   <li><b>Bounded.</b> Every list carries a caller {@code limit} clamped by
 *       {@link com.nexus.platform.Paging}.</li>
 *   <li><b>Totally ordered.</b> Each list's ORDER BY ends in a primary-key tiebreak, so a page boundary
 *       cannot be crossed twice or skipped when two rows share a millisecond.</li>
 * </ul>
 *
 * <p>Nothing here writes: §126 makes the admin analytics agent read-only, and a repository that could
 * write would make that a comment instead of a guarantee.
 */
@Repository
public class AdminAiRepository {

    /** A page of rows plus the count of the predicate that produced it. */
    public record Slice(List<Map<String, Object>> rows, long total) {
    }

    private final TenantJdbc jdbc;

    public AdminAiRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- runs (§70)

    private static final String RUN_SELECT = """
            select r.id, r.agent, r.model, r.provider, r.status, r.fallback_used, r.task_id,
                   r.prompt_tokens, r.completion_tokens, r.cost_usd, r.latency_ms, r.error,
                   r.merchant_id, r.user_id, r.conversation_id, r.parent_run_id, r.fact_ids,
                   r.tool_calls, r.started_at, r.finished_at
            from agent_runs r
            """;

    public Slice runs(TenantContext tenant, String agent, String status, int limit, int offset) {
        StringBuilder where = new StringBuilder("where r.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        if (agent != null) {
            where.append(" and r.agent = :agent");
            params.put("agent", agent);
        }
        if (status != null) {
            where.append(" and r.status = :status");
            params.put("status", status);
        }
        Map<String, Object> pageParams = new LinkedHashMap<>(params);
        pageParams.put("limit", limit);
        pageParams.put("offset", offset);
        List<Map<String, Object>> rows = jdbc.forTenant(tenant,
                RUN_SELECT + where + " order by r.started_at desc, r.id desc limit :limit offset :offset",
                pageParams);
        long total = jdbc.countForTenant(tenant, "select count(*) from agent_runs r " + where, params);
        return new Slice(rows, total);
    }

    // ---------------------------------------------------------------- costs (§69/§160)

    /**
     * The three documented groupings, each a fixed SQL fragment selected by the caller's already
     * validated token — the token itself is never concatenated. An unknown token is refused by the
     * controller before it reaches this method.
     */
    public List<Map<String, Object>> costBy(TenantContext tenant, String groupBy, int limit) {
        String expression = switch (groupBy) {
            case "agent" -> "coalesce(r.agent, 'unknown')";
            case "model" -> "coalesce(r.model, 'unknown')";
            case "day" -> "to_char(date_trunc('day', r.started_at), 'YYYY-MM-DD')";
            default -> throw new IllegalArgumentException("unsupported group_by: " + groupBy);
        };
        return jdbc.forTenant(tenant, """
                select %s as group_key, count(*) as runs,
                       coalesce(sum(r.cost_usd), 0) as cost_usd,
                       coalesce(sum(r.prompt_tokens), 0) as prompt_tokens,
                       coalesce(sum(r.completion_tokens), 0) as completion_tokens,
                       round(avg(r.latency_ms)) as avg_latency_ms
                from agent_runs r
                where r.tenant_id = :tenant_id
                group by 1
                order by cost_usd desc, group_key asc
                limit :limit
                """.formatted(expression), Json.map("limit", limit));
    }

    public Map<String, Object> costTotals(TenantContext tenant) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as runs,
                       coalesce(sum(r.cost_usd), 0) as cost_usd,
                       coalesce(sum(r.prompt_tokens), 0) as prompt_tokens,
                       coalesce(sum(r.completion_tokens), 0) as completion_tokens,
                       count(distinct r.agent) as agents,
                       count(distinct r.model) as models,
                       count(*) filter (where r.fallback_used is not null) as fallback_runs
                from agent_runs r
                where r.tenant_id = :tenant_id
                """, Json.map()).orElse(new LinkedHashMap<>());
    }

    // ---------------------------------------------------------------- ask (§126, read-only)

    /** Merchant counts by status — one real row, never a per-status round trip. */
    public Map<String, Object> merchantSnapshot(TenantContext tenant) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as total,
                       count(*) filter (where m.status = 'published') as published,
                       count(*) filter (where m.status = 'pending_review') as pending_review,
                       count(*) filter (where m.status = 'draft') as draft,
                       count(*) filter (where m.status = 'suspended') as suspended
                from merchants m
                where m.tenant_id = :tenant_id
                """, Json.map()).orElse(new LinkedHashMap<>());
    }

    public Map<String, Object> orderSnapshot(TenantContext tenant) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as total,
                       coalesce(sum(o.total), 0) as gmv,
                       count(*) filter (where o.status = 'completed') as completed,
                       count(*) filter (where o.status = 'cancelled') as cancelled
                from orders o
                where o.tenant_id = :tenant_id
                """, Json.map()).orElse(new LinkedHashMap<>());
    }

    public Map<String, Object> reservationSnapshot(TenantContext tenant) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as total,
                       count(*) filter (where r.status = 'confirmed') as confirmed,
                       count(*) filter (where r.status = 'completed') as completed,
                       count(*) filter (where r.status = 'cancelled') as cancelled
                from reservations r
                where r.tenant_id = :tenant_id
                """, Json.map()).orElse(new LinkedHashMap<>());
    }

    public Map<String, Object> reviewSnapshot(TenantContext tenant) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as total,
                       count(*) filter (where r.status = 'published') as published,
                       count(*) filter (where r.status = 'pending') as pending,
                       count(*) filter (where r.status = 'flagged') as flagged
                from reviews r
                where r.tenant_id = :tenant_id
                """, Json.map()).orElse(new LinkedHashMap<>());
    }

    public Map<String, Object> searchEventSnapshot(TenantContext tenant) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as searches,
                       count(distinct e.session_id) as sessions
                from events e
                where e.tenant_id = :tenant_id and e.name = 'search'
                """, Json.map()).orElse(new LinkedHashMap<>());
    }
}
