package com.nexus.growth;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * {@code POST /api/v1/share} and {@code GET /api/v1/share/{code}} — §8's short link, the last documented
 * route in this build that had no implementation, and the {@code share_links} table V7 adds to hold it.
 *
 * <p>The tests are written around the three ways a share surface goes wrong rather than around the happy
 * path: a link that is handed out for a page that is not public (a short address to a 404), a second share
 * of the same subject that mints a second address instead of returning the first, and a code that resolves
 * across a tenant boundary. Each one is a promise to a stranger holding a URL, which is why they are
 * asserted against the database and the resolver rather than only against the mint response.
 */
class ShareLinkTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;
    private UUID publishedMerchant;
    private String publishedSlug;

    @BeforeEach
    void seedShareableSubject() {
        tenant = newTenant("share");
        other = newTenant("share-other");
        publishedSlug = "shareable-" + System.nanoTime();
        publishedMerchant = newMerchant(tenant, publishedSlug, "published");
        jdbc.update("update merchants set description = :d, images = cast(:i as jsonb) where id = :id",
                new MapSqlParameterSource("d", "A demo restaurant in Sha Tin")
                        .addValue("i", "[\"https://cdn.example.test/one.jpg\"]").addValue("id", publishedMerchant));
    }

    @Test
    @DisplayName("Sharing a merchant mints one link, and sharing it again returns the same one")
    void mintsOnceAndReuses() {
        ResponseEntity<String> first = post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "merchant", "subject_id", publishedMerchant.toString()));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode minted = Json.tree(first.getBody());
        String code = minted.path("code").asText();
        assertThat(code).matches("[0-9A-HJKMNP-TV-Z]{10}");
        assertThat(minted.path("created").asBoolean()).isTrue();
        assertThat(minted.path("target_path").asText()).isEqualTo("/m/" + publishedSlug);
        assertThat(minted.path("short_url").asText()).endsWith("/s/" + code);
        assertThat(minted.path("og").path("title").asText()).isNotBlank();

        ResponseEntity<String> again = post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "merchant", "subject_id", publishedMerchant.toString()));
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode reused = Json.tree(again.getBody());
        assertThat(reused.path("code").asText()).isEqualTo(code);
        assertThat(reused.path("created").asBoolean()).isFalse();

        // One live link, however many times it was shared.
        assertThat(count("select count(*) from share_links where subject_id = :id and revoked_at is null",
                Map.of("id", publishedMerchant))).isEqualTo(1);
    }

    @Test
    @DisplayName("The resolver opens the code, and a code nobody minted is absent")
    void resolverResolvesAndRefuses() {
        String code = Json.tree(post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "merchant", "subject_id", publishedMerchant.toString())).getBody())
                .path("code").asText();

        ResponseEntity<String> resolved = get(tenant, null, "/api/v1/share/" + code);
        assertThat(resolved.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(resolved.getBody());
        assertThat(body.path("resolved").asBoolean()).isTrue();
        assertThat(body.path("target_path").asText()).isEqualTo("/m/" + publishedSlug);
        assertThat(body.path("og").path("title").asText()).isNotBlank();

        assertThat(get(tenant, null, "/api/v1/share/ZZZZZZZZZZ").getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(get(tenant, null, "/api/v1/share/ZZZZZZZZZZ").getBody())
                .path("error").path("code").asText()).isEqualTo("share_link_not_found");
    }

    @Test
    @DisplayName("A page that is not public has nothing to share, and says so as absent")
    void onlyPublicPagesAreShareable() {
        UUID draft = newMerchant(tenant, "draft-" + System.nanoTime(), "draft");
        ResponseEntity<String> refused = post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "merchant", "subject_id", draft.toString()));
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(refused.getBody()).path("error").path("code").asText())
                .isEqualTo("subject_not_shareable");

        // Another tenant's published merchant is absent too — not forbidden, absent (D5).
        UUID foreign = newMerchant(other, "foreign-" + System.nanoTime(), "published");
        assertThat(post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "merchant", "subject_id", foreign.toString())).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("A collection shares under its own URL grammar, and an unpublished one does not")
    void collectionGrammar() {
        String collectionSlug = "col-" + System.nanoTime();
        UUID collection = newCollection(tenant, collectionSlug, "collection", true);
        JsonNode minted = Json.tree(post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "collection", "subject_id", collection.toString())).getBody());
        assertThat(minted.path("target_path").asText()).isEqualTo("/collections/" + collectionSlug);

        UUID unpublished = newCollection(tenant, "hidden-" + System.nanoTime(), "collection", false);
        assertThat(post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "collection", "subject_id", unpublished.toString())).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // A guide is the same table with a different kind, and it resolves under the guides grammar.
        UUID guide = newCollection(tenant, "guide-" + System.nanoTime(), "guide", true);
        assertThat(Json.tree(post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "guide", "subject_id", guide.toString())).getBody())
                .path("target_path").asText()).startsWith("/guides/");
    }

    @Test
    @DisplayName("An unknown subject type is a 422 naming the field, not a silent merchant lookup")
    void unknownSubjectTypeIsRejected() {
        ResponseEntity<String> res = post(tenant, null, "/api/v1/share",
                Json.map("subject_type", "nonsense", "subject_id", publishedMerchant.toString()));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(res.getBody()).path("error").path("details").path("field").asText())
                .isEqualTo("subject_type");
    }

    private UUID newCollection(Tenant owner, String slug, String kind, boolean published) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into collections (id, tenant_id, kind, slug, title, description, cover_url, visibility,
                                         published_at)
                values (:id, :tenant, :kind, :slug, :title, 'A demo collection', null, 'public',
                        cast(:published as timestamptz))
                """, new MapSqlParameterSource("id", id).addValue("tenant", owner.id()).addValue("kind", kind)
                .addValue("slug", slug).addValue("title", "Demo " + slug)
                .addValue("published", published ? Timestamp.from(Instant.now()).toInstant().toString() : null));
        return id;
    }
}
