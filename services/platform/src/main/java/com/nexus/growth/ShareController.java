package com.nexus.growth;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/v1/share} and its resolver — the short link and Open Graph payload of §8, and the last
 * documented route in this build that had no implementation.
 *
 * <p>It was blocked on a table rather than on code: §8 has promised "short link + OG payload" since the
 * contract was written, and V1–V6 never created one to hold the link. {@code V7__share_links.sql} is that
 * table, and the three constraints it carries are the design — a globally unique code (the stranger holding
 * it knows nothing about tenants), one <em>live</em> link per subject (so re-sharing is idempotent instead
 * of minting a second address), and no counter write on the resolver (a GET that writes cannot be cached).
 *
 * <p><strong>Anonymous sharing is allowed, deliberately.</strong> §60 wants a first-time visitor who just
 * found a place to be able to send it to a friend; requiring a session at that exact moment is where a
 * viral loop dies. What keeps it honest is that the <em>subject</em> must already be public in the caller's
 * own tenant — a draft merchant, a foreign tenant's merchant and an unpublished guide all answer the same
 * 404 — so the route mints addresses to pages that already exist and reveals nothing that page does not.
 * When a caller is signed in, {@code created_by} records who minted it.
 *
 * <p>{@code GET /api/v1/share/{code}} exists because the short URL has to open something. A link the
 * platform hands out but cannot resolve is exactly the §155 failure — advertising an address nothing
 * answers — and it is the reason this route is documented in §8 rather than left as a 404 surface.
 */
@RestController
@RequestMapping("/api/v1/share")
public class ShareController {

    /** Crockford base32 without I, L, O and U — the four characters people mistype or read as words. */
    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final int CODE_LENGTH = 10;
    private static final List<String> SUBJECT_TYPES = List.of("merchant", "offering", "collection", "guide");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final ShareRepository shares;
    private final AuditService audit;
    private final String siteUrl;

    public ShareController(ShareRepository shares, AuditService audit,
                           @Value("${nexus.public-site-url:http://localhost:3000}") String siteUrl) {
        this.shares = shares;
        this.audit = audit;
        this.siteUrl = siteUrl == null || siteUrl.isBlank() ? "" : siteUrl.replaceAll("/+$", "");
    }

    /**
     * Mints a link, or returns the one this subject already has. 201 when a link was created, 200 when an
     * existing one is handed back — the caller can tell the two apart, and neither is an error.
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> share(@RequestBody Map<String, Object> body,
                                                     HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Principal principal = Req.principalOrNull(request);
        String subjectType = subjectType(body.get("subject_type"));
        UUID subjectId = requireUuid(body.get("subject_id"), "subject_id");

        Map<String, Object> target = shares.subject(tenant, subjectType, subjectId)
                .orElseThrow(() -> ApiException.notFound("subject_not_shareable",
                        "No public " + subjectType + " with that id in this tenant"));

        var existing = shares.liveForSubject(tenant, subjectType, subjectId);
        if (existing.isPresent()) {
            return ResponseEntity.ok(payload(tenant, existing.get(), target, false));
        }

        UUID createdBy = principal == null ? null : principal.userId();
        Map<String, Object> row;
        try {
            row = shares.insert(tenant, newCode(), subjectType, subjectId, createdBy);
        } catch (DuplicateKeyException e) {
            // Two shares of one subject raced, or the random code collided. Either way the answer is the
            // link that now exists, not a 500 — and if it was a code collision the retry is a fresh code.
            row = shares.liveForSubject(tenant, subjectType, subjectId)
                    .orElseGet(() -> shares.insert(tenant, newCode(), subjectType, subjectId, createdBy));
        }

        audit.record(request, "create_share_link", subjectType, subjectId, null, null,
                Json.map("code", Json.str(row, "code"), "path", Json.str(target, "path")), null);
        return ResponseEntity.status(HttpStatus.CREATED).body(payload(tenant, row, target, true));
    }

    /**
     * Resolves a code to what it points at. Unknown, revoked and other-tenant codes all answer 404: a
     * stranger holding a dead link learns that it is dead, and learns nothing else.
     */
    @GetMapping("/{code}")
    public Map<String, Object> resolve(@PathVariable String code, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> row = shares.resolve(tenant, code)
                .orElseThrow(() -> ApiException.notFound("share_link_not_found", "No live share link with that code"));
        String subjectType = Json.str(row, "subject_type");
        UUID subjectId = Json.uuid(row, "subject_id");
        // A link whose subject stopped being public is not silently redirected: the resolution reports the
        // absence, which is what lets the edge render an honest "this page is no longer available".
        Map<String, Object> target = shares.subject(tenant, subjectType, subjectId).orElse(null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", Json.str(row, "code"));
        out.put("subject_type", subjectType);
        out.put("subject_id", subjectId);
        out.put("resolved", target != null);
        out.put("target_path", target == null ? null : Json.str(target, "path"));
        out.put("target_url", target == null ? null : siteUrl + Json.str(target, "path"));
        out.put("og", og(target));
        out.put("created_at", Json.ts(row, "created_at"));
        if (target == null) {
            out.put("reason", "subject_no_longer_public");
        }
        return out;
    }

    // ==================================================================== payload

    private Map<String, Object> payload(TenantContext tenant, Map<String, Object> row, Map<String, Object> target,
                                        boolean created) {
        String code = Json.str(row, "code");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", code);
        out.put("short_url", siteUrl + "/s/" + code);
        out.put("target_path", Json.str(target, "path"));
        out.put("target_url", siteUrl + Json.str(target, "path"));
        out.put("subject_type", Json.str(row, "subject_type"));
        out.put("subject_id", Json.uuid(row, "subject_id"));
        out.put("og", og(target));
        out.put("created", created);
        out.put("links_for_subject", shares.countForSubject(tenant, Json.str(row, "subject_type"),
                Json.uuid(row, "subject_id")));
        return out;
    }

    /**
     * The Open Graph payload, built only from columns that exist. {@code description} and {@code image_url}
     * stay null when the row has none — an unillustrated page does not get an invented picture, and an
     * undescribed one does not get an invented sentence.
     */
    private static Map<String, Object> og(Map<String, Object> target) {
        if (target == null) {
            return null;
        }
        Map<String, Object> og = new LinkedHashMap<>();
        og.put("title", Json.str(target, "title"));
        og.put("description", Json.str(target, "description"));
        og.put("image_url", Json.str(target, "image_url"));
        og.put("type", "website");
        return og;
    }

    /** A fresh code, retried on collision by the caller rather than looped here. */
    private static String newCode() {
        StringBuilder sb = new StringBuilder(CODE_LENGTH);
        for (int i = 0; i < CODE_LENGTH; i++) {
            sb.append(ALPHABET[RANDOM.nextInt(ALPHABET.length)]);
        }
        return sb.toString();
    }

    private static String subjectType(Object raw) {
        String value = raw == null ? null : String.valueOf(raw).trim().toLowerCase(Locale.ROOT);
        if (value == null || !SUBJECT_TYPES.contains(value)) {
            throw ApiException.validation("subject_type must be one of " + SUBJECT_TYPES,
                    Json.map("field", "subject_type"));
        }
        return value;
    }

    private static UUID requireUuid(Object raw, String field) {
        UUID parsed = Json.uuidOrNull(raw == null ? null : String.valueOf(raw));
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }
}
