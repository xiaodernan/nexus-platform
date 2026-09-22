package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The consumer's own write to the review surface (API_CONTRACT §6, spec §55). It is the one route in
 * {@code com.nexus.catalog} that inserts, which is why {@link CatalogController} can say "none of them
 * writes" and this class exists apart from it.
 *
 * <p>What a posted review becomes, and why:
 * <ul>
 *   <li><b>{@code pending}.</b> User-generated content reaches a stranger only past a human decision
 *       (§55/§127), and this build has no automated abuse filter, so writing {@code published} would make
 *       the public rating whoever-typed-fastest's rating. The author sees the row in this response; the
 *       merchant's {@code /reviews} page does not, because that read filters on {@code status = 'published'}.</li>
 *   <li><b>It changes no number.</b> {@code rating_agg} and the {@code rating} fact beside it are computed
 *       over published rows (D35), so a queued review moves nothing — {@code aggregate_changed} says so on
 *       the face of the response. Publishing one is the moment both must be restated, and there is
 *       deliberately no route here that does it.</li>
 *   <li><b>The visit badges are derived.</b> {@code verified_purchase} and {@code verified_reservation} come
 *       from this caller's own order and reservation rows at this merchant. The request cannot set them, and
 *       the response prints the predicate it used, so a tick never means more than the row behind it.</li>
 * </ul>
 *
 * <p>{@code Idempotency-Key} is required: a double-tapped submit must create one review and one moderation
 * case, not two of each.
 */
@RestController
@RequestMapping("/api/v1/merchants")
public class ReviewController {

    private static final int BODY_MIN = 20;
    private static final int BODY_MAX = 2000;
    private static final int TITLE_MAX = 120;
    private static final List<String> LANGUAGES = List.of("en", "zh-HK", "zh-CN");

    /**
     * The body is validated here rather than by bean-validation annotations so the 422 carries the field name
     * and the limit the caller broke — {@code details.field} plus {@code min_length}/{@code max_length} —
     * which is what lets a form say 「再多寫幾個字」 instead of showing a server error.
     */
    public record ReviewBody(Double rating, String body, String title, String language, String offering_id) {
    }

    private final CatalogRepository catalog;
    private final ReviewRepository reviews;
    private final IdempotencyService idempotency;

    public ReviewController(CatalogRepository catalog, ReviewRepository reviews, IdempotencyService idempotency) {
        this.catalog = catalog;
        this.reviews = reviews;
        this.idempotency = idempotency;
    }

    @PostMapping("/{idOrSlug}/reviews")
    @RequiresAuth
    @com.nexus.platform.Idempotent(scope = "review")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> add(@PathVariable String idOrSlug, @RequestBody ReviewBody body,
                                   HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        UUID reference = Json.uuidOrNull(idOrSlug);
        Instant asOf = Instant.now();
        Map<String, Object> merchant = catalog.merchantRow(tenant, idOrSlug,
                reference == null ? new UUID(0, 0) : reference, asOf)
                .orElseThrow(() -> ApiException.notFound("merchant_not_found", "No such merchant"));
        UUID merchantId = Json.uuid(merchant, "id");

        double rating = requireRating(body.rating());
        String text = requireBody(body.body());
        String title = requireTitle(body.title());
        String language = requireLanguage(body.language());
        UUID offeringId = requireOffering(tenant, merchantId, body.offering_id());

        return idempotency.run("review", request.getHeader("Idempotency-Key"), userId, () ->
                write(tenant, merchant, merchantId, userId, offeringId, rating, title, text, language));
    }

