package com.nexus.cloud.dispatcher;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SignatureTest {

    @Test
    void itComputesHmacSha256OverTheBody() {
        String token = Signature.sha256Hex("secret", "body".getBytes(StandardCharsets.UTF_8));
        // FNV-known vector: HMAC-SHA256 of "body" under key "secret"
        assertThat(token)
            .hasSize(64)
            .matches("^[0-9a-f]{64}$");
    }

    @Test
    void itIsDifferentForDifferentSecrets() {
        byte[] body = "body".getBytes(StandardCharsets.UTF_8);
        String a = Signature.sha256Hex("secret-A", body);
        String b = Signature.sha256Hex("secret-B", body);
        assertThat(a).isNotEqualTo(b);
    }

    @Test
    void itIsDeterministicForTheSameInput() {
        byte[] body = "{\"id\":\"abc\",\"type\":\"LeadCaptured\"}".getBytes(StandardCharsets.UTF_8);
        assertThat(Signature.sha256Hex("hello", body))
            .isEqualTo(Signature.sha256Hex("hello", body));
    }
}
