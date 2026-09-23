package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * A rate-limit scope is a promise about traffic that arrives. {@link RateLimitFilter} declares its scopes as
 * path prefixes and nothing anywhere asked the router whether anything is served there — so the AI scope carried
 * {@code /api/v1/ai/} while this service's own OpenAPI description says {@code /api/v1/ai/**} belongs to the AI
 * service, and {@code API_CONTRACT} §7 says the same in a table row. That prefix could do exactly one thing:
 * charge a bucket to a request that then 404s, while the route the scope was written for
 * ({@code /api/v1/merchant/ai-agent}) was the only one it ever actually counted.
 *
 * <p>The gate reads the prefixes out of the filter's source rather than keeping a list here, because a list
 * copied from the code can drift from it unnoticed (D44), and it asks the running router — not a grep — for what
 * is served, because a mapping can be conditioned, prefixed or absent in ways a text search cannot see (D41,
 * D44). It checks every {@code path.startsWith("…")} literal in the file, the {@code /api/v1/} routing guard
 * included: a prefix is a claim about traffic this service sees, whatever it is used for. Deleting the dead line
 * is the fix; this is what stops the next one, by refusing the shape rather than the instance.
 */
class RateLimitScopeRoutesTest extends NexusIntegrationTest {

    private static final Path FILTER = Path.of("src/main/java/com/nexus/platform/RateLimitFilter.java");
    private static final Pattern PREFIX = Pattern.compile("path\\.startsWith\\(\"(/[A-Za-z0-9/_.-]*)\"\\)");

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping routes;

    @Test
    @DisplayName("Every path prefix the filter matches on is a path this router serves")
    void scopesNameServedRoutes() throws IOException {
        List<String> prefixes = new ArrayList<>();
        Matcher found = PREFIX.matcher(Files.readString(FILTER, StandardCharsets.UTF_8));
        while (found.find()) {
            prefixes.add(found.group(1));
        }

        Set<String> served = new LinkedHashSet<>();
        for (RequestMappingInfo info : routes.getHandlerMethods().keySet()) {
            served.addAll(info.getPatternValues());
        }

        assertThat(prefixes).as("the prefixes read out of " + FILTER).isNotEmpty();
        assertThat(served)
                .as("the running router answered with registered paths — an empty or tiny set would make the "
                        + "check below pass by having compared nothing")
                .hasSizeGreaterThan(50);

        List<String> unreachable = new ArrayList<>();
        for (String prefix : prefixes) {
            if (served.stream().noneMatch(path -> path.startsWith(prefix))) {
                unreachable.add(prefix);
            }
        }
        assertThat(unreachable)
                .as("prefixes with a bucket and no route behind them; a scope that only ever sees 404s is an "
                        + "unread promise, and the route that does exist gets no coverage the reader can trust")
                .isEmpty();
    }
}
