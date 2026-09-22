package com.nexus.growth;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Reads and writes {@code referrals} (V1 §growth, spec §59-§62).
 *
 * <p>The write side creates only {@code invited} rows with an empty {@code reward}. That is the
 * §110 rule made structural: a reward is recorded only on a genuine conversion event, and nothing
 * in this module can advance a status or fill a reward, so an invite can never mint a credit by
 * itself. The status ladder ({@code invited→signed_up→first_value→rewarded}) is moved only by
 * verified conversion, which is not this module's surface.
 */
@Repository
public class ReferralRepository {

    private final TenantJdbc jdbc;

    public ReferralRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** Inserts an invite and returns the stored row. */
    public Map<String, Object> insertInvite(TenantContext tenant, UUID referrerId, String kind,
                                            String inviteeEmail, String code) {
        return jdbc.insertForTenant(tenant, """
                insert into referrals (tenant_id, kind, referrer_type, referrer_id, invitee_email, code,
                                       status, reward)
                values (:tenant_id, :kind, 'user', :referrer_id, :invitee_email, :code, 'invited', '{}'::jsonb)
                returning id, tenant_id, kind, referrer_type, referrer_id, invitee_email, code, status,
                          reward, created_at, converted_at
                """, Json.map("kind", kind, "referrer_id", referrerId, "invitee_email", inviteeEmail,
                "code", code));
    }

    /**
     * An open invite to the same address from the same referrer. Returned instead of inserting a
     * duplicate, so a double-click cannot spam the same inbox or pad the funnel counts.
     */
    public Optional<Map<String, Object>> openInviteForEmail(TenantContext tenant, UUID referrerId, String email) {
        return jdbc.firstForTenant(tenant, """
                select id, tenant_id, kind, referrer_type, referrer_id, invitee_email, code, status, reward,
                       created_at, converted_at
                from referrals
                where tenant_id = :tenant_id and referrer_type = 'user' and referrer_id = :referrer_id
                  and invitee_email = :invitee_email and status = 'invited'
                order by created_at desc limit 1
                """, Json.map("referrer_id", referrerId, "invitee_email", email));
    }

    public List<Map<String, Object>> listByReferrer(TenantContext tenant, UUID referrerId, int limit, int offset) {
        return jdbc.forTenant(tenant, """
                select id, tenant_id, kind, referrer_type, referrer_id, invitee_email, code, status, reward,
                       created_at, converted_at
                from referrals
                where tenant_id = :tenant_id and referrer_type = 'user' and referrer_id = :referrer_id
                order by created_at desc, id
                limit :limit offset :offset
                """, Json.map("referrer_id", referrerId, "limit", limit, "offset", offset));
    }

    public long countByReferrer(TenantContext tenant, UUID referrerId) {
        return jdbc.countForTenant(tenant, """
                select count(*)
                from referrals
                where tenant_id = :tenant_id and referrer_type = 'user' and referrer_id = :referrer_id
                """, Json.map("referrer_id", referrerId));
    }

    /**
     * Funnel counts over a real attribution window: rows are bucketed by their stored status, and
     * {@code earned_amount} sums only {@code rewarded} rows' recorded reward amounts. Zero here is
     * the honest reading of a programme nobody has converted on yet — nothing pads it.
     */
    public Map<String, Object> statsFor(TenantContext tenant, UUID referrerId, int windowDays) {
        return jdbc.firstForTenant(tenant, """
                select count(*)                                                   as invited,
                       count(*) filter (where status = 'signed_up')               as signed_up,
                       count(*) filter (where status = 'first_value')             as first_value,
                       count(*) filter (where status = 'rewarded')                as rewarded,
                       count(*) filter (where status = 'expired')                 as expired,
                       coalesce(sum(((reward->>'amount')::numeric))
                                filter (where status = 'rewarded'), 0)            as earned_amount,
                       min(reward->>'currency') filter (where status = 'rewarded') as earned_currency
                from referrals
                where tenant_id = :tenant_id and referrer_type = 'user' and referrer_id = :referrer_id
                  and created_at >= now() - make_interval(days => :window_days)
                """, Json.map("referrer_id", referrerId, "window_days", windowDays)).orElse(null);
    }
}
