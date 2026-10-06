package com.nexus.merchant;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * The reads and link writes the §5 merchant content surface needs that are not already owned by
 * {@link MerchantRepository} (profile, locations, hours, membership), {@code OfferingRepository}
 * (offerings) or {@code FactRepository} (the trust layer). Keeping the leftovers here means the
 * existing three stay the single definition of their own subject.
 *
 * <p>Every statement is tenant-predicated: {@code merchant_categories} and {@code facts} carry no
 * {@code tenant_id} of their own, so they are written through a join to the tenant-owned
 * {@code merchants} row rather than by an id the caller supplied (DECISIONS D5).
 */
@Repository
public class MerchantContentRepository {

    private final TenantJdbc jdbc;

    public MerchantContentRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- taxonomy -------------------------------------------------------

    /**
     * Resolves the {@code category} field of an offering input: a uuid, or the slug of a category in
     * this tenant or in the global catalog ({@code categories.tenant_id IS NULL}). Empty means "no
     * such category", so the caller rejects the write instead of storing a dangling reference.
     */
    public Optional<UUID> categoryId(TenantContext tenant, String ref) {
        if (ref == null || ref.isBlank()) {
            return Optional.empty();
        }
        UUID id = Json.uuidOrNull(ref);
        if (id != null) {
            return jdbc.firstForTenant(tenant, """
                    select c.id from categories c
                    where c.id = :id and (c.tenant_id = :tenant_id or c.tenant_id is null)
                    """, Json.map("id", id)).map(r -> Json.uuid(r, "id"));
        }
        return jdbc.firstForTenant(tenant, """
                select c.id from categories c
                where c.slug = :slug and (c.tenant_id = :tenant_id or c.tenant_id is null)
                order by (c.tenant_id is null) limit 1
                """, Json.map("slug", ref)).map(r -> Json.uuid(r, "id"));
    }

    /**
     * Replaces the merchant's taxonomy links with exactly {@code categoryIds}. The caller has already
     * resolved each id through {@link #categoryId}, so an unknown id is a 422 there rather than a FK
     * violation here. A merchant with no links is a real state — the read path then falls back to the
     * denormalised {@code category_primary} label (D24).
     */
    public int replaceCategories(TenantContext tenant, UUID merchantId, List<UUID> categoryIds) {
        jdbc.updateForTenant(tenant, """
                delete from merchant_categories mc using merchants m
                where mc.merchant_id = m.id and m.tenant_id = :tenant_id and mc.merchant_id = :merchant_id
                """, Json.map("merchant_id", merchantId));
        int linked = 0;
        for (UUID categoryId : categoryIds) {
            linked += jdbc.updateForTenant(tenant, """
                    insert into merchant_categories (merchant_id, category_id)
                    select m.id, cast(:category_id as uuid) from merchants m
                    where m.id = :merchant_id and m.tenant_id = :tenant_id
                    on conflict (merchant_id, category_id) do nothing
                    """, Json.map("merchant_id", merchantId, "category_id", categoryId));
        }
        return linked;
    }

    // ---- dashboard helpers ---------------------------------------------

    /**
     * Conversation threads still needing a human for this merchant (§5 {@code /merchant/conversations}).
     * {@code open} and {@code handoff} are the two non-terminal states of {@code conversations.status};
     * {@code closed}/{@code archived} are not work.
     */
    public long openConversations(TenantContext tenant, UUID merchantId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from conversations c
                where c.tenant_id = :tenant_id and c.merchant_id = :merchant_id
                  and c.status in ('open', 'handoff')
                """, Json.map("merchant_id", merchantId));
    }

    // ---- export (§107) --------------------------------------------------

    /** The merchant's own catalogue rows for the §107 data-ownership export, oldest first and bounded. */
    public List<Map<String, Object>> exportOfferings(TenantContext tenant, UUID merchantId, int limit) {
        return jdbc.forTenant(tenant, """
                select o.id, o.kind, o.slug, o.name, o.name_zh, o.description, o.price_amount, o.currency,
                       o.price_model, o.price_source, o.price_updated_at, o.stock_quantity, o.bookable,
                       o.status, o.created_at, o.updated_at
                from offerings o
                where o.tenant_id = :tenant_id and o.merchant_id = :merchant_id
                order by o.created_at, o.id
                limit :limit
                """, Json.map("merchant_id", merchantId, "limit", limit));
    }

    // ---- trust layer ----------------------------------------------------

    /**
     * Marks the offering's live facts for one attribute stale. Used when a merchant clears a price or a
     * stock count: the card then renders no number, and a fact left un-expired would be a citation for a
     * claim nobody makes any more (§19). {@code facts} has no {@code tenant_id}, so the predicate rides
     * on the merchant join.
     */
    public int expireFacts(TenantContext tenant, UUID offeringId, String attribute) {
        return jdbc.updateForTenant(tenant, """
                update facts f set stale = true
                from merchants m
                where f.merchant_id = m.id and m.tenant_id = :tenant_id
                  and f.subject_type = 'offering' and f.subject_id = :offering_id
                  and f.attribute = :attribute and f.stale = false
                """, Json.map("offering_id", offeringId, "attribute", attribute));
    }
}
