package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.net.URI;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * §7's favorite door — {@code GET}/{@code POST}/{@code DELETE /api/v1/me/favorites} — had never been walked:
 * {@code grep -rn "favorites" services/platform/src/test/java} returned nothing at all when D50 started, so every
 * promise on those three handlers was unobserved, including the validator behind them. Walking it found two.
 *
 * <ul>
 *   <li><b>A saved item could point at a row nothing can open.</b> {@code assertSubjectInTenant} accepted any
 *       collection in the caller's tenant, while §8's own read filter hides rows that are not
 *       {@code visibility='public' AND published_at is not null} <em>and</em> attributable — a shape the demo
 *       data is full of (measured on the loaded seed: 31 public rows with no {@code published_at}, and 31 more
 *       stamped but with neither an author nor a provenance token, out of 576). A favorite for one of those saves
 *       successfully, renders in the list, and links to a 404. The fix asks {@code CollectionsRepository}, which
 *       owns the rule, rather than copying a predicate that would drift from it (D44).</li>
 *   <li><b>{@code guide} was advertised and then refused.</b> {@code FavoriteBody}'s own pattern accepts
 *       {@code merchant|offering|guide|collection}, but the validator had no guide branch, so the fourth
 *       documented value answered 422 {@code Unsupported subject_type} — a DTO promising what the code under it
 *       denies. Guides are rows of the same table, so both labels now resolve through the publishability rule and
 *       are pinned to their {@code kind}: an id cannot be saved under a name the directory would not file it
 *       under.</li>
 * </ul>
 */
class FavoriteDoorTest extends NexusIntegrationTest {

    private ResponseEntity<String> save(Tenant tenant, UUID user, String type, UUID subjectId, String note) {
        return post(tenant, token(tenant, user, "consumer"), "/api/v1/me/favorites",
                Json.map("subject_type", type, "subject_id", String.valueOf(subjectId), "note", note));
    }

    private JsonNode list(Tenant tenant, UUID user) {
        return Json.tree(get(tenant, token(tenant, user, "consumer"), "/api/v1/me/favorites").getBody());
    }

    private ResponseEntity<String> remove(Tenant tenant, UUID user, String type, UUID subjectId) {
        return http.exchange(URI.create(url("/api/v1/me/favorites/" + type + "/" + subjectId)), HttpMethod.DELETE,
                new HttpEntity<>(json(tenant, token(tenant, user, "consumer"))), String.class);
    }

