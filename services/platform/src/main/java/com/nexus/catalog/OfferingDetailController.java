package com.nexus.catalog;

import com.nexus.merchant.MerchantRepository;
import com.nexus.platform.ApiException;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §4 — the consumer-facing public read of one offering. The offering half of §4's
 * grammar is minimal but real: a person holding an offering slug should reach the same projection the
 * merchant menu renders, with the merchant's own identity attached, without a session.
 *
 * <p>This read is intentionally narrow: it serves <strong>active</strong> offerings only (an archived
 * offering and an absent one are indistinguishable — the same {@code offering_not_found} 404, D5), it
 * carries no workspace fields (plan tier, handshake statistics, internal ids beyond the subject id), and
 * it is a cacheable public page just like the merchant profile. Facts ride the same projection the menu
 * uses, so the two can never disagree about the price of an item.
 *
 * <p>Slug uniqueness inside a tenant is not guaranteed by the schema; the row served for an ambiguous
 * slug is the one with the most recent activity (active status wins, then popularity). A caller that
 * needs the sibling list asks the menu endpoint with the merchant id.
 */
@RestController
@RequestMapping("/api/v1/offerings")
public class OfferingDetailController {

    private static final String CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";

    private final OfferingRepository offerings;
    private final MerchantRepository merchants;

    public OfferingDetailController(OfferingRepository offerings, MerchantRepository merchants) {
        this.offerings = offerings;
        this.merchants = merchants;
    }

    /** {@code GET /api/v1/offerings/{idOrSlug}} — public, cacheable (§4), no session required. */
    @GetMapping("/{idOrSlug}")
    public Map<String, Object> offering(@PathVariable String idOrSlug, HttpServletRequest request,
                                        HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        String trimmed = idOrSlug.trim();
        Optional<Map<String, Object>> row = Json.uuidOrNull(trimmed) != null
                ? offerings.find(tenant, Json.uuidOrNull(trimmed))
                : offerings.findBySlugAny(tenant, trimmed);
        Map<String, Object> offering = row
                .filter(found -> "active".equals(Json.str(found, "status")))
                .orElseThrow(() -> ApiException.notFound("offering_not_found", "No such offering"));
        UUID merchantId = Json.uuid(offering, "merchant_id");

        // Merchant identity rides the same payload so clients never need a second request to render a
        // breadcrumb — and so the listing this offering belongs to is the one the page links to.
        List<Map<String, Object>> locations = merchants.locations(tenant, merchantId);
        Map<String, Object> location = locations.stream()
                .filter(loc -> Boolean.TRUE.equals(Json.bool(loc, "is_primary")))
                .findFirst()
                .orElse(locations.isEmpty() ? null : locations.get(0));
        Map<String, Object> merchant = new java.util.LinkedHashMap<>();
        merchant.put("id", merchantId.toString());
        merchant.put("slug", Json.str(offering, "merchant_slug"));
        merchant.put("name", Json.str(offering, "merchant_name"));
        merchant.put("city", location != null ? Json.str(location, "city") : null);
        merchant.put("district", location != null ? Json.str(location, "district") : null);
        merchant.put("geo", location != null && Json.dec(location, "lat") != null && Json.dec(location, "lng") != null
                ? Json.map("lat", Json.dec(location, "lat"), "lng", Json.dec(location, "lng"))
                : null);

        Map<String, Object> out = OfferingRepository.view(offering);
        out.put("merchant", merchant);
        out.put("as_of", asOf.toString());
        cache(response, CACHE, tenant);
        demoFlags(response, offering);
        return out;
    }

    private void cache(HttpServletResponse response, String directive, TenantContext tenant) {
        response.setHeader("Cache-Control", directive);
        response.setHeader("Vary", "X-Tenant");
    }

    private void demoFlags(HttpServletResponse response, Map<String, Object> offering) {
        DemoFlags.markOrigin(response, Json.str(offering, "merchant_data_origin"));
    }
}
