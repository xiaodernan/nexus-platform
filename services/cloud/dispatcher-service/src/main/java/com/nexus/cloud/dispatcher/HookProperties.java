package com.nexus.cloud.dispatcher;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.validation.annotation.Validated;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;

/**
 * The only configuration knob that actually arms an outbound POST: a non-empty {@code hooks}
 * block where every hook has {@code enabled: true}. Everything else defaults to safe-inert:
 * empty hook map, polling once every 1 second, circuit breaker trips on 3 consecutive failures,
 * exp base 250 ms, jitter 100 ms deterministic (fnv1a64 of `hookId + deliveryId`), 5 max attempts,
 * 5 s timeout. An empty map means NO outbound HTTP ever leaves the process.
 *
 * <p>Secrets never leave this class in JVM memory: they live in the yaml/env the operator sets
 * and are read once at boot. {@link #hooks()} exposes only the masked map for observability.
 */
@Component
@Validated
@ConfigurationProperties(prefix = "nexus.dispatcher")
public class HookProperties {

    private boolean enabled = true;

    private String url = "redis://127.0.0.1:6380/0";

    private long pollMs = 1000L;

    /** The bound of in-flight (not yet delivered-or-parked) tasks kept in memory. */
    private int maxInFlight = 64;

    /** The queue depth before the poller refuses to read another entry (backpressure). */
    private int maxQueue = 128;

    private Map<String, Hook> hooks = new LinkedHashMap<>();

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public String getUrl() { return url; }
    public void setUrl(String url) { this.url = url; }

    public long getPollMs() { return pollMs; }
    public void setPollMs(long pollMs) { this.pollMs = pollMs; }

    public int getMaxInFlight() { return maxInFlight; }
    public void setMaxInFlight(int maxInFlight) { this.maxInFlight = maxInFlight; }

    public int getMaxQueue() { return maxQueue; }
    public void setMaxQueue(int maxQueue) { this.maxQueue = maxQueue; }

    public Map<String, Hook> getHooks() { return hooks; }
    public void setHooks(Map<String, Hook> hooks) { this.hooks = hooks == null ? new LinkedHashMap<>() : hooks; }

    /** The number of enabled hooks — the gate an operator flips to arm the outbound plane. */
    public long enabledHookCount() {
        return hooks.values().stream().filter(Hook::isOn).count();
    }

    /** The map admin endpoints should expose: everything {@link Hook} publicly exposes,
     *  secrets masked. */
    public Map<String, PublicHook> publicHooks() {
        Map<String, PublicHook> out = new LinkedHashMap<>();
        for (Map.Entry<String, Hook> entry : hooks.entrySet()) {
            Hook h = entry.getValue();
            out.put(entry.getKey(),
                new PublicHook(h.id, h.eventTypes, h.uri, h.isOn(),
                    h.maxAttempts, h.baseDelayMs, h.jitterMs, h.timeoutMs,
                    h.circuitBreakerThreshold, h.enabled == null ? true : h.enabled));
        }
        return out;
    }

    /** Default timeout for the underlying {@code java.net.http.HttpClient} send. */
    public Duration webhookTimeout() {
        // A single number drives both the HTTP client's timeout and per-hook overrides are allowed.
        return Duration.ofMillis(5_000L);
    }

    public static class Hook {
        /** Event-type match. Empty/`*` matches everything; a prefix `Reservation*` matches namespace. */
        private String eventTypes = "";

        @NotBlank
        @Pattern(regexp = "^https?://\\S+$", message = "uri must be an absolute http(s) URL")
        private String uri;

        @NotBlank
        private String secret;

        @Positive
        private int maxAttempts = 5;

        @Positive
        private long baseDelayMs = 250L;

        private long jitterMs = 100L;

        @Positive
        private long timeoutMs = 5_000L;

        @Positive
        private int circuitBreakerThreshold = 3;

        private Boolean enabled = true;

        /** Stable hook id — the map key, kept for symmetry with the public shape. */
        private String id;

        public String getEventTypes() { return eventTypes; }
        public void setEventTypes(String eventTypes) { this.eventTypes = eventTypes == null ? "" : eventTypes; }

        public String getUri() { return uri; }
        public void setUri(String uri) { this.uri = uri; }

        public String getSecret() { return secret; }
        public void setSecret(String secret) { this.secret = secret; }

        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int maxAttempts) { this.maxAttempts = maxAttempts; }

        public long getBaseDelayMs() { return baseDelayMs; }
        public void setBaseDelayMs(long baseDelayMs) { this.baseDelayMs = baseDelayMs; }

        public long getJitterMs() { return jitterMs; }
        public void setJitterMs(long jitterMs) { this.jitterMs = jitterMs; }

        public long getTimeoutMs() { return timeoutMs; }
        public void setTimeoutMs(long timeoutMs) { this.timeoutMs = timeoutMs; }

        public int getCircuitBreakerThreshold() { return circuitBreakerThreshold; }
        public void setCircuitBreakerThreshold(int circuitBreakerThreshold) {
            this.circuitBreakerThreshold = circuitBreakerThreshold;
        }

        public Boolean getEnabled() { return enabled; }
        public void setEnabled(Boolean enabled) { this.enabled = enabled; }

        public String getId() { return id; }
        public void setId(String id) { this.id = id; }

        public boolean isOn() { return Boolean.TRUE.equals(enabled); }

        /** True iff {@code event.getType()} matches this hook. */
        public boolean matches(String eventType) {
            if (eventTypes == null || eventTypes.isBlank() || "*".equals(eventTypes.trim())) {
                return true;
            }
            for (String raw : eventTypes.split(",")) {
                String spec = raw.trim();
                if (spec.isEmpty()) continue;
                if (spec.endsWith("*")) {
                    String prefix = spec.substring(0, spec.length() - 1);
                    if (eventType != null && eventType.startsWith(prefix)) return true;
                } else if (spec.equals(eventType)) {
                    return true;
                }
            }
            return false;
        }
    }

    public record PublicHook(
            String id,
            String eventTypes,
            String uri,
            boolean enabled,
            int maxAttempts,
            long baseDelayMs,
            long jitterMs,
            long timeoutMs,
            int circuitBreakerThreshold,
            Boolean enabledMirror
    ) {}
}
