package com.nexus.catalog;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Repository;

/**
 * API_CONTRACT §8 — the consumer reads over the one table that backs both surfaces. There is no
 * {@code guides} table: a guide is {@code collections WHERE kind = 'guide'} (the §8 preamble), so
 * {@code /collections}, {@code /collections/{slug}}, {@code /guides} and {@code /guides/{slug}} all
 * query this same repository, narrowed only by the {@code kind} a caller may ask for.
 *
 * <p>Three scopes the query encodes that a naive read would get wrong:
 * <ul>
 *   <li><b>Listing filter (§8).</b> {@code visibility = 'public' AND published_at IS NOT NULL} — a draft
 *       never appears, exactly as the "publishable" column of the §8 table states it.</li>
 *   <li><b>Provenance gate (§27/§108, AGENT_CONTRACT §1).</b> A row is only readable when it can honestly
 *       say who made it: either {@code seo->>'generated_by'} carries a real provenance token, or
 *       {@code author_id} points at a real account. A row with neither is not publishable, so it is
 *       excluded here — which is also what makes an unattributable slug a 404 rather than a page that
 *       quietly claims an author it does not have.</li>
 *   <li><b>Tenant isolation (§2).</b> The predicate is {@code c.tenant_id = :tenant_id} with the id bound
 *       as a parameter through {@link TenantJdbc#forTenant}; a row in another tenant reads as absent. The
 *       author join is anchored on {@code c.author_id}, and the join is LEFT so a collection with no
 *       author (an AI guide) still reads — the provenance gate above is what decides its publishability.</li>
 * </ul>
 *
 * <p>No client text reaches the SQL: {@code kind} is validated by the controller and arrives as a bind
 * parameter, never a fragment. The item jsonb is returned raw — resolving entity ids into cards is a
 * read-side concern that lives in the controller and reuses {@link MerchantCards}, not a second card
 * projection this repository would drift from.
 */
@Repository
public class CollectionsRepository {

    /** Every column a §8 consumer page renders, plus the author's real display name and the raw item count. */
    private static final String COLUMNS = String.join("\n",
            "       c.id, c.tenant_id, c.author_id, c.kind, c.slug, c.title, c.title_zh, c.description,",
            "       c.cover_url, c.items, c.visibility, c.data_origin, c.seo, c.published_at, c.created_at,",
            "       c.updated_at,",
            // A malformed jsonb `items` is not an array; report it as zero rather than failing the page.
            "       case when jsonb_typeof(c.items) = 'array' then jsonb_array_length(c.items) else 0 end",
            "           as item_count,",
            "       au.display_name as author_display_name");

    private static final String FROM = String.join("\n",
            "from collections c",
            "left join users au on au.id = c.author_id");

    /** The published-page scope plus the §8 listing filter. */
    private static final String SCOPE = String.join("\n",
            "where c.tenant_id = :tenant_id",
            "  and c.visibility = 'public'",
            "  and c.published_at is not null");

    /**
     * The provenance gate: a real {@code generated_by} token, or a real author account. The §8 table's
     * "absent provenance is served as {@code creator} only when {@code author_id} is a real user,
     * otherwise the row is not publishable" — enforced as a predicate so the list and the by-slug 404
     * can never disagree about what is readable.
     */
    private static final String PUBLISHABLE = String.join("\n",
            "  and ( lower(btrim(coalesce(c.seo->>'generated_by', ''))) in ('ai', 'editor', 'creator')",
            "        or (c.author_id is not null and au.id is not null) )");

    /** Newest-published first, slug as the stable tiebreak — an organic order with no placement input. */
    private static final String ORDER = "order by c.published_at desc, c.slug asc";

    private final TenantJdbc jdbc;

