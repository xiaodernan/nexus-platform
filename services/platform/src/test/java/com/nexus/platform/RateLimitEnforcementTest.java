package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

/**
 * §1 promises {@code 429 + Retry-After + X-RateLimit-Remaining}. Before D47 this repository had never produced
 * one: the rung appears nowhere in {@code src/test/java}, and the shared harness sets
 * {@code nexus.ratelimit.enabled=false}, so the filter the contract describes was switched off in every test
 * that ran through it. The ladder below is therefore the first witness that the promise is kept — and the
 * first chance to see what it actually answers with.
 *
 * <p>The interesting half is not the 429 but its key. The auth bucket is keyed per client IP, so the whole
 * gate stood or fell on {@code Req.clientIp}, which until now returned the first {@code X-Forwarded-For} entry
 * whenever a caller sent one — and {@code server.forward-headers-strategy: framework} had the container doing
 * the same thing one layer down. Two ways to buy a fresh login bucket per attempt, and one way to write
 * anything at all into the address column of {@code audit_logs}.
 *
 * <p>This class therefore declares the peer untrusted: the only proxy allowed to name a client sits on a
 * network these requests never arrive from, so the socket peer stays {@code 127.0.0.1} and a forged header has
 * to prove itself useless. {@code ForwardedHeaderTrustTest} runs the configuration that shipped before the
 * fix and shows the header winning; {@code DeclaredProxyTest} runs a declared proxy and shows the header
 * legitimately counting.
 *
 * <p>Order note: one Spring context holds one in-memory {@code KeyValueStore}, so the buckets below are shared
 * by this class's methods. Each method spends a different scope ({@code auth-ip} versus {@code write}), which
 * is what keeps them independent of each other.
 */
@TestPropertySource(properties = {
        "nexus.ratelimit.enabled=true",
        // The only address allowed to name a client is one these requests never arrive from, so the peer stays
        // 127.0.0.1 and a forged X-Forwarded-For has to prove itself useless. Escape-free on purpose: an
        // inlined test property loses its backslashes before the valve sees it.
        "server.tomcat.remoteip.internal-proxies=192.168.*",
        "nexus.ratelimit.auth-requests=3",
        "nexus.ratelimit.write-requests=1",
        "nexus.ratelimit.ai-requests=2"
})
class RateLimitEnforcementTest extends NexusIntegrationTest {

    @Autowired
    RateLimiter limiter;

