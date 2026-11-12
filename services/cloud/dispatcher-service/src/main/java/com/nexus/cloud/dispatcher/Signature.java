package com.nexus.cloud.dispatcher;

import java.nio.charset.StandardCharsets;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * HMAC-SHA256 of a body, hex-encoded, constant-time comparable on the verifying side.
 *
 * The header we emit is {@code X-Nexus-Event-Signature: sha256=<hex>}. The receiving side computes
 * {@code HMACSHA256(secret, rawBody)} and does a constant-time compare against the hex. Lives here
 * because two services that must agree on bytes agree on bytes, not on string handling.
 */
public final class Signature {

    private Signature() {}

    public static String sha256Hex(String secret, byte[] body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(body));
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable — refusing to send unsigned webhook", e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xF, 16));
            out.append(Character.forDigit(b & 0xF, 16));
        }
        return out.toString();
    }
}
