package com.nexus.platform;

import java.util.UUID;

/**
 * Tenant scope for the current request (DECISIONS D5). A market/city deployment boundary; every
 * tenant-owned table row carries {@code tenant_id} and repositories receive this as their first
 * argument — see {@link TenantJdbc} for the enforcement and {@code TenantConventionArchitectureTest}
 * for the ArchUnit rule.
 */
public record TenantContext(UUID tenantId, String slug, String currency, String timezone, String countryCode) {

    public String idString() {
        return tenantId.toString();
    }
}
