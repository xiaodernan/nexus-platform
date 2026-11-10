package com.nexus.cloud.insight;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * D889 — a read-only window into the configuration this process ACTUALLY resolved.
 *
 * <p>Every other registry member imports the Config Server; the fifth one did not. This controller
 * closes that seam and makes the round trip observable. {@code @RefreshScope} is the load-bearing
 * part: on {@code POST /actuator/refresh} the bean is destroyed and re-created with new
 * {@code @Value} bindings, so a config-repo edit becomes visible without a restart. Without it,
 * a config server that merely serves a file at boot is decoration.
 *
 * <p>The fallback is honest: {@code local} means no Config Server answered, not that a remote
 * label happened to be "local". The view never guesses and never reports a label it did not read.
 */
@RestController
@RefreshScope
public class ConfigViewController {

    private final String label;

    public ConfigViewController(@Value("${nexus.insight.label:local}") String label) {
        this.label = label;
    }

    @GetMapping("/insight/config")
    public Map<String, Object> config() {
        return Map.of(
                "service", "nexus-insight",
                "config_label", label,
                "note", "the label this process resolved; 'local' means no Config Server answered");
    }
}
