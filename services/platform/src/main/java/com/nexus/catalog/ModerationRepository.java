package com.nexus.catalog;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * The human-review queue (API_CONTRACT §9, spec §55/§127) over {@code moderation_cases}.
 *
 * <p>The queue exists because a machine is not allowed to be the last reader of user content. A row here is
 * a promise that somebody with a name and an audit entry looked at the thing, so the two operations this
 * class offers are the two that keep that promise checkable: read the open cases with the subject's own
 * facts beside them, and close one by writing the decision onto the subject row and the case row together.
 *
 * <p>Closing is guarded in the statement rather than in Java — {@code where status = 'open'} — because two
 * reviewers clicking the same case at the same moment must not both win. The row count tells the caller
 * which one did.
 */
@Repository
public class ModerationRepository {

    private final TenantJdbc jdbc;

    public ModerationRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** Open (or any status) cases, newest first, with the subject summarised inline. */
    public List<Map<String, Object>> cases(TenantContext tenant, String status, String subjectType, int limit,
                                           int offset) {
        // A review case is anchored through its review's merchant, so a case is only visible in the market
        // its subject belongs to — the same rule facts follow. `moderation_cases` also carries non-review
        // subject types (§127); those keep their identity and report `subject_known: false` rather than
        // being joined into a shape they do not have.
        return jdbc.forTenant(tenant, """
                select c.id, c.subject_type, c.subject_id, c.reason, c.policy, c.auto_action, c.status,
                       c.created_at, c.resolved_at, c.resolution,
                       r.rating as review_rating, left(r.body, 280) as review_excerpt, r.language,
                       r.data_origin as review_origin, r.status as review_status,
                       r.merchant_id as review_merchant_id, r.offering_id as review_offering_id,
                       m.slug as merchant_slug, m.display_name as merchant_name, m.status as merchant_status
                from moderation_cases c
                left join reviews r on c.subject_type = 'review' and r.id = c.subject_id
                left join merchants m on m.id = r.merchant_id
                where c.tenant_id = :tenant_id
                  and (c.subject_type <> 'review' or m.tenant_id = :tenant_id)
                  and (:status::text is null or c.status = :status)
                  and (:subject_type::text is null or c.subject_type = :subject_type)
                order by c.created_at desc
                limit :lim offset :off
                """, Json.map("status", status, "subject_type", subjectType, "lim", limit, "off", offset));
    }

    public long countCases(TenantContext tenant, String status, String subjectType) {
        return jdbc.countForTenant(tenant, """
                select count(*) from moderation_cases c
                where c.tenant_id = :tenant_id
                  and (:status::text is null or c.status = :status)
                  and (:subject_type::text is null or c.subject_type = :subject_type)
                """, Json.map("status", status, "subject_type", subjectType));
    }

    public Optional<Map<String, Object>> find(TenantContext tenant, UUID caseId) {
        return jdbc.firstForTenant(tenant, """
                select c.id, c.subject_type, c.subject_id, c.status, c.reason, c.resolved_at, c.tenant_id
                from moderation_cases c
                where c.id = :id and c.tenant_id = :tenant_id limit 1
                """, Json.map("id", caseId));
    }

    public Optional<Map<String, Object>> reviewOf(TenantContext tenant, UUID reviewId) {
        return jdbc.firstForTenant(tenant, """
                select r.id, r.merchant_id, r.offering_id, r.status, r.user_id, m.tenant_id
                from reviews r join merchants m on m.id = r.merchant_id
                where r.id = :id and m.tenant_id = :tenant_id limit 1
                """, Json.map("id", reviewId));
    }

    /**
     * Write the decision onto the review itself. The case row records that a human closed something; the
     * review row is what the rest of the system reads, so a resolve that only touched the case would leave
     * the content pending forever while the queue looked clean.
     */
    public void decideReview(TenantContext tenant, UUID reviewId, String status, UUID moderatorId, String note) {
        jdbc.updateForTenant(tenant, """
                update reviews r set status = :status, updated_at = now(),
                       moderation = moderation || cast(:decision as jsonb)
                from merchants m
                where r.id = :id and r.merchant_id = m.id and m.tenant_id = :tenant_id
                """, Json.map("id", reviewId, "status", status, "tenant_id", tenant.tenantId(),
                "decision", Json.write(Json.map("decision", status, "by", moderatorId.toString(),
                        "at", java.time.Instant.now().toString(), "note", note == null ? "" : note))));
    }

    /** @return 1 when this call closed the case, 0 when somebody faster already had. */
    public int closeCase(TenantContext tenant, UUID caseId, UUID resolverId, Map<String, Object> resolution) {
        return jdbc.updateForTenant(tenant, """
                update moderation_cases c
                   set status = 'resolved', assigned_to = :resolver, resolution = cast(:resolution as jsonb),
                       resolved_at = now()
                 where c.id = :id and c.tenant_id = :tenant_id and c.status = 'open'
                """, Json.map("id", caseId, "resolver", resolverId, "tenant_id", tenant.tenantId(),
                "resolution", Json.write(resolution)));
    }
}
