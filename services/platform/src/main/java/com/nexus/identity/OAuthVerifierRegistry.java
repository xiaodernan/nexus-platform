package com.nexus.identity;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * Chooses the verifier for {@code POST /api/v1/auth/oauth/{provider}}. A provider is supported when
 * either a real client id is configured ({@link JwksOAuthVerifier}) or the {@code dev} profile is
 * active ({@link DevOAuthVerifier}, which does not check signatures and says so in the response).
 */
@Component
public class OAuthVerifierRegistry {

    private static final Logger log = LoggerFactory.getLogger(OAuthVerifierRegistry.class);

    private final Map<String, OAuthTokenVerifier> verifiers = new LinkedHashMap<>();
    private final boolean devProfile;

    public OAuthVerifierRegistry(Environment env,
                                 @Value("${nexus.oauth.google.client-id:}") String googleClientId,
                                 @Value("${nexus.oauth.google.jwks-uri:https://www.googleapis.com/oauth2/v3/certs}")
                                 String googleJwksUri,
                                 @Value("${nexus.oauth.google.issuer:https://accounts.google.com}") String googleIssuer,
                                 @Value("${nexus.oauth.apple.client-id:}") String appleClientId,
                                 @Value("${nexus.oauth.apple.jwks-uri:https://appleid.apple.com/auth/keys}")
                                 String appleJwksUri,
                                 @Value("${nexus.oauth.apple.issuer:https://appleid.apple.com}") String appleIssuer) {
        this.devProfile = env.acceptsProfiles(Profiles.of("dev", "test"));
        register("google", googleClientId, googleJwksUri, googleIssuer);
        register("apple", appleClientId, appleJwksUri, appleIssuer);
        if (devProfile) {
            for (String provider : List.of("google", "apple", "dev")) {
                verifiers.putIfAbsent(provider, new DevOAuthVerifier(provider));
            }
            log.warn("oauth_mode dev_verifier_active — id_token signatures are NOT verified (dev/test profile only)");
        }
    }

    private void register(String provider, String clientId, String jwksUri, String issuer) {
        if (clientId == null || clientId.isBlank()) {
            return;
        }
        verifiers.put(provider, new JwksOAuthVerifier(provider, jwksUri, issuer, clientId));
        log.info("oauth_verifier provider={} mode=jwks_rs256 issuer={}", provider, issuer);
    }

    public Optional<OAuthTokenVerifier> verifierFor(String provider) {
        if (provider == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(verifiers.get(provider.toLowerCase()));
    }

    public String verifierName(String provider) {
        return verifierFor(provider).map(OAuthTokenVerifier::mode).orElse("none");
    }

    public List<String> supported() {
        return new ArrayList<>(verifiers.keySet());
    }
}
