package com.nexus.cloud.insight;

import java.util.Map;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * A declarative call to the monolith, resolved as {@code lb://NEXUS-PLATFORM} through Eureka +
 * Spring Cloud LoadBalancer. There is no host, no port and no URI literal on this interface: if the
 * service is renamed in the registry, the caller has to say so here rather than quietly reaching a
 * stale address.
 *
 * <p>The fallback is NOT a cached healthy answer. It returns an explicit
 * {@code insight_fallback: true} marker so the aggregator can label the row {@code unavailable}
 * instead of mistaking a breaker response for a live service (the platform's "real data or nothing"
 * rule, applied to health).
 */
@FeignClient(name = "NEXUS-PLATFORM", fallback = PlatformHealthFallback.class,
        configuration = InsightTraceConfig.Defaults.class)
public interface PlatformHealthClient {

    @GetMapping("/api/v1/health")
    Map<String, Object> health();
}
