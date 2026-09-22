package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPlatformRole;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §9 — the human-review queue: reading it, and closing a case.
 *
 * <p>These two routes are what makes D37's {@code pending} status an honest answer instead of a dead end: a
 * consumer review is stored out of sight until a named person with an audit entry decides otherwise. The
 * decision is written to <em>both</em> rows — the case (who closed it, when, with what note) and the review
 * (what it now is) — because a queue that records resolutions while the content stays pending is a log, not
 * a control.
 *
 * <p>Publishing a review moves an aggregate, so the same call restates the {@code rating} fact beside it
 * (D35/D38): the rendered number and its citation are derived together from the published rows, in the same
 * statement order, and never hand-synced.
 *
 * <p>{@code platform_admin} or {@code platform_ops} only, and the audit trail is written by
 * {@link RequiresPlatformRole}'s interceptor for the access and by this class for the decision itself, so a
 * reviewer's identity is on the record either way. Merchant staff have no route here on purpose: a merchant
 * approving the reviews of their own shop is the conflict §55 exists to avoid.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class ModerationController {

    private static final Set<String> DECISIONS = Set.of("published", "rejected", "flagged");
    private static final Set<String> CASE_STATUSES = Set.of("open", "resolved");
    private static final Set<String> SUBJECT_TYPES = Set.of("review", "merchant", "document", "message",
            "listing");

    /** {@code {decision, note}} — {@code decision} is the review's new status, not a verdict word. */
    public record ResolveBody(String decision, String note) {
    }

    private final AuditService audit;
    private final ModerationRepository queue;
    private final ReviewRepository reviews;
    private final FactRepository facts;
    private final IdempotencyService idempotency;
    private final Paging paging;

    public ModerationController(AuditService audit, ModerationRepository queue, ReviewRepository reviews,
                                FactRepository facts, IdempotencyService idempotency, Paging paging) {
        this.audit = audit;
        this.queue = queue;
        this.reviews = reviews;
        this.facts = facts;
        this.idempotency = idempotency;
        this.paging = paging;
    }

    @GetMapping("/moderation")
    @RequiresPlatformRole
    public Map<String, Object> list(@RequestParam(required = false) String status,
                                    @RequestParam(required = false) String subject_type,
                                    @RequestParam(required = false) String limit,
                                    @RequestParam(required = false) String cursor,
                                    HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        String caseStatus = status == null || status.isBlank() ? null : enumValue(status, CASE_STATUSES, "status");
        String subject = subject_type == null || subject_type.isBlank() ? null
                : enumValue(subject_type, SUBJECT_TYPES, "subject_type");
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);

        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> row : queue.cases(tenant, caseStatus, subject, size, offset)) {
            items.add(caseView(row));
        }
        Map<String, Object> page = paging.page(items, offset, size, queue.countCases(tenant, caseStatus, subject));
        page.put("status", caseStatus == null ? "all" : caseStatus);
        page.put("as_of", Instant.now().toString());
        // What the queue is for, stated where a reader will see it rather than in a doc they have to trust.
        page.put("definition", Json.map(
                "case", "a subject that needs a human decision before consumers see it (§127)",
                "open", "no decision recorded yet; only `open` cases can be resolved",
                "resolved", "a named reviewer closed it; the subject row carries the same decision",
                "publishing_a_review", "moves the merchant's rating and restates the rating fact beside it"));
        return page;
    }

    @PostMapping("/moderation/{id}/resolve")
    @RequiresPlatformRole
    public Map<String, Object> resolve(@PathVariable String id, @RequestBody ResolveBody body,
                                       HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID resolverId = Req.userId(request);
        UUID caseId = Json.uuidOrNull(id) == null
                ? throwBadRequest() : Json.uuidOrNull(id);
        String decision = body.decision() == null ? null : body.decision().trim();
        if (decision == null || !DECISIONS.contains(decision)) {
            throw ApiException.validation("decision must be one of " + DECISIONS,
                    Json.map("field", "decision", "allowed", List.copyOf(DECISIONS)));
        }
        String note = body.note() == null || body.note().isBlank() ? null : body.note().trim();
        if (note != null && note.length() > 500) {
            throw ApiException.validation("note must be at most 500 characters",
                    Json.map("field", "note", "max_length", 500, "received", note.length()));
        }

        Map<String, Object> kase = queue.find(tenant, caseId)
                .orElseThrow(() -> ApiException.notFound("moderation_case_not_found", "No such case in this tenant"));
        if (!"review".equals(Json.str(kase, "subject_type"))) {
            throw ApiException.validation("only review cases can be resolved on this route yet",
                    Json.map("field", "subject_type", "received", Json.str(kase, "subject_type"),
                            "why", "the other subject types have no decision state to write back to "
                                    + "without their own routes (§127)"));
        }
        if (!"open".equals(Json.str(kase, "status"))) {
            throw ApiException.conflict("case_already_resolved", "This case was closed by an earlier decision",
                    Json.map("case_id", caseId.toString(), "resolved_at", Json.ts(kase, "resolved_at")));
        }
        UUID reviewId = Json.uuid(kase, "subject_id");
        Map<String, Object> review = queue.reviewOf(tenant, reviewId)
                .orElseThrow(() -> ApiException.notFound("review_not_found", "No such review in this tenant"));

        return idempotency.run("moderation_resolve", request.getHeader("Idempotency-Key"), resolverId, () ->
                close(tenant, request, caseId, reviewId, review, resolverId, decision, note));
    }

    private Map<String, Object> close(TenantContext tenant, HttpServletRequest request, UUID caseId,
                                      UUID reviewId, Map<String, Object> review, UUID resolverId,
                                      String decision, String note) {
        Map<String, Object> before = Json.map("review_status", Json.str(review, "status"),
                "case_status", "open");
        queue.decideReview(tenant, reviewId, decision, resolverId, note, decision);
        // Guarded on `status = 'open'` in the statement: the second of two simultaneous reviewers gets 0 and
        // must not believe they decided anything.
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
            // the published rows, in the same call that made those rows change (D35/D38).
            reviews.refreshRating(tenant, facts, "merchant", merchantId, merchantId);
            restated.add("merchant rating");
            UUID offeringId = Json.uuid(review, "offering_id");
            if (offeringId != null) {
                reviews.refreshRating(tenant, facts, "offering", offeringId, merchantId);
                restated.add("offering rating");
            }
        }

        audit(request, caseId, merchantId, before, reviewId, decision, note, restated);
        Map<String, Object> after = Json.map("review_status", decision, "case_status", "resolved");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("case_id", caseId.toString());
        out.put("review_id", reviewId.toString());
        out.put("decision", decision);
        out.put("resolved_at", Instant.now().toString());
        out.put("resolved_by", resolverId.toString());
        out.put("aggregate_restated", restated);
        out.put("before", before);
        out.put("after", after);
        out.put("note", "published".equals(decision)
                ? "The review is now readable on the merchant's public page and counted in its rating."
                : "The review stays hidden from consumers; the rating and its fact are unchanged.");
        return out;
    }

    /**
     * The decision belongs in {@code audit_logs} as well as on the two rows: {@code moderation_cases} says
     * who closed a case, and this says what the reviewer believed they were changing. A stub here that
     * quietly skipped the call would leave the class comment claiming a record that did not exist.
     */
    private void audit(HttpServletRequest request, UUID caseId, UUID merchantId, Map<String, Object> before,
                       UUID reviewId, String decision, String note, List<String> restated) {
        audit.record(request, "moderation_resolve", "moderation_case", caseId, merchantId, before,
                Json.map("review_id", reviewId.toString(), "review_status", decision),
                Json.map("decision", decision, "note", note == null ? "" : note,
                        "aggregate_restated", restated));
    }

    private static Map<String, Object> caseView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("case_id", Json.str(row, "id"));
        out.put("subject_type", Json.str(row, "subject_type"));
        out.put("subject_id", Json.str(row, "subject_id"));
        out.put("reason", Json.str(row, "reason"));
        out.put("policy", Json.str(row, "policy"));
        out.put("auto_action", Json.str(row, "auto_action"));
        out.put("status", Json.str(row, "status"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("resolved_at", Json.ts(row, "resolved_at"));
        out.put("resolution", Json.jsonObject(row, "resolution"));
        boolean known = Json.str(row, "review_status") != null;
        out.put("subject_known", known);
        if (known) {
            out.put("subject", Json.map(
                    "review_id", Json.str(row, "subject_id"),
                    "rating", Json.dec(row, "review_rating"),
                    "excerpt", Json.str(row, "review_excerpt"),
                    "language", Json.str(row, "language"),
                    "status", Json.str(row, "review_status"),
                    "data_origin", Json.str(row, "review_origin"),
                    "merchant", Json.map("id", Json.str(row, "review_merchant_id"),
                            "slug", Json.str(row, "merchant_slug"),
                            "name", Json.str(row, "merchant_name"))));
        }
        return out;
    }

    private static String enumValue(String raw, Set<String> allowed, String field) {
        String value = raw.trim().toLowerCase();
        if (!allowed.contains(value)) {
            List<String> sorted = new ArrayList<>(allowed);
            sorted.sort(String::compareTo);
            throw ApiException.validation(field + " must be one of " + sorted,
                    Json.map("field", field, "allowed", sorted));
        }
        return value;
    }

    private static UUID throwBadRequest() {
        throw ApiException.validation("id must be a uuid", Json.map("field", "id"));
    }
}
