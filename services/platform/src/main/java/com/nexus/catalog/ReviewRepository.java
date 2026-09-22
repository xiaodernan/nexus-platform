package com.nexus.catalog;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * The consumer's write door to {@code reviews} (API_CONTRACT §6, spec §55), and the moderation case that
 * comes with it.
 *
 * <p>Three rules shape this class, and all three exist because the alternative is a lie the platform would
 * tell about itself:
 * <ul>
 *   <li><b>A new review is {@code pending}, never {@code published}.</b> §55/§127 put user-generated content
 *       in front of a human before it is shown to anyone, and there is no automated abuse filter in this
 *       build — publishing on write would mean every consumer page is edited by whoever types fastest. The
 *       row is readable by its author (the response echoes it) and by nobody else: {@code /reviews} filters
 *       on {@code status = 'published'}.</li>
 *   <li><b>It does not move the rating.</b> A rendered aggregate and the {@code rating} fact behind it are
 *       computed over published rows only (D35), so a queued review changes no number anywhere. When a human
 *       publishes one, both must be restated — that is the same invariant a merchant edit has to honour
 *       (D25), not a new one.</li>
 *   <li><b>The visit badges are derived, never declared.</b> {@code verified_purchase} and
 *       {@code verified_reservation} come from this schema's own order and reservation rows for this caller
 *       at this merchant. A reviewer cannot claim them, and the response says exactly which statuses
 *       counted, so a badge never means more than the row behind it.</li>
 * </ul>
 */
@Repository
public class ReviewRepository {

    /** A booking that took place. A cancelled hold is evidence of a change of mind, not of a visit. */
    static final String ATTENDED_STATUSES = "'confirmed','completed'";
    /** Money that moved and was not given back. */
    static final String PAID_STATUSES = "'paid','preparing','completed'";

    /** A rating is derived from rows that change rarely enough to re-check daily (AGENT_CONTRACT §5). */
    static final Duration RATING_TTL = Duration.ofHours(24);

    /** The review columns, in the order {@link CatalogController#reviewView} reads them. */
    private static final String COLUMNS = """
            select r.id, r.tenant_id, r.merchant_id, r.offering_id, r.user_id, r.rating, r.title, r.body,
                   r.language, r.photos, r.aspects, r.verified_purchase, r.verified_reservation, r.data_origin,
                   r.status, r.moderation, r.helpful_count, r.created_at, r.updated_at
            """;

    private final TenantJdbc jdbc;

    public ReviewRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Store the review. {@code data_origin} is the literal {@code 'user'} — this is a person's own account,
     * not synthetic content (§109 marks the difference, and §19 makes it unlosable) — and {@code status} is
     * the literal {@code 'pending'} for the reason in the class comment.
     */
    public Map<String, Object> insert(TenantContext tenant, UUID merchantId, UUID userId, UUID offeringId,
                                      double rating, String title, String body, String language,
                                      boolean verifiedPurchase, boolean verifiedReservation) {
        return jdbc.insertForTenant(tenant, """
                insert into reviews (tenant_id, merchant_id, offering_id, user_id, rating, title, body, language,
                                     verified_purchase, verified_reservation, data_origin, status, moderation)
                values (:tenant_id, :merchant_id, cast(:offering_id as uuid), :user_id, :rating, :title, :body,
                        :language, :verified_purchase, :verified_reservation, 'user', 'pending',
                        cast(:moderation as jsonb))
                returning id, status, data_origin, verified_purchase, verified_reservation, helpful_count,
                          created_at, updated_at
                """, Json.map("merchant_id", merchantId, "user_id", userId, "offering_id", offeringId,
                "rating", rating, "title", title, "body", body, "language", language,
                "verified_purchase", verifiedPurchase, "verified_reservation", verifiedReservation,
                "moderation", Json.write(Json.map("queued_by", "consumer_write",
                        "rule", "spec §55: user-generated reviews are published by a human"))));
    }

    /** The row as it now stands, for the replay path: a repeated call returns what it created, not a new one. */
    public Optional<Map<String, Object>> find(TenantContext tenant, UUID reviewId) {
        return jdbc.firstForTenant(tenant, COLUMNS + """
                from reviews r join merchants m on m.id = r.merchant_id
                where r.id = :review_id and m.tenant_id = :tenant_id
                """, Json.map("review_id", reviewId));
    }

    /** The author's own queue, so the app can show "3 of your reviews are awaiting review". */
    public java.util.List<Map<String, Object>> byAuthor(TenantContext tenant, UUID userId, int limit) {
        return jdbc.forTenant(tenant, COLUMNS + """
                from reviews r join merchants m on m.id = r.merchant_id
                where r.user_id = :user_id and m.tenant_id = :tenant_id and r.status = 'pending'
                order by r.created_at desc limit :lim
                """, Json.map("user_id", userId, "lim", limit));
    }

    /**
     * One voice per person per place. Two kinds of row are excluded, for two reasons.
     *
     * <p>A {@code rejected} review is a judgement about that text, not a permanent silence, so the author
     * may try again. And a {@code demo} row is not anybody's voice at all: the synthetic corpus attributes
     * thousands of published reviews to the demo accounts it also lets you log in as, so counting them here
     * would mean no demo user could ever post a review anywhere in the dataset — an honest route that nobody
     * can reach is still a dead route. The synthetic rows keep appearing in the aggregate, because that is
     * what the demo dataset is, and they are marked {@code data_origin='demo'} while they do.
     */
    public Optional<Map<String, Object>> openReviewBy(TenantContext tenant, UUID merchantId, UUID userId) {
        return jdbc.firstForTenant(tenant, """
                select r.id, r.status, r.created_at from reviews r join merchants m on m.id = r.merchant_id
                where r.merchant_id = :merchant_id and r.user_id = :user_id and m.tenant_id = :tenant_id
                  and r.status <> 'rejected' and r.data_origin <> 'demo'
                order by r.created_at desc limit 1
                """, Json.map("merchant_id", merchantId, "user_id", userId));
    }

