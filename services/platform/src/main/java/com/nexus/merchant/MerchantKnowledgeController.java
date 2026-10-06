package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The §24-26 knowledge base as the merchant sees it: which documents the AI agent may answer from, and
 * a reindex request that is a <em>queue write</em>, never an embedding.
 *
 * <p>That boundary is the point of this controller. {@code nexus_ai} is the only writer of
 * {@code chunks.embedding} (§52 — there is no LLM-to-database path), so reindexing moves
 * {@code documents.status} to {@code pending} and stops; the response says {@code queued}, names the
 * documents and reports how many chunks a rebuild would touch. A route that claimed "reindexed" would
 * be claiming work it did not do.
 *
 * <p>The read is deliberately narrow: it reports document rows and their chunk counts, never chunk
 * text, so a merchant console cannot become a second way to read another tenant's content — the
 * predicate is on the tenant and the merchant, and an unknown document id is reported rather than
 * silently dropped.
 */
@RestController
@RequestMapping("/api/v1/merchant")
public class MerchantKnowledgeController {

    /** Upper bound on a reindex sweep; a merchant with more documents pages instead of sweeping. */
    private static final int MAX_REINDEX_DOCUMENTS = 500;
    private static final int DEFAULT_REINDEX_DOCUMENTS = 100;

    private final MerchantKnowledgeRepository knowledge;
    private final Paging paging;
    private final AuditService audit;

    public MerchantKnowledgeController(MerchantKnowledgeRepository knowledge, Paging paging, AuditService audit) {
        this.knowledge = knowledge;
        this.paging = paging;
        this.audit = audit;
    }

    /** {@code GET /api/v1/merchant/knowledge-base} — the documents and their chunk counts, paged. */
    @GetMapping("/knowledge-base")
    @RequiresPermission(value = MerchantPermissions.READ_PRODUCTS, merchant = "param:merchant_id")
    public Map<String, Object> knowledgeBase(@RequestParam(required = false) String merchant_id,
                                             @RequestParam(required = false) String kind,
                                             @RequestParam(required = false) String limit,
                                             @RequestParam(required = false) String cursor,
                                             HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = requireUuid(merchant_id, "merchant_id");
        int pageLimit = paging.limit(limit);
        int offset = paging.offset(cursor);

        List<Map<String, Object>> rows = knowledge.documents(tenant, merchantId, kind, pageLimit, offset);
        List<Map<String, Object>> items = new ArrayList<>();
        long chunks = 0;
        for (Map<String, Object> row : rows) {
            items.add(documentView(row));
            Long n = Json.longOf(row, "chunk_count");
            chunks += n == null ? 0 : n;
        }
        long total = knowledge.countDocuments(tenant, merchantId, kind);
        Map<String, Object> page = paging.page(items, offset, pageLimit, total);
        page.put("merchant_id", merchantId);
        page.put("kind", kind);
        page.put("chunks_on_page", chunks);
        page.put("degraded", false);
        return page;
    }

    /**
     * {@code POST /api/v1/merchant/knowledge-base/reindex} — queues documents for the AI service.
     *
     * <p>Idempotent by nature: the statement is {@code status='pending'} on rows that may already be
     * pending, so calling it twice queues the same set and reports the same number rather than
     * doubling anything. A caller that names documents it does not own gets those ids back under
     * {@code unknown_document_ids} — the count is real, so a console cannot show "12 queued" for a
     * request that queued 3.
     */
    @PostMapping("/knowledge-base/reindex")
    @RequiresPermission(value = MerchantPermissions.CONFIGURE_AI, merchant = "body:merchant_id")
    public Map<String, Object> reindex(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = requireUuid(body.get("merchant_id"), "merchant_id");

        List<UUID> requested = uuidList(body.get("document_ids"));
        List<UUID> unknown = new ArrayList<>();
        List<UUID> target;
        if (requested.isEmpty()) {
            int wanted = boundedLimit(body.get("limit"));
            target = knowledge.documentIds(tenant, merchantId, wanted);
        } else {
            if (requested.size() > MAX_REINDEX_DOCUMENTS) {
                throw ApiException.validation("at most " + MAX_REINDEX_DOCUMENTS + " documents per request",
                        Json.map("field", "document_ids", "received", requested.size()));
            }
            target = knowledge.existingDocumentIds(tenant, merchantId, requested);
            for (UUID id : requested) {
                if (!target.contains(id)) {
                    unknown.add(id);
                }
            }
        }

        long chunks = knowledge.chunkCount(tenant, merchantId, target);
        int queued = knowledge.markForReindex(tenant, merchantId, target);
        audit.record(request, "reindex_knowledge_base", "merchant", merchantId, merchantId, null,
                Json.map("queued", queued, "chunks_to_rebuild", chunks),
                Json.map("requested", requested.size(), "unknown", unknown.size()));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId);
        out.put("queued", queued);
        out.put("document_ids", target.stream().map(UUID::toString).toList());
        out.put("unknown_document_ids", unknown.stream().map(UUID::toString).toList());
        out.put("chunks_to_rebuild", chunks);
        out.put("status", "queued");
        out.put("note", "The platform marks documents pending; the AI service performs the embedding.");
        return out;
    }

    private static Map<String, Object> documentView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("document_id", Json.uuid(row, "id"));
        out.put("merchant_id", Json.uuid(row, "merchant_id"));
        out.put("offering_id", Json.uuid(row, "offering_id"));
        out.put("kind", Json.str(row, "kind"));
        out.put("title", Json.str(row, "title"));
        out.put("source_uri", Json.str(row, "source_uri"));
        out.put("mime_type", Json.str(row, "mime_type"));
        out.put("lang", Json.str(row, "lang"));
        out.put("status", Json.str(row, "status"));
        out.put("error", Json.str(row, "error"));
        out.put("metadata", Json.jsonObject(row, "metadata"));
        out.put("chunk_count", Json.longOf(row, "chunk_count"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        return out;
    }

    private static int boundedLimit(Object raw) {
        if (raw == null || String.valueOf(raw).isBlank()) {
            return DEFAULT_REINDEX_DOCUMENTS;
        }
        int value;
        try {
            value = Integer.parseInt(String.valueOf(raw));
        } catch (NumberFormatException e) {
            throw ApiException.validation("limit must be an integer", Json.map("field", "limit"));
        }
        if (value <= 0) {
            throw ApiException.validation("limit must be positive", Json.map("field", "limit"));
        }
        return Math.min(value, MAX_REINDEX_DOCUMENTS);
    }

    private static List<UUID> uuidList(Object raw) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw ApiException.validation("document_ids must be an array of uuids",
                    Json.map("field", "document_ids"));
        }
        List<UUID> out = new ArrayList<>();
        for (Object item : list) {
            UUID parsed = Json.uuidOrNull(item == null ? null : String.valueOf(item));
            if (parsed == null) {
                throw ApiException.validation("document_ids must be an array of uuids",
                        Json.map("field", "document_ids"));
            }
            out.add(parsed);
        }
        return out;
    }

    private static UUID requireUuid(Object raw, String field) {
        UUID parsed = Json.uuidOrNull(raw == null ? null : String.valueOf(raw));
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }
}
