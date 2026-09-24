package com.nexus.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.platform.RequiresAuth;
import com.nexus.testsupport.NexusIntegrationTest;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.condition.PathPatternsRequestCondition;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * §8's write door — {@code POST /api/v1/collections} — walked in the state it actually creates.
 *
 * <p>§8 has promised this route since the contract was written, and the promise nobody had tested is the one
 * this class is really about: <em>a row created here must not be readable by a stranger.</em> That is the §27
 * line (a human authorizes publication) and the §109 line (a person's own writing is not demo content), and
 * both rest on two columns plus an attribution rule. Every one of them is a predicate in
 * {@link CollectionsRepository} that a unit test could read charitably, so this walks the HTTP surface in the
 * order the facts arrive: created → invisible → dated but private, still invisible → private but public-flagged,
 * still invisible → both holding, served. Each corner is its own assertion because the rule is an AND, and a
 * walk that visits only one of the two half-states leaves the other half of the AND unwitnessed — which is
 * exactly what the D61 mutation run caught.
 *
 * <p>Two assertions are gates on the design rather than on the data:
 * <ul>
 *   <li>The router is asked, not the prose, whether any verb can publish. "No route stamps
 *       {@code published_at}" is the sentence that makes §27 hold by construction, so a test that read only
 *       this controller would not notice a {@code PATCH} added two classes away.</li>
 *   <li>The favourites door and this door are checked against each other on the same row (D50): an
 *       un-publishable row must not be saveable, and the moment it is publishable it must be — which is only
 *       worth asserting because both ask {@code isPublishable} rather than each keeping a copy of the rule.</li>
 * </ul>
 */
class CollectionDraftWriteTest extends NexusIntegrationTest {

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping routes;

    private Tenant tenant;
    private Tenant other;
    private UUID author;
    private String token;

    @BeforeEach
    void seedPeople() {
        tenant = newTenant("drafts");
        other = newTenant("drafts-other");
        author = newUser(tenant, "draft-author", "consumer");
        token = token(tenant, author, "consumer");
    }

    /** Distinct per run: slugs are unique inside a tenant and the suite shares one database. */
    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- the §8 invariant

    @Test
    @DisplayName("A created draft is invisible to all four §8 reads, and one flipped column is not enough to publish it")
    void aDraftIsNotAPublication() {
        String slug = "shatin-walk-" + tag();
        ResponseEntity<String> created = post(tenant, token, "/api/v1/collections", Json.map(
                "kind", "guide", "slug", slug, "title", "A walk through Sha Tin",
                "description", "Six stops, written by hand."));
        assertThat(created.getStatusCode()).as("201: the row really exists now").isEqualTo(HttpStatus.CREATED);

        JsonNode row = Json.tree(created.getBody());
        String id = row.path("id").asText();
        assertThat(row.path("status").asText()).isEqualTo("draft");
        assertThat(row.path("visibility").asText()).isEqualTo("private");
        assertThat(row.path("published_at").isNull()).as("never stamped, and nothing here stamps it").isTrue();
        assertThat(row.path("data_origin").asText()).isEqualTo("user");
        // §109: a person's own writing is not demo content, so the badge must be off — in the payload and on
        // the header, which are the two places a UI could read it from.
        assertThat(row.path("flags").path("demo").asBoolean()).isFalse();
        assertThat(created.getHeaders().getFirst("X-Demo-Data")).isNull();

        // Attribution came from the session, and the projection says so without inventing a name.
        assertThat(row.path("author").path("user_id").asText()).isEqualTo(author.toString());
        assertThat(row.path("author").path("display_name").asText()).isEqualTo("User draft-author");
        assertThat(row.path("generated_by").asText()).isEqualTo("creator");
        assertThat(row.path("reviewed_by_human").asBoolean()).isFalse();
        // `noindex` is deliberately absent from a write response: it is an instruction about a page a crawler
        // can reach, and this row is not reachable yet. The fact behind it — nobody reviewed it — is here, and
        // the flag is asserted below on the read that serves the row.
        assertThat(row.has("noindex")).as("unreachable, so unindexable is not yet a claim").isFalse();
        assertThat(row.path("item_count").asInt()).isZero();
        assertThat(count("select count(*) from collections where id = cast(:id as uuid)", Map.of("id", id)))
                .as("exactly one row for one accepted POST").isEqualTo(1);
        assertThat(count("select count(*) from audit_logs where action = 'create_collection_draft'"
                + " and subject_id = cast(:id as uuid)", Map.of("id", id)))
                .as("the write says who did it (§52)").isEqualTo(1);

        // The draft is not a public page: every §8 read behaves as if it does not exist.
        assertThat(slugs(body(tenant, "/api/v1/collections?limit=200"))).doesNotContain(slug);
        assertThat(slugs(body(tenant, "/api/v1/guides?limit=200"))).doesNotContain(slug);
        assertNotFound("/api/v1/collections/" + slug, "collection_not_found");
        assertNotFound("/api/v1/guides/" + slug, "guide_not_found");
        // ...and it is not saveable either: the favourites door asks the same repository the directory does.
        assertThat(post(tenant, token, "/api/v1/me/favorites",
                Json.map("subject_type", "guide", "subject_id", id)).getStatusCode())
                .as("D50: saving an invisible row would save a link to a 404").isEqualTo(HttpStatus.NOT_FOUND);

        // The scope is an AND of two facts, so each half alone has to keep the row hidden, and that is only
        // worth walking because a one-corner test leaves the other predicate free to go: with the published-but-
        // private corner missing, deleting `visibility = 'public'` from SCOPE kept this class green (D61's M2).
        jdbc.update("update collections set published_at = now() where id = cast(:id as uuid)", Map.of("id", id));
        assertThat(slugs(body(tenant, "/api/v1/guides?limit=200"))).as("dated, but still private")
                .doesNotContain(slug);
        assertNotFound("/api/v1/guides/" + slug, "guide_not_found");
        assertThat(post(tenant, token, "/api/v1/me/favorites",
                Json.map("subject_type", "guide", "subject_id", id)).getStatusCode())
                .as("a publish date is not a licence to be read: the favourites door asks the same AND").isEqualTo(
                        HttpStatus.NOT_FOUND);

        // The other corner: the §8 listing's `visibility` half alone.
        jdbc.update("update collections set visibility = 'public', published_at = null where id = cast(:id as uuid)",
                Map.of("id", id));
        assertThat(slugs(body(tenant, "/api/v1/guides?limit=200"))).as("public, but never published")
                .doesNotContain(slug);
        assertNotFound("/api/v1/guides/" + slug, "guide_not_found");

        // Now both facts, which is the human decision §27 describes, done the only way this build allows.
        jdbc.update("update collections set published_at = now() where id = cast(:id as uuid)", Map.of("id", id));
        ResponseEntity<String> served = getRaw(tenant, null, "/api/v1/guides/" + slug);
        assertThat(served.getStatusCode()).as("no session, and it still serves").isEqualTo(HttpStatus.OK);
        JsonNode page = Json.tree(served.getBody());
        assertThat(page.path("id").asText()).isEqualTo(id);
        assertThat(page.path("slug").asText()).isEqualTo(slug);
        assertThat(page.path("title").path("en").asText()).isEqualTo("A walk through Sha Tin");
        assertThat(page.path("author").path("display_name").asText()).isEqualTo("User draft-author");
        assertThat(page.path("noindex").asBoolean()).as("published is not the same as reviewed").isTrue();
        assertThat(served.getHeaders().getFirst("X-Demo-Data"))
                .as("a served page says where its content came from, and this one came from a person").isNull();

        String list = body(tenant, "/api/v1/guides?limit=200");
        assertThat(slugs(list)).contains(slug);
        assertThat(Json.tree(list).path("total_estimate").asInt()).isEqualTo(1);
        assertThat(Json.tree(list).path("items").get(0).path("flags").path("demo").asBoolean())
                .as("the list's badge tracks the row, not the tenant's seed").isFalse();

        // The row a moment ago unsaveable is now saveable — under the kind it actually is.
        assertThat(post(tenant, token, "/api/v1/me/favorites",
                Json.map("subject_type", "guide", "subject_id", id)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(post(tenant, token, "/api/v1/me/favorites",
                Json.map("subject_type", "collection", "subject_id", id)).getStatusCode())
                .as("kind is pinned: a guide is not a collection, whatever the caller called it")
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("No session, no write; and a published draft stays inside its own tenant")
    void authAndTenantAreBothLoadBearing() {
        String slug = "private-to-its-own-t-" + tag();

        ResponseEntity<String> anonymous = post(tenant, null, "/api/v1/collections",
                Json.map("slug", slug, "title", "No session, no row"));
        assertThat(anonymous.getStatusCode()).as("the §8 reads are public; this one is not")
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(anonymous.getBody()).path("error").path("code").asText()).isEqualTo("unauthorized");
        assertThat(count("select count(*) from collections where slug = :slug", Map.of("slug", slug)))
                .as("a refused write leaves no row").isZero();
        // Two separate things refuse that caller, and the HTTP leg above cannot tell them apart: the
        // `@RequiresAuth` interceptor before the handler runs, and `Req.userId` inside the handler, which answers
        // the same code and the same message. The outcome is witnessed by the 401; the declaration is only
        // witnessed by asking the method, and D45's lesson is that a door with one half missing is a door that
        // happens to be shut. Deleting the annotation is mutation M7 — and the first version of this check stayed
        // green under it anyway, because its `peek` body ended in `.as(...)` with no terminal assertion. An
        // `assertThat` that never reaches one asserts nothing. So: collect, size, then ask out loud.
        List<Method> posts = Arrays.stream(CollectionsWriteController.class.getMethods())
                .filter(method -> method.isAnnotationPresent(PostMapping.class))
                .toList();
        assertThat(posts).as("exactly one mapped POST here").hasSize(1);
        for (Method post : posts) {
            assertThat(post.isAnnotationPresent(RequiresAuth.class))
                    .as("%s is §8's only write, so it declares its own door", post.getName())
                    .isTrue();
        }

        String id = Json.tree(post(tenant, token, "/api/v1/collections",
                Json.map("kind", "guide", "slug", slug, "title", "Published by SQL")).getBody())
                .path("id").asText();
        assertThat(count("select count(*) from collections where id = cast(:id as uuid) and author_id = :a"
                + " and visibility = 'private' and published_at is null and data_origin = 'user'",
                Map.of("id", id, "a", author)))
                .as("the literals the insert promised are the literals the row holds").isEqualTo(1);
        jdbc.update("update collections set visibility = 'public', published_at = now()"
                + " where id = cast(:id as uuid)", Map.of("id", id));

        // Same slug, another market: the row is not there, in either direction.
        assertThat(getRaw(other, null, "/api/v1/guides/" + slug).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(slugs(body(other, "/api/v1/guides?limit=200"))).doesNotContain(slug);
        assertThat(slugs(body(tenant, "/api/v1/guides?limit=200"))).contains(slug);
    }

    // ---------------------------------------------------------------- replay

    @Test
    @DisplayName("A retried slug is one row and a 409 that names it; another tenant may still take the same slug")
    void theIndexIsTheReplayGuard() {
        String slug = "retried-" + tag();
        Map<String, Object> payload = Json.map("kind", "collection", "slug", slug, "title", "Ten cafes",
                "description", "One per paragraph.");

        JsonNode first = Json.tree(post(tenant, token, "/api/v1/collections", payload).getBody());
        ResponseEntity<String> again = post(tenant, token, "/api/v1/collections", payload);

        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        JsonNode error = Json.tree(again.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("slug_taken");
        assertThat(error.path("details").path("existing_id").asText()).isEqualTo(first.path("id").asText());
        assertThat(error.path("details").path("owned_by_caller").asBoolean())
                .as("the caller's own row, so a screen can say 「already saved」 rather than 「no」").isTrue();
        assertThat(error.path("details").path("existing_visibility").asText()).isEqualTo("private");
        assertThat(error.path("details").path("replay_guard").asText()).isEqualTo("collections_tenant_id_slug_key");

        assertThat(count("select count(*) from collections where slug = :slug and tenant_id = :t",
                Map.of("slug", slug, "t", tenant.id()))).as("the retry created nothing").isEqualTo(1);
        // And a refused retry must not have edited the row either: a 409 that also updates is the worst kind of lie.
        assertThat(count("select count(*) from collections where id = cast(:id as uuid) and title = 'Ten cafes'"
                + " and description = 'One per paragraph.' and visibility = 'private'",
                Map.of("id", first.path("id").asText()))).isEqualTo(1);

        // Per tenant, not global: another market can write its own guide at the same words in the URL.
        UUID outsider = newUser(other, "other-author", "consumer");
        assertThat(post(other, token(other, outsider, "consumer"), "/api/v1/collections", payload).getStatusCode())
                .as("UNIQUE (tenant_id, slug) is per tenant, so a clash in one market is not a claim on another")
                .isEqualTo(HttpStatus.CREATED);

        // The other half of the same refusal. `owned_by_caller` is what a form reads to decide between 「已经存过」
        // and 「这个地址被占了」, so the false branch has to have been produced by a real row rather than inferred
        // from the true one — the same M2 lesson as the publishability AND: a two-valued field tested on one
        // value is tested on half of it. (In the seeded demo tenant this is not hypothetical: four slugs are
        // already held by demo rows, `select visibility, data_origin, count(*) from collections group by 1,2`.)
        UUID rival = newUser(tenant, "rival-author", "consumer");
        String rivalSlug = "rival-" + tag();
        String rivalId = Json.tree(post(tenant, token(tenant, rival, "consumer"), "/api/v1/collections",
                Json.map("slug", rivalSlug, "title", "Written by someone else")).getBody())
                .path("id").asText();
        JsonNode clash = Json.tree(post(tenant, token, "/api/v1/collections",
                Json.map("slug", rivalSlug, "title", "Same words, different person")).getBody())
                .path("error");
        assertThat(clash.path("code").asText()).isEqualTo("slug_taken");
        assertThat(clash.path("details").path("owned_by_caller").asBoolean())
                .as("a retry is the caller's own row; this one is not, and the payload says so").isFalse();
        assertThat(clash.path("details").path("existing_id").asText()).isEqualTo(rivalId);
        assertThat(clash.path("details").path("existing_visibility").asText())
                .as("the clash is with a draft, and the caller is told that much and no more").isEqualTo("private");
        assertThat(count("select count(*) from collections where slug = :slug and tenant_id = :t",
                Map.of("slug", rivalSlug, "t", tenant.id()))).as("a clash writes nothing").isEqualTo(1);
    }

    // ---------------------------------------------------------------- what the body cannot say

    @Test
    @DisplayName("A body that tries to set visibility, publication, origin, author, tenant or provenance is refused")
    void theTrustBearingColumnsAreNotBodyFields() {
        for (String reserved : List.of("visibility", "published_at", "data_origin", "author_id", "tenant_id",
                "seo")) {
            String slug = "reserved-" + reserved + "-" + tag();
            ResponseEntity<String> res = post(tenant, token, "/api/v1/collections", Json.map(
                    "slug", slug, "title", "Trying to say it myself", reserved, "public"));
            assertThat(res.getStatusCode()).as(reserved).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            JsonNode error = Json.tree(res.getBody()).path("error");
            assertThat(error.path("code").asText()).isEqualTo("validation_error");
            assertThat(error.path("details").path("field").asText()).isEqualTo(reserved);
            assertThat(error.path("details").path("reason").asText()).as(reserved + " says why").isNotEmpty();
            assertThat(count("select count(*) from collections where slug = :slug", Map.of("slug", slug)))
                    .as("and nothing was written for " + reserved).isZero();
        }

        // An unrecognised key is refused too: a silent drop is how `titel` becomes "the API lost my title".
        ResponseEntity<String> typo = post(tenant, token, "/api/v1/collections",
                Json.map("titel", "Misspelled", "slug", "typo-" + tag()));
        assertThat(typo.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(typo.getBody()).path("error");
        assertThat(error.path("details").path("field").asText()).isEqualTo("titel");
        assertThat(error.path("details").path("accepted_fields").toString()).contains("title", "slug");
    }

    @Test
    @DisplayName("Validation names the field and the rule, and a rejected body never reaches the table")
    void refusalsAreSpecific() {
        String slug = "shapes-" + tag();
        assertValidation(Json.map("title", "No slug at all"), "slug", null);
        assertValidation(Json.map("slug", "Bad Slug", "title", "T"), "slug", "pattern");
        assertValidation(Json.map("slug", slug, "kind", "menu", "title", "T"), "kind", "allowed");
        assertValidation(Json.map("slug", slug, "title", "T".repeat(201)), "title", "max_length");
        assertValidation(Json.map("slug", slug, "title", "T", "cover_url", "javascript:alert(1)"),
                "cover_url", null);
        assertValidation(Json.map("slug", slug, "title", "T", "items", "not-an-array"), "items", null);
        assertValidation(Json.map("slug", slug, "title", "T", "items", List.of(42)), "items[0]", "shape");
        assertValidation(Json.map("slug", slug, "title", "T", "items",
                List.of(Json.map("subject_type", "merchant", "subject_id", "not-a-uuid"))),
                "items[0].subject_id", "subject_type");
        assertValidation(Json.map("slug", slug, "title", "T", "items",
                List.of(Json.map("subject_type", "restaurant", "subject_id", UUID.randomUUID().toString()))),
                "items[0].subject_type", "allowed");
        assertValidation(Json.map("slug", slug, "title", "T", "items",
                List.of(Json.map("subject_id", UUID.randomUUID().toString()))), "items[0].subject_type", null);

        assertThat(count("select count(*) from collections where tenant_id = :t", Map.of("t", tenant.id())))
                .as("ten refused bodies, zero rows").isZero();

        // Absent kind is the column's own default, stated rather than assumed: no kind means a collection.
        JsonNode created = Json.tree(post(tenant, token, "/api/v1/collections",
                Json.map("slug", slug, "title", "A bare list")).getBody());
        assertThat(created.path("kind").asText()).isEqualTo("collection");
        assertThat(created.path("cover_image").isNull()).as("no cover is a real state, not a placeholder").isTrue();
        assertThat(count("select count(*) from collections where id = cast(:id as uuid) and items = '[]'::jsonb"
                + " and cover_url is null and seo = '{}'::jsonb", Map.of("id", created.path("id").asText())))
                .as("absent means absent in the row, not defaulted into something").isEqualTo(1);

        // A typed block is a legitimate element of §8's array, so the write keeps it exactly as written.
        JsonNode prose = Json.tree(post(tenant, token, "/api/v1/collections", Json.map(
                "slug", "blocks-" + tag(), "title", "Prose and shops",
                "items", List.of(Json.map("type", "paragraph", "text", "Start at the ferry."),
                        Json.map("subject_type", "merchant", "subject_id", UUID.randomUUID().toString()),
                        Json.map("subject_type", "collection", "subject_id", created.path("id").asText(),
                                "note", "the bare list above")))).getBody());
        assertThat(prose.path("item_count").asInt()).isEqualTo(3);
        assertThat(count("select count(*) from collections where id = cast(:id as uuid)"
                + " and jsonb_array_length(items) = 3 and items->0->>'type' = 'paragraph'"
                + " and items->2->>'subject_type' = 'collection'", Map.of("id", prose.path("id").asText())))
                .as("stored as an ordered array, not re-sorted, filtered or resolved").isEqualTo(1);
    }

    // ---------------------------------------------------------------- the design, gated on the router

    @Test
    @DisplayName("No served verb can publish: create is the only §8 write, and it writes a draft")
    void publicationIsNotRouted() {
        Set<String> served = new TreeSet<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry : routes.getHandlerMethods().entrySet()) {
            for (String path : pathsOf(entry.getKey())) {
                if (path.startsWith("/api/v1/collections") || path.startsWith("/api/v1/guides")) {
                    entry.getKey().getMethodsCondition().getMethods()
                            .forEach(method -> served.add(method + " " + path));
                }
            }
        }
        // A mapped method with no declared verbs answers every verb — that is exactly how a publish sneaks in,
        // so the set below is compared for equality rather than for containment.
        assertThat(served).as("the §8 surface, read off the running router rather than from this file's prose")
                .containsExactlyInAnyOrderElementsOf(List.of(
                        "GET /api/v1/collections",
                        "GET /api/v1/collections/{slug}",
                        "GET /api/v1/guides",
                        "GET /api/v1/guides/{slug}",
                        "POST /api/v1/collections"));
        assertThat(served).noneMatch(entry -> entry.toLowerCase().contains("publish"));
    }

    /** The patterns one mapping serves; empty when it declares none, which the test above would then miss. */
    private static Set<String> pathsOf(RequestMappingInfo info) {
        PathPatternsRequestCondition paths = info.getPathPatternsCondition();
        if (paths != null) {
            Set<String> out = new TreeSet<>();
            paths.getPatterns().forEach(pattern -> out.add(pattern.getPatternString()));
            return out;
        }
        return info.getPatternsCondition() == null ? Set.of() : new TreeSet<>(info.getPatternsCondition().getPatterns());
    }

    // ---------------------------------------------------------------- helpers

    private String body(Tenant market, String path) {
        ResponseEntity<String> res = getRaw(market, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private List<String> slugs(String body) {
        List<String> out = new ArrayList<>();
        Json.tree(body).path("items").forEach(node -> out.add(node.path("slug").asText()));
        return out;
    }

    private void assertNotFound(String path, String code) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).as(path).isEqualTo(code);
    }

    /** A 422 that names the field, and — where the rule is numeric or patterned — the limit it broke. */
    private void assertValidation(Map<String, Object> payload, String field, String detailKey) {
        ResponseEntity<String> res = post(tenant, token, "/api/v1/collections", payload);
        assertThat(res.getStatusCode()).as(String.valueOf(field)).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(res.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("validation_error");
        assertThat(error.path("details").path("field").asText()).isEqualTo(field);
        if (detailKey != null) {
            assertThat(error.path("details").has(detailKey)).as(field + " names its " + detailKey).isTrue();
        }
    }
}
