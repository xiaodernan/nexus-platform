package com.nexus.cloud.gateway;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * The honest answer when the breaker opens: the upstream is not reachable right now, and we say so
 * instead of serving a fabricated payload or hanging. Same error shape as the rest of the API contract
 * (`{"error":{"code","message","request_id"}}`), status 503, and the request id from the edge filter so
 * the caller can correlate the refusal with the logs.
 */
@RestController
public class EdgeFallbackController {

    @GetMapping("/fallback/platform")
    public ResponseEntity<Map<String, Object>> platform(
            @RequestHeader(value = EdgeRequestIdFilter.HEADER, required = false) String requestId) {
        return unavailable("edge_upstream_unavailable", "the platform is not reachable; try again shortly", requestId);
    }

    @GetMapping("/fallback/ai")
    public ResponseEntity<Map<String, Object>> ai(
            @RequestHeader(value = EdgeRequestIdFilter.HEADER, required = false) String requestId) {
        return unavailable("edge_upstream_unavailable", "the ai service is not reachable; try again shortly", requestId);
    }

    @GetMapping("/fallback/web")
    public ResponseEntity<Map<String, Object>> web(
            @RequestHeader(value = EdgeRequestIdFilter.HEADER, required = false) String requestId) {
        return unavailable("edge_upstream_unavailable", "the web app is not reachable; try again shortly", requestId);
    }

    private static ResponseEntity<Map<String, Object>> unavailable(String code, String message, String requestId) {
        Map<String, Object> error = new LinkedHashMap<>();
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("code", code);
        inner.put("message", message);
        inner.put("request_id", requestId == null ? "unknown" : requestId);
        error.put("error", inner);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(error);
    }
}
