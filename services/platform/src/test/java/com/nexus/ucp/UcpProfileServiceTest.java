package com.nexus.ucp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The properties that matter here are the honest ones: a profile reports exactly what the merchant
 * published, and the absence of a profile stays an absence instead of becoming a plausible default.
 */
@ExtendWith(MockitoExtension.class)
class UcpProfileServiceTest {

    private static final UUID TENANT = UUID.randomUUID();
    private static final TenantContext TENANT_CTX = new TenantContext(TENANT, "hong-kong", "HKD", "Asia/Hong_Kong", "HK");

    @Mock
    private TenantJdbc jdbc;

    private UcpProfileService service;

    @BeforeEach
    void setUp() {
        service = new UcpProfileService(jdbc);
    }

    /** jsonb arrives from JDBC as a raw JSON string (or PGobject); {@code Json.jsonArray} parses either. */
    private static Map<String, Object> row(String capabilities, String endpoint) {
        return Json.map(
                "id", UUID.randomUUID(),
                "version", "2026-04-08",
                "endpoint", endpoint,
                "capabilities", capabilities,
                "payment_handlers", "[]",
                "published_at", "2026-09-01T10:00:00Z",
                "merchant_id", UUID.randomUUID(),
                "slug", "cafe-889",
                "display_name", "Cafe 889",
                "data_origin", "demo");
    }

    @Test
    void reportsOnlyDeclaredCapabilities() {
        when(jdbc.firstForTenant(eq(TENANT_CTX), anyString(), any()))
                .thenReturn(Optional.of(row("[\"discovery\",\"cart\"]", null)));

        UcpProfileService.Profile profile = service.publishedProfile(TENANT_CTX, "cafe-889").orElseThrow();

        assertThat(profile.document().get("version")).isEqualTo("2026-04-08");
        assertThat(profile.document().get("capabilities")).isEqualTo(List.of("discovery", "cart"));
        // No base endpoint was published, so nothing may be claimed as reachable.
        assertThat((List<?>) profile.document().get("endpoints")).allSatisfy(entry ->
                assertThat(((Map<?, ?>) entry).get("resolved")).isEqualTo(false));
        assertThat(profile.dataOrigin()).isEqualTo("demo");
    }

    @Test
    void buildsCapabilityUrlsFromThePublishedBaseOnly() {
        when(jdbc.firstForTenant(eq(TENANT_CTX), anyString(), any()))
                .thenReturn(Optional.of(row("[\"checkout\"]", "https://merchant.example/ucp/")));

        List<?> endpoints = (List<?>) service.publishedProfile(TENANT_CTX, "cafe-889")
                .orElseThrow().document().get("endpoints");

        assertThat(endpoints).hasSize(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> first = (Map<String, Object>) endpoints.get(0);
        assertThat(first)
                .containsEntry("capability", "checkout")
                .containsEntry("url", "https://merchant.example/ucp/checkout")
                .containsEntry("resolved", true);
    }

    @Test
    void unpublishedMerchantStaysAnAbsence() {
        when(jdbc.firstForTenant(eq(TENANT_CTX), anyString(), any())).thenReturn(Optional.empty());

        assertThat(service.publishedProfile(TENANT_CTX, "nobody")).isEmpty();

        ApiException e = service.notPublished("nobody");
        assertThat(e.status()).isEqualTo(404);
        assertThat(e.code()).isEqualTo("ucp_profile_not_published");
        assertThat(e.details()).containsKey("phase");
    }

    @Test
    void publishedProfileWithoutCapabilitiesIsAnErrorNotAnEmptyPromise() {
        when(jdbc.firstForTenant(eq(TENANT_CTX), anyString(), any()))
                .thenReturn(Optional.of(row("[]", null)));

        ApiException e = org.junit.jupiter.api.Assertions.assertThrows(ApiException.class,
                () -> service.publishedProfile(TENANT_CTX, "cafe-889"));
        assertThat(e.code()).isEqualTo("internal");
    }
}
