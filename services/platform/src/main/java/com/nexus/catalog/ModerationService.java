package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The one transactional write behind a moderation decision (API_CONTRACT §9, spec §55/§127).
 *
 * <p>A decision is four statements — the review's status, the case's closure, the merchant's rating and its
 * fact (plus the offering's, for a review that cites a dish) — and a reader can see the card in between any
 * two of them. That is not a theoretical window: running the lifecycle walk against a seeded database
 * produced a profile printing one rating while its citation carried another, which is the exact defect D35
 * and D38 exist to prevent, arriving through the door D39 opened.
 *
 * <p>So the writes happen together or not at all. The case close is still guarded in its own statement
 * ({@code where status = 'open'}) so a concurrent reviewer cannot overwrite a decision; the row count tells
 * this method whether it won, and a loss rolls everything back rather than leaving the review published
 * against a case somebody else closed.
 */
@Service
public class ModerationService {

    private final ModerationRepository queue;
    private final ReviewRepository reviews;
    private final FactRepository facts;

    public ModerationService(ModerationRepository queue, ReviewRepository reviews, FactRepository facts) {
        this.queue = queue;
        this.reviews = reviews;
        this.facts = facts;
    }

    @Transactional
    public Map<String, Object> resolve(TenantContext tenant, UUID caseId, Map<String, Object> review,
                                       UUID reviewId, UUID resolverId, String decision, String note) {
        queue.decideReview(tenant, reviewId, decision, resolverId, note);
        int closed = queue.closeCase(tenant, caseId, resolverId, Json.map(
                "decision", decision, "note", note == null ? "" : note, "by", resolverId.toString()));
        if (closed == 0) {
            throw ApiException.conflict("case_already_resolved",
                    "Another reviewer closed this case first; the decision on the review is theirs",
                    Json.map("case_id", caseId.toString()));
        }

        UUID merchantId = Json.uuid(review, "merchant_id");
        List<String> restated = new ArrayList<>();
        if ("published".equals(decision)) {
            // The number a card prints and the fact that cites it are one claim: recompute together, from
            // the published rows, inside the same transaction that made those rows change (D35/D38).
            reviews.refreshRating(tenant, facts, "merchant", merchantId, merchantId);
            restated.add("merchant rating");
            UUID offeringId = Json.uuid(review, "offering_id");
            if (offeringId != null) {
                reviews.refreshRating(tenant, facts, "offering", offeringId, merchantId);
                restated.add("offering rating");
            }
        }
        return Json.map("case_id", caseId.toString(), "review_id", reviewId.toString(), "decision", decision,
                "resolved_by", resolverId.toString(), "aggregate_restated", restated);
    }
}
