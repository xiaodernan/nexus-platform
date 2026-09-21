package com.nexus.merchant;

import com.nexus.catalog.FactRepository;
import com.nexus.catalog.OfferingRepository;
import com.nexus.merchant.MerchantImportPort.Extraction;
import com.nexus.merchant.MerchantImportPort.ProposedOffering;
import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import jakarta.annotation.PreDestroy;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * AI import pipeline (§5.1, §22): a job is a {@code documents} row; extraction runs off the request
 * thread; every proposal is written as a {@code draft} offering plus an {@code imported} fact so the
 * provenance survives. Nothing is published by this path — a human flips the status.
 */
@Service
public class ImportService {

    private static final Logger log = LoggerFactory.getLogger(ImportService.class);

    private final TenantJdbc jdbc;
    private final OfferingRepository offerings;
    private final FactRepository facts;
    private final AuditService audit;
    private final MerchantImportPort port;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "nexus-import");
        thread.setDaemon(true);
        return thread;
    });

    public ImportService(TenantJdbc jdbc, OfferingRepository offerings, FactRepository facts, AuditService audit,
                         HeuristicImportAdapter heuristic, HttpImportAdapter http,
                         @Value("${nexus.imports.mode:heuristic}") String mode) {
        this.jdbc = jdbc;
        this.offerings = offerings;
        this.facts = facts;
        this.audit = audit;
        this.port = "http".equalsIgnoreCase(mode) ? http : heuristic;
        log.info("import_port mode={} adapter={}", mode, this.port.name());
    }

    @PreDestroy
    public void stop() {
        executor.shutdownNow();
    }

    public Map<String, Object> start(TenantContext tenant, UUID merchantId, Map<String, Object> source,
                                     List<Map<String, Object>> files, UUID actorId) {
        String type = String.valueOf(source == null ? "text" : source.getOrDefault("type", "text"));
        String value = source == null ? null : (String) source.get("value");
        if (!MerchantImportPort.SUPPORTED_SOURCE_TYPES.contains(type)) {
            throw ApiException.validation("source.type must be one of " + MerchantImportPort.SUPPORTED_SOURCE_TYPES,
                    Json.map("field", "source.type", "given", type));
        }
        Map<String, String> fileTexts = new LinkedHashMap<>();
        if (files != null) {
            for (Map<String, Object> file : files) {
                String name = String.valueOf(file.getOrDefault("name", "upload"));
                Object content = file.get("content_base64");
                if (content == null) {
                    fileTexts.put(name, null);
                    continue;
                }
                fileTexts.put(name, decode(name, String.valueOf(content)));
            }
        }
        String digest = sha256(type + "|" + (value == null ? "" : value) + "|" + fileTexts);
        Map<String, Object> row = jdbc.insertForTenant(tenant, """
                insert into documents (tenant_id, merchant_id, kind, source_uri, title, raw_text, content_hash, lang,
                                      status, metadata)
                values (:tenant_id, :merchant_id, :kind, cast(:source_uri as text), :title,
                        cast(:raw_text as text), :content_hash, 'zh-HK', 'processing', cast(:metadata as jsonb))
                returning id
                """, Json.map("merchant_id", merchantId,
                "kind", "url".equals(type) ? "url" : "menu",
                "source_uri", "url".equals(type) ? value : null,
                "title", "Merchant import (" + type + ")",
                "raw_text", "url".equals(type) ? null : abbreviate(value),
                "content_hash", digest,
                "metadata", Json.write(Json.map("job", "merchant_import", "source_type", type,
                        "extractor", port.name(), "requested_by", actorId == null ? null : actorId.toString()))));
        UUID jobId = Json.uuid(row, "id");
        audit.record(tenant, "user", actorId, "create_import_job", "document", jobId, merchantId, null, null,
                Json.map("source_type", type), null, null);

        String capturedTenantId = tenant.idString();
        executor.submit(() -> run(tenant, merchantId, jobId, type, value, fileTexts, capturedTenantId));

        return Json.map("job_id", jobId.toString(), "status", "queued", "extractor", port.name(),
                "poll", "/api/v1/merchant/imports/" + jobId);
    }

    private void run(TenantContext tenant, UUID merchantId, UUID jobId, String type, String value,
                     Map<String, String> files, String tenantIdForLog) {
        log.debug("import_job_started job={} tenant={}", jobId, tenantIdForLog);
        try {
            Extraction extraction = port.extract(type, value, files);
            List<Map<String, Object>> proposals = new ArrayList<>();
            for (ProposedOffering proposal : extraction.proposals()) {
                String slug = MerchantService.slugify(proposal.name());
                if (slug == null) {
                    continue;
                }
                Map<String, Object> fields = new LinkedHashMap<>();
                fields.put("slug", slug + "-" + jobId.toString().substring(0, 4));
                fields.put("name", proposal.name());
                fields.put("name_zh", proposal.nameZh());
                fields.put("kind", proposal.kind() == null ? "product" : proposal.kind());
                fields.put("description", proposal.description());
                fields.put("price_amount", proposal.price());
                fields.put("currency", proposal.currency() == null ? "HKD" : proposal.currency());
                fields.put("price_model", proposal.priceModel() == null ? "fixed" : proposal.priceModel());
                fields.put("price_source", "imported");
                fields.put("status", "draft");
                fields.put("attributes", Json.map("imported_from", type, "import_job", jobId.toString()));
                UUID offeringId;
                try {
                    offeringId = offerings.insert(tenant, merchantId, fields);
                } catch (org.springframework.dao.DuplicateKeyException dup) {
                    // Re-running the same import is idempotent-ish: skip the duplicate line.
                    continue;
                }
                UUID factId = facts.record(tenant, "offering", offeringId, merchantId, "price",
                        Json.map("amount", proposal.price() == null ? null : proposal.price().toPlainString(),
                                "currency", proposal.currency() == null ? "HKD" : proposal.currency()),
                        null, proposal.currency(), "imported", proposal.confidence(), FactRepository.PRICE_TTL);
                proposals.add(Json.map("offering_id", offeringId.toString(),
                        "offering_draft", OfferingRepository.view(offerings.require(tenant, offeringId)),
                        "confidence", proposal.confidence(),
                        "evidence", proposal.evidence(),
                        "evidence_fact_ids", List.of(factId.toString())));
            }
            finish(jobId, "indexed", extraction, proposals, null);
            log.info("import_job_finished job={} proposals={} extractor={} degraded={}", jobId, proposals.size(),
                    extraction.extractor(), extraction.degraded());
        } catch (Exception e) {
            log.error("import_job_failed job={} message={}", jobId, e.toString());
            finish(jobId, "failed", null, List.of(), e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private void finish(UUID jobId, String status, Extraction extraction, List<Map<String, Object>> proposals,
                        String error) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        if (extraction != null) {
            metadata.put("extractor", extraction.extractor());
            metadata.put("degraded", extraction.degraded());
            metadata.put("note", extraction.note());
        }
        metadata.put("proposals", proposals);
        // documents has no tenant column; job ids are uuids owned by one merchant and status is verified
        // by the caller through get(), which is tenant-checked.
        jdbc.crossTenantUpdate("""
                update documents set status = :status, error = cast(:error as text),
                       metadata = coalesce(metadata, '{}'::jsonb) || cast(:patch as jsonb), updated_at = now()
                where id = :id
                """, Json.map("id", jobId, "status", status, "error", error, "patch", Json.write(metadata)));
    }

    public Map<String, Object> get(TenantContext tenant, UUID jobId) {
        Map<String, Object> row = jdbc.oneForTenant(tenant, """
                select d.id, d.merchant_id, d.kind, d.source_uri, d.status, d.error, d.metadata, d.created_at,
                       d.updated_at, m.tenant_id
                from documents d join merchants m on m.id = d.merchant_id
                where d.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", jobId), "import_job_not_found");
        Map<String, Object> metadata = Json.jsonObject(row, "metadata");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("job_id", Json.str(row, "id"));
        out.put("merchant_id", Json.str(row, "merchant_id"));
        out.put("status", Json.str(row, "status"));
        out.put("source_type", Json.str(row, "kind"));
        out.put("source_uri", Json.str(row, "source_uri"));
        out.put("extractor", metadata.get("extractor"));
        out.put("degraded", metadata.getOrDefault("degraded", false));
        out.put("note", metadata.get("note"));
        out.put("error", Json.str(row, "error"));
        out.put("proposals", metadata.getOrDefault("proposals", List.of()));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        out.put("review_notice", "Proposals are draft offerings. Publish them with "
                + "PATCH /api/v1/merchant/offerings/{id} {\"status\":\"active\"} after review (§5.1).");
        return out;
    }

    private static String decode(String name, String base64) {
        try {
            byte[] bytes = java.util.Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
            if (bytes.length > 512 * 1024) {
                return null;
            }
            String text = new String(bytes, StandardCharsets.UTF_8);
            // PDFs/xlsx arrive as binary: if it is not mostly text we refuse rather than pretend.
            long printable = text.chars().filter(c -> c == '\n' || c == '\t' || (c >= 32 && c < 127) || c > 0x2000)
                    .count();
            if (text.isEmpty() || printable < text.length() * 0.8) {
                log.info("import_file_skipped name={} reason=not_readable_text", name);
                return null;
            }
            return text;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String abbreviate(String value) {
        if (value == null) {
            return null;
        }
        return value.length() > 200_000 ? value.substring(0, 200_000) : value;
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw ApiException.internal("SHA-256 unavailable", e);
        }
    }
}
