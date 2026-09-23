package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

/**
 * D47 took the application's trust in {@code X-Forwarded-For} out of {@code Req.clientIp}, and that is only
 * half of it. With {@code server.forward-headers-strategy: framework} the container had already replaced
 * {@code getRemoteAddr()} with whatever the caller typed, before the application saw the request, so the code
 * fix on its own would have been cosmetic. The line that carries the trust is
 * {@code server.tomcat.remoteip.internal-proxies}: a forwarded address counts exactly when the socket peer
 * itself is a declared proxy.
 *
 * <p>{@code DeclaredProxyTest} runs the supported deployment. This class runs the one this repository shipped,
 * so that "a caller could choose its own rate-limit bucket" stays a measurement instead of a story — and so
 * the shape of the default stays a decision somebody has to argue for.
 */
@TestPropertySource(properties = {
        "nexus.ratelimit.enabled=true",
        "nexus.ratelimit.auth-requests=1",
        // The value that shipped before D47. Asked for here on purpose: it honours X-Forwarded-For from any
        // peer, which is the whole bug, and it is what made the fix in Req.clientIp not enough on its own.
        "server.forward-headers-strategy=framework"
})
class ForwardedHeaderTrustTest extends NexusIntegrationTest {

    private static final Path RESOURCES = Path.of("src/main/resources");
    private static final Pattern STRATEGY =
            Pattern.compile("^\\s*forward-headers-strategy:\\s*(\\S+)\\s*(?:#.*)?$");

    private ResponseEntity<String> login(Tenant tenant, String email, String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Tenant", tenant.slug());
        headers.set("X-Forwarded-For", forwardedFor);
        return http.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(Map.of("email", email, "password", "wrong"), headers), String.class);
    }

    private String recordedLoginIp(Tenant tenant) {
        return String.valueOf(row("select host(ip) as ip from audit_logs where tenant_id = :t "
                        + "and action = 'login_failed' order by id desc limit 1",
                Map.of("t", tenant.id())).get("ip"));
    }

    @Test
    @DisplayName("Under framework the caller really did choose its own bucket — the pre-D47 default, reproduced")
    void frameworkHandsTheLoginGateToTheCaller() {
        Tenant tenant = newTenant("rl-fw");
        String email = "framework@example.test";

        assertThat(login(tenant, email, "203.0.113.11").getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(login(tenant, email, "203.0.113.11").getStatusCode())
                .as("that named client has now spent its single attempt")
                .isEqualTo(HttpStatus.TOO_MANY_REQUESTS);

        // The evasion: nothing about this next request is a second login attempt from one client, yet the
        // header renames the client and the budget refills. This is what one line of configuration bought.
        assertThat(login(tenant, email, "203.0.113.12").getStatusCode())
                .as("a different address in the header is a different bucket, whoever typed it")
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(login(tenant, email, "203.0.113.13").getStatusCode())
                .as("and it can be repeated for as many addresses as the caller can type")
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        assertThat(recordedLoginIp(tenant))
                .as("the same untrusted string is what lands in audit_logs.ip")
                .isEqualTo("203.0.113.13");
        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'login_failed'",
                Map.of("t", tenant.id())))
                .as("four attempts, one refusal, three handler visits — the gate answered nobody in particular")
                .isEqualTo(3);
    }

    @Test
    @DisplayName("The same string also decided whether the audit trail existed at all")
    void anUntrustedAddressTakesItsOwnRowWithIt() {
        Tenant tenant = newTenant("rl-fw-garbage");

        // Not an address, so `cast(:ip as inet)` fails inside AuditService.record — which catches everything by
        // design, because a broken audit write must not turn a successful action into a 500. The caller still
        // gets its 401; the row that was supposed to record the refused login is simply not there, and the only
        // trace of it is a log line. Under the fixed configuration the same request writes the row (see
        // RateLimitEnforcementTest, whose first attempt carries this very value).
        assertThat(login(tenant, "garbage@example.test", "not-an-ip").getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(count("select count(*) from audit_logs where tenant_id = :t", Map.of("t", tenant.id())))
                .as("framework put `not-an-ip` into an inet column and the catch swallowed the loss")
                .isZero();
    }

    @Test
    @DisplayName("No shipped config file hands the forwarded header to whoever sends it")
    void shippedDefaultRefusesTheHeaderFromAnyoneButAProxy() throws IOException {
        List<String> declared = new ArrayList<>();
        List<Path> configs;
        try (var paths = Files.walk(RESOURCES)) {
            configs = paths.filter(p -> p.toString().endsWith(".yml")).sorted().toList();
        }
        for (Path config : configs) {
            for (String line : Files.readAllLines(config, StandardCharsets.UTF_8)) {
                Matcher found = STRATEGY.matcher(line);
                if (found.matches()) {
                    String value = found.group(1);
                    declared.add(config + " -> " + value);
                    // ${ENV:fallback} is the offer to an operator; the fallback is what ships.
                    String effective = value.startsWith("${")
                            ? value.substring(value.lastIndexOf(':') + 1, value.length() - 1)
                            : value;
                    assertThat(effective)
                            .as(config + " declares " + value + ": framework honours X-Forwarded-For from any "
                                    + "peer, which is what let a caller pick its own rate-limit bucket")
                            .isIn("none", "native");
                    assertThat(value)
                            .as("an operator behind a proxy must be able to say so without editing the file")
                            .startsWith("${");
                }
            }
        }
        assertThat(declared)
                .as("the trust decision has to be written down somewhere: " + RESOURCES)
                .isNotEmpty();
    }
}
