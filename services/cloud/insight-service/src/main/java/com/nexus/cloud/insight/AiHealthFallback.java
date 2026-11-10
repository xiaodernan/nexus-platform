package com.nexus.cloud.insight;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.stereotype.Component;

/**
 * The AI service's honest fallback. NEXUS-AI registers only by opt-in (D877), so "absent from the
 * registry" is an expected state on this dev plane — and the aggregated view says so.
 */
@Component
public class AiHealthFallback implements AiHealthClient {

    @Override
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("insight_fallback", true);
        body.put("status", "unavailable");
        body.put("detail", "no live NEXUS-AI response; the breaker answered");
        return body;
    }
}
