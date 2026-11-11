package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;

/**
 * D902 door: an unknown {@code X-Tenant} slug must not cost one Postgres query per request.
 * TenantFilter runs at order 20 — before AuthFilter (30) and RateLimitFilter (50) — so the
 * penetrating request is unauthenticated and unthrottled; {@code computeIfAbsent} does not store
 * a null result, so every bogus slug re-ran the SELECT forever (cache penetration).
 *
 * <p>The instrument is a counting {@link NamedParameterJdbcTemplate}: it overrides the exact
 * overload {@code load()} calls and answers from a fixture, so the number counted is the number
 * of selects the SERVICE issues — no database, no timing, no flake. The HTTP behavior (404 for
 * unknown, 200 for known) is proven separately by {@code TenantNegativeCacheHttpTest}.
 */
class TenantCachePenetrationTest {

    /** Counts selects; never opens a connection (the datasource is a nameless stub). */
    static final class CountingJdbc extends NamedParameterJdbcTemplate {
        final AtomicInteger selects = new AtomicInteger();
        Function<String, List<Map<String, Object>>> answer = slug -> List.of();

        CountingJdbc() {
            super(new SimpleDriverDataSource());
        }

        @Override
        public List<Map<String, Object>> queryForList(String sql, SqlParameterSource paramSource) {
            selects.incrementAndGet();
            return answer.apply((String) paramSource.getValue("slug"));
        }
    }

    private static Map<String, Object> row(String slug) {
        return Map.of("id", UUID.randomUUID(), "slug", slug, "currency", "HKD",
                "timezone", "Asia/Hong_Kong", "country_code", "HK");
    }

    @Test
    @DisplayName("R1: the same unknown slug twice costs ONE select, not one per request")
    void unknownSlugIsCached() {
        CountingJdbc jdbc = new CountingJdbc();
        TenantService tenants = new TenantService(jdbc, 30_000, 1024);
        assertThat(tenants.resolve("no-such-tenant")).isNull();
        assertThat(tenants.resolve("no-such-tenant")).isNull();
        assertThat(jdbc.selects.get()).as("the negative tier must answer the second resolve").isEqualTo(1);
    }

    @Test
    @DisplayName("R2: the negative tier is bounded — the eldest entry is evicted, the newest kept")
    void negativeCacheIsBounded() {
        CountingJdbc jdbc = new CountingJdbc();
        int cap = 64;
        TenantService tenants = new TenantService(jdbc, 30_000, cap);
        assertThat(tenants.resolve("ghost-0")).isNull();
        for (int i = 1; i <= cap * 4; i++) {
            assertThat(tenants.resolve("ghost-" + i)).isNull();
        }
        int before = jdbc.selects.get();
        assertThat(tenants.resolve("ghost-0")).isNull();
        assertThat(jdbc.selects.get()).as("the eldest negative was evicted, so it must select again")
                .isEqualTo(before + 1);
        assertThat(tenants.resolve("ghost-" + cap * 4)).isNull();
        assertThat(jdbc.selects.get()).as("the newest negative must still be cached").isEqualTo(before + 1);
    }

    @Test
    @DisplayName("R3: a negative entry expires — after the TTL the slug is looked up again")
    void negativeEntryExpires() throws Exception {
        CountingJdbc jdbc = new CountingJdbc();
        // 500ms, not 120: on a cold JVM the first two resolves can take >120ms of class loading,
        // which expired the entry before the pre-sleep checkpoint and flaked the door (found by A2).
        TenantService tenants = new TenantService(jdbc, 500, 1024);
        assertThat(tenants.resolve("ephemeral")).isNull();
        assertThat(tenants.resolve("ephemeral")).isNull();
        assertThat(jdbc.selects.get()).isEqualTo(1);
        Thread.sleep(700);
        assertThat(tenants.resolve("ephemeral")).isNull();
        assertThat(jdbc.selects.get()).as("an expired negative must be re-validated against the table")
                .isEqualTo(2);
    }

    @Test
    @DisplayName("R4: a known slug resolves with one select, normalized, and keeps its row fields")
    void knownSlugUnchanged() {
        CountingJdbc jdbc = new CountingJdbc();
        jdbc.answer = slug -> slug.equals("hong-kong") ? List.of(row(slug)) : List.of();
        TenantService tenants = new TenantService(jdbc, 30_000, 1024);
        TenantContext first = tenants.resolve("hong-kong");
        TenantContext second = tenants.resolve("  HONG-KONG  ");
        assertThat(first).isNotNull();
        assertThat(second).isSameAs(first);
        assertThat(first.currency()).isEqualTo("HKD");
        assertThat(first.timezone()).isEqualTo("Asia/Hong_Kong");
        assertThat(first.countryCode()).isEqualTo("HK");
        assertThat(jdbc.selects.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("R5: a failed select propagates and is never cached as a negative")
    void dbFailureIsNotCached() {
        CountingJdbc jdbc = new CountingJdbc();
        jdbc.answer = slug -> {
            throw new IllegalStateException("db down");
        };
        TenantService tenants = new TenantService(jdbc, 30_000, 1024);
        assertThatThrownBy(() -> tenants.resolve("hong-kong")).isInstanceOf(IllegalStateException.class);
        jdbc.answer = slug -> List.of(row(slug));
        assertThat(tenants.resolve("hong-kong")).as("a failure must not poison the next resolve").isNotNull();
    }

    @Test
    @DisplayName("R6: evict() clears the negative tier too, so a newly created tenant is visible")
    void evictClearsNegative() {
        CountingJdbc jdbc = new CountingJdbc();
        TenantService tenants = new TenantService(jdbc, 30_000, 1024);
        assertThat(tenants.resolve("late-arrival")).isNull();
        jdbc.answer = slug -> List.of(row(slug));
        tenants.evict("late-arrival");
        assertThat(tenants.resolve("late-arrival")).as("evict must drop the negative, not just the positive")
                .isNotNull();
    }
}