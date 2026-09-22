package com.nexus.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * API_CONTRACT §8 — collections and guides over live rows, read from the one table both surfaces share.
 *
 * <p>Every rule this pins is about what a page is not allowed to say. A guide is a collection of another kind,
 * not a second object, so the four endpoints must agree about visibility. A list cites merchants by id, so an id
 * that resolves to nothing has to drop rather than render a placeholder — and the response must admit it dropped,
 * or a ten-item guide showing eight is a silent lie. Provenance is the §27 gate: an unattributable row is not
 * publishable, and a row with no account behind it must not gain a person's name. Assertions are on HTTP bodies,
 * because each of these survives a unit test that reads the SQL charitably.
 */
class CollectionsReadTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;
    private UUID author;
    private UUID otherAuthor;

    @BeforeEach
    void seedTenants() {
        tenant = newTenant("collections");
        other = newTenant("collections-other");
        author = newUser(tenant, "curator", "consumer");
        otherAuthor = newUser(other, "other-curator", "consumer");
    }

    /** Distinct per run: slugs are unique inside a tenant and the tests share one database. */
    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- the lists

    @Test
    @DisplayName("/guides answers kind=guide only; /collections answers every kind and ?kind= narrows it")
    void kindPinningSplitsOneTable() {
        String tag = tag();
        seed(tenant, "guide", "a-guide-" + tag, items(merchant(tenant, "guide-merchant-" + tag)));
        seed(tenant, "collection", "a-collection-" + tag, items(merchant(tenant, "collection-merchant-" + tag)));

        assertThat(kinds(body("/api/v1/guides?limit=100"))).contains("guide");
        assertThat(body("/api/v1/guides?limit=100")).doesNotContain("\"kind\":\"collection\"");

        JsonNode all = Json.tree(body("/api/v1/collections?limit=100"));
        assertThat(kindsOf(all.path("items"))).contains("guide", "collection");
        assertThat(all.path("kind").isNull()).as("no kind typed, so none is claimed").isTrue();

        JsonNode only = Json.tree(body("/api/v1/collections?kind=collection&limit=100"));
        assertThat(only.path("kind").asText()).isEqualTo("collection");
        assertThat(only.path("items").get(0).path("slug").asText()).isEqualTo("a-collection-" + tag);
    }

    @Test
    @DisplayName("A draft, a private row and an unattributable row are all absent — and each for a different reason")
    void onlyPublishedPublicAttributableRowsAppear() {
        String tag = tag();
        UUID visible = merchant(tenant, "visible-" + tag);
        seed(tenant, "collection", "listed-" + tag, items(visible));
        seed(tenant, "collection", "draft-" + tag, items(visible), "public", null);
        seed(tenant, "collection", "private-" + tag, items(visible), "private", Instant.now());
        // No author and no generated_by token: §8 calls this row not publishable, so it is not readable either.
        seed(tenant, "collection", "unattributed-" + tag, items(visible), "public", Instant.now(),
                Map.of(), null);

        List<String> slugs = slugs(body("/api/v1/collections?limit=100"));
        assertThat(slugs).contains("listed-" + tag)
                .doesNotContain("draft-" + tag, "private-" + tag, "unattributed-" + tag);

        assertNotFound("/api/v1/collections/draft-" + tag, "collection_not_found");
        assertNotFound("/api/v1/collections/private-" + tag, "collection_not_found");
        assertNotFound("/api/v1/collections/unattributed-" + tag, "collection_not_found");
    }

    @Test
    @DisplayName("An unknown ?kind= is a 422 that names the field; another tenant's slug is a 404")
    void badInputAndForeignTenantFailLoudly() {
        String tag = tag();
        seed(other, "collection", "not-mine-" + tag, items(merchant(other, "other-merchant-" + tag)),
                "public", Instant.now(), Map.of(), otherAuthor);

        assertValidation("/api/v1/collections?kind=blog", "kind");
        assertNotFound("/api/v1/collections/not-mine-" + tag, "collection_not_found");
        assertNotFound("/api/v1/guides/nothing-here-" + tag, "guide_not_found");
    }

    // ---------------------------------------------------------------- the detail

    @Test
    @DisplayName("Merchant ids resolve to §2 cards in stored order; an id that resolves to nothing drops and is named")
    void itemsResolveToCardsAndUnresolvableIdsDrop() {
        String tag = tag();
        UUID first = merchant(tenant, "first-" + tag);
        UUID second = merchant(tenant, "second-" + tag);
        UUID archived = merchant(tenant, "retired-" + tag, "archived");
        UUID never = UUID.randomUUID();
        // `first` is cited twice on purpose: the seeded Sha Tin guide does exactly that, and a cards array
        // shorter than the items it came from reads as a dropped row rather than as one shop listed twice.
        seed(tenant, "guide", "with-cards-" + tag,
                of(item(first), item(second), item(first), item(archived), item(never)));

        JsonNode page = Json.tree(body("/api/v1/collections/with-cards-" + tag));
        assertThat(slugsOf(page.path("cards")))
                .containsExactly("first-" + tag, "second-" + tag, "first-" + tag);

        // The ordered list keeps what resolved, in the stored order, each entry carrying its own card.
        JsonNode items = page.path("items");
        assertThat(items).hasSize(3);
        assertThat(items.get(0).path("card").path("id").asText()).isEqualTo(first.toString());
        assertThat(items.get(0).path("note").asText()).isEqualTo("Sha Tin");
        assertThat(items.get(1).path("card").path("id").asText()).isEqualTo(second.toString());

        // Neither dropped id renders a card, and both are named. item_count still says what was stored.
        assertThat(stringList(page.path("dropped_item_ids")))
                .containsExactly(archived.toString(), never.toString());
        assertThat(page.path("item_count").asInt()).isEqualTo(5);
        assertThat(cardIds(items)).doesNotContain(archived.toString(), never.toString());
    }

    @Test
    @DisplayName("A resolved card is the §2 projection the directory uses, stamped with this response's own instant")
    void cardsAreTheDirectoryProjection() {
        String tag = tag();
        UUID shop = merchant(tenant, "same-card-" + tag);
        seed(tenant, "collection", "card-parity-" + tag, items(shop));

        JsonNode detail = Json.tree(body("/api/v1/collections/card-parity-" + tag));
        JsonNode fromGuide = detail.path("cards").get(0);
        JsonNode fromDirectory = null;
        for (JsonNode item : Json.tree(body("/api/v1/merchants?limit=100")).path("items")) {
            if (shop.toString().equals(item.path("id").asText())) {
                fromDirectory = item;
            }
        }
        assertThat(fromDirectory).as("the merchant is in the directory too").isNotNull();

        // Everything a card carries is present here; the directory item is that card plus its own grid columns.
        List<String> guideKeys = fieldNames(fromGuide);
        assertThat(fieldNames(fromDirectory)).containsAll(guideKeys);
        for (String key : List.of("card_type", "id", "slug", "title", "subtitle", "price", "rating", "facts",
                "flags")) {
            assertThat(fromGuide.path(key)).as(key).isEqualTo(fromDirectory.path(key));
        }
        // §5: an open state is only meaningful with the instant it was computed, and it must be this read's.
        assertThat(fromGuide.path("open").path("as_of").asText()).isEqualTo(detail.path("as_of").asText());
        assertThat(fromGuide.path("flags").path("sponsored").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("An item that is not a merchant reference passes through unresolved instead of being deleted")
    void blockItemsPassThroughUnresolved() {
        String tag = tag();
        UUID shop = merchant(tenant, "prose-merchant-" + tag);
        seed(tenant, "guide", "has-blocks-" + tag,
                of(block("paragraph", "A demo route, written for synthetic merchants."), item(shop),
                        block("heading", "Where to eat")));

        JsonNode items = Json.tree(body("/api/v1/collections/has-blocks-" + tag)).path("items");
        assertThat(items).hasSize(3);
        assertThat(items.get(0).path("type").asText()).isEqualTo("paragraph");
        assertThat(items.get(0).has("card")).isFalse();
        assertThat(items.get(1).path("card").path("id").asText()).isEqualTo(shop.toString());
        assertThat(items.get(2).path("type").asText()).isEqualTo("heading");
    }

    @Test
    @DisplayName("A stored item that is not an object is echoed rather than deleted")
    void scalarItemsSurviveTheResolutionWalk() {
        String tag = tag();
        UUID shop = merchant(tenant, "scalar-merchant-" + tag);
        // `[<id>, 42, null, {...}]`: jsonb keeps every element, so `item_count` says four. Dropping the
        // three this read cannot resolve left a four-item guide rendering an empty list with nothing
        // named as dropped — the reader had no way to tell "empty" from "we skipped what we couldn't parse".
        seed(tenant, "guide", "scalar-items-" + tag, of("\"" + shop + "\"", "42", "null", item(shop)));

        JsonNode page = Json.tree(body("/api/v1/collections/scalar-items-" + tag));
        assertThat(page.path("item_count").asInt()).isEqualTo(4);
        assertThat(page.path("items")).hasSize(4);
        assertThat(page.path("items").get(0).asText()).isEqualTo(shop.toString());
        // A bare string is not reinterpreted as a reference: only the shape the column documents resolves.
        assertThat(page.path("items").get(0).has("card")).isFalse();
        assertThat(page.path("items").get(3).path("card").path("id").asText()).isEqualTo(shop.toString());
        assertThat(page.path("cards")).hasSize(1);
        assertThat(page.path("dropped_item_ids")).isEmpty();
    }

    @Test
    @DisplayName("A `cover` that is not an object degrades to the column, it does not fail the read")
    void nonObjectCoverDoesNotBreakTheProfile() {
        String tag = tag();
        seed(tenant, "guide", "string-cover-" + tag, items(merchant(tenant, "cover-merchant-" + tag)),
                "public", Instant.now(), Map.of("cover", "https://demo.invalid/one-big-string.jpg"), author);

        JsonNode page = Json.tree(body("/api/v1/guides/string-cover-" + tag));
        // `seo` is free jsonb, so any writer can put anything under any key; the projection's job is to
        // say what it knows — the real `cover_url` — and leave the rest null.
        assertThat(page.path("cover_image").path("url").asText()).isEqualTo("/demo/img/guide.svg");
        assertThat(page.path("cover_image").path("alt").isNull()).isTrue();
        assertThat(page.path("cover_image").path("credit").isNull()).isTrue();
    }

    @Test
    @DisplayName("A `seo` column that is not an object degrades to nothing, it does not fail the read")
    void scalarSeoDoesNotBreakTheProfile() {
        String tag = tag();
        // `collections.seo` is jsonb with no shape constraint, so a writer can put a string or an array
        // there. The read's job is then to say what it still knows from the real columns — the title, the
        // cover, the author — and to treat the unreadable provenance as absent, which §8 already defines
        // as `ai`, not to answer 500 for data it did not expect.
        jdbc.update("""
                insert into collections (id, tenant_id, author_id, kind, slug, title, description, cover_url,
                                         items, visibility, data_origin, seo, published_at)
                values (:id, :t, :author, 'guide', :slug, 'Scalar seo guide', 'A demo list.', '/demo/img/x.svg',
                        cast(:items as jsonb), 'public', 'demo', cast(:seo as jsonb), now())
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                .addValue("author", author).addValue("slug", "scalar-seo-" + tag)
                .addValue("items", items(merchant(tenant, "seo-merchant-" + tag)))
                .addValue("seo", "\"not-an-object\""));

        JsonNode page = Json.tree(body("/api/v1/guides/scalar-seo-" + tag));
        assertThat(page.path("slug").asText()).isEqualTo("scalar-seo-" + tag);
        assertThat(page.path("generated_by").asText()).isEqualTo("creator");
        assertThat(page.path("curated_by").path("name").asText()).isEqualTo("User curator");
        // Unreadable provenance is still unreviewed, so the §27 gate applies rather than defaulting open.
        assertThat(page.path("noindex").asBoolean()).isTrue();
        assertThat(page.path("cover_image").path("url").asText()).isEqualTo("/demo/img/x.svg");
    }

    // ---------------------------------------------------------------- attribution

    @Test
    @DisplayName("Absent provenance reads as creator because a real account backs the row, and the name is that account's")
    void attributionComesFromRealColumns() {
        String tag = tag();
        seed(tenant, "guide", "attributed-" + tag, items(merchant(tenant, "attributed-merchant-" + tag)));

        JsonNode page = Json.tree(body("/api/v1/guides/attributed-" + tag));
        // No seo.generated_by is stored, so §8's derivation applies — and it holds only because author_id is real.
        assertThat(page.path("generated_by").asText()).isEqualTo("creator");
        assertThat(page.path("curated_by").path("type").asText()).isEqualTo("creator");
        assertThat(page.path("curated_by").path("name").asText()).isEqualTo("User curator");
        assertThat(page.path("author").path("display_name").asText()).isEqualTo("User curator");

        // §27: nothing in the row says a human reviewed it, so the page is noindex and says why.
        assertThat(page.path("reviewed_by_human").asBoolean()).isFalse();
        assertThat(page.path("noindex").asBoolean()).isTrue();
        assertThat(page.path("noindex_reason").asText()).contains("§27");
    }

    @Test
    @DisplayName("An editorial claim with no account behind it reports as AI curation; a named model keeps its name")
    void noNameIsEverInvented() {
        String tag = tag();
        seed(tenant, "guide", "model-" + tag, items(merchant(tenant, "model-merchant-" + tag)),
                "public", Instant.now(),
                Json.map("generated_by", "ai", "curated_by", "model", "model", "nexus-guide-v1"), author);
        seed(tenant, "guide", "model-nameless-" + tag, items(merchant(tenant, "nameless-merchant-" + tag)),
                "public", Instant.now(),
                Json.map("generated_by", "ai", "curated_by", "model"), author);
        seed(tenant, "guide", "faceless-" + tag, items(merchant(tenant, "faceless-merchant-" + tag)),
                "public", Instant.now(),
                Json.map("generated_by", "ai", "curated_by", "editorial"), null);

        JsonNode model = Json.tree(body("/api/v1/guides/model-" + tag));
        assertThat(model.path("generated_by").asText()).isEqualTo("ai");
        assertThat(model.path("curated_by").path("type").asText()).isEqualTo("model");
        assertThat(model.path("curated_by").path("name").asText()).isEqualTo("nexus-guide-v1");

        // "model" with no model named cannot cite a version, so it reports as AI rather than inventing one.
        JsonNode nameless = Json.tree(body("/api/v1/guides/model-nameless-" + tag));
        assertThat(nameless.path("curated_by").path("type").asText()).isEqualTo("ai");
        assertThat(nameless.path("curated_by").path("name").asText()).isEqualTo("AI curation");

        // The row claims an editorial board and has no account behind it: no person's name appears.
        JsonNode faceless = Json.tree(body("/api/v1/guides/faceless-" + tag));
        assertThat(faceless.path("curated_by").path("type").asText()).isEqualTo("ai");
        assertThat(faceless.path("curated_by").path("name").asText()).isEqualTo("AI curation");
        assertThat(faceless.path("generated_by").asText()).isEqualTo("ai");
        assertThat(faceless.path("author").isNull()).isTrue();
    }

    @Test
    @DisplayName("A human-reviewed row is indexable, and a cover with no credit keeps a null credit")
    void reviewedRowsAreIndexableAndCreditStaysNull() {
        String tag = tag();
        seed(tenant, "guide", "reviewed-" + tag, items(merchant(tenant, "reviewed-merchant-" + tag)),
                "public", Instant.now(), Json.map("reviewed_by_human", "true"), author);

        JsonNode page = Json.tree(body("/api/v1/guides/reviewed-" + tag));
        assertThat(page.path("reviewed_by_human").asBoolean()).isTrue();
        assertThat(page.path("noindex").asBoolean()).isFalse();
        assertThat(page.path("noindex_reason").isNull()).isTrue();

        // cover_url is set and seo.cover is not: a URL with no photographer, and none is invented.
        assertThat(page.path("cover_image").path("url").asText()).isEqualTo("/demo/img/guide.svg");
        assertThat(page.path("cover_image").path("credit").isNull()).isTrue();
        assertThat(page.path("cover_image").path("alt").isNull()).isTrue();
        // §8: the stored seo object survives this view minus the keys the view already promoted.
        assertThat(page.path("seo").has("reviewed_by_human")).isFalse();
    }

    @Test
    @DisplayName("Both reads are public, cacheable, tenant-varying and badged as synthetic")
    void readsArePublicCacheableAndBadged() {
        String tag = tag();
        seed(tenant, "collection", "badged-" + tag, items(merchant(tenant, "badged-merchant-" + tag)));

        ResponseEntity<String> detail = getRaw(tenant, null, "/api/v1/collections/badged-" + tag);
        assertThat(detail.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(detail.getHeaders().getCacheControl()).contains("public").contains("s-maxage")
                .contains("stale-while-revalidate");
        assertThat(detail.getHeaders().getFirst(HttpHeaders.VARY)).contains("X-Tenant");
        assertThat(detail.getHeaders().getFirst("X-Demo-Data")).isEqualTo("true");

        ResponseEntity<String> list = getRaw(tenant, null, "/api/v1/collections");
        assertThat(list.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list.getHeaders().getFirst("X-Demo-Data")).isEqualTo("true");
    }

    // ---------------------------------------------------------------- helpers

    private String body(String path) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private void assertValidation(String path, String field) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode error = Json.tree(res.getBody()).path("error");
        assertThat(error.path("code").asText()).as(path).isEqualTo("validation_error");
        assertThat(error.path("details").path("field").asText()).as(path).isEqualTo(field);
    }

    private void assertNotFound(String path, String code) {
        ResponseEntity<String> res = getRaw(tenant, null, path);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).as(path).isEqualTo(code);
    }

    private UUID merchant(Tenant owner, String slug) {
        return merchant(owner, slug, "published");
    }

    private UUID merchant(Tenant owner, String slug, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, category_primary, status,
                                       data_origin, avg_price_hkd, popularity_score, ownership_verified)
                values (:id, :t, :slug, :legal, :display, 'cafe', :status, 'demo', 80.00, 5, true)
                """, new MapSqlParameterSource("id", id).addValue("t", owner.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug)
                .addValue("status", status));
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng,
                                       is_primary)
                values (:id, :m, :t, '1 Curator Road', 'Hong Kong', 'Sha Tin', 22.385, 114.188, true)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("m", id).addValue("t", owner.id()));
        return id;
    }

    /** One merchant reference in the shape V1's column comment documents and the seeder writes. */
    private static String item(UUID merchantId) {
        return "{\"subject_type\":\"merchant\",\"subject_id\":\"" + merchantId + "\",\"note\":\"Sha Tin\"}";
    }

    private static String items(UUID... merchantIds) {
        List<String> elements = new ArrayList<>();
        for (UUID id : merchantIds) {
            elements.add(item(id));
        }
        return of(elements.toArray(String[]::new));
    }

    /** A §8 typed block: prose this read does not resolve and must not delete. */
    private static String block(String type, String text) {
        return "{\"type\":\"" + type + "\",\"text\":\"" + text + "\"}";
    }

    private static String of(String... elements) {
        return "[" + String.join(",", elements) + "]";
    }

    private void seed(Tenant owner, String kind, String slug, String itemsJson) {
        seed(owner, kind, slug, itemsJson, "public", Instant.now(), Map.of(), author);
    }

    private void seed(Tenant owner, String kind, String slug, String itemsJson, String visibility,
                      Instant publishedAt) {
        seed(owner, kind, slug, itemsJson, visibility, publishedAt, Map.of(), author);
    }

    private void seed(Tenant owner, String kind, String slug, String itemsJson, String visibility,
                      Instant publishedAt, Map<String, Object> seo, UUID authorId) {
        jdbc.update("""
                insert into collections (id, tenant_id, author_id, kind, slug, title, description, cover_url,
                                         items, visibility, data_origin, seo, published_at)
                values (:id, :t, :author, :kind, :slug, :title, 'A demo list of synthetic merchants.',
                        '/demo/img/guide.svg', cast(:items as jsonb), :visibility, 'demo',
                        cast(:seo as jsonb), :published)
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", owner.id())
                .addValue("author", authorId).addValue("kind", kind).addValue("slug", slug)
                .addValue("title", "Demo " + slug).addValue("items", itemsJson)
                .addValue("visibility", visibility).addValue("seo", Json.write(seo))
                .addValue("published", publishedAt == null ? null : Timestamp.from(publishedAt)));
    }

    private static List<String> kinds(String body) {
        return kindsOf(Json.tree(body).path("items"));
    }

    private static List<String> kindsOf(JsonNode items) {
        List<String> out = new ArrayList<>();
        items.forEach(node -> out.add(node.path("kind").asText()));
        return out;
    }

    private static List<String> slugs(String body) {
        List<String> out = new ArrayList<>();
        Json.tree(body).path("items").forEach(node -> out.add(node.path("slug").asText()));
        return out;
    }

    private static List<String> slugsOf(JsonNode cards) {
        List<String> out = new ArrayList<>();
        cards.forEach(node -> out.add(node.path("slug").asText()));
        return out;
    }

    private static List<String> cardIds(JsonNode items) {
        List<String> out = new ArrayList<>();
        items.forEach(node -> out.add(node.path("card").path("id").asText()));
        return out;
    }

    private static List<String> stringList(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(node -> out.add(node.asText()));
        return out;
    }

    private static List<String> fieldNames(JsonNode node) {
        List<String> out = new ArrayList<>();
        node.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
