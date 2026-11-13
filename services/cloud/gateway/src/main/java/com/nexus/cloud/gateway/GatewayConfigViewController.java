package com.nexus.cloud.gateway;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * D1034 — a read-only window into the configuration this edge ACTUALLY resolved.
 *
 * Symmetry with {@code /insight/config} (D889), {@code /dispatcher/config} (D993/D994),
 * {@code /events/config} (D1023): every member that imports the Config Server exposes which
 * label it actually picked, and {@code @RefreshScope} keeps that answer honest when the
 * Config Server's file is rewritten on disk. The edge never leaves a stale label readable.
 */
@RestController
@RefreshScope
public class GatewayConfigViewController {

    private final String label;

    public GatewayConfigViewController(@Value("${nexus.gateway.label:local}") String label) {
        this.label = label;
    }

    @GetMapping("/gateway/config")
    public Map<String, Object> config() {
        return Map.of(
                "service", "nexus-gateway",
                "config_label", label,
                "note", "the label this edge resolved; 'local' means no Config Server answered");
    }
}
