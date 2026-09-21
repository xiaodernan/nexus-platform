package com.nexus.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Real {@code id_token} verification for google/apple: RS256 signature over the provider JWKS (kid
 * matched, cached with refresh), plus {@code iss}, {@code aud} and {@code exp} checks. No third-party
 * JWT library is needed — everything is JDK crypto.
 *
 * <p>Registered only when a client id is configured; otherwise the provider is simply unsupported
 * (see {@link OAuthVerifierRegistry}).
 */
public class JwksOAuthVerifier implements OAuthTokenVerifier {

    private static final Logger log = LoggerFactory.getLogger(JwksOAuthVerifier.class);

    private final String provider;
    private final String jwksUri;
    private final String expectedIssuer;
    private final String clientId;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private volatile JsonNode keySet;
    private volatile long keySetAt;

    public JwksOAuthVerifier(String provider, String jwksUri, String expectedIssuer, String clientId) {
        this.provider = provider;
        this.jwksUri = jwksUri;
        this.expectedIssuer = expectedIssuer;
        this.clientId = clientId;
    }

    @Override
    public String provider() {
        return provider;
    }

    @Override
    public String mode() {
        return "jwks_rs256";
    }

    @Override
    public Optional<OAuthIdentity> verify(String idToken) {
        if (idToken == null || idToken.isBlank()) {
            return Optional.empty();
        }
        String[] parts = idToken.split("\\.");
        if (parts.length != 3) {
            return Optional.empty();
        }
        try {
            JsonNode header = Json.MAPPER.readTree(Base64.getUrlDecoder().decode(parts[0]));
            JsonNode payload = Json.MAPPER.readTree(Base64.getUrlDecoder().decode(parts[1]));
            if (!"RS256".equals(header.path("alg").asText())) {
                log.info("oauth_rejected provider={} reason=alg_must_be_rs256", provider);
                return Optional.empty();
            }
            String kid = header.path("kid").asText(null);
            RSAPublicKey key = findKey(kid);
            if (key == null) {
                log.info("oauth_rejected provider={} reason=unknown_kid kid={}", provider, kid);
                return Optional.empty();
            }
            Signature verifier = Signature.getInstance("SHA256withRSA");
            verifier.initVerify(key);
            verifier.update((parts[0] + "." + parts[1]).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getUrlDecoder().decode(parts[2]))) {
                log.info("oauth_rejected provider={} reason=bad_signature", provider);
                return Optional.empty();
            }
            long now = System.currentTimeMillis() / 1000;
            if (payload.path("exp").asLong(0) <= now) {
                return Optional.empty();
            }
            String iss = payload.path("iss").asText("");
            if (expectedIssuer != null && !expectedIssuer.isBlank() && !expectedIssuer.equals(iss)) {
                log.info("oauth_rejected provider={} reason=issuer issuer={}", provider, iss);
                return Optional.empty();
            }
            if (clientId != null && !clientId.isBlank() && !audienceMatches(payload)) {
                log.info("oauth_rejected provider={} reason=aud client_id={}", provider, clientId);
                return Optional.empty();
            }
            String sub = payload.path("sub").asText(null);
            if (sub == null || sub.isBlank()) {
                return Optional.empty();
            }
            return Optional.of(new OAuthIdentity(provider, sub,
                    payload.path("email").asText(null),
                    payload.path("name").asText(payload.path("given_name").asText(null)),
                    payload.path("locale").asText(null)));
        } catch (Exception e) {
            log.warn("oauth_verification_error provider={} type={} message={}", provider,
                    e.getClass().getSimpleName(), e.getMessage());
            return Optional.empty();
        }
    }

    private boolean audienceMatches(JsonNode payload) {
        JsonNode aud = payload.path("aud");
        if (aud.isArray()) {
            for (JsonNode n : aud) {
                if (clientId.equals(n.asText())) {
                    return true;
                }
            }
            return false;
        }
        return clientId.equals(aud.asText(null));
    }

    private RSAPublicKey findKey(String kid) throws Exception {
        JsonNode keys = keys();
        if (keys == null) {
            return null;
        }
        for (JsonNode k : keys) {
            if (!"RSA".equals(k.path("kty").asText())) {
                continue;
            }
            if (kid != null && k.has("kid") && !kid.equals(k.path("kid").asText())) {
                continue;
            }
            BigInteger modulus = new BigInteger(1, Base64.getUrlDecoder().decode(k.path("n").asText()));
            BigInteger exponent = new BigInteger(1, Base64.getUrlDecoder().decode(k.path("e").asText()));
            return (RSAPublicKey) java.security.KeyFactory.getInstance("RSA")
                    .generatePublic(new RSAPublicKeySpec(modulus, exponent));
        }
        return null;
    }

    private JsonNode keys() {
        long now = System.currentTimeMillis();
        JsonNode snapshot = keySet;
        if (snapshot != null && now - keySetAt < Duration.ofHours(1).toMillis()) {
            return snapshot.path("keys");
        }
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(jwksUri)).timeout(Duration.ofSeconds(3)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                log.warn("jwks_fetch_status provider={} status={}", provider, response.statusCode());
                return snapshot == null ? null : snapshot.path("keys");
            }
            JsonNode parsed = Json.MAPPER.readTree(response.body());
            keySet = parsed;
            keySetAt = now;
            return parsed.path("keys");
        } catch (Exception e) {
            // Offline / blocked network: keep serving the previous cache, but never pretend it verified.
            log.warn("jwks_fetch_failed provider={} message={}", provider, e.getMessage());
            return snapshot == null ? null : snapshot.path("keys");
        }
    }
}
