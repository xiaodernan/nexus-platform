package com.nexus.catalog;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * The §4 consumer reads over the merchant table: a filterable directory list, one profile, its menu,
 * its published reviews and its reservation slots.
 *
 * <p>Every row here is rendered through {@link MerchantCards}, the same projection the §29 SEO pages and
 * the AI search rails use, so a merchant cannot look different on the aisle than on the card that led to
 * it. This repository adds no derived statistics of its own: the numbers it returns are either columns
 * ({@code avg_price_hkd}, {@code rating_agg}), an {@code open_now} computation
 * ({@link MerchantCards#OPEN_NOW}), or a {@code count(*)}/{@code avg} over real rows — never an estimate
 * dressed up as a measurement (§19).
 *
 * <p>Two scopes the tenant guard would otherwise miss:
 * <ul>
 *   <li>{@code business_hours}, {@code availability_slots}, {@code merchant_categories} and
 *       {@code review_summaries} have no {@code tenant_id} column, so each is reached through a join to
 *       its merchant, and that join carries the predicate.</li>
 *   <li>Only {@code status = 'published'} merchants are readable at all (AGENT_CONTRACT §1); a draft or
 *       suspended business is indistinguishable from one that does not exist.</li>
 * </ul>
 */
@Repository
public class CatalogRepository {

    /**
     * The parsed filters of {@code GET /api/v1/merchants}. A null field means "not filtered" — the
     * controller parses and validates, this record only carries.
     */
    public record MerchantFilters(String district, String category, BigDecimal maxPrice, BigDecimal minRating,
                                  boolean openNow) {
    }

    /**
     * Profile columns on top of the card columns: the fields a consumer page shows that a card has no
     * room for. Names are the {@code merchants} columns, so there is nothing to reconcile later.
     */
    private static final String PROFILE_COLUMNS = String.join("\n",
            "       m.tenant_id, m.legal_name, m.display_name_zh, m.price_band, m.popularity_score,",
            "       m.contact, m.socials, m.attributes, m.seo, m.ai_agent_enabled, m.plan, m.status,",
            "       m.created_at");

    /** Review columns for the §4 menu-of-reviews page — the row, plus who wrote it. */
    private static final String REVIEW_COLUMNS = String.join("\n",
            "       r.id, r.merchant_id, r.offering_id, r.user_id, r.author_label, r.rating, r.title, r.body,",
            "       r.language, r.photos, r.verified_purchase, r.verified_reservation, r.data_origin,",
            "       r.helpful_count, r.aspects, r.created_at, u.display_name as author_name");

    private final TenantJdbc jdbc;

    public CatalogRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- directory list --------------------------------------------------

    /**
     * Published merchants, as card rows. {@code orderBy} must come from the caller's whitelist
     * ({@code Paging.orderBy}) — it is the only SQL fragment in these two methods that is not a constant.
     */
    public List<Map<String, Object>> merchantRows(TenantContext tenant, MerchantFilters filters, Instant asOf,
                                                  String orderBy, int limit, int offset) {
        Map<String, Object> params = cardParams(tenant.timezone(), filters, asOf);
        params.put("limit", limit);
        params.put("offset", offset);
        return jdbc.forTenant(tenant, String.join("\n",
                "select " + MerchantCards.COLUMNS,
                "from merchants m",
                MerchantCards.LATERAL_JOINS,
                where(filters),
                "order by " + orderBy + ", m.slug asc",
                "limit :limit offset :offset"), params);
    }

    /**
     * The same statement's row count, for {@code total_estimate}. It repeats {@link #where} verbatim
     * rather than wrapping the listing in a sub-select so the two can never disagree about what matched.
     */
    public long countMerchants(TenantContext tenant, MerchantFilters filters, Instant asOf) {
        return jdbc.countForTenant(tenant, String.join("\n",
                "select count(*)",
                "from merchants m",
                MerchantCards.LATERAL_JOINS,
                where(filters)), cardParams(tenant.timezone(), filters, asOf));
    }

    // ---- one merchant ----------------------------------------------------

    /**
     * The card row plus the profile columns, by public slug or by id. One statement, so the profile and
     * the open/closed verdict cannot be read at two different instants.
     */
    public Optional<Map<String, Object>> merchantRow(TenantContext tenant, String reference, UUID idReference,
                                                     Instant asOf) {
        Map<String, Object> params = new LinkedHashMap<>(MerchantCards.openStateParams(asOf, tenant.timezone()));
        params.put("reference", reference);
        params.put("id_reference", idReference);
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select " + MerchantCards.COLUMNS + ",",
                PROFILE_COLUMNS,
                "from merchants m",
                MerchantCards.LATERAL_JOINS,
                "where m.tenant_id = :tenant_id and m.status = 'published'",
                "  and (m.slug = :reference or m.id = :id_reference)"), params);
    }

    /** The merchant's own taxonomy rows, parent included: {@code categories} is global, so the join anchors on the merchant. */
    public List<Map<String, Object>> categoriesOf(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, String.join("\n",
                "select c.id, c.slug, c.name, c.name_zh, c.kind, pc.slug as parent_slug, pc.name as parent_name",
                "from merchant_categories mc",
                "join categories c on c.id = mc.category_id",
                "left join categories pc on pc.id = c.parent_id",
                "join merchants m on m.id = mc.merchant_id",
                "where mc.merchant_id = :merchant_id and m.tenant_id = :tenant_id",
                "order by c.name"), Json.map("merchant_id", merchantId));
    }

    // ---- reviews (§4, §54, §109) -----------------------------------------

    /**
     * Published reviews only. {@code sort=helpful} orders by the stored {@code helpful_count} column —
     * the platform does not weight, boost or hide a review for any other reason (§66 applies to reviews
     * as it does to listings: spend is not a ranking input).
     */
    public List<Map<String, Object>> reviewRows(TenantContext tenant, UUID merchantId, String orderBy, int limit,
                                                int offset) {
        Map<String, Object> params = Json.map("merchant_id", merchantId, "limit", limit, "offset", offset);
        return jdbc.forTenant(tenant, String.join("\n",
                "select " + REVIEW_COLUMNS,
                "from reviews r",
                "join merchants m on m.id = r.merchant_id",
                "left join users u on u.id = r.user_id",
                "where r.merchant_id = :merchant_id and m.tenant_id = :tenant_id and r.status = 'published'",
                "order by " + orderBy + ", r.id asc",
                "limit :limit offset :offset"), params);
    }

    public long countReviews(TenantContext tenant, UUID merchantId) {
        // `m.tenant_id` is the scope; reviews.tenant_id is the author's tenant, which a merchant's own
        // published reviews are not required to share (imported rows), so it is not the filter here.
        return jdbc.countForTenant(tenant, String.join("\n",
                "select count(*)",
                "from reviews r",
                "join merchants m on m.id = r.merchant_id",
                "where r.merchant_id = :merchant_id and m.tenant_id = :tenant_id and r.status = 'published'"),
                Json.map("merchant_id", merchantId));
    }

    /**
     * The rating histogram and average over published reviews, with the two verification flags the
     * review rows actually carry. This is a recomputation, not a cache: {@code merchants.rating_agg} is
     * a denormalised column and may lag the review table, and the page that shows both must be able to
     * say which one it used.
     */
    public Map<String, Object> reviewStats(TenantContext tenant, UUID merchantId) {
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select count(*) as published_reviews,",
                "       round(avg(r.rating), 2) as average_rating,",
                "       count(*) filter (where r.rating >= 4) as positive_reviews,",
                "       count(*) filter (where r.rating <= 2) as negative_reviews,",
                "       count(*) filter (where r.verified_purchase) as verified_purchase_reviews,",
                "       count(*) filter (where r.verified_reservation) as verified_reservation_reviews,",
                "       max(r.created_at) as latest_review_at,",
                "       m.tenant_id",
                "from reviews r",
                "join merchants m on m.id = r.merchant_id",
                "where r.merchant_id = :merchant_id and m.tenant_id = :tenant_id and r.status = 'published'",
                "group by m.tenant_id"), Json.map("merchant_id", merchantId)).orElse(Map.of());
    }

    /** The distribution over published reviews, one row per star bucket that has any. */
    public List<Map<String, Object>> ratingBuckets(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, String.join("\n",
                "select floor(r.rating)::int as bucket, count(*) as reviews,",
                "       m.tenant_id",
                "from reviews r",
                "join merchants m on m.id = r.merchant_id",
                "where r.merchant_id = :merchant_id and m.tenant_id = :tenant_id and r.status = 'published'",
                "group by 1, m.tenant_id",
                "order by bucket desc"), Json.map("merchant_id", merchantId));
    }

    /**
     * The stored AI summary, if the review agent has written one. {@code review_summaries} has no tenant
     * column (its primary key is the merchant), so the merchant join below is the scope.
     */
    public Optional<Map<String, Object>> reviewSummaryRow(TenantContext tenant, UUID merchantId) {
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select rs.merchant_id, rs.overall, rs.praise, rs.complaints, rs.sample_size, rs.model,",
                "       rs.generated_at, rs.updated_at, m.tenant_id, m.data_origin",
                "from review_summaries rs",
                "join merchants m on m.id = rs.merchant_id",
                "where rs.merchant_id = :merchant_id and m.tenant_id = :tenant_id"),
                Json.map("merchant_id", merchantId));
    }

    // ---- availability (§20, §40) -----------------------------------------

    /**
     * Bookable slots with capacity left. No cache header may be put on this read: a slot is a claim
     * about a moment that someone else may take a second later (§20), so the caller gets the rows and
     * the instant they were true.
     */
    public List<Map<String, Object>> availabilityRows(TenantContext tenant, UUID merchantId, Instant from,
                                                      Instant to, Integer partySize, int limit) {
        Map<String, Object> params = Json.map("merchant_id", merchantId,
                "from_at", Timestamp.from(from), "to_at", Timestamp.from(to), "limit", limit);
        String partyClause = "";
        if (partySize != null) {
            // A slot seats a party only if the leftover capacity covers it; `capacity_total` is the
            // pool's size, which a larger party cannot be squeezed into either.
            params.put("party_size", partySize);
            partyClause = "  and s.capacity_left >= :party_size and s.capacity_total >= :party_size\n";
        }
        return jdbc.forTenant(tenant, String.join("\n",
                "select s.id, s.merchant_id, s.pool_id, s.starts_at, s.ends_at, s.capacity_total,",
                "       s.capacity_left, s.price_amount, s.currency, s.source, s.updated_at,",
                "       p.name as pool_name, p.kind as pool_kind, p.capacity as pool_capacity,",
                "       o.id as offering_id, o.slug as offering_slug, o.name as offering_name,",
                "       m.tenant_id",
                "from availability_slots s",
                "join merchants m on m.id = s.merchant_id",
                // The pool and its offering are anchored to the slot's own merchant, not merely to their
                // primary keys: a row reached through a mismatched join would describe another business.
                "left join resource_pools p on p.id = s.pool_id and p.merchant_id = s.merchant_id",
                "left join offerings o on o.id = p.offering_id and o.merchant_id = s.merchant_id",
                "where s.merchant_id = :merchant_id and m.tenant_id = :tenant_id",
                "  and m.status = 'published'",
                "  and s.starts_at >= :from_at and s.starts_at < :to_at",
                "  and s.capacity_left > 0",
                partyClause,
                "order by s.starts_at asc, s.id asc",
                "limit :limit"), params);
    }

    // ---- the shared WHERE ------------------------------------------------

    /**
     * The published-merchant scope plus the five documented filters. {@link MerchantCards#LATERAL_JOINS}
     * must be present in the statement: {@code loc} is the district filter's target as well as the
     * card's location, which is deliberate — a merchant is listed under the district its own card shows,
     * not under a secondary outlet the page never renders.
     */
    private String where(MerchantFilters f) {
        StringBuilder sql = new StringBuilder("where m.tenant_id = :tenant_id and m.status = 'published'");
        if (f.district() != null) {
            sql.append("\n  and lower(btrim(coalesce(loc.district, ''))) = lower(:district)");
        }
        if (f.category() != null) {
            // Match the printed column *or* the taxonomy (leaf, parent, by slug or by display name):
            // `category_primary` holds a name like `Bubble Tea` while the routes and the AI service use
            // `bubble-tea`, and a filter that answered one form only returned an empty page for the
            // other (D23). Both are real columns of real rows, so neither branch can invent a match.
            sql.append("\n  and (nullif(btrim(coalesce(m.category_primary, '')), '') = :category")
                    .append("\n       or exists (select 1 from merchant_categories mc")
                    .append("\n                  join categories c on c.id = mc.category_id")
                    .append("\n                  left join categories pc on pc.id = c.parent_id")
                    .append("\n                  where mc.merchant_id = m.id")
                    .append("\n                    and (lower(c.slug) = lower(:category)")
                    .append("\n                      or lower(c.name) = lower(:category)")
                    .append("\n                      or lower(pc.slug) = lower(:category)")
                    .append("\n                      or lower(pc.name) = lower(:category))))");
        }
        if (f.maxPrice() != null) {
            // A merchant with no published price is not "cheap": it is unknown, so it does not match.
            sql.append("\n  and m.avg_price_hkd <= :max_price");
        }
        if (f.minRating() != null) {
            sql.append("\n  and m.rating_agg >= :min_rating");
        }
        if (f.openNow()) {
            sql.append("\n  and ").append(MerchantCards.OPEN_NOW);
        }
        return sql.toString();
    }

    /** Parameters for both the listing and its count: the open-state clock plus whichever filters are set. */
    private Map<String, Object> cardParams(String timezone, MerchantFilters f, Instant asOf) {
        Map<String, Object> params = new LinkedHashMap<>(MerchantCards.openStateParams(asOf, timezone));
        if (f.district() != null) {
            params.put("district", f.district());
        }
        if (f.category() != null) {
            params.put("category", f.category());
        }
        if (f.maxPrice() != null) {
            params.put("max_price", f.maxPrice());
        }
        if (f.minRating() != null) {
            params.put("min_rating", f.minRating());
        }
        return params;
    }
}
