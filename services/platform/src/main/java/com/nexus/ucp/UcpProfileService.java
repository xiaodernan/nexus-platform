package com.nexus.ucp;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Service;

/**
 * The UCP boundary (§3, §43, D14). Agentic-commerce profiles are assembled here and nowhere else, so a
 * protocol change breaks one class instead of leaking protocol shapes into the commerce core.
 *
 * <p>A profile is a projection over published {@code agent_profiles} rows: this service never infers a
 * capability the merchant did not declare. A merchant that has published nothing answers 404, which is
 * the honest difference between "checked" and "not built" (§109, D6).
 */
@Service
public class UcpProfileService {

    /** The assembled document plus the supply truth flag the caller needs for {@code X-Demo-Data} (§109). */
    public record Profile(Map<String, Object> document, String dataOrigin) {
    }

    private final TenantJdbc jdbc;

    public UcpProfileService(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    private static final String SELECT_PUBLISHED = """
            select ap.id, ap.version, ap.endpoint, ap.capabilities, ap.payment_handlers,
                   ap.published_at,
                   m.id as merchant_id, m.slug, m.display_name, m.data_origin
              from agent_profiles ap
              join merchants m on m.id = ap.merchant_id
             where m.tenant_id = :tenant_id
               and m.slug = :slug
               and ap.protocol = 'ucp'
               and ap.status = 'published'
             order by ap.published_at desc nulls last
             limit 1
            """;

    /** Newest published profile for a merchant slug, or empty when the merchant has published none. */
    public Optional<Profile> publishedProfile(TenantContext tenant, String slug) {
        return jdbc.firstForTenant(tenant, SELECT_PUBLISHED, Json.map("slug", slug)).map(this::toProfile);
    }

    /** 404 shape shared by both endpoints; {@code details} tells an integrating agent what it is missing. */
    public ApiException notPublished(String slug) {
        return new ApiException(404, "ucp_profile_not_published",
                "This merchant has not published a UCP capability profile",
                Json.map("merchant_slug", slug,
                        "expected", "an agent_profiles row with protocol='ucp' and status='published'",
                        "phase", "UCP is a reserved seam in phase 1 (docs/UCP.md §5); the hand-off is Phase 4"));
    }

    private Profile toProfile(Map<String, Object> row) {
        List<Object> capabilities = Json.jsonArray(row, "capabilities");
        if (capabilities.isEmpty()) {
            throw new ApiException(500, "internal", "Published UCP profile declares no capabilities",
                    Json.map("profile_id", String.valueOf(row.get("id"))));
        }
        String endpoint = Json.str(row, "endpoint");
        List<Object> endpoints = capabilities.stream()
                .map(Object::toString)
                // Resolved against URLs we actually serve: a declared-but-unbuilt capability is reported as
                // unresolved rather than pointed at an endpoint nobody answers.
                .map(cap -> (Object) Json.map(
                        "capability", cap,
                        "url", endpoint == null || endpoint.isBlank() ? null : endpoint.replaceAll("/+$", "") + "/" + cap,
                        "resolved", endpoint != null && !endpoint.isBlank()))
                .toList();

        Map<String, Object> document = Json.map(
                "version", Json.str(row, "version"),
                "merchant", Json.map(
                        "id", String.valueOf(row.get("merchant_id")),
                        "slug", Json.str(row, "slug"),
                        "display_name", Json.str(row, "display_name"),
                        "data_origin", Json.str(row, "data_origin")),
                "capabilities", capabilities,
                "endpoints", endpoints,
                "payment_handlers", Json.jsonArray(row, "payment_handlers"),
                "published_at", Json.ts(row, "published_at"));

        return new Profile(document, Json.str(row, "data_origin"));
    }
}
