package com.nexus.platform;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * The fixed V1 schema ships no data (docs/DECISIONS.md D2 of the infra contract: migrations are
 * schema-only), so the tenant row the resolver needs is ensured at startup. Idempotent and
 * insert-only — it never mutates or deletes anything.
 */
@Component
public class BootstrapRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(BootstrapRunner.class);

    private final NamedParameterJdbcTemplate jdbc;
    private final String defaultSlug;

    public BootstrapRunner(NamedParameterJdbcTemplate jdbc, @Value("${nexus.tenant.default-slug:hong-kong}") String defaultSlug) {
        this.jdbc = jdbc;
        this.defaultSlug = defaultSlug;
    }

    @Override
    public void run(ApplicationArguments args) {
        int inserted = jdbc.update("""
                insert into tenants (slug, name, country_code, timezone, currency)
                values (:slug, initcap(replace(:slug, '-', ' ')), 'HK', 'Asia/Hong_Kong', 'HKD')
                on conflict (slug) do nothing
                """, new MapSqlParameterSource("slug", defaultSlug));
        log.info("bootstrap_tenant slug={} created={} (0 = already present)", defaultSlug, inserted);
    }
}
