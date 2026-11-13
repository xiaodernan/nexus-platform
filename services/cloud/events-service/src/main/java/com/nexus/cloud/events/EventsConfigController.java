package com.nexus.cloud.events;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * D1023 — a read-only window into the configuration this process ACTUALLY resolved.
 *
 * Symmetry with the insight-service (/insight/config, D889) and the dispatcher-service
 * (/dispatcher/config, D993/D994): the sixth registry member joins the package so every
 * member that imports the Config Server can prove which label it actually picked, and
 * {@code @RefreshScope} keeps that answer honest when the Config Server's file is rewritten
 * on disk.
 *
 * Narrow door on purpose — {@code POST /actuator/refresh} is exposed because a deployment on a
 * trusted plane already owns the door; this controller only serves the read.
 */
@RestController
@RefreshScope
public class EventsConfigController {

    private final String label;

    public EventsConfigController(@Value("${nexus.events.label:local}") String label) {
        this.label = label;
    }

    @GetMapping("/events/config")
    public Map<String, Object> config() {
        return Map.of(
                "service", "nexus-events",
                "config_label", label,
                "note", "the label this process resolved; 'local' means no Config Server answered");
    }
}
