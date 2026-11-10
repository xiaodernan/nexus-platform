package com.nexus.cloud.insight;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.client.discovery.EnableDiscoveryClient;
import org.springframework.cloud.openfeign.EnableFeignClients;

/**
 * D885 — the plane's first genuinely separate service.
 *
 * <p>It registers with Eureka as {@code NEXUS-INSIGHT} (opt-out via
 * {@code NEXUS_INSIGHT_EUREKA_ENABLED=false}), shows up in Spring Boot Admin like every other
 * member, and calls the monolith and the AI service through declarative Feign clients resolved by
 * NAME through Spring Cloud LoadBalancer. It owns no database and writes nothing.
 *
 * <p>The monolith stays a monolith. This is a sidecar that consumes the registry, not a reason to
 * split commerce transactions across a network.
 */
@SpringBootApplication
@EnableDiscoveryClient
@EnableFeignClients
public class InsightServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(InsightServiceApplication.class, args);
    }
}
