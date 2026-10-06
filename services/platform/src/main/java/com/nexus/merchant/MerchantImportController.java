package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The §5.1 AI import surface: {@code POST /api/v1/merchant/imports} (accept) and
 * {@code GET /api/v1/merchant/imports/{job_id}} (poll).
 *
 * <p>This controller adds no extraction. {@link ImportService} owns the pipeline and the
 * {@link MerchantImportPort} choice ({@code HttpImportAdapter} → {@code /ai/v1/imports/extract}, with
 * {@code HeuristicImportAdapter} as the offline fallback); §22 explicitly forbids a second extractor, so
 * the POST simply validates and hands off, and the GET reads the same {@code documents} row the worker
 * writes.
 *
 * <p>// CONTRACT GAP: §5.1 mandates {@code status:"queued"} on accept and says the client polls, but it
 * never names the poll states. The persisted state is {@code documents.status}
 * ({@code pending|processing|indexed|failed}), so the job status reported here is a stated projection of
 * that column ({@code queued|running|succeeded|failed}), and {@code document_status} carries the raw
 * value. Two declared clients disagree with the four-state vocabulary — {@code packages/types}
 * {@code ImportJobStatusValue} (queued/crawling/parsing/classifying/completed/failed/cancelled) and the
 * SDK's {@code ImportJob} union plus its {@code wait()} terminal set (done/completed/failed/partial) —
 * so an SDK poll would not treat {@code succeeded} as terminal. That is reported rather than papered
 * over by inventing a fifth state; {@code terminal} is emitted so a client can stop without guessing.
 */
@RestController
@RequestMapping("/api/v1/merchant/imports")
public class MerchantImportController {

    private final ImportService imports;
    private final MerchantImportRepository repository;

    public MerchantImportController(ImportService imports, MerchantImportRepository repository) {
        this.imports = imports;
        this.repository = repository;
    }

    /**
     * {@code POST /api/v1/merchant/imports} → {@code 202 {job_id, status:"queued"}}. The job row is
     * created and the extraction is submitted off-thread; nothing is published by this path (§5.1).
     */
    @PostMapping
    @RequiresPermission(value = MerchantPermissions.WRITE_PRODUCTS, merchant = "body:merchant_id")
    public ResponseEntity<Map<String, Object>> create(@RequestBody Map<String, Object> body,
                                                      HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(Json.str(body, "merchant_id"), "merchant_id");
        Map<String, Object> source = body.get("source") instanceof Map<?, ?> map ? cast(map) : Map.of();
        List<Map<String, Object>> files = new java.util.ArrayList<>();
        if (body.get("files") instanceof List<?> list) {
            for (Object value : list) {
                if (value instanceof Map<?, ?> map) {
                    files.add(cast(map));
                }
            }
        }
        Map<String, Object> started = imports.start(tenant, merchantId, source, files,
                Req.principal(request).userId());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("job_id", started.get("job_id"));
        out.put("status", "queued");
        out.put("merchant_id", merchantId.toString());
        out.put("extractor", started.get("extractor"));
        out.put("poll", started.get("poll"));
        return ResponseEntity.accepted().body(out);
    }

    /**
     * {@code GET /api/v1/merchant/imports/{job_id}} — the poll. Another tenant's job id is absent (the
     * {@code @RequiresPermission} resolver joins the owning merchant, so it 404s before this method runs),
     * and a job whose extraction threw reports {@code failed} with the error text, never a silent success.
     */
    @GetMapping("/{job_id}")
    @RequiresPermission(value = MerchantPermissions.READ_PRODUCTS, merchant = "importjob:job_id")
    public Map<String, Object> get(@PathVariable String job_id, HttpServletRequest request,
                                  HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        UUID jobId = uuid(job_id, "job_id");
        Map<String, Object> raw = imports.get(tenant, jobId);
        String documentStatus = Json.str(raw, "status");
        String status = jobStatus(documentStatus);
        boolean terminal = "succeeded".equals(status) || "failed".equals(status);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("job_id", jobId.toString());
        out.put("merchant_id", Json.str(raw, "merchant_id"));
        out.put("status", status);
        out.put("document_status", documentStatus);
        out.put("terminal", terminal);
        out.put("stage", documentStatus);
        out.put("progress", "succeeded".equals(status) || "failed".equals(status) ? 1.0 : null);
        out.put("proposals", raw.getOrDefault("proposals", List.of()));
        out.put("document_ids", List.of(jobId.toString()));
        out.put("chunks_indexed", repository.chunkCount(tenant, jobId));
        out.put("source_type", Json.str(raw, "source_type"));
        out.put("source_uri", Json.str(raw, "source_uri"));
        out.put("extractor", raw.get("extractor"));
        out.put("degraded", raw.getOrDefault("degraded", false));
        out.put("note", raw.get("note"));
        out.put("error", raw.get("error"));
        out.put("created_at", Json.str(raw, "created_at"));
        out.put("updated_at", Json.str(raw, "updated_at"));
        out.put("finished_at", terminal ? Json.str(raw, "updated_at") : null);
        out.put("review_notice", raw.get("review_notice"));
        out.put("status_vocabulary", List.of("queued", "running", "succeeded", "failed"));
        out.put("status_map", Json.map(
                "queued", "documents.status='pending' (accepted; ImportService writes 'processing' immediately)",
                "running", "documents.status='processing'",
                "succeeded", "documents.status='indexed'",
                "failed", "documents.status='failed'"));
        response.setHeader("Cache-Control", "no-store");
        return out;
    }

    /** The stated projection of {@code documents.status}; an unrecognised value is passed through as-is. */
    private static String jobStatus(String documentStatus) {
        if (documentStatus == null) {
            return "queued";
        }
        return switch (documentStatus) {
            case "pending" -> "queued";
            case "processing" -> "running";
            case "indexed" -> "succeeded";
            case "failed" -> "failed";
            default -> documentStatus;
        };
    }

    private static UUID uuid(String raw, String field) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation("'" + field + "' must be a uuid", Json.map("field", field));
        }
        return parsed;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> raw) {
        return (Map<String, Object>) raw;
    }
}