    /** §127: the human-review queue. A pending row with no case in it is a review nobody will ever read. */
    public void queueModeration(TenantContext tenant, UUID reviewId) {
        jdbc.insertForTenant(tenant, """
                insert into moderation_cases (tenant_id, subject_type, subject_id, reason, policy, auto_action,
                                              status)
                values (:tenant_id, 'review', :review_id, 'user_submitted review awaiting first publication',
                        '§55/§127: user-generated content is shown only after a human decision', 'none', 'open')
                returning id, status
                """, Json.map("review_id", reviewId));
    }

    /** Did this caller book a place that happened? Derived from reservation rows, never from the request. */
    public boolean attended(TenantContext tenant, UUID merchantId, UUID userId) {
        return jdbc.countForTenant(tenant, String.join("\n",
                "select count(*) from reservations r join merchants m on m.id = r.merchant_id",
                "where r.merchant_id = :merchant_id and r.user_id = :user_id and m.tenant_id = :tenant_id",
                "  and r.status in (" + ATTENDED_STATUSES + ")"),
                Json.map("merchant_id", merchantId, "user_id", userId)) > 0;
    }

    /** Did this caller buy something here and keep it? Derived from order rows against this merchant. */
    public boolean purchased(TenantContext tenant, UUID merchantId, UUID userId) {
        return jdbc.countForTenant(tenant, String.join("\n",
                "select count(*) from orders o join merchants m on m.id = o.merchant_id",
                "where o.merchant_id = :merchant_id and o.user_id = :user_id and m.tenant_id = :tenant_id",
                "  and o.status in (" + PAID_STATUSES + ")"),
                Json.map("merchant_id", merchantId, "user_id", userId)) > 0;
    }

    /** The offering must be the merchant's own, or the review would cite a dish this place never served. */
    public boolean offeringBelongs(TenantContext tenant, UUID merchantId, UUID offeringId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from offerings o join merchants m on m.id = o.merchant_id
                where o.id = :offering_id and o.merchant_id = :merchant_id and m.tenant_id = :tenant_id
                """, Json.map("offering_id", offeringId, "merchant_id", merchantId)) > 0;
    }

    /**
     * Recompute the rating of a subject from the rows that actually count, and restate the fact beside it.
     *
     * <p>This is the step D35's whole rule depends on and the one D38 only made possible: an aggregate
     * column and its citation are not two facts to keep in sync by hand, they are one claim, so they are
     * derived together, here, from {@code status = 'published'} rows. The SQL is deliberately
     * {@code round(avg(rating), 2)} — the same expression {@code quality.sql} re-derives and the same
     * half-away-from-zero rounding the seed now uses (D35), so a live recompute and a seeded value cannot
     * come apart by a cent.
     *
     * <p>A subject with no published reviews gets {@code 0.00 / 0} and no fact: absence is not a rating of
     * zero. The upsert keeps one row per claim, which V5 now enforces and D36 checks.
     */
    public void refreshRating(TenantContext tenant, FactRepository facts, String subjectType, UUID subjectId,
                              UUID merchantId) {
        boolean isMerchant = "merchant".equals(subjectType);
        String column = isMerchant ? "merchant_id" : "offering_id";
        String target = isMerchant ? "merchants" : "offerings";
        Map<String, Object> aggregate = jdbc.oneForTenant(tenant, """
                select coalesce(round(avg(r.rating), 2), 0) as value, count(r.id) as n,
                       max(r.created_at) as through_at
                from reviews r join merchants m on m.id = r.merchant_id
                where r.""" + column + """
                   = :subject_id and m.tenant_id = :tenant_id and r.status = 'published'
                """, Json.map("subject_id", subjectId), "subject_not_found");
        jdbc.updateForTenant(tenant, "update " + target
                + " set rating_agg = :value, review_count = :n"
                + " where id = :subject_id and tenant_id = :tenant_id",
                Json.map("subject_id", subjectId, "tenant_id", tenant.tenantId(),
                        "value", aggregate.get("value"), "n", aggregate.get("n")));

        long n = ((Number) aggregate.get("n")).longValue();
        if (n == 0) {
            facts.drop(tenant, subjectType, subjectId, "rating");
            return;
        }
        facts.record(tenant, subjectType, subjectId, merchantId, "rating",
                Json.map("value", aggregate.get("value"), "count", n, "max_score", 5,
                        "method", "mean_of_published_reviews",
                        // An ISO instant, the same shape every read surfaces timestamps in; the raw
                        // driver's Timestamp would serialise as a JVM-localised string.
                        "reviewed_through", aggregate.get("through_at") instanceof java.sql.Timestamp at
                                ? at.toInstant().toString() : null),
                null, null, "observed", confidenceFor((int) n), RATING_TTL);
    }

    /**
     * How much a mean over {@code n} reviews is worth — the same three bands the seeded corpus writes
     * (D35), because a confidence that depends on who wrote the row is not a confidence.
     */
    static double confidenceFor(int n) {
        if (n < 5) {
            return 0.7;
        }
        if (n < 50) {
            return 0.8;
        }
        return 0.9;
    }
}
