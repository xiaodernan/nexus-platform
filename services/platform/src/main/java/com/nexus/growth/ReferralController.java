package com.nexus.growth;

import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code /api/v1/referrals/**} — consumer/merchant/creator referral invites (API_CONTRACT §8,
 * spec §59-§62). Every route here is authenticated as a user: the referrer on a row is the
 * caller's own account ({@code referrer_type = 'user'}), never a guessed identity.
 *
 * <p>The honesty rule that shapes this whole controller (§110, restated in DECISIONS D6): an
 * invite is only an invite. {@code reward} is written as {@code {}} and stays empty until a
 * verified conversion moves the status — no endpoint in this class can advance a status, pay a
 * reward, or count a signup.
 */
@RestController
@RequestMapping("/api/v1/referrals")
@RequiresAuth
public class ReferralController {

    /** Body of {@code POST /api/v1/referrals/invite {kind,email}} (API_CONTRACT §8). */
    public record InviteBody(@NotBlank @Pattern(regexp = "^(consumer|merchant|creator)$") String kind,
                             @NotBlank @Size(max = 254)
                             @Pattern(regexp = "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$") String email) {
    }

    /** Unambiguous alphabet (no 0/O, 1/I): codes are read back by humans. */
    private static final char[] CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private final ReferralRepository referrals;
    private final Paging paging;
    private final AuditService audit;

    public ReferralController(ReferralRepository referrals, Paging paging, AuditService audit) {
        this.referrals = referrals;
        this.paging = paging;
        this.audit = audit;
    }

    @PostMapping("/invite")
    public Map<String, Object> invite(@Valid @RequestBody InviteBody body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        String email = body.email().trim().toLowerCase();

        var existing = referrals.openInviteForEmail(tenant, userId, email);
        Map<String, Object> row;
        boolean reused;
        if (existing.isPresent()) {
            row = existing.get();
            reused = true; // a double-click replays the open invite instead of sending a second one
        } else {
            row = referrals.insertInvite(tenant, userId, body.kind(), email, newCode());
            reused = false;
            audit.record(request, "referral_invite", "referral", Json.uuid(row, "id"), null, null, null,
                    Json.map("kind", body.kind()));
        }
        Map<String, Object> out = new LinkedHashMap<>(referralView(row));
        out.put("status_note", reused
                ? "An open invite to this address already exists; the same code was returned (§110: "
                + "repeats do not create extra funnel rows)."
                : "Invitation recorded. No reward is attached until a verified conversion happens (§110).");
        return out;
    }

    /** {@code GET /api/v1/referrals/me} — the caller's own invite history, cursor-paginated. */
    @GetMapping("/me")
    public Map<String, Object> me(@RequestParam(required = false) String limit,
                                  @RequestParam(required = false) String cursor,
                                  HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);
        List<Map<String, Object>> items = referrals.listByReferrer(tenant, userId, size, offset).stream()
                .map(ReferralController::referralView)
                .toList();
        Map<String, Object> page = paging.page(items, offset, size, referrals.countByReferrer(tenant, userId));
        page.put("referrer_id", userId.toString());
        return page;
    }

    /**
     * {@code GET /api/v1/referrals/me/stats} — funnel counts over {@code window_days} plus earned
     * value, sourced and defined in the payload itself (every number states where it came from).
     */
    @GetMapping("/me/stats")
    public Map<String, Object> stats(@RequestParam(required = false, defaultValue = "90") Integer window_days,
                                     HttpServletRequest request) {
        if (window_days == null || window_days < 1 || window_days > 3650) {
            throw com.nexus.platform.ApiException.validation("window_days must be between 1 and 3650",
                    Json.map("field", "window_days"));
        }
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        Map<String, Object> row = referrals.statsFor(tenant, userId, window_days);
        BigDecimal earned = row == null ? BigDecimal.ZERO : Json.dec(row, "earned_amount");
        String currency = row == null ? null : Json.str(row, "earned_currency");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("invited", row == null ? 0 : Json.longOf(row, "invited"));
        out.put("signed_up", row == null ? 0 : Json.longOf(row, "signed_up"));
        out.put("first_value", row == null ? 0 : Json.longOf(row, "first_value"));
        out.put("rewarded", row == null ? 0 : Json.longOf(row, "rewarded"));
        out.put("expired", row == null ? 0 : Json.longOf(row, "expired"));
        out.put("earned", Json.money(earned == null ? BigDecimal.ZERO : earned,
                currency == null || currency.isBlank() ? tenant.currency() : currency));
        out.put("window_days", window_days);
        out.put("source", "referrals");
        out.put("definitions", Json.map(
                "invited", "all invites created in the window (status buckets below are disjoint)",
                "signed_up/first_value/rewarded/expired", "rows whose stored status is exactly that value",
                "earned", "sum(referrals.reward->>'amount') over status='rewarded' rows; rewards are "
                        + "written only on genuine conversion (§110), so 0.00 is a real state, not a placeholder"));
        return out;
    }

    // ---- helpers ---------------------------------------------------------

    private static Map<String, Object> referralView(Map<String, Object> r) {
        return Json.map(
                "id", Json.str(r, "id"),
                "tenant_id", Json.str(r, "tenant_id"),
                "kind", Json.str(r, "kind"),
                "referrer_type", Json.str(r, "referrer_type"),
                "referrer_id", Json.str(r, "referrer_id"),
                "invitee_email", Json.str(r, "invitee_email"),
                "invitee_id", Json.str(r, "invitee_id"),
                "code", Json.str(r, "code"),
                "status", Json.str(r, "status"),
                "reward", Json.json(r, "reward"),
                "created_at", Json.ts(r, "created_at"),
                "converted_at", Json.ts(r, "converted_at"));
    }

    private static String newCode() {
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) {
            sb.append(CODE_ALPHABET[RANDOM.nextInt(CODE_ALPHABET.length)]);
        }
        return sb.toString();
    }
}
