package com.nexus.growth;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Persistence for §8's share links: the {@code share_links} table V7 adds.
 *
 * <p>The subject lookup is the part worth reading. A share link is a promise that the address it carries
 * opens something, so {@link #subject} resolves the target <em>now</em>, from the same rows the consumer
 * page reads, and only from rows that are actually public: a published merchant, an offering of a
 * published merchant, a public collection, a published guide. A draft merchant has no shareable page, and
 * a link minted for one would be a short address to a 404 — so it is refused at mint time rather than
 * handed out and broken later.
 *
 * <p>The returned row is normalised across four different tables into one shape
 * ({@code path, title, description, image_url}) because that is all an Open Graph payload needs, and the
 * alternative — four response shapes for one endpoint — would push the difference into every client.
 * {@code image_url} and {@code description} are nullable and stay nullable: an unillustrated merchant must
 * not gain an image, and an undescribed one must not gain a sentence (the §19 rule, applied to metadata).
 */
@Repository
public class ShareRepository {

    private final TenantJdbc jdbc;

    public ShareRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** The live link for a subject, if one was already minted. */
    public Optional<Map<String, Object>> liveForSubject(TenantContext tenant, String subjectType, UUID subjectId) {
        return jdbc.firstForTenant(tenant, """
                select s.id, s.code, s.subject_type, s.subject_id, s.created_by, s.hits, s.created_at
                from share_links s
                where s.tenant_id = :tenant_id and s.subject_type = :subject_type
                  and s.subject_id = :subject_id and s.revoked_at is null
                """, Json.map("subject_type", subjectType, "subject_id", subjectId));
    }

    /** Resolves a code. A revoked or unknown code is absent — the same answer for both. */
    public Optional<Map<String, Object>> resolve(TenantContext tenant, String code) {
        return jdbc.firstForTenant(tenant, """
                select s.id, s.code, s.subject_type, s.subject_id, s.hits, s.created_at
                from share_links s
                where s.tenant_id = :tenant_id and s.code = :code and s.revoked_at is null
                """, Json.map("code", code));
    }

    /**
     * Mints a code. The partial unique index is what makes this safe under concurrency: two simultaneous
     * shares of one subject cannot both insert, and the loser's {@code DuplicateKeyException} is turned into
     * "here is the link that already exists" by the controller rather than into a 500.
     */
    public Map<String, Object> insert(TenantContext tenant, String code, String subjectType, UUID subjectId,
                                      UUID createdBy) {
        return jdbc.insertForTenant(tenant, """
                insert into share_links (tenant_id, code, subject_type, subject_id, created_by)
                values (:tenant_id, :code, :subject_type, :subject_id, :created_by)
                returning id, code, subject_type, subject_id, created_by, hits, created_at
                """, Json.map("code", code, "subject_type", subjectType, "subject_id", subjectId,
                "created_by", createdBy));
    }

    /** Counts the links a tenant has minted for a subject, revoked ones included — for the caller's report. */
    public long countForSubject(TenantContext tenant, String subjectType, UUID subjectId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from share_links s
                where s.tenant_id = :tenant_id and s.subject_type = :subject_type and s.subject_id = :subject_id
                """, Json.map("subject_type", subjectType, "subject_id", subjectId));
    }

    /**
     * The public target of a subject, normalised to {@code path,title,description,image_url}.
     *
     * <p>An empty result means "there is nothing shareable here", and the controller answers 404 for it —
     * the same answer a foreign tenant gets, so a caller cannot use this route to discover which merchant
     * ids exist in another tenant.
     */
    public Optional<Map<String, Object>> subject(TenantContext tenant, String subjectType, UUID subjectId) {
        String sql = switch (subjectType) {
            case "merchant" -> """
                    select '/m/' || m.slug as path, m.display_name as title, m.description as description,
                           m.images->>0 as image_url
                    from merchants m
                    where m.id = :subject_id and m.tenant_id = :tenant_id and m.status = 'published'
                    """;
            case "offering" -> """
                    select '/o/' || o.slug as path, o.name as title, o.description as description,
                           o.images->>0 as image_url
                    from offerings o join merchants m on m.id = o.merchant_id
                    where o.id = :subject_id and o.tenant_id = :tenant_id and m.tenant_id = :tenant_id
                      and m.status = 'published' and o.status = 'active'
                    """;
            case "collection", "guide" -> """
                    select case when c.kind = 'guide' then '/guides/' else '/collections/' end || c.slug as path,
                           c.title as title, c.description as description, c.cover_url as image_url
                    from collections c
                    where c.id = :subject_id and c.tenant_id = :tenant_id
                      and c.visibility = 'public' and c.published_at is not null
                      and c.kind = :kind
                    """;
            default -> null;
        };
        if (sql == null) {
            return Optional.empty();
        }
        Map<String, Object> params = Json.map("subject_id", subjectId);
        if ("collection".equals(subjectType) || "guide".equals(subjectType)) {
            params.put("kind", subjectType);
        }
        List<Map<String, Object>> rows = jdbc.forTenant(tenant, sql, params);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }
}
