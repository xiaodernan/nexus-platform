package com.nexus.cloud.dispatcher;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.client.discovery.EnableDiscoveryClient;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * NEXUS Webhook Dispatcher — D973.
 *
 * Seventh Spring Cloud element on this plane. Turns domain events on {@code nexus:events} into
 * HMAC-SHA256 signed outbound webhook deliveries, retried with exp backoff + deterministic jitter,
 * DLQ'd after N attempts, circuit-broken on repeated failures. Without explicitly-enabled hooks in
 * the configuration, the service subscribes and re-ACKs every event without ever performing an
 * outbound HTTP call.
 */
@SpringBootApplication
@EnableDiscoveryClient
@EnableScheduling
public class DispatcherApplication {

    public static void main(String[] args) {
        SpringApplication.run(DispatcherApplication.class, args);
    }
}
