package com.nexus.cloud.events;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.client.discovery.EnableDiscoveryClient;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * D928's second half: the FIFTH member of the Spring Cloud plane.
 *
 * <p>Unlike {@code nexus-insight}, this service does not call other services through Feign.
 * It tails ONE Redis stream ({@code nexus:events}) into a bounded in-memory ring and answers
 * {@code /events/*}. It exists so the
 * bus the platform writes into has a consumer on this plane that reads it — currently the only consumer.
 *
 * <p>Registering with Eureka is opt-out via env {@code NEXUS_EVENTS_EUREKA_ENABLED}
 * (default true); when disabled this service is a local diagnostic endpoint for the dot side.
 */
@SpringBootApplication
@EnableScheduling
@EnableDiscoveryClient
public class EventsApplication {

    public static void main(String[] args) {
        SpringApplication.run(EventsApplication.class, args);
    }
}
