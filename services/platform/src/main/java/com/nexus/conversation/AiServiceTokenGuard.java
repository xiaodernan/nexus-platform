package com.nexus.conversation;

import com.nexus.platform.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Guards {@code POST /api/v1/internal/conversations/{id}/agent-message} — the single door the AI
 * service persists dialogue through instead of owning {@code conversations}/{@code messages}/
 * {@code handoffs} itself (STATUS.md D12).
 *
 * <p>The shared secret comes from {@code NEXUS_AI_INTERNAL_TOKEN}. It is compared in constant time.
 * When the token is not configured the door answers {@code 501 not_implemented} rather than falling
 * back to "accept anything" — DECISIONS D7 forbids a silently permissive default, and an unconfigured
 * deployment must fail loudly at the call site, not silently drop agent writes.
 */
@Component
public class AiServiceTokenGuard {

    public static final String HEADER = "X-Internal-Token";

    private final String expected;

    public AiServiceTokenGuard(@Value("${NEXUS_AI_INTERNAL_TOKEN:}") String expected) {
        this.expected = expected == null ? "" : expected.trim();
    }

    public boolean configured() {
        return expected.length() >= 16;
    }

    /** @param presented the raw {@value #HEADER} header value */
    public void require(String presented) {
        if (!configured()) {
            throw ApiException.notImplemented("The AI-service internal door is not configured on this deployment "
                    + "(set NEXUS_AI_INTERNAL_TOKEN, minimum 16 characters). Conversation writes for the agent "
                    + "path are unavailable until it is, per DECISIONS D7.");
        }
        if (presented == null || presented.isBlank()) {
            throw ApiException.unauthorized("internal_token_missing",
                    "The " + HEADER + " header is required for internal conversation writes");
        }
        byte[] a = expected.getBytes(StandardCharsets.UTF_8);
        byte[] b = presented.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(a, b)) {
            throw ApiException.unauthorized("internal_token_invalid", "Internal service token does not verify");
        }
    }
}
