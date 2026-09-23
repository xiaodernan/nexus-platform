package com.nexus.platform;

import java.util.UUID;

/**
 * Authenticated subject. {@code subjectType} is the value the interceptor looks grants up under, and today two
 * authenticators produce one: {@code user} for a bearer or cookie session ({@code AuthFilter}) and {@code
 * api_key} for an {@code nx_} secret ({@code ApiKeyService.verify}). The other two names in
 * {@code permission_grants.subject_type} are grant-row spellings rather than subjects this build authenticates:
 * a human's rows may be filed as {@code merchant_user}, which is why every human read unions both (D40, D42),
 * and {@code agent} is named in V1's column comment and AGENT_CONTRACT §8 while the AI service still enters
 * through its own token door (D12) and no read asks for a row filed that way.
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
