package com.nexus.platform;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * HS256 JWT issue/verify with the claim set fixed by API_CONTRACT §3:
 * {@code sub, tid, typ(access|refresh), sid, jti, iat, exp} (+ {@code role}, {@code mer} for
 * merchant-scoped API keys). Access 15m, refresh 30d rotating.
 *
 * <p>RS256 for production is a deliberate not-yet-done item (see README "Known gaps"); the secret is
 * mandatory outside the dev profile so the app refuses to boot with an empty signing key.
 */
@Component
public class JwtService {

    private static final String HEADER = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";

    private final byte[] secret;
    private final String issuer;
    private final long accessTtlSeconds;
    private final long refreshTtlSeconds;

    public JwtService(@Value("${nexus.jwt.secret:}") String secret,
                      @Value("${nexus.jwt.issuer:nexus-platform}") String issuer,
                      @Value("${nexus.jwt.access-ttl-seconds:900}") long accessTtlSeconds,
                      @Value("${nexus.jwt.refresh-ttl-seconds:2592000}") long refreshTtlSeconds,
                      Environment env) {
        boolean dev = env.acceptsProfiles(org.springframework.core.env.Profiles.of("dev"));
        if ((secret == null || secret.isBlank()) && !dev) {
            throw new IllegalStateException("NEXUS_JWT_SECRET must be set outside the dev profile (D7: no silent fallbacks)");
        }
        this.secret = (secret == null || secret.isBlank() ? "dev-only-insecure-jwt-secret-change-me-0123456789" : secret)
                .getBytes(StandardCharsets.UTF_8);
        this.issuer = issuer;
        this.accessTtlSeconds = accessTtlSeconds;
        this.refreshTtlSeconds = refreshTtlSeconds;
    }

    public long accessTtlSeconds() {
        return accessTtlSeconds;
    }

    public long refreshTtlSeconds() {
        return refreshTtlSeconds;
    }

    public Map<String, Object> claims(String type, String subject, String tenantId, String sid, String jti,
                                      Map<String, Object> extra) {
        long now = System.currentTimeMillis() / 1000;
        long ttl = "refresh".equals(type) ? refreshTtlSeconds : accessTtlSeconds;
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", issuer);
        claims.put("sub", subject);
        claims.put("tid", tenantId);
        claims.put("typ", type);
        claims.put("sid", sid);
        claims.put("jti", jti);
        claims.put("iat", now);
        claims.put("exp", now + ttl);
        if (extra != null) {
            claims.putAll(extra);
        }
        return claims;
    }

    public String sign(Map<String, Object> claims) {
        String h = b64(HEADER.getBytes(StandardCharsets.UTF_8));
        String p = b64(Json.write(claims).getBytes(StandardCharsets.UTF_8));
        String signingInput = h + "." + p;
        return signingInput + "." + b64(hmac(signingInput));
    }

    /** Verified claims. Throws 401 {@code invalid_token} on any problem. */
    public Map<String, Object> verify(String token) {
        if (token == null || token.isBlank()) {
            throw ApiException.unauthorized("invalid_token", "Token missing");
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            throw ApiException.unauthorized("invalid_token", "Malformed token");
        }
        byte[] expected = hmac(parts[0] + "." + parts[1]);
        byte[] actual;
        try {
            actual = Base64.getUrlDecoder().decode(parts[2]);
        } catch (IllegalArgumentException e) {
            throw ApiException.unauthorized("invalid_token", "Malformed signature");
        }
        if (!java.security.MessageDigest.isEqual(expected, actual)) {
            throw ApiException.unauthorized("invalid_token", "Signature does not verify");
        }
        JsonNode node;
        try {
            node = Json.MAPPER.readTree(Base64.getUrlDecoder().decode(parts[1]));
        } catch (Exception e) {
            throw ApiException.unauthorized("invalid_token", "Malformed payload");
        }
        long exp = node.path("exp").asLong(0);
        if (exp <= System.currentTimeMillis() / 1000) {
            throw ApiException.unauthorized("token_expired", "Access token expired");
        }
        Map<String, Object> claims = new LinkedHashMap<>();
        node.fieldNames().forEachRemaining(k -> claims.put(k, node.get(k).isNumber() ? node.get(k).numberValue() : node.get(k).asText()));
        return claims;
    }

    public static String stringClaim(Map<String, Object> claims, String key) {
        Object v = claims.get(key);
        return v == null ? null : String.valueOf(v);
    }

    private byte[] hmac(String signingInput) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw ApiException.internal("HMAC unavailable", e);
        }
    }

    private static String b64(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
