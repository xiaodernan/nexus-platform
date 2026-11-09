package com.nexus.cloud.gateway;

import java.util.UUID;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

import reactor.core.publisher.Mono;

/**
 * Ensures every request that crosses the edge has an {@code X-Request-Id}. The platform already mints
 * one when absent (§1), but minting at the first hop means the id is the same one the browser, the
 * gateway log and the platform log can all quote; a caller-supplied id is never overwritten.
 */
@Component
public class EdgeRequestIdFilter implements GlobalFilter, Ordered {

    public static final String HEADER = "X-Request-Id";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String requestId = exchange.getRequest().getHeaders().getFirst(HEADER);
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
            ServerHttpRequest request = exchange.getRequest().mutate().header(HEADER, requestId).build();
            exchange = exchange.mutate().request(request).build();
        }
        // Set early so a gateway-local answer (route miss, 404) still carries the correlation id.
        exchange.getResponse().getHeaders().set(HEADER, requestId);
        return chain.filter(exchange);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
