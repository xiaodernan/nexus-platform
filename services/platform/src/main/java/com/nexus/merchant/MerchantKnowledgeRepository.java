package com.nexus.merchant;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * The merchant knowledge base as the platform sees it: {@code documents} rows plus their {@code chunks}
 * count (§24-26, §5). The platform owns the {@code documents} row (status, metadata) and reads
 * {@code chunks}; it never writes an embedding, because {@code nexus_ai} is the only writer of
 * {@code chunks.embedding} (§52 — no {@code LLM → database} path).
 *
 * <p>{@code documents.tenant_id} is nullable in V1, so every statement predicates on it explicitly: a
 * document whose tenant is unknown is invisible rather than leaked across tenants (D5).
 */
@Repository
public class MerchantKnowledgeRepository {

    private final TenantJdbc jdbc;

    public MerchantKnowledgeRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** One page of the merchant's documents, newest first, each with its chunk count. */
    public List<Map<String, Object>> documents(TenantContext tenant, UUID merchantId, String kind, int limit,
                                               int offset) {
        Map<String, Object> params = Json.map("merchant_id", merchantId, "limit", limit, "offset", offset);
        String kindClause = "";
        if (kind != null && !kind.isBlank()) {
            kindClause = " and d.kind = :kind";
            params.put("kind", kind);
        }
        return jdbc.forTenant(tenant, """
                select d.id, d.merchant_id, d.offering_id, d.kind, d.source_uri, d.title, d.mime_type, d.lang,
                       d.content_hash, d.status, d.error, d.metadata, d.created_at, d.updated_at,
                       coalesce(ch.n, 0) as chunk_count
                from documents d
                left join lateral (select count(*) as n from chunks c where c.document_id = d.id) ch on true
                where d.tenant_id = :tenant_id and d.merchant_id = :merchant_id
                """ + kindClause + " order by d.created_at desc, d.id limit :limit offset :offset", params);
    }

    public long countDocuments(TenantContext tenant, UUID merchantId, String kind) {
        Map<String, Object> params = Json.map("merchant_id", merchantId);
        String kindClause = "";
        if (kind != null && !kind.isBlank()) {
            kindClause = " and d.kind = :kind";
            params.put("kind", kind);
        }
        return jdbc.countForTenant(tenant, """
                select count(*) from documents d
                where d.tenant_id = :tenant_id and d.merchant_id = :merchant_id
                """ + kindClause, params);
    }

    /** Document ids this merchant owns, newest first — the default target set when a reindex names none. */
    public List<UUID> documentIds(TenantContext tenant, UUID merchantId, int limit) {
        return jdbc.forTenant(tenant, """
                select d.id from documents d
                where d.tenant_id = :tenant_id and d.merchant_id = :merchant_id
                order by d.created_at desc limit :limit
                """, Json.map("merchant_id", merchantId, "limit", limit)).stream()
                .map(row -> Json.uuid(row, "id")).toList();
    }

    /** The subset of {@code ids} this merchant actually owns — so an unknown id is reported, not claimed. */
    public List<UUID> existingDocumentIds(TenantContext tenant, UUID merchantId, List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        return jdbc.forTenant(tenant, """
                select d.id from documents d
                where d.tenant_id = :tenant_id and d.merchant_id = :merchant_id and d.id in (:ids)
                """, Json.map("merchant_id", merchantId, "ids", ids)).stream()
                .map(row -> Json.uuid(row, "id")).toList();
    }

    /**
     * Queues the documents for re-indexing by moving them to {@code documents.status='pending'} — the
     * schema's own word for "awaiting processing". The embedding itself is the AI service's job; this
     * method does not touch {@code chunks}.
     */
    public int markForReindex(TenantContext tenant, UUID merchantId, List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("merchant_id", merchantId);
        params.put("ids", ids);
        return jdbc.updateForTenant(tenant, """
                update documents d set status = 'pending', error = null, updated_at = now()
                where d.tenant_id = :tenant_id and d.merchant_id = :merchant_id and d.id in (:ids)
                """, params);
    }

    /** Chunks the reindex would rebuild, for the caller's progress estimate — a count, never a claim. */
    public long chunkCount(TenantContext tenant, UUID merchantId, List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        return jdbc.countForTenant(tenant, """
                select count(*) from chunks c
                join documents d on d.id = c.document_id
                where d.tenant_id = :tenant_id and d.merchant_id = :merchant_id and d.id in (:ids)
                """, Json.map("merchant_id", merchantId, "ids", ids));
    }
}
