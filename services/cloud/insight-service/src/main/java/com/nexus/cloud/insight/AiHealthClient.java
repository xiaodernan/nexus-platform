package com.nexus.cloud.insight;

import java.util.Map;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * The same declarative shape against the FastAPI service. NEXUS-AI registers only under its own
 * opt-in (D877); when it has not, the name resolves to no instance and the fallback answers — which
 * is precisely the state this client should report, not hide.
 */
@FeignClient(name = "NEXUS-AI", fallback = AiHealthFallback.class)
public interface AiHealthClient {

    @GetMapping("/ai/v1/health")
    Map<String, Object> health();
}