    private Map<String, Object> write(TenantContext tenant, Map<String, Object> merchant, UUID merchantId,
                                      UUID userId, UUID offeringId, double rating, String title, String body,
                                      String language) {
        Map<String, Object> existing = reviews.openReviewBy(tenant, merchantId, userId).orElse(null);
        if (existing != null) {
            // 409, not a second row: this account already has a voice at this place, and a second review
            // would double-weight one opinion inside an aggregate that claims to count people.
            throw ApiException.conflict("review_exists",
                    "You already have a review of this place that has not been rejected",
                    Json.map("review_id", Json.str(existing, "id"), "status", Json.str(existing, "status")));
        }
        boolean attended = reviews.attended(tenant, merchantId, userId);
        boolean purchased = reviews.purchased(tenant, merchantId, userId);
        Map<String, Object> inserted = reviews.insert(tenant, merchantId, userId, offeringId, rating, title, body,
                language, purchased, attended);
        UUID reviewId = Json.uuid(inserted, "id");
        // §127: a pending row with no case in the queue is a review that will never be read by anyone.
        reviews.queueModeration(tenant, reviewId);

        Map<String, Object> stored = reviews.find(tenant, reviewId)
                .orElseThrow(() -> ApiException.internal("review vanished after insert", null));
        Map<String, Object> out = new LinkedHashMap<>(CatalogController.reviewView(stored));
        // The read projection has no `status`, because every row it serves is published by definition. A
        // write response without it would leave the author holding a review id and no idea whether anyone
        // can see it — which is the whole question this route's design turns on.
        out.put("status", Json.str(stored, "status"));
        out.put("status_note", "queued for a human decision (§55/§127): visible to you and to the moderation "
                + "queue, and to no consumer page.");
        out.put("aggregate_changed", false);
        out.put("verification_basis", Json.map(
                "verified_reservation", "this caller holds a reservation at this merchant with status in ("
                        + ReviewRepository.ATTENDED_STATUSES + ")",
                "verified_purchase", "this caller holds an order at this merchant with status in ("
                        + ReviewRepository.PAID_STATUSES + ")"));
        out.put("merchant", Json.map("id", merchantId.toString(), "slug", Json.str(merchant, "slug")));
        out.put("as_of", Instant.now().toString());
        return out;
    }

    // ---- validation -------------------------------------------------------

    private static double requireRating(Double raw) {
        if (raw == null) {
            throw ApiException.validation("rating is required", Json.map("field", "rating"));
        }
        if (raw < 1 || raw > 5) {
            throw ApiException.validation("rating must be between 1 and 5",
                    Json.map("field", "rating", "min", 1, "max", 5, "received", raw));
        }
        double tenth = Math.round(raw * 10) / 10.0;
        if (Math.abs(tenth - raw) > 1e-9) {
            throw ApiException.validation("rating is stored to one decimal place, so " + raw
                    + " is refused rather than quietly rounded", Json.map("field", "rating", "received", raw));
        }
        return raw;
    }

    private static String requireBody(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.length() < BODY_MIN) {
            throw ApiException.validation("body must be at least " + BODY_MIN + " characters — a star with no "
                    + "sentence behind it tells the next reader nothing",
                    Json.map("field", "body", "min_length", BODY_MIN, "received", value.length()));
        }
        if (value.length() > BODY_MAX) {
            throw ApiException.validation("body must be at most " + BODY_MAX + " characters",
                    Json.map("field", "body", "max_length", BODY_MAX, "received", value.length()));
        }
        return value;
    }

    private static String requireTitle(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.trim();
        if (value.length() > TITLE_MAX) {
            throw ApiException.validation("title must be at most " + TITLE_MAX + " characters",
                    Json.map("field", "title", "max_length", TITLE_MAX, "received", value.length()));
        }
        return value;
    }

    private static String requireLanguage(String raw) {
        if (raw == null || raw.isBlank()) {
            return "zh-HK";                    // V1's column default for this market, stated rather than hidden
        }
        String value = raw.trim();
        if (!LANGUAGES.contains(value)) {
            throw ApiException.validation("language must be one of " + LANGUAGES,
                    Json.map("field", "language", "allowed", LANGUAGES, "received", value));
        }
        return value;
    }

    /**
     * An optional offering citation must belong to this merchant. A review pointing at another shop's dish
     * would render a link that goes nowhere, and would make 「這條評論是關於這個套餐」 false about the page
     * showing it.
     */
    private UUID requireOffering(TenantContext tenant, UUID merchantId, String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        UUID id = Json.uuidOrNull(raw);
        if (id == null) {
            throw ApiException.validation("offering_id must be a uuid",
                    Json.map("field", "offering_id", "received", raw));
        }
        if (!reviews.offeringBelongs(tenant, merchantId, id)) {
            throw ApiException.validation("offering_id is not on this merchant's menu",
                    Json.map("field", "offering_id", "merchant_id", merchantId.toString()));
        }
        return id;
    }
}
