package com.nexus.ucp;

import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * UCP discovery surface (§3, §43, D14). Two paths, one truth:
 *
 * <ul>
 *   <li>{@code GET /.well-known/ucp} — the origin profile. It sits outside {@code /api/v1} on purpose: that
 *       is where an external agent looks first, and it must not need a tenant header or a session.</li>
 *   <li>{@code GET /api/v1/merchants/{slug}/ucp.json} — a merchant profile, projected from a published
 *       {@code agent_profiles} row.</li>
 * </ul>
 *
 * <p>Both are read-only and anonymous: a capability profile describes what exists, never secrets. Payment
 * handler entries are opaque provider references — no card data, ever (§42).
 */
@RestController
public class UcpController {

    private final UcpProfileService profiles;
    private final String originVersion;

    public UcpController(UcpProfileService profiles,
                         @Value("${nexus.ucp.origin-version:unversioned}") String originVersion) {
        this.profiles = profiles;
        this.originVersion = originVersion;
    }

    /**
     * Phase 1 declares zero origin capabilities. Listing {@code checkout} here would advertise a hand-off
     * nobody implements, which is the failure mode §43 tells us to avoid.
     */
    @GetMapping("/.well-known/ucp")
    public Map<String, Object> originProfile(HttpServletResponse response) {
        response.setHeader("Cache-Control", "public, max-age=3600");
        return Json.map(
                "protocol", "ucp",
                "version", originVersion,
                "status", "not_integrated",
                "capabilities", List.of(),
                "payment_handlers", List.of(),
                "merchant_profiles", "/api/v1/merchants/{slug}/ucp.json",
                "note", "NEXUS reserves the UCP seam (docs/UCP.md). Profiles publish per merchant from an "
                        + "explicitly published agent_profiles row; an origin capability appears only once its endpoint answers.");
    }

    @GetMapping("/api/v1/merchants/{slug}/ucp.json")
    public Map<String, Object> merchantProfile(@PathVariable String slug, HttpServletRequest request,
                                               HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        UcpProfileService.Profile profile =
                profiles.publishedProfile(tenant, slug).orElseThrow(() -> profiles.notPublished(slug));
        DemoFlags.markOrigin(response, profile.dataOrigin());
        // A published profile is merchant-authored configuration, not live supply: it may cache, but a
        // revoke should reach agents within minutes rather than hours (§20).
        response.setHeader("Cache-Control", "public, max-age=300");
        return profile.document();
    }
}
