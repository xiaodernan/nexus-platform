package com.nexus;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * NEXUS commerce core — a single deployable modular monolith.
 *
 * <p>Packages mirror the future service split (docs/DECISIONS.md D2):
 * identity, merchant, catalog, discovery, commerce, reservation, payment, conversation,
 * growth, analytics, admin, with cross-cutting concerns in platform.
 */
@SpringBootApplication
public class NexusApplication {

    public static void main(String[] args) {
        SpringApplication.run(NexusApplication.class, args);
    }
}
