package com.nexus.cloud.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * D850: the edge's arithmetic, tested without a WebFlux context — the bucket is the part that must
 * never lie, so it is the part that gets the test.
 */
class TokenBucketTest {

    @Test
    void burstIsSpentThenBlocked() {
        TokenBucket bucket = new TokenBucket(3, 0);
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isFalse();
        assertThat(bucket.tryAcquire()).isFalse();
    }

    @Test
    void bucketRefillsOverTime() throws InterruptedException {
        TokenBucket bucket = new TokenBucket(2, 100); // 100 tokens/s -> one token per 10ms
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isFalse();
        Thread.sleep(50); // ~5 tokens refilled, capped at capacity 2
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isFalse();
    }

    @Test
    void capacityIsEnforcedEvenAfterIdle() throws InterruptedException {
        TokenBucket bucket = new TokenBucket(2, 1000);
        Thread.sleep(50); // far more "refill" than capacity
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isTrue();
        assertThat(bucket.tryAcquire()).isFalse();
    }

    @Test
    void rejectsDegenerateArguments() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new TokenBucket(0, 1))
                .isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new TokenBucket(1, -1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fallbackBodyCarriesTheContractShapeAnd503() {
        EdgeFallbackController fallback = new EdgeFallbackController();
        var response = fallback.platform("corr-123");
        assertThat(response.getStatusCode().value()).isEqualTo(503);
        assertThat(response.getBody()).containsKey("error");
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> error = (java.util.Map<String, Object>) response.getBody().get("error");
        assertThat(error.get("code")).isEqualTo("edge_upstream_unavailable");
        assertThat(error.get("request_id")).isEqualTo("corr-123");

        var ai = fallback.ai(null);
        assertThat(ai.getStatusCode().value()).isEqualTo(503);
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> aiError = (java.util.Map<String, Object>) ai.getBody().get("error");
        assertThat(aiError.get("request_id")).isEqualTo("unknown");
    }
}
