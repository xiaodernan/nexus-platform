package com.nexus;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * NEXUS commerce core — a single deployable modular monolith.
 *
 * <p>Packages mirror the future service split (docs/DECISIONS.md D2):
 * identity, merchant, catalog, discovery, commerce, reservation, payment, conversation,
 * growth, analytics, admin, with cross-cutting concerns in platform.
 *
 * <p>{@code @EnableScheduling} is required for {@link com.nexus.identity.RetentionSweeper}'s tick to
 * fire. The tick itself defaults-off behind {@code nexus.retention.enabled}; tests that drive the
 * sweeper directly are unaffected.
 */
@SpringBootApplication
@EnableScheduling
public class NexusApplication {

    public static void main(String[] args) {
        SpringApplication.run(NexusApplication.class, args);
    }
}
