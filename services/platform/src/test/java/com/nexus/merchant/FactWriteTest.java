package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.testsupport.NexusIntegrationTest;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * What a merchant edit leaves in the trust layer, asserted against the card that has to cite it.
 *
 * <p>Two defects lived here, and each was invisible from whichever side of the boundary you were standing
 * on. The price fact was filed under {@code avg_price} while every reader — the card's lateral, the seeded
 * corpus, {@code quality.sql}, {@code FactAttribute} in packages/types — joins {@code price}, so the write
 * went into a column of its own and the card went on citing the number from before the edit. And
 * {@code FactRepository.record} was a bare INSERT, so a second edit filed a rival claim rather than
 * restating the first, to be settled by {@code limit 1}. V5 and D38 close both; these fail if either
 * regresses.
 */
class FactWriteTest extends NexusIntegrationTest {

    private static final String OBSERVATION = """
            select id, observed_at, expires_at, stale, value from facts
            where merchant_id = :id and attribute = 'price'
            """;

    @Autowired
    private MerchantService merchants;

    private Tenant tenant;

    @BeforeEach
    void seedTenant() {
        tenant = newTenant("facts");
    }

    /** The service takes the resolved tenant, not the fixture's id-and-slug pair. */
    private TenantContext context() {
        return new TenantContext(tenant.id(), tenant.slug(), "HKD", "Asia/Hong_Kong", "HK");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    @Test
    @DisplayName("A price edit restates the claim the card cites, and leaves no rival behind")
    void priceEditUpdatesTheCitedClaim() {
        String tag = tag();
        UUID id = merchant("priced-" + tag);

        merchants.recordProfileFacts(context(), id, Map.of("avg_price_hkd", new BigDecimal("88.00")));
        assertThat(priceFact("priced-" + tag).path("value").path("amount").asText()).isEqualTo("88.00");
        // The name this write used before D38. A fact nobody joins is a fact nobody cites.
        assertThat(count("select count(*) from facts where attribute = 'avg_price'", Map.of())).isZero();

        merchants.recordProfileFacts(context(), id, Map.of("avg_price_hkd", new BigDecimal("120.00")));
        assertThat(priceFact("priced-" + tag).path("value").path("amount").asText()).isEqualTo("120.00");
        assertThat(count("select count(*) from facts where merchant_id = :id and attribute = 'price'",
                Map.of("id", id))).isEqualTo(1);
    }

    @Test
    @DisplayName("A re-observed claim is the same row, fresh, with one expiry clock")
    void refreshRestoresFreshness() {
        String tag = tag();
        UUID id = merchant("fresh-" + tag);
        merchants.recordProfileFacts(context(), id, Map.of("avg_price_hkd", new BigDecimal("60.00")));
        Map<String, Object> before = row(OBSERVATION, Map.of("id", id));
        UUID factId = (UUID) before.get("id");
        assertThat(before.get("stale")).isEqualTo(false);
        assertThat(Duration.between(((Timestamp) before.get("observed_at")).toInstant(), Instant.now())
                .abs().toSeconds()).isLessThan(120);

        merchants.recordProfileFacts(context(), id, Map.of("avg_price_hkd", new BigDecimal("75.00")));
        Map<String, Object> after = row(OBSERVATION, Map.of("id", id));

        // The same row, restated — not a second live claim beside it.
        assertThat(after.get("id")).isEqualTo(factId);
        assertThat(Json.tree(String.valueOf(after.get("value"))).path("amount").asText()).isEqualTo("75.00");
        assertThat((Timestamp) after.get("observed_at")).isAfterOrEqualTo((Timestamp) before.get("observed_at"));
        assertThat(after.get("stale")).isEqualTo(false);
        // Six hours from this observation (AGENT_CONTRACT §5): a refresh does not inherit the old deadline.
        assertThat(Duration.between(((Timestamp) after.get("observed_at")).toInstant(),
                ((Timestamp) after.get("expires_at")).toInstant()).toMinutes()).isEqualTo(360);
    }

    // ---------------------------------------------------------------- fixtures

    private JsonNode priceFact(String slug) {
        var res = getRaw(tenant, null, "/api/v1/merchants/" + slug);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode facts = Json.tree(res.getBody()).path("facts");
        for (JsonNode fact : facts) {
            if ("price".equals(fact.path("attribute").asText())) {
                return fact;
            }
        }
        throw new AssertionError("no price fact in " + facts + " — the card prints a price with nothing behind it");
    }

    private UUID merchant(String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, status, data_origin,
                                       avg_price_hkd, ownership_verified)
                values (:id, :t, :slug, :legal, :display, 'published', 'demo', 80.00, true)
                """, new MapSqlParameterSource("id", id).addValue("t", tenant.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug));
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng,
                                       is_primary)
                values (:id, :m, :t, '1 Ledger Road', 'Hong Kong', 'Sha Tin', 22.385, 114.188, true)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", id).addValue("t", tenant.id()));
        return id;
    }
}