    private ResponseEntity<String> login(Tenant tenant, String email, String password, String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Tenant", tenant.slug());
        if (forwardedFor != null) {
            headers.set("X-Forwarded-For", forwardedFor);
        }
        return http.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(Map.of("email", email, "password", password), headers), String.class);
    }

    private String recordedLoginIp(UUID tenantId) {
        // host(ip), not ip::text: Postgres renders an inet as "127.0.0.1/32" when cast to text, and the mask
        // bits are part of the stored value rather than part of the address.
        return String.valueOf(row("select host(ip) as ip from audit_logs where tenant_id = :t "
                        + "and action = 'login_failed' order by id desc limit 1",
                Map.of("t", tenantId)).get("ip"));
    }

    @Test
    @DisplayName("The switch this class exists to flip is really flipped, and it refuses at limit + 1")
    void limiterAnswersForItself() {
        String probe = "probe-" + System.nanoTime();
        assertThat(limiter.check(probe, probe, 1, Duration.ofSeconds(60)).allowed())
                .as("one request inside a fresh window").isTrue();

        RateLimiter.Outcome over = limiter.check(probe, probe, 1, Duration.ofSeconds(60));
        assertThat(over.allowed())
                .as("if this is true, nexus.ratelimit.enabled=false still won and every assertion in this "
                        + "file is vacuous rather than green").isFalse();
        assertThat(over.remaining()).isZero();
        assertThat(over.retryAfterSeconds()).isGreaterThanOrEqualTo(1);
        assertThat(limiter.check(probe, "someone-else", 1, Duration.ofSeconds(60)).allowed())
                .as("the spent bucket belongs to the probe principal alone").isTrue();
    }

    @Test
    @DisplayName("The fourth login from one peer is a 429, and no forged address buys a fifth attempt")
    void authLadderRefusesTheForgedEscape() {
        Tenant tenant = newTenant("rl-auth");
        String email = "brute@example.test";

        // §3's login failure: the handler answers 401, and the window counts down on the way. The claimed
        // address is deliberately not an address at all: under the pre-D47 configuration that string reached
        // `cast(:ip as inet)`, and `AuditService.record` swallows the failure, so this request took its own
        // audit row with it. Here it can only be noise — the row exists, and it holds the peer.
        ResponseEntity<String> first = login(tenant, email, "wrong-1", "not-an-ip");
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(first.getBody()).path("error").path("code").asText()).isEqualTo("invalid_credentials");
        assertThat(first.getHeaders().getFirst("X-RateLimit-Limit")).isEqualTo("3");
        assertThat(first.getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("2");

        // The trail still exists: typing something that is not an address cannot make this row disappear the way
        // it did under the pre-D47 configuration (ForwardedHeaderTrustTest keeps that failure running).
        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'login_failed'",
                Map.of("t", tenant.id()))).isEqualTo(1);
        // And the header the caller chose did not become the address the row recorded.
        assertThat(recordedLoginIp(tenant.id()))
                .as("X-Forwarded-For: not-an-ip on the request above")
                .isEqualTo("127.0.0.1");

        assertThat(login(tenant, email, "wrong-2", null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(login(tenant, email, "wrong-3", null).getHeaders().getFirst("X-RateLimit-Remaining"))
                .isEqualTo("0");

        // Attempt four never reaches the handler at all, and says so in the three ways §1 promises.
        ResponseEntity<String> fourth = login(tenant, email, "wrong-4", null);
        assertThat(fourth.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(fourth.getHeaders().getFirst("Content-Type")).contains("application/json");
        assertThat(fourth.getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("0");
        String retryAfter = fourth.getHeaders().getFirst("Retry-After");
        assertThat(retryAfter).as("§1's Retry-After").isNotBlank();
        assertThat(Long.parseLong(retryAfter)).isBetween(1L, 300L);
        assertThat(Json.tree(fourth.getBody()).path("error").path("code").asText()).isEqualTo("rate_limited");
        assertThat(Json.tree(fourth.getBody()).path("error").path("details").path("retry_after").asLong())
                .as("the envelope and the header agree")
                .isEqualTo(Long.parseLong(retryAfter));

        // The escape that used to work: a different claimed address per attempt. Three fresh identities,
        // three refusals, because none of them is the peer the container saw.
        for (int attempt = 1; attempt <= 3; attempt++) {
            ResponseEntity<String> spoofed = login(tenant, email, "spoof-" + attempt, "203.0.113." + attempt);
            assertThat(spoofed.getStatusCode())
                    .as("attempt claiming to come from 203.0.113." + attempt)
                    .isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        }

        // Seven attempts, three handler visits: the refusals were answered before the route ran, which is the
        // only reason a 429 on a wrong password is worth anything.
        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'login_failed'",
                Map.of("t", tenant.id()))).isEqualTo(3);
    }

    @Test
    @DisplayName("One principal's spent write budget is not everybody's, and it never touches a read")
    void writeBudgetIsPerPrincipal() {
        Tenant tenant = newTenant("rl-write");
        UUID person = newUser(tenant, "writer@example.test", "consumer");
        UUID other = newUser(tenant, "other@example.test", "consumer");
        String path = "/api/v1/merchants/nobody-here/reviews";

        // First write: the request gets all the way to §6's door, which asks for an Idempotency-Key (D45).
        ResponseEntity<String> allowed = post(tenant, token(tenant, person, "consumer"), path, Map.of());
        assertThat(allowed.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(allowed.getBody()).path("error").path("details").path("scope").asText())
                .isEqualTo("review");

        ResponseEntity<String> spent = post(tenant, token(tenant, person, "consumer"), path, Map.of());
        assertThat(spent.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(spent.getHeaders().getFirst("X-RateLimit-Limit")).isEqualTo("1");

        assertThat(post(tenant, token(tenant, other, "consumer"), path, Map.of()).getStatusCode())
                .as("the second person's first write is not the first person's fourth")
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        assertThat(get(tenant, token(tenant, person, "consumer"), "/api/v1/me").getStatusCode())
                .as("a spent write budget does not starve a read")
                .isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("The AI scope is a principal's window, charged at the one AI-ish door this service serves")
    void aiScopeCountsPerPrincipal() {
        Tenant tenant = newTenant("rl-ai");
        UUID first = newUser(tenant, "ai-a@example.test", "merchant");
        UUID second = newUser(tenant, "ai-b@example.test", "merchant");
        // A GET on purpose. This prefix is a mutating path, so a POST would be charged to the write scope too —
        // 1 per window in this class — and the second attempt would be refused for the wrong reason. The ai
        // scope is charged for any method, so the bucket still fills while the router answers what it answers
        // (405 here, and the assertion only needs it to be the router rather than the limiter).
        // The point is §1's "per principal" for this scope, and that the door is the one that exists: the
        // prefix `/api/v1/ai/**` used to sit in the filter and serve nothing (D49).
        String path = "/api/v1/merchant/ai-agent/config";

        for (int attempt = 1; attempt <= 2; attempt++) {
            ResponseEntity<String> answered = get(tenant, token(tenant, first, "merchant"), path);
            assertThat(answered.getStatusCode())
                    .as("attempt " + attempt + " got past the limiter and answered " + answered.getStatusCode())
                    .isNotEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        }

        ResponseEntity<String> third = get(tenant, token(tenant, first, "merchant"), path);
        assertThat(third.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(third.getHeaders().getFirst("X-RateLimit-Limit")).isEqualTo("2");
        assertThat(Json.tree(third.getBody()).path("error").path("code").asText()).isEqualTo("rate_limited");

        assertThat(get(tenant, token(tenant, second, "merchant"), path).getStatusCode())
                .as("a second principal's first attempt is not charged to the first one's window")
                .isNotEqualTo(HttpStatus.TOO_MANY_REQUESTS);
    }
}
