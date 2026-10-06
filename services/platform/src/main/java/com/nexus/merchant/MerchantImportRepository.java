package com.nexus.merchant;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Import-pipeline reads (§5.1, §22) that are not already in {@link ImportService}. The pipeline itself —
 * crawl/parse/extract, the {@code documents} row, the draft offerings and their {@code imported} facts —
 * belongs to {@link ImportService} and its {@link MerchantImportPort}; duplicating any of it here would
 * create the second extractor §22 forbids.
 *
 * <p>What is left is counting: how many proposals are still awaiting review, and how many chunks a
 * document has. Both are reads over tables the platform already owns or shares.
 */
@Repository
public class MerchantImportRepository {

    private final TenantJdbc jdbc;

    public MerchantImportRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Draft offerings this merchant has from an import — the §5.1 "nothing is published without
     * merchant review" queue, and the dashboard's {@code pending_proposals}. An offering is identified
     * as import-derived by the {@code attributes.import_job} marker {@link ImportService} writes, so a
     * hand-created draft is not counted as a pending proposal.
     */
    public long proposalCount(TenantContext tenant, UUID merchantId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from offerings o
                where o.tenant_id = :tenant_id and o.merchant_id = :merchant_id
                  and o.status = 'draft' and o.attributes->>'import_job' is not null
                """, Json.map("merchant_id", merchantId));
    }

    /**
     * Chunks indexed for one document. {@code chunks.tenant_id} is nullable (the AI service owns those
     * rows), so the predicate rides on the owning {@code documents} row, which the platform writes with
     * a tenant — a document whose tenant is unknown therefore counts as zero rather than leaking.
     */
    public long chunkCount(TenantContext tenant, UUID documentId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from chunks c
                join documents d on d.id = c.document_id
                where d.id = :document_id and d.tenant_id = :tenant_id
                """, Json.map("document_id", documentId));
    }
}
