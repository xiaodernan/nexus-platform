package com.nexus.platform;

import java.util.UUID;

/**
 * Authenticated subject. {@code subjectType} matches the {@code permission_grants.subject_type}
 * domain: {@code user} | {@code merchant_user} | {@code agent} | {@code api_key}
 * (AGENT_CONTRACT §8 — authorisation is per subject, not per model).
 */
public record Principal(
        String subjectType,
        UUID subjectId,
        UUID userId,
        UUID tenantId,
        String role,
        UUID merchantId,
        String sid,
        String jti,
        String authMethod) {

    public boolean isUser() {
        return "user".equals(subjectType) && userId != null;
    }

    public boolean hasPlatformRole(String... roles) {
        if (role == null) {
            return false;
        }
        for (String r : roles) {
            if (role.equals(r)) {
                return true;
            }
        }
        return false;
    }
}
