package com.nexus.platform;

import java.security.SecureRandom;
import java.util.Base64;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * Argon2id password hashing (API_CONTRACT §3). Parameters are the OWASP-ish defaults for a
 * login-path hash: 16-byte salt, 32-byte tag, 64 MiB memory, 3 iterations, parallelism 1.
 * Stored form is the standard {@code $argon2id$v=19$m=...,t=...,p=...$salt$hash} encoding.
 */
@Component
public class PasswordHasher {

    private static final SecureRandom RANDOM = new SecureRandom();
    private final Argon2PasswordEncoder encoder = new Argon2PasswordEncoder(16, 32, 1, 64 * 1024, 3);

    public String hash(String rawPassword) {
        if (rawPassword == null || rawPassword.isBlank()) {
            throw ApiException.validation("password must not be blank", Json.map("field", "password"));
        }
        return encoder.encode(rawPassword);
    }

    public boolean matches(String rawPassword, String storedHash) {
        if (rawPassword == null || storedHash == null || storedHash.isBlank()) {
            return false;
        }
        try {
            return encoder.matches(rawPassword, storedHash);
        } catch (IllegalArgumentException e) {
            // Hash produced by another scheme / corrupted — never a match, but log it loudly.
            org.slf4j.LoggerFactory.getLogger(PasswordHasher.class)
                    .warn("argon2_hash_unreadable type={}", e.getClass().getSimpleName());
            return false;
        }
    }

    public String randomToken(int bytes) {
        byte[] buf = new byte[bytes];
        RANDOM.nextBytes(buf);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
    }
}
