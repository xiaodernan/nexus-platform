package com.nexus.cloud.insight;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.stereotype.Component;

/**
 * What the breaker answers with when {@code NEXUS-PLATFORM} has no live instance or refuses the
 * call. Deliberately DOES NOT return {@code {"status":"UP"}}: a fallback that impersonates a healthy
 * upstream would make every aggregated view a lie. {@code insight_fallback} is the marker the
 * controller uses to name this row honestly.
 */
@Component
public class PlatformHealthFallback implements PlatformHealthClient {

    @Override
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("insight_fallback", true);
        body.put("status", "unavailable");
        body.put("detail", "no live NEXUS-PLATFORM response; the breaker answered");
        return body;
    }
}