    public CollectionsRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Paged §8 collection/guide rows. {@code kind} is a validated token or null for "any kind"; when set,
     * it is the only difference between {@code /collections} and {@code /guides}.
     */
    public List<Map<String, Object>> collectionRows(TenantContext tenant, String kind, int limit, int offset) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("limit", limit);
        params.put("offset", offset);
        return jdbc.forTenant(tenant, String.join("\n",
                "select " + COLUMNS,
                FROM,
                SCOPE,
                kindClause(kind),
                PUBLISHABLE,
                ORDER,
                "limit :limit offset :offset"), kindParams(params, kind));
    }

    /** The same statement's row count, repeating the scope + gate verbatim so the two cannot disagree. */
    public long countCollections(TenantContext tenant, String kind) {
        return jdbc.countForTenant(tenant, String.join("\n",
                "select count(*)",
                FROM,
                SCOPE,
                kindClause(kind),
                PUBLISHABLE), kindParams(new LinkedHashMap<>(), kind));
    }

    /**
     * The author's own row by id, with <b>no</b> publishability predicate. Two different questions use this:
     * the write response reads back what it just stored (a draft fails {@link #PUBLISHABLE} by design, so the
     * directory's scope would hide the row from the person who owns it), and the collision answer names the
     * live slug before the unique index has been explained. Never a consumer read.
     */
    public Optional<Map<String, Object>> anyRowById(TenantContext tenant, java.util.UUID id) {
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select " + COLUMNS,
                FROM,
                "where c.tenant_id = :tenant_id",
                "  and c.id = :id",
                "limit 1"), Json.map("id", id));
    }

    /**
     * The row a {@code POST /api/v1/collections} collides with, whatever its visibility. {@code UNIQUE
     * (tenant_id, slug)} is V1's, so this is at most one row, and it is the only way the 409 can name the id
     * the caller has to reason about instead of guessing whether their own write went through.
     */
    public Optional<Map<String, Object>> anyRowBySlug(TenantContext tenant, String slug) {
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select c.id, c.kind, c.slug, c.visibility, c.data_origin, c.author_id, c.published_at",
                "from collections c",
                "where c.tenant_id = :tenant_id",
                "  and c.slug = :slug",
                "limit 1"), Json.map("slug", slug));
    }

    /**
     * Store a draft. Every trust-bearing column is a literal here rather than a parameter, because this route
     * can only be reached by an authenticated person and the row's own facts follow from that:
     * {@code author_id} is the session's subject, {@code visibility='private'} and {@code published_at is
     * null} together keep §8's directory from serving an unfinished page, {@code data_origin='user'} is what
     * §109 means by not passing a person's writing off as synthetic (and the same token the review write uses),
     * and {@code seo} stays {@code {}} because provenance and human-review claims belong to the publisher.
     * There is deliberately no {@code update} beside this: stamping {@code published_at} is §27's human
     * decision, and this build routes that to no one.
     */
    public Map<String, Object> insertDraft(TenantContext tenant, java.util.UUID authorId, String kind,
                                           String slug, String title, String titleZh, String description,
                                           String coverUrl, String itemsJson) {
        return jdbc.insertForTenant(tenant, String.join("\n",
                "insert into collections (tenant_id, author_id, kind, slug, title, title_zh, description,",
                "                       cover_url, items, visibility, data_origin, seo)",
                "values (:tenant_id, :author_id, :kind, :slug, :title, :title_zh, :description, :cover_url,",
                "        cast(:items as jsonb), 'private', 'user', '{}'::jsonb)",
                "returning id"),
                Json.map("author_id", authorId, "kind", kind, "slug", slug, "title", title,
                        "title_zh", titleZh, "description", description, "cover_url", coverUrl,
                        "items", itemsJson));
    }

    /**
     * §8's publishability rule as one callable question, composed from the same fragments the directory reads
     * with. Needed by anything that must not hand out a pointer to a row the reader can never open —
     * {@code POST /api/v1/me/favorites} took any collection in the tenant until D50, which let a saved item link
     * straight at the 404 the listing filter had already produced. {@code kind} pins the subject to what the
     * caller said it was saving: a guide is {@code kind='guide'} here and nowhere else, so an id cannot be
     * saved under the wrong label.
     */
    public boolean isPublishable(TenantContext tenant, java.util.UUID collectionId, String kind) {
        return jdbc.countForTenant(tenant, String.join("\n",
                "select count(*)",
                FROM,
                SCOPE,
                "  and c.id = :id",
                "  and c.kind = :kind",
                PUBLISHABLE), Json.map("id", collectionId, "kind", kind)) == 1;
    }

    /**
     * One row by public slug, already scoped to published + provenance-gated. {@code requiredKind} pins
     * {@code /guides/{slug}} to {@code guide}; pass null for {@code /collections/{slug}}, which serves
     * any kind. Absent — including a slug that exists but is a draft, another tenant's, or fails the gate —
     * this is empty, and the controller turns that into the resource-specific 404.
     */
    public Optional<Map<String, Object>> collectionBySlug(TenantContext tenant, String slug, String requiredKind) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("slug", slug);
        String kindClause = "";
        if (requiredKind != null) {
            kindClause = "  and c.kind = :kind\n";
            params.put("kind", requiredKind);
        }
        return jdbc.firstForTenant(tenant, String.join("\n",
                "select " + COLUMNS,
                FROM,
                SCOPE,
                "  and c.slug = :slug",
                kindClause,
                PUBLISHABLE,
                "limit 1"), params);
    }

    // ---- the optional kind clause ----------------------------------------

    private static String kindClause(String kind) {
        return kind == null ? "" : "  and c.kind = :kind\n";
    }

    private static Map<String, Object> kindParams(Map<String, Object> params, String kind) {
        if (kind != null) {
            params.put("kind", kind);
        }
        return params;
    }
}
