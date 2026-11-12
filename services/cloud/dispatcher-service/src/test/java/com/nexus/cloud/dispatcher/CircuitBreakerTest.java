package com.nexus.cloud.dispatcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CircuitBreakerTest {

    @Test
    void itStaysClosed() {
        CircuitBreaker breaker = new CircuitBreaker(1_000L);
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.CLOSED);
    }

    @Test
    void itOpensAfterThresholdConsecutiveFailures() {
        CircuitBreaker breaker = new CircuitBreaker(1_000L);
        breaker.registerFailure("h", 3);
        breaker.registerFailure("h", 3);
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.CLOSED);
        breaker.registerFailure("h", 3);
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.OPEN);
    }

    @Test
    void itAllowsHalfOpenAfterCooldownElapses() throws InterruptedException {
        // cooldown=100ms; nanoTime monotonic — sleeping 150ms must expose the HALF_OPEN probe.
        CircuitBreaker breaker = new CircuitBreaker(100L);
        for (int i = 0; i < 3; i++) breaker.registerFailure("h", 3);
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.OPEN);
        Thread.sleep(150L);
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.HALF_OPEN);
    }

    @Test
    void itClosesOnFirstSuccess() {
        CircuitBreaker breaker = new CircuitBreaker(1_000L);
        breaker.registerFailure("h", 3);
        breaker.registerFailure("h", 3);
        breaker.registerFailure("h", 3);
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.OPEN);
        breaker.registerSuccess("h");
        assertThat(breaker.allow("h")).isEqualTo(CircuitBreaker.Verdict.CLOSED);
    }

    @Test
    void itTracksHooksIndependently() {
        CircuitBreaker breaker = new CircuitBreaker(1_000L);
        breaker.registerFailure("a", 2);
        breaker.registerFailure("a", 2);
        assertThat(breaker.allow("a")).isEqualTo(CircuitBreaker.Verdict.OPEN);
        assertThat(breaker.allow("b")).isEqualTo(CircuitBreaker.Verdict.CLOSED);
    }
}
