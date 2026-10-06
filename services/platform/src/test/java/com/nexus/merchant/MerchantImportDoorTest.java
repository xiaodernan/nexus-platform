package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The import lane's selector, witnessed against a real import instead of against the seed (§5.1, §22).
 *
 * <p>Two reads in this lane resolve to nothing in the shipped dataset — {@code offerings.attributes.import_job}
 * (0 of 5534 rows) and {@code documents.metadata.extractor} (0 of 1040) — and the seed's quality gate already
 * answers for both: its {@code read_answer} table files them as {@code dead-reader}, with the reason "no seeded
 * offering carries an import job", re-read from the data on every run. That answer has to stay true, so the seed
 * does not carry a hand-written marker: {@code import_job} means "an import produced this row", and stamping one
 * onto a fabricated row would be a provenance claim the content cannot support — the same rule that leaves
 * {@code collections.seo.generated_by} unanswered. The other kind on offer, {@code empty-by-guard}, is not
 * available here: the gate defines it as "D64 keeps that table empty" and rejects it while {@code rows > 0}, and
 * {@code offerings} holds 5534 rows.
 *
 * <p>What was actually missing was a witness, not data: nothing drove an import through the door and read the
 * console back. This does — offline, through the heuristic port the service defaults to, so the extraction is
 * deterministic and no network is involved — and then asserts the console's own read sees exactly what the
 * pipeline wrote. The seeded dataset is untouched; these rows live in {@code nexus_test}.
 */
class MerchantImportDoorTest extends NexusIntegrationTest {

    @Test
    @DisplayName("An import becomes pending proposals and draft offerings, and a hand-made draft is not one")
    void anImportBecomesPendingProposals() throws Exception {
        Tenant tenant = newTenant("import");
        UUID owner = newUser(tenant, "owner-" + tag(), "consumer");
        UUID merchant = newMerchant(tenant, "imp-" + tag(), "published");
        staff(tenant, merchant, owner, MerchantPermissions.OWNER.toArray(String[]::new));
        String token = token(tenant, owner, "consumer");

        // A draft no import produced, written as a row the way the workspace tests write fixtures. The read's
        // own comment claims this is not a pending proposal, so that claim is the first thing asserted.
        jdbc.update("""
                insert into offerings (id, tenant_id, merchant_id, slug, name, kind, status, currency,
                                       price_amount)
                values (:id, :tenant, :m, :slug, 'Hand-made draft', 'product', 'draft', 'HKD', 88)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("tenant", tenant.id())
                .addValue("m", merchant).addValue("slug", "hand-" + tag()));

        assertThat(pendingProposals(tenant, token, merchant))
                .as("a draft nothing imported is not a proposal").isZero();

        // Three price-bearing lines, two of them in Chinese, so both shapes the parser documents are used.
        String menu = "招牌雲吞麵 HK$48\n凍檸檬茶 $22\nRoast duck 128";
        ResponseEntity<String> accepted = post(tenant, token, "/api/v1/merchant/imports",
                Json.map("merchant_id", merchant.toString(),
                        "source", Json.map("type", "text", "value", menu)));
        assertThat(accepted.getStatusCode()).as(body(accepted)).isEqualTo(HttpStatus.ACCEPTED);
        JsonNode queued = Json.tree(accepted.getBody());
        assertThat(queued.path("status").asText()).isEqualTo("queued");
        assertThat(queued.path("extractor").asText()).isEqualTo("heuristic_local");
        String jobId = queued.path("job_id").asText();

        // The extraction runs off-thread, so this polls the door the client polls and stops on the payload's own
        // `terminal` flag; a job still running after ten seconds fails the test rather than waiting it out.
        JsonNode job = awaitJob(tenant, token, jobId);
        assertThat(job.path("terminal").asBoolean()).isTrue();
        assertThat(job.path("status").asText()).isEqualTo("succeeded");
        assertThat(job.path("document_status").asText()).isEqualTo("indexed");
        assertThat(job.path("extractor").asText()).isEqualTo("heuristic_local");
        assertThat(job.path("degraded").asBoolean()).isFalse();
        assertThat(job.path("proposals")).hasSize(3);

        // The marker the selector keys on names the job that produced the row, and each proposal carries the
        // price it proposed as a fact — an imported claim is a row, not prose inside a metadata blob.
        assertThat(count("""
                select count(*) from offerings where merchant_id = :m and status = 'draft'
                  and attributes->>'import_job' = :job
                """, Map.of("m", merchant, "job", jobId))).isEqualTo(3);
        assertThat(count("""
                select count(*) from offerings where merchant_id = :m and status = 'draft'
                  and attributes->>'import_job' is null
                """, Map.of("m", merchant))).as("only the hand-made draft").isEqualTo(1);
        assertThat(count("""
                select count(*) from facts f join offerings o on o.id = f.subject_id
                where o.merchant_id = :m and f.attribute = 'price' and f.source = 'imported'
                """, Map.of("m", merchant))).isEqualTo(3);

        // The second empty read: the extractor name lives on the job's document row, which the poll above reads.
        assertThat(row("select metadata->>'extractor' as extractor from documents where id = cast(:id as uuid)",
                Map.of("id", jobId)).get("extractor")).isEqualTo("heuristic_local");

        assertThat(pendingProposals(tenant, token, merchant))
                .as("the console read sees what the import produced, and only that").isEqualTo(3);
    }

    /** The dashboard's {@code pending_proposals}, read through the door the console calls. */
    private long pendingProposals(Tenant tenant, String token, UUID merchant) {
        ResponseEntity<String> res = get(tenant, token,
                "/api/v1/merchant/dashboard/overview?merchant_id=" + merchant);
        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.OK);
        return Json.tree(res.getBody()).path("pending_proposals").asLong();
    }

    /** Poll the import door until the job reports itself terminal, or fail with the last payload seen. */
    private JsonNode awaitJob(Tenant tenant, String token, String jobId) throws Exception {
        JsonNode last = null;
        for (int attempt = 0; attempt < 50; attempt++) {
            ResponseEntity<String> res = get(tenant, token, "/api/v1/merchant/imports/" + jobId);
            assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.OK);
            last = Json.tree(res.getBody());
            if (last.path("terminal").asBoolean()) {
                return last;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("the import job never reported itself terminal: " + last);
    }

    private static String body(ResponseEntity<String> res) {
        return String.valueOf(res.getBody());
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }
}
