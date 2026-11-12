package com.nexus.cloud.dispatcher;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The window this sidecar exposes to humans and dashboards. Read-only by construction.
 * Every response is a projection of what the service already knows — no fabricated numbers.
 */
@RestController
public class DispatcherViewController {

    private final DispatcherReader reader;
    private final DispatcherWorker worker;

    public DispatcherViewController(DispatcherReader reader, DispatcherWorker worker) {
        this.reader = reader;
        this.worker = worker;
    }

    @GetMapping("/dispatcher/state")
    public Map<String, Object> state() {
        return reader.state();
    }

    @GetMapping("/dispatcher/recent")
    public Map<String, Object> recent() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("recent", ((java.util.Map<?, ?>) worker.state().get("recent")));
        @SuppressWarnings("unchecked")
        Map<String, Map<String, Object>> hooks = (Map<String, Map<String, Object>>)
            ((Map<?, ?>) worker.state().get("hooks"));
        out.put("hooks", hooks);
        out.put("enabled", worker.state().get("enabled"));
        out.put("circuitBreakers", worker.state().get("circuitBreakers"));
        return out;
    }
}
