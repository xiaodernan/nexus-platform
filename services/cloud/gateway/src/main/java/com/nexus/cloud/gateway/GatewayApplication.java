package com.nexus.cloud.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.client.discovery.EnableDiscoveryClient;

/**
 * The cloud plane's single edge. Routes are URI-based on purpose: the monolith is not yet a Eureka
 * client, so the gateway must not depend on discovery to serve traffic. It still registers itself,
 * which is what the smoke run asserts — the registry learns about the edge without the edge needing
 * the registry to route.
 */
@SpringBootApplication
@EnableDiscoveryClient
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
