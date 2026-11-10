package com.nexus.cloud.insight;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * D885 — one read-only view of the plane, assembled from what the two Feign clients ACTUALLY saw.
 *
 * <p>The honesty contract is the whole point of this class:
 * <ul>
 *   <li>a fallback (or an exception) is reported as {@code status: unavailable}, never {@code UP};
 *   <li>a response with no {@code status} field is {@code unknown}, never assumed healthy;
 *   <li>only the upstream's own {@code status} is copied out — the rest of its payload is not
 *       forwarded, so this endpoint cannot become a back door into another service's internals;
 *   <li>{@code all_up} is true only when BOTH rows reported exactly {@code UP}.
 * </ul>
 *
 * <p>Nothing is cached, inferred or filled in. A service that is not registered is unavailable, and
 * the view says so. This is a dev-plane observer, not a health authority for production routing.
 */
@RestController
public class PlaneController {

    private final PlatformHealthClient platform;
    private final AiHealthClient ai;

    public PlaneController(PlatformHealthClient platform, AiHealthClient ai) {
        this.platform = platform;
        this.ai = ai;
    }

    @GetMapping("/insight/plane")
    public Map<String, Object> plane() {
        List<Map<String, Object>> upstreams = List.of(
                describe("NEXUS-PLATFORM", "lb://NEXUS-PLATFORM", platform::health),
                describe("NEXUS-AI", "lb://NEXUS-AI", ai::health));
        boolean allUp = upstreams.stream().allMatch(row -> "UP".equals(row.get("status")));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("service", "nexus-insight");
        out.put("plane", "spring-cloud-sidecar");
        out.put("all_up", allUp);
        out.put("upstreams", upstreams);
        out.put("note", "each status is the named service's own answer, or unavailable when the "
                + "circuit-breaker fallback answered. Nothing is inferred and nothing is cached.");
        return out;
    }

    private Map<String, Object> describe(String name, String route, Supplier<Map<String, Object>> call) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", name);
        row.put("route", route);
        try {
            Map<String, Object> body = call.get();
            if (body == null) {
                row.put("status", "unknown");
                row.put("source", "empty-response");
            } else if (Boolean.TRUE.equals(body.get("insight_fallback"))) {
                row.put("status", "unavailable");
                row.put("source", "fallback");
                row.put("detail", "breaker/fallback answered; no upstream response was observed");
            } else if (body.get("status") != null) {
                row.put("status", String.valueOf(body.get("status")));
                row.put("source", "upstream");
            } else {
                row.put("status", "unknown");
                row.put("source", "upstream-without-status");
            }
        } catch (Exception exc) {
            // Name and exception class only. A stack trace or an upstream message is not ours to echo.
            row.put("status", "unavailable");
            row.put("source", "exception");
            row.put("detail", exc.getClass().getSimpleName());
        }
        return row;
    }
}
