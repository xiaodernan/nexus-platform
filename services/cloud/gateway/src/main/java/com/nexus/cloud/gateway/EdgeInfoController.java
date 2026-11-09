package com.nexus.cloud.gateway;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.route.RouteDefinitionLocator;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import reactor.core.publisher.Mono;

/**
 * A read-only window into the edge: which service this is, which config label it resolved, and the
 * route table it will use. The smoke run reads this to prove the config-server round-trip (label
 * {@code cloud-smoke} instead of the local default) without exposing the whole environment.
 */
@RestController
public class EdgeInfoController {

    private final RouteDefinitionLocator routes;
    private final String service;
    private final String label;

    public EdgeInfoController(
            RouteDefinitionLocator routes,
            @Value("${spring.application.name}") String service,
            @Value("${nexus.edge.label:local}") String label) {
        this.routes = routes;
        this.service = service;
        this.label = label;
    }

    @GetMapping("/cloud/info")
    public Mono<Map<String, Object>> info() {
        return routes.getRouteDefinitions()
                .map(route -> Map.of("id", route.getId(), "uri", route.getUri().toString()))
                .collectList()
                .map(table -> Map.of("service", service, "label", label, "routes", table));
    }
}
