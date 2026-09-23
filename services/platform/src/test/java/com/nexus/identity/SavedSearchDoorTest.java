package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The third door D50's audit found unopened: {@code GET}/{@code POST}/{@code DELETE
 * /api/v1/me/saved-searches}, whose §7 row had an empty description cell — the same pairing that turned
 * favourites into an unwalked wall (§45).
 *
 * <p>Walking it caught the same shape twice over. Both delete handlers called their repository, threw the row
 * count away, and answered {@code {"status":"removed"}} regardless — so un-saving a row that was never there, or
 * that belongs to somebody else, was reported as a success. {@link FavoriteDoorTest}'s last case shows the
 * sibling on the favourites door; here it is the saved-search one, plus the survivor check that makes the
 * difference visible: the other person's row has to still be there afterwards, and the answer has to be the
 * same 404 an absent id gets (D5), because a response that distinguishes "not yours" from "not there" is an
 * existence oracle wearing a success message.
 */
class SavedSearchDoorTest extends NexusIntegrationTest {

    private ResponseEntity<String> save(Tenant tenant, UUID user, Object body) {
        return post(tenant, token(tenant, user, "consumer"), "/api/v1/me/saved-searches", body);
    }

    private JsonNode list(Tenant tenant, UUID user) {
        return Json.tree(get(tenant, token(tenant, user, "consumer"), "/api/v1/me/saved-searches").getBody());
    }

    private ResponseEntity<String> remove(Tenant tenant, UUID user, UUID id) {
        return http.exchange(java.net.URI.create(url("/api/v1/me/saved-searches/" + id)), HttpMethod.DELETE,
                new HttpEntity<>(json(tenant, token(tenant, user, "consumer"))), String.class);
    }

    @Test
    @DisplayName("The door saves, lists every field it stores, and removes")
    void saveListRemove() {
        Tenant tenant = newTenant("saved-search");
        UUID person = newUser(tenant, "saver@saved.test", "consumer");

        assertThat(list(tenant, person)).as("a fresh account has none").isEmpty();

        ResponseEntity<String> saved = save(tenant, person, Json.map("name", "Quiet tables",
                "query", "quiet restaurant sha tin", "intent", Json.map("district", "sha-tin"), "notify", true));
        assertThat(saved.getStatusCode()).as("save said: %s", saved.getBody()).isEqualTo(HttpStatus.OK);
        String id = Json.tree(saved.getBody()).path("id").asText();
        assertThat(Json.tree(saved.getBody()).path("status").asText()).isEqualTo("saved");

        JsonNode row = list(tenant, person).get(0);
        assertThat(row.path("id").asText()).isEqualTo(id);
        assertThat(row.path("name").asText()).isEqualTo("Quiet tables");
        assertThat(row.path("query").asText()).isEqualTo("quiet restaurant sha tin");
        assertThat(row.path("notify").asBoolean()).isTrue();
        assertThat(row.path("intent").path("district").asText())
                .as("the intent jsonb round-trips rather than stringifying")
                .isEqualTo("sha-tin");
        assertThat(row.path("created_at").asText()).isNotBlank();

        // Defaults, stated: an omitted notify is false, and an omitted intent is an empty object, not null.
        JsonNode plain = Json.tree(save(tenant, person, Json.map("query", "late noodles")).getBody());
        JsonNode listed = list(tenant, person).get(0);
        assertThat(listed.path("id").asText()).isEqualTo(plain.path("id").asText());
        assertThat(listed.path("notify").asBoolean()).isFalse();
        assertThat(listed.path("intent").isObject()).isTrue();
        assertThat(listed.path("intent").isEmpty()).isTrue();

        assertThat(remove(tenant, person, UUID.fromString(id)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(tenant, person)).hasSize(1);
    }

    @Test
    @DisplayName("Nothing is reported removed unless a row went away")
    void removingWhatIsNotThereIsAFourOhFour() {
        Tenant tenant = newTenant("saved-search-404");
        UUID owner = newUser(tenant, "owner@saved.test", "consumer");
        UUID other = newUser(tenant, "other@saved.test", "consumer");
        String id = Json.tree(save(tenant, owner, Json.map("query", "ramen tai hang")).getBody()).path("id").asText();

        ResponseEntity<String> neverExisted = remove(tenant, other, UUID.randomUUID());
        assertThat(neverExisted.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(neverExisted.getBody()).path("error").path("code").asText())
                .isEqualTo("saved_search_not_found");

        ResponseEntity<String> notYours = remove(tenant, other, UUID.fromString(id));
        assertThat(notYours.getStatusCode())
                .as("the same 404, so the answer cannot be used to probe whose rows exist: %s", notYours.getBody())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(notYours.getBody()).path("error").path("message").asText())
                .isEqualTo(Json.tree(neverExisted.getBody()).path("error").path("message").asText());
        assertThat(list(tenant, owner)).as("the owner's row survived the attempt").hasSize(1);

        assertThat(remove(tenant, owner, UUID.fromString(id)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(tenant, owner)).isEmpty();
    }

    @Test
    @DisplayName("A blank query is refused before anything is stored")
    void blankQueryIsRefused() {
        Tenant tenant = newTenant("saved-search-valid");
        UUID person = newUser(tenant, "picky@saved.test", "consumer");

        ResponseEntity<String> blank = save(tenant, person, Json.map("query", "   ", "name", "nothing"));
        assertThat(blank.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(blank.getBody()).contains("query");
        assertThat(list(tenant, person)).as("a refused save stores nothing").isEmpty();

        assertThat(post(tenant, null, "/api/v1/me/saved-searches", Json.map("query", "late noodles")).getStatusCode())
                .as("the door is not public").isEqualTo(HttpStatus.UNAUTHORIZED);
    }
}
