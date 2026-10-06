package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The §24-26 knowledge base over HTTP, witnessed against rows this test wrote — the door the adoption of
 * {@code MerchantKnowledgeController} has to pass, because the pair ships with no test of its own.
 *
 * <p>The pinned property is the boundary the controller exists to hold: a reindex is a <em>queue write</em>
 * (documents move to {@code pending}, the response says {@code queued}, the audit row names a count) and
 * never an embedding — no chunk is touched, and {@code chunks.embedding} stays exactly as empty as the
 * platform found it. The read is narrow the same way: document rows and chunk counts, with no chunk text
 * reachable from a merchant console, and an id the caller does not own comes back under
 * {@code unknown_document_ids} instead of being claimed or silently dropped.
 */
class MerchantKnowledgeDoorTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID merchant;
    private UUID manager;
    private UUID booker;
    private String staffToken;
    private String bookerToken;
    private UUID menuDoc;
    private UUID policyDoc;

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("knowledge");
        merchant = newMerchant(tenant, "kb-" + tag(), "published");
        manager = newUser(tenant, "manager" + tag(), "consumer");
        staff(tenant, merchant, manager, "read_products", "configure_ai");
        staffToken = token(tenant, manager, "consumer");
        booker = newUser(tenant, "booker" + tag(), "consumer");
        bookerToken = token(tenant, booker, "consumer");
        menuDoc = document("menu", "Lunch menu", 3);
        policyDoc = document("policy", "Cancellation policy", 1);
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private UUID document(String kind, String title, int chunks) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into documents (id, tenant_id, merchant_id, kind, title, content_hash, status)
                values (:id, :t, :m, :kind, :title, :hash, 'indexed')
                """, new MapSqlParameterSource("id", id).addValue("t", tenant.id())
                .addValue("m", merchant).addValue("kind", kind).addValue("title", title)
                .addValue("hash", "hash-" + tag()));
        for (int i = 0; i < chunks; i++) {
            jdbc.update("""
                    insert into chunks (id, document_id, merchant_id, tenant_id, ordinal, text)
                    values (:id, :doc, :m, :t, :ordinal, :text)
                    """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("doc", id)
                    .addValue("m", merchant).addValue("t", tenant.id()).addValue("ordinal", i)
                    .addValue("text", "chunk " + i + " of " + title));
        }
        return id;
    }

    private ResponseEntity<String> list(String query) {
        return get(tenant, staffToken, "/api/v1/merchant/knowledge-base?" + query);
    }

    @Test
    @DisplayName("The read counts chunks and never opens them, and the reindex queues without embedding")
    void theReadCountsAndTheReindexQueues() {
        ResponseEntity<String> res = list("merchant_id=" + merchant);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(res.getBody());
        assertThat(page.path("items")).hasSize(2);
        assertThat(page.path("total_estimate").asLong()).isEqualTo(2);
        assertThat(page.path("chunks_on_page").asLong()).isEqualTo(4);
        assertThat(page.path("degraded").asBoolean()).isFalse();

        // The read is narrow: document rows carry counts, not content. A token unique to the chunk text
        // must not be reachable from this screen at all.
        assertThat(res.getBody()).doesNotContain("chunk 1 of Lunch menu");

        JsonNode menus = Json.tree(list("merchant_id=" + merchant + "&kind=menu").getBody());
        assertThat(menus.path("items")).hasSize(1);
        assertThat(menus.path("items").get(0).path("chunk_count").asLong()).isEqualTo(3);

        // A reindex that names a document the caller does not own reports it, and queues the rest.
        UUID stranger = UUID.randomUUID();
        ResponseEntity<String> queued = post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString(), "document_ids",
                        List.of(menuDoc.toString(), policyDoc.toString(), stranger.toString())));
        assertThat(queued.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode job = Json.tree(queued.getBody());
        assertThat(job.path("status").asText()).isEqualTo("queued");
        assertThat(job.path("queued").asInt()).isEqualTo(2);
        assertThat(job.path("document_ids").toString()).contains(menuDoc.toString());
        assertThat(job.path("unknown_document_ids").toString()).contains(stranger.toString());
        assertThat(job.path("chunks_to_rebuild").asLong()).isEqualTo(4);

        // The queue write moved both rows to pending; it did not embed anything, and idempotence holds.
        assertThat(count("select count(*) from documents where id in (cast(:a as uuid), cast(:b as uuid)) "
                + "and status = 'pending'", Map.of("a", menuDoc, "b", policyDoc))).isEqualTo(2);
        assertThat(count("select count(*) from chunks where embedding is not null", Map.of())).isZero();
        ResponseEntity<String> again = post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString(), "document_ids",
                        List.of(menuDoc.toString(), policyDoc.toString())));
        assertThat(Json.tree(again.getBody()).path("queued").asInt()).isEqualTo(2);

        // The audit row names what the queue write did, because the response's counts are real.
        assertThat(count("select count(*) from audit_logs where action = 'reindex_knowledge_base' "
                + "and merchant_id = :m", Map.of("m", merchant))).isEqualTo(2);
    }

    @Test
    @DisplayName("Naming no documents queues the merchant's own set, and the refusal table is a refusal")
    void theDefaultTargetAndTheRefusals() {
        // No document_ids: the default target is the merchant's own documents, bounded, newest first.
        ResponseEntity<String> queued = post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString()));
        assertThat(Json.tree(queued.getBody()).path("queued").asInt()).isEqualTo(2);
        assertThat(Json.tree(queued.getBody()).path("unknown_document_ids").isEmpty()).isTrue();

        assertThat(list("merchant_id=not-a-uuid").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString(), "document_ids",
                        List.of("not-a-uuid"))).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString(), "limit", "0")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        List<String> tooMany = new ArrayList<>();
        for (int i = 0; i < 501; i++) {
            tooMany.add(UUID.randomUUID().toString());
        }
        assertThat(post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString(), "document_ids", tooMany)).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        Tenant other = newTenant("knowledge-other");
        UUID theirs = newMerchant(other, "elsewhere-" + tag(), "published");
        assertThat(post(tenant, staffToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", theirs.toString())).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(get(tenant, null, "/api/v1/merchant/knowledge-base?merchant_id=" + merchant)
                .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        // Two grants, two denials, both audited: read_products for the read, configure_ai for the write.
        assertThat(get(tenant, bookerToken, "/api/v1/merchant/knowledge-base?merchant_id=" + merchant)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(post(tenant, bookerToken, "/api/v1/merchant/knowledge-base/reindex",
                Json.map("merchant_id", merchant.toString())).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(2);
        assertThat(get(tenant, staffToken, "/api/v1/merchant/knowledge-base?merchant_id=" + merchant)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }
}
