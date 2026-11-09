package com.nexus.cloud.config;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.config.server.EnableConfigServer;

/**
 * Serves the cloud plane's externalised configuration. The repository is the classpath folder
 * {@code config-repo}, so the served files ship inside this jar: one artefact, no external volume,
 * and the gateway's optional config import verifies the round-trip without a database.
 */
@SpringBootApplication
@EnableConfigServer
public class ConfigServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ConfigServerApplication.class, args);
    }
}
