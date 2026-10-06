package com.nexus.merchant;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Persistence for the §27 marketing surface: {@code campaigns} and the {@code coupons} they spend.
 *
 * <p>Two rules shape every statement here, and both exist because a campaign is the one object the
 * platform may show to consumers <em>on the merchant's behalf</em>:
 *
 * <ul>
 *   <li><strong>A campaign is born a draft.</strong> {@code insertCampaign} writes
 *       {@code status='draft'} unconditionally — not the caller's {@code status} — because §27 makes
 *       publishing an explicit human action on a different route. A caller that asks to be born live
 *       is refused at the controller, so the draft is not a silent rewrite of its request.</li>
 *   <li><strong>Tenant scoping rides on the merchant, never on the child row alone.</strong>
 *       {@code campaigns.tenant_id} is nullable in V1, so a predicate on the child's own column would
 *       silently hide every row the seed wrote without one. Each statement joins
 *       {@code merchants} and predicates on {@code m.tenant_id = :tenant_id}, which is also what
 *       {@code WorkspaceAccess} uses to authorise the call in the first place — the read and the
 *       permission check cannot disagree about which merchant a row belongs to.</li>
 * </ul>
 */
@Repository
public class MerchantCampaignRepository {

    private final TenantJdbc jdbc;

    public MerchantCampaignRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** One campaign row, tenant-scoped through its merchant; absent or foreign → {@code campaign_not_found}. */
    public Map<String, Object> campaign(TenantContext tenant, UUID campaignId) {
        return jdbc.oneForTenant(tenant, """
                select c.*
                from campaigns c join merchants m on m.id = c.merchant_id
                where c.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", campaignId), "campaign_not_found");
    }

    /**
     * Creates a campaign in {@code draft}. {@code channel} is a {@code text[] NOT NULL DEFAULT '{}'}
     * column and {@code audience}/{@code creative}/{@code metrics} are {@code jsonb NOT NULL}, so each
     * is coalesced here rather than trusting the driver to reject a null three layers down.
     */
    public Map<String, Object> insertCampaign(TenantContext tenant, UUID merchantId, Map<String, Object> params) {
        Map<String, Object> args = Json.map("merchant_id", merchantId,
                "title", params.get("title"),
                "goal", params.get("goal"),
                "channel", String.join(",", (List<String>) params.getOrDefault("channel", List.of())),
                "audience", Json.write(params.getOrDefault("audience", Map.of())),
                "creative", Json.write(params.getOrDefault("creative", Map.of())),
                "coupon_ids", String.join(",", (List<String>) params.getOrDefault("coupon_ids", List.of())),
                "generated_by", params.get("generated_by"),
                "starts_at", params.get("starts_at"),
                "ends_at", params.get("ends_at"));
        return jdbc.insertForTenant(tenant, """
                insert into campaigns (merchant_id, tenant_id, title, goal, channel, audience, creative,
                                       coupon_ids, status, generated_by, metrics, starts_at, ends_at)
                select :merchant_id, :tenant_id, :title, :goal,
                       case when :channel = '' then '{}'::text[] else string_to_array(:channel, ',') end,
                       cast(:audience as jsonb), cast(:creative as jsonb),
                       case when :coupon_ids = '' then '{}'::uuid[] else string_to_array(:coupon_ids, ',')::uuid[] end,
                       'draft', :generated_by, '{}'::jsonb,
                       cast(:starts_at as timestamptz), cast(:ends_at as timestamptz)
                from merchants m where m.id = :merchant_id and m.tenant_id = :tenant_id
                returning *
                """, args);
    }

    /**
     * The human publish (§27). Idempotent by construction: it sets {@code approved_by}/{@code
     * approved_at} only when the row is not already live, so a double-click records the same decision
     * once instead of moving a timestamp. {@code changed} is returned so the caller can tell "I
     * published this" from "this was already published" without comparing clocks.
     *
     * <p>A campaign whose {@code starts_at} is in the future is {@code scheduled}, not {@code live}:
     * publishing means "approved to run", and a campaign that has been approved but has not begun is
     * not yet showing anything to anybody.
     */
    public Map<String, Object> approve(TenantContext tenant, UUID campaignId, UUID approverId,
                                       java.time.Instant now, String nextStatus) {
        return jdbc.insertForTenant(tenant, """
                update campaigns c
                set status = :next_status,
                    approved_by = :approver,
                    approved_at = cast(:now as timestamptz),
                    updated_at = now()
                where c.id = :id
                  and exists (select 1 from merchants m where m.id = c.merchant_id and m.tenant_id = :tenant_id)
                returning *
                """, Json.map("id", campaignId, "approver", approverId, "now", now.toString(),
                "next_status", nextStatus));
    }

    /**
     * Publishes the campaign's own draft coupons. A live campaign that advertises a code which is still
     * a draft would be promising something the coupon table says is not active — the §19 failure
     * applied to marketing. This runs inside the same transaction as the campaign state change, so the
     * pair never lands half-published.
     */
    public int publishCouponsOf(TenantContext tenant, UUID campaignId, UUID approverId, java.time.Instant now) {
        return jdbc.updateForTenant(tenant, """
                update coupons cp
                set status = 'active', published_by = :approver, published_at = cast(:now as timestamptz)
                where cp.status = 'draft'
                  and cp.id in (select unnest(c.coupon_ids) from campaigns c where c.id = :id)
                  and cp.tenant_id = :tenant_id
                """, Json.map("id", campaignId, "approver", approverId, "now", now.toString()));
    }

    /** Draft coupons still attached to a campaign — what a publish is about to move. */
    public int countDraftCoupons(TenantContext tenant, UUID campaignId) {
        return (int) jdbc.countForTenant(tenant, """
                select count(*)
                from coupons cp
                where cp.status = 'draft'
                  and cp.id in (select unnest(c.coupon_ids) from campaigns c
                                join merchants m on m.id = c.merchant_id
                                where c.id = :id and m.tenant_id = :tenant_id)
                  and cp.tenant_id = :tenant_id
                """, Json.map("id", campaignId));
    }

    /**
     * Resolves a coupon that must belong to {@code merchantId}. A campaign may only advertise this
     * merchant's own offers, so a coupon id from another merchant (or another tenant) is refused
     * before the campaign is written — {@code coupon_not_found}, because the honest answer to "is this
     * your coupon" is the same 404 the workspace gives for anything it does not own (D5).
     */
    public void couponMerchant(TenantContext tenant, UUID couponId, UUID merchantId) {
        Map<String, Object> row = jdbc.oneForTenant(tenant, """
                select cp.merchant_id as merchant_id
                from coupons cp
                where cp.id = :id and cp.merchant_id = :merchant_id and cp.tenant_id = :tenant_id
                """, Json.map("id", couponId, "merchant_id", merchantId), "coupon_not_found");
        if (row.get("merchant_id") == null) {
            throw com.nexus.platform.ApiException.notFound("coupon_not_found",
                    "Coupon belongs to no merchant and cannot be attached to a campaign");
        }
    }

    /**
     * Creates a coupon in {@code draft}. {@code code} is {@code UNIQUE (tenant_id, code)}; the caller
     * turns the driver's constraint violation into a 409. {@code created_by} is the acting human —
     * never inferred, because §27 wants to know who authorised the offer.
     */
    public Map<String, Object> insertCoupon(TenantContext tenant, UUID merchantId, Map<String, Object> params) {
        Map<String, Object> args = Json.map("merchant_id", merchantId,
                "code", params.get("code"),
                "kind", params.get("kind"),
                "value", params.get("value"),
                "min_spend", params.get("min_spend"),
                "max_uses", params.get("max_uses"),
                "applies_to", Json.write(params.getOrDefault("applies_to", Map.of())),
                "starts_at", params.get("starts_at"),
                "ends_at", params.get("ends_at"),
                "created_by", params.get("created_by"));
        return jdbc.insertForTenant(tenant, """
                insert into coupons (tenant_id, merchant_id, code, kind, value, min_spend, max_uses,
                                     applies_to, starts_at, ends_at, status, created_by)
                select :tenant_id, :merchant_id, :code, :kind, cast(:value as numeric),
                       cast(:min_spend as numeric), cast(:max_uses as integer), cast(:applies_to as jsonb),
                       cast(:starts_at as timestamptz), cast(:ends_at as timestamptz), 'draft', :created_by
                from merchants m where m.id = :merchant_id and m.tenant_id = :tenant_id
                returning *
                """, args);
    }
}
