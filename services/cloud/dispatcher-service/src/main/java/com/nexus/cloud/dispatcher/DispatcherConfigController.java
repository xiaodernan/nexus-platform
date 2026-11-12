package com.nexus.cloud.dispatcher;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * D993 — a read-only window into the configuration this process ACTUALLY resolved.
 *
 * Symmetry with insight-service's {@code /insight/config} (D889): every registry member that
 * imports the config server should expose which label it actually picked, and {@code @RefreshScope}
 * is what keeps the answer honest when the Config Server's file is rewritten on disk.
 *
 * The door is deliberately narrow — POST /actuator/refresh is exposed by the application because a
 * deployment with an ingress already owns the door; this controller only serves the read.
 */
@RestController
@RefreshScope
public class DispatcherConfigController {

    private final String label;

    public DispatcherConfigController(@Value("${nexus.dispatcher.label:local}") String label) {
        this.label = label;
    }

    @GetMapping("/dispatcher/config")
    public Map<String, Object> config() {
        return Map.of(
                "service", "nexus-dispatcher",
                "config_label", label,
                "note", "the label this process resolved; 'local' means no Config Server answered");
    }
}