    private UUID collection(Tenant tenant, UUID author, String slug, String kind, boolean stamped) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into collections (id, tenant_id, author_id, kind, slug, title, visibility, published_at)"
                        + " values (:id, :t, :a, :kind, :slug, :title, 'public', "
                        + (stamped ? "now()" : "null") + ")",
                new MapSqlParameterSource("id", id).addValue("t", tenant.id()).addValue("a", author)
                        .addValue("kind", kind).addValue("slug", slug).addValue("title", "Row " + slug));
        return id;
    }

    @Test
    @DisplayName("The door saves, lists, re-saves as an update of the same row, and removes")
    void saveListAndRemove() {
        Tenant tenant = newTenant("fav-door");
        UUID person = newUser(tenant, "saver@fav.test", "consumer");
        UUID merchant = newMerchant(tenant, "fav-m-" + System.nanoTime(), "active");

        // 200 rather than 201: the handler carries no @ResponseStatus, and §7 had promised nothing about this
        // door until D50 wrote down what it answers. Its neighbours (/reviews, /api-keys) do answer 201 — the
        // inconsistency is reported in docs/STATUS.md, not fixed by changing a status under a client.
        ResponseEntity<String> saved = save(tenant, person, "merchant", merchant, "date night");
        assertThat(saved.getStatusCode()).as("first save said: %s", saved.getBody())
                .isEqualTo(HttpStatus.OK);
        String favoriteId = Json.tree(saved.getBody()).path("id").asText();
        assertThat(Json.tree(saved.getBody()).path("status").asText()).isEqualTo("saved");

        JsonNode first = list(tenant, person).get(0);
        assertThat(first.path("subject_type").asText()).isEqualTo("merchant");
        assertThat(first.path("subject_id").asText()).isEqualTo(merchant.toString());
        assertThat(first.path("note").asText()).isEqualTo("date night");
        assertThat(first.path("id").asText()).isEqualTo(favoriteId);
        assertThat(first.path("created_at").asText()).isNotBlank();

        // A second save of the same subject is that row's update, not a second favourite: the unique constraint
        // is (user_id, subject_type, subject_id) and the insert turns a conflict into a note refresh.
        ResponseEntity<String> again = save(tenant, person, "merchant", merchant, "second Thursday");
        assertThat(again.getStatusCode()).as("a repeat save updates the row, and is still 200")
                .isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(again.getBody()).path("id").asText()).isEqualTo(favoriteId);
        assertThat(count("select count(*) from favorites where user_id = :u", Map.of("u", person))).isEqualTo(1);
        assertThat(list(tenant, person).get(0).path("note").asText()).isEqualTo("second Thursday");

        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'favorite'",
                Map.of("t", tenant.id()))).as("both accepted saves were audited").isEqualTo(2);

        assertThat(remove(tenant, person, "merchant", merchant).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(tenant, person)).isEmpty();
        assertThat(count("select count(*) from favorites where user_id = :u", Map.of("u", person))).isZero();
    }

    @Test
    @DisplayName("A subject outside the caller's tenant reads exactly like a subject that never existed")
    void foreignReadsAsAbsent() {
        Tenant mine = newTenant("fav-mine");
        Tenant theirs = newTenant("fav-theirs");
        UUID person = newUser(mine, "watcher@fav.test", "consumer");
        UUID foreignMerchant = newMerchant(theirs, "fav-foreign-" + System.nanoTime(), "active");

        ResponseEntity<String> crossTenant = save(mine, person, "merchant", foreignMerchant, null);
        ResponseEntity<String> neverExisted = save(mine, person, "merchant", UUID.randomUUID(), null);
        assertThat(crossTenant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(neverExisted.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(neverExisted.getBody()).path("error").path("code").asText())
                .isEqualTo(Json.tree(crossTenant.getBody()).path("error").path("code").asText());
        assertThat(Json.tree(neverExisted.getBody()).path("error").path("message").asText())
                .as("D5: distinguishable 404s would make the code an existence oracle")
                .isEqualTo(Json.tree(crossTenant.getBody()).path("error").path("message").asText());

        assertThat(save(mine, person, "coupon", foreignMerchant, null).getStatusCode())
                .as("a subject_type outside the DTO's own pattern is a validation refusal, not a 404")
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(mine, null, "/api/v1/me/favorites",
                Json.map("subject_type", "merchant", "subject_id", foreignMerchant.toString())).getStatusCode())
                .as("the door is not public").isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("Nothing unsavable: the door and the §8 directory agree about each of the three row shapes")
    void onlyPublishableRowsCanBeSaved() {
        Tenant tenant = newTenant("fav-pub");
        UUID author = newUser(tenant, "author@fav.test", "consumer");
        UUID fan = newUser(tenant, "fan@fav.test", "consumer");
        String shown = "shown-" + System.nanoTime();
        String draft = "draft-" + System.nanoTime();
        String noAuthor = "noauthor-" + System.nanoTime();
        UUID shownId = collection(tenant, author, shown, "collection", true);
        UUID draftId = collection(tenant, author, draft, "collection", false);
        UUID noAuthorId = collection(tenant, null, noAuthor, "collection", true);

        assertThat(save(tenant, fan, "collection", shownId, null).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(save(tenant, fan, "collection", draftId, null).getStatusCode())
                .as("no published_at is a draft: the list cannot show it, so a save must not accept it either")
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(save(tenant, fan, "collection", noAuthorId, null).getStatusCode())
                .as("stamped but neither author nor provenance token is not publishable (§27/§108)")
                .isEqualTo(HttpStatus.NOT_FOUND);

        String directory = get(tenant, null, "/api/v1/collections?limit=100").getBody();
        assertThat(directory).as("the publishable row is listed").contains("\"" + shown + "\"");
        assertThat(directory).as("and the two the gate hides are not").doesNotContain(draft).doesNotContain(noAuthor);
        assertThat(get(tenant, null, "/api/v1/collections/" + shown).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(get(tenant, null, "/api/v1/collections/" + draft).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get(tenant, null, "/api/v1/collections/" + noAuthor).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("The fourth documented subject_type is honoured, and pinned to the kind it names")
    void guideIsASubjectTypeAndNotACollection() {
        Tenant tenant = newTenant("fav-guide");
        UUID author = newUser(tenant, "writer@fav.test", "consumer");
        UUID fan = newUser(tenant, "reader@fav.test", "consumer");
        String guideSlug = "guide-" + System.nanoTime();
        String bookSlug = "book-" + System.nanoTime();
        UUID guide = collection(tenant, author, guideSlug, "guide", true);
        UUID book = collection(tenant, author, bookSlug, "collection", true);

        assertThat(save(tenant, fan, "guide", guide, null).getStatusCode())
                .as("FavoriteBody advertises guide; until D50 the validator answered 422 for it")
                .isEqualTo(HttpStatus.OK);
        assertThat(save(tenant, fan, "guide", book, null).getStatusCode())
                .as("a collection id saved as a guide would resolve later as something else")
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(save(tenant, fan, "collection", guide, null).getStatusCode())
                .as("and the same pinning holds from the other side")
                .isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(get(tenant, null, "/api/v1/guides/" + guideSlug).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(tenant, fan).get(0).path("subject_type").asText()).isEqualTo("guide");
    }
}
