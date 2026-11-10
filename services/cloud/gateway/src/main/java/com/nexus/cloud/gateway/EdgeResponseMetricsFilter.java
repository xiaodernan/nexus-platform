package com.nexus.cloud.gateway;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.support.ServerWebExchangeUtils;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * One honest edge signal this build actually has: every 5xx status code that LEAVES the edge is
 * counted, tagged with the matched route. No inference about why — upstream failure, breaker fallback,
 * anything >= 500 — the edge saw it on the wire and counts it.
 *
 * <p>The gateway's own Retry filter is Spring's implementation and emits no micrometer counter; rather
 * than pretend one exists, the plane counts what it can truthfully observe. Named
 * {@code nexus.edge.response.5xx} with a single tag {@code route}.
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
public class EdgeResponseMetricsFilter implements WebFilter {

    private final MeterRegistry registry;

    public EdgeResponseMetricsFilter(MeterRegistry registry) {
        this.registry = registry;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        return chain.filter(exchange).then(Mono.fromRunnable(() -> {
            var status = exchange.getResponse().getStatusCode();
            if (status != null && status.value() >= 500) {
                var matched = exchange.getAttributes().get(ServerWebExchangeUtils.GATEWAY_PREDICATE_ROUTE_ATTR);
                String route = matched instanceof Route r ? r.getId() : "unknown";
                registry.counter("nexus.edge.response.5xx",
                        "route", route).increment();
            }
        }));
    }
}
