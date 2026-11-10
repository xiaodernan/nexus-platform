package com.nexus.platform;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The config-server round-trip's proof on the monolith (cloud profile, opt-in — D872).
 *
 * <p>`/api/v1/cloud/info` reports the banner the monolith resolved from the config server
 * (`nexus.platform.banner`, default "unmanaged" when the config server is absent). Under the
 * `cloud` profile the `spring.config.import` in {@code application-cloud.yml} makes that the
 * marker served by the native repo; POST {@code /actuator/refresh} (exposed under the cloud
 * profile only) re-reads this bean via {@code @RefreshScope}, which is what a config-repo edit
 * without a restart looks like for the monolith.
 *
 * <p>Deliberately content-free: this endpoint carries no user data, no configuration beyond a
 * label, and no operational surface — the config server itself carries the health of every service
 * the plane serves. Dev plane only by configuration; a production overlay would hide it.
 */
@RestController
@RefreshScope
@RequestMapping("/api/v1/cloud")
public class CloudInfoController {

    private final String banner;
    private final org.springframework.core.env.Environment env;

    public CloudInfoController(
            @Value("${nexus.platform.banner:unmanaged}") String banner,
            org.springframework.core.env.Environment env) {
        this.banner = banner;
        this.env = env;
    }

    @GetMapping("/info")
    public Map<String, Object> info() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("service", "nexus-platform");
        out.put("banner", banner);
        out.put("config_source", banner.equals("unmanaged") ? "local-default" : "config-server");
        out.put("profiles", env.getActiveProfiles());
        return out;
    }
}
