package com.nexus.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import java.util.Base64;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Local-development only: reads the payload of an {@code id_token} <b>without</b> verifying its
 * signature, so the OAuth flow can be exercised offline against a hand-made JWT. It is registered
 * only when the {@code dev} profile is active and the response of every login through it says
 * {@code "oauth":{"mode":"dev_unsigned"}}, which is what keeps it honest (D6).
 */
public final class DevOAuthVerifier implements OAuthTokenVerifier {

    private static final Logger log = LoggerFactory.getLogger(DevOAuthVerifier.class);

    private final String provider;

    public DevOAuthVerifier(String provider) {
        this.provider = provider;
    }

    @Override
    public String provider() {
        return provider;
    }

    @Override
    public String mode() {
        return "dev_unsigned";
    }

    @Override
    public Optional<OAuthIdentity> verify(String idToken) {
        if (idToken == null || idToken.isBlank()) {
            return Optional.empty();
        }
        String[] parts = idToken.split("\\.");
        if (parts.length < 2) {
            log.warn("dev_oauth_rejected reason=not_a_jwt provider={}", provider);
            return Optional.empty();
        }
        try {
            JsonNode payload = Json.MAPPER.readTree(Base64.getUrlDecoder().decode(parts[1]));
            String sub = payload.path("sub").asText(null);
            if (sub == null || sub.isBlank()) {
                return Optional.empty();
            }
            log.warn("dev_oauth_accepted provider={} sub={} (signature NOT verified, dev profile only)", provider, sub);
            return Optional.of(new OAuthIdentity(provider, sub,
                    payload.path("email").asText(null),
                    payload.path("name").asText(payload.path("given_name").asText(null)),
                    payload.path("locale").asText(null)));
        } catch (Exception e) {
            return Optional.empty();
        }
    }
}
