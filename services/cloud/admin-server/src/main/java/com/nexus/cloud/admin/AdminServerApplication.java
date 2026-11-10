package com.nexus.cloud.admin;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.client.discovery.EnableDiscoveryClient;

/**
 * The plane's one window. Every service registered with Eureka (NEXUS-GATEWAY,
 * NEXUS-PLATFORM, NEXUS-AI under opt-in, NEXUS-ADMIN itself if asked to) is listed here
 * live: health, details, metrics, env, loggers, mappings. No auth — it sits behind the
 * same trusted-hop boundary the edge does; nothing public routes to it until the plane
 * gets a deployment ingress (D850's ruling applies).
 */
@SpringBootApplication
@EnableDiscoveryClient
@de.codecentric.boot.admin.server.config.EnableAdminServer
public class AdminServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(AdminServerApplication.class, args);
    }
}
