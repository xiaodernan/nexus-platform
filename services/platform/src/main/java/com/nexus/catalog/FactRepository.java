package com.nexus.catalog;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * The trust-layer primitive (AGENT_CONTRACT §4, §20 freshness): every material value we render — a
 * price, opening hours, availability — gets a {@code facts} row with a source, confidence and TTL, so
 * a claim can be cited or marked stale. Facts have no tenant column in V1; they are anchored through
 * {@code merchants}, so merchant-scoped writes here always verify the merchant is in-tenant first.
 */
@Repository
public class FactRepository {

    /** Freshness classes from AGENT_CONTRACT §5. */
    public static final Duration PRICE_TTL = Duration.ofHours(6);
    public static final Duration HOURS_TTL = Duration.ofDays(1);
    public static final Duration DESCRIPTION_TTL = Duration.ofDays(7);

    private final TenantJdbc jdbc;

    public FactRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Record an observation of a claim. A second observation of the same {@code (subject, attribute)}
     * <em>replaces</em> the first rather than filing a rival beside it: readers take
     * {@code order by observed_at desc limit 1}, so a stale row that outlives the fact it describes is a
     * second truth waiting to be cited (V5 makes that a constraint, not a convention). A refreshed claim is
     * observed now, is no longer stale, and carries a fresh TTL — one expiry clock per claim.
     */
    public UUID record(TenantContext tenant, String subjectType, UUID subjectId, UUID merchantId, String attribute,
                       Object value, String unit, String currency, String source, double confidence, Duration ttl) {
        Map<String, Object> row = jdbc.crossTenantReturning("""
                insert into facts (subject_type, subject_id, merchant_id, attribute, value, unit, currency, source,
                                   confidence, observed_at, expires_at)
                values (:subject_type, :subject_id, cast(:merchant_id as uuid), :attribute, cast(:value as jsonb),
                        cast(:unit as text), cast(:currency as text), :source, cast(:confidence as numeric),
                        now(),
                        case when cast(:ttl_seconds as bigint) is null then null
                             else now() + make_interval(secs => cast(:ttl_seconds as bigint)) end)
                on conflict (subject_type, subject_id, attribute) do update
                  set value = excluded.value, unit = excluded.unit, currency = excluded.currency,
                      source = excluded.source, confidence = excluded.confidence,
                      merchant_id = excluded.merchant_id, observed_at = now(), stale = false,
                      expires_at = excluded.expires_at
                returning id
                """, Json.map("subject_type", subjectType, "subject_id", subjectId, "merchant_id", merchantId,
                "attribute", attribute,
                "value", value instanceof String s ? s : Json.write(value),
                "unit", unit, "currency", currency, "source", source, "confidence", confidence,
                "ttl_seconds", ttl == null ? null : ttl.getSeconds()));
        return Json.uuid(row, "id");
    }

    /**
     * Retire a claim that stopped existing: a subject whose published evidence is now empty must not
     * keep a card citing a rating it no longer has. Leaving the row behind is the false citation in
     * its least visible form — the number disappears from the card while its provenance stays live.
     */
    public void drop(TenantContext tenant, String subjectType, UUID subjectId, String attribute) {
        jdbc.updateForTenant(tenant, "delete from facts f using merchants m"
                + " where f.merchant_id = m.id and m.tenant_id = :tenant_id"
                + " and f.subject_type = :subject_type and f.subject_id = :subject_id"
                + " and f.attribute = :attribute",
                Json.map("tenant_id", tenant.tenantId(), "subject_type", subjectType,
                        "subject_id", subjectId, "attribute", attribute));
    }

    public Optional<Map<String, Object>> latest(TenantContext tenant, String subjectType, UUID subjectId,
                                                String attribute) {
        // facts.merchant_id is the tenant anchor for merchant-owned subjects.
        return jdbc.firstForTenant(tenant, """
                select f.id, f.subject_type, f.subject_id, f.attribute, f.value, f.source, f.confidence,
                       f.observed_at, f.expires_at, f.stale, m.tenant_id
                from facts f join merchants m on m.id = f.merchant_id
                where f.subject_type = :subject_type and f.subject_id = :subject_id and f.attribute = :attribute
                  and m.tenant_id = :tenant_id
                order by f.observed_at desc limit 1
                """, Json.map("subject_type", subjectType, "subject_id", subjectId, "attribute", attribute));
    }

    public List<Map<String, Object>> forSubject(TenantContext tenant, String subjectType, UUID subjectId) {
        return jdbc.forTenant(tenant, """
                select f.id, f.subject_type, f.subject_id, f.attribute, f.value, f.unit, f.currency, f.source,
                       f.confidence, f.observed_at, f.expires_at, f.stale, m.tenant_id
                from facts f join merchants m on m.id = f.merchant_id
                where f.subject_type = :subject_type and f.subject_id = :subject_id and m.tenant_id = :tenant_id
                order by f.observed_at desc limit 50
                """, Json.map("subject_type", subjectType, "subject_id", subjectId));
    }

    /** §5: expired facts are marked stale rather than deleted, so a UI can say "may have changed". */
    public int markExpiredStale(TenantContext tenant) {
        return jdbc.updateForTenant(tenant, """
                update facts f set stale = true
                from merchants m
                where f.merchant_id = m.id and m.tenant_id = :tenant_id
                  and f.expires_at is not null and f.expires_at < now() and f.stale = false
                """, Json.map());
    }

    public static Map<String, Object> view(Map<String, Object> row) {
        return Json.map("fact_id", Json.str(row, "id"), "subject_type", Json.str(row, "subject_type"),
                "subject_id", Json.str(row, "subject_id"), "attribute", Json.str(row, "attribute"),
                "value", Json.json(row, "value"), "unit", Json.str(row, "unit"), "currency", Json.str(row, "currency"),
                "source", Json.str(row, "source"), "confidence", Json.dec(row, "confidence"),
                "observed_at", Json.ts(row, "observed_at"), "expires_at", Json.ts(row, "expires_at"),
                "stale", Json.bool(row, "stale"));
    }
}
