package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §8 — the public reads over collections and guides. There is no {@code guides} table: a guide
 * is {@code collections WHERE kind = 'guide'}, so all four endpoints answer from {@link CollectionsRepository}
 * and differ only in the {@code kind} they pin. The §8 write ({@code POST /api/v1/collections}) is not here:
 * this controller holds no session, and a consumer-facing read is not where a row gets created.
 *
 * <p>What the handlers add over the repository is the resolution and the attribution:
 * <ul>
 *   <li><b>§8 item resolution.</b> {@code collections.items} is an ordered array of
 *       {@code {subject_type, subject_id, note}} (the V1 column comment, and what every seeded row holds).
 *       Merchant items are resolved into §2 {@code EntityCard}s on the same read — one batched
 *       {@link MerchantCards#cardsByIds} per page, never a query per item — and an id that resolves to no
 *       published merchant <em>drops</em> the item and appears on {@code dropped_item_ids}. A placeholder card
 *       is the §19 failure this rule prevents; a silently shorter list is the one {@code dropped_item_ids}
 *       prevents.</li>
 *   <li><b>§27 / §108 attribution.</b> {@code generated_by} and {@code curated_by.name} are derived under the
 *       contract's own rule — absent provenance reads as {@code creator} only when {@code author_id} is a real
 *       account, which is also the repository's publishability gate, so the two cannot disagree. No name is
 *       ever invented, and {@code noindex} is stated here rather than decided by the view.</li>
 *   <li><b>§66.</b> The order is the repository's {@code published_at desc, slug asc}. No handler here reads a
 *       campaign, coupon, plan or spend column, so nothing paid can move a guide up the directory.</li>
 * </ul>
 *
 * <p>Cached, and honestly stamped: the embedded cards carry a computed open/closed state, so every response
 * says which instant it was computed against ({@code as_of}) and shares the §4 directory's TTL.
 */
@RestController
public class CollectionsController {

    /** Same TTL as the §4 directory: cached cards age, and {@code as_of} is what makes that visible. */
    private static final String CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";

    /** The kinds §8 and DATABASE.md §3.9 define. */
    private static final List<String> KINDS = List.of("collection", "guide", "itinerary");

    private static final List<String> GENERATED_BY = List.of("ai", "editor", "creator");
    private static final List<String> CURATED_BY = List.of("editorial", "creator", "model", "ai");

    private static final String AI_CURATION = "AI curation";

    private final CollectionsRepository collections;
    private final MerchantCards cards;
    private final Paging paging;

    public CollectionsController(CollectionsRepository collections, MerchantCards cards, Paging paging) {
        this.collections = collections;
        this.cards = cards;
        this.paging = paging;
    }

    // ---- the four §8 reads ------------------------------------------------

    @GetMapping("/api/v1/collections")
    public Map<String, Object> listCollections(@RequestParam(required = false) String kind,
                                               @RequestParam(required = false) String limit,
                                               @RequestParam(required = false) String cursor,
                                               HttpServletRequest request, HttpServletResponse response) {
        return page(request, response, Paging.enumFilter(kind, KINDS, "kind"), limit, cursor);
    }

    @GetMapping("/api/v1/guides")
    public Map<String, Object> listGuides(@RequestParam(required = false) String limit,
                                          @RequestParam(required = false) String cursor,
                                          HttpServletRequest request, HttpServletResponse response) {
        return page(request, response, "guide", limit, cursor);
    }

    @GetMapping("/api/v1/collections/{slug}")
    public Map<String, Object> collection(@PathVariable String slug,
                                         HttpServletRequest request, HttpServletResponse response) {
        return detail(request, response, slug, null, "collection_not_found");
    }

    @GetMapping("/api/v1/guides/{slug}")
    public Map<String, Object> guide(@PathVariable String slug,
                                     HttpServletRequest request, HttpServletResponse response) {
        return detail(request, response, slug, "guide", "guide_not_found");
    }

    // ---- the two shapes ---------------------------------------------------

    /** A paged list. {@code kind} is the filter actually applied, not the one typed. */
    private Map<String, Object> page(HttpServletRequest request, HttpServletResponse response,
                                     String kind, String rawLimit, String rawCursor) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        int size = paging.limit(rawLimit);
        int offset = paging.offset(rawCursor);

        List<Map<String, Object>> rows = collections.collectionRows(tenant, kind, size, offset);
        long total = collections.countCollections(tenant, kind);
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            items.add(summary(row));
        }

        cache(response, tenant);
        DemoFlags.mark(response, rows.stream()
                .anyMatch(row -> DemoFlags.isDemo(Json.str(row, "data_origin"))));
        Map<String, Object> page = paging.page(items, offset, size, total);
        page.put("kind", kind);
        page.put("scope", "public, published and attributable (§8); drafts and unattributable rows are absent");
        page.put("unit", "item_count is the size of the stored ordered list, before unresolvable ids drop out");
        return page;
    }

    /** One row by slug, fully resolved. Absent, a draft, another tenant's or unattributable → 404. */
    private Map<String, Object> detail(HttpServletRequest request, HttpServletResponse response,
                                       String slug, String requiredKind, String notFoundCode) {
        TenantContext tenant = Req.tenant(request);
        Instant asOf = Instant.now();
        Map<String, Object> row = collections.collectionBySlug(tenant, slug, requiredKind)
                .orElseThrow(() -> ApiException.notFound(notFoundCode,
                        "No published " + (requiredKind == null ? "collection" : requiredKind)
                                + " with slug " + slug));

        // One batched read for every merchant the row cites; both views below are built from that map.
        List<Object> stored = Json.jsonArray(row, "items");
        Map<String, Map<String, Object>> byId = cardIndex(merchantIdsOf(stored), tenant, asOf);

        List<String> dropped = new ArrayList<>();
        List<Object> items = new ArrayList<>();
        List<Map<String, Object>> resolved = new ArrayList<>();
        for (Object element : stored) {
            if (!(element instanceof Map<?, ?> raw)) {
                // Not an object, so not a reference this read can resolve — but it is still one of the
                // `item_count` elements the row stores. Echo it as written: a list that answered four short
                // with nothing dropped and nothing named is the §8 lie in its cleanest form.
                items.add(element);
                continue;
            }
            Map<String, Object> item = asMap(raw);
            UUID id = merchantIdOf(item);
            if (id == null) {
                // A typed block, or a subject type this read does not project: pass it through as stored.
                // "We did not resolve it" is not "it does not exist", and dropping prose is the worse lie.
                items.add(item);
                continue;
            }
            Map<String, Object> card = byId.get(id.toString());
            if (card == null) {
                dropped.add(id.toString());
                continue;
            }
            item.put("card", card);
            items.add(item);
            // Item order, repeats included: the seeded Sha Tin guide cites ten merchants over nine shops, and a
            // `cards` array one shorter than the items it came from reads as a lost item. `byId` is the distinct
            // set — one read per shop — while this walk mirrors what the author actually wrote.
            resolved.add(card);
        }

        Map<String, Object> out = new LinkedHashMap<>(summary(row));
        out.put("items", items);
        out.put("cards", resolved);
        out.put("dropped_item_ids", dropped);
        out.put("visibility", Json.str(row, "visibility"));
        out.put("data_origin", Json.str(row, "data_origin"));
        out.put("author", authorOf(row));
        out.put("seo", seoOf(row));
        out.put("noindex", noIndexOf(row));
        out.put("noindex_reason", noindexReasonOf(row));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("as_of", asOf.toString());

        cache(response, tenant);
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        return out;
    }

    // ---- the §8 view ------------------------------------------------------

    /** The columns both surfaces render: identity, provenance and counts, with no item resolution. */
    private static Map<String, Object> summary(Map<String, Object> row) {
        Map<String, Object> seo = Json.jsonObject(row, "seo");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", Json.str(row, "id"));
        out.put("kind", Json.str(row, "kind"));
        out.put("slug", Json.str(row, "slug"));
        out.put("title", Json.map("en", Json.str(row, "title"), "zh", Json.str(row, "title_zh")));
        out.put("description", Json.str(row, "description"));
        out.put("cover_image", coverOf(row, seo));
        out.put("generated_by", generatedByOf(row, seo));
        out.put("curated_by", curatedByOf(row, seo));
        // §27: the human-authorization signal. It lives in `seo` as text, not in a column of its own.
        out.put("reviewed_by_human", isTrue(seo.get("reviewed_by_human")));
        out.put("city", blankToNull(seo.get("city")));
        out.put("category", blankToNull(seo.get("category")));
        out.put("item_count", Json.integer(row, "item_count"));
        out.put("published_at", Json.ts(row, "published_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        // §66: no placement input reaches this projection, so "sponsored" is a fact about the query.
        out.put("flags", Json.map("sponsored", false,
                "demo", DemoFlags.isDemo(Json.str(row, "data_origin"))));
        return out;
    }

    // ---- attribution (§27 / §108) ----------------------------------------

    /**
     * §8: absent provenance reads as {@code creator} only when {@code author_id} is a real account. The
     * repository's publishability gate is exactly that disjunction, so a row that reached here has either a
     * stored token or an author — and an authorless AI guide therefore reports as {@code ai}.
     */
    private static String generatedByOf(Map<String, Object> row, Map<String, Object> seo) {
        String stored = token(seo.get("generated_by"), GENERATED_BY);
        if (stored != null) {
            return stored;
        }
        return Json.str(row, "author_display_name") == null ? "ai" : "creator";
    }

    /**
     * §8: the name is a real account's name, a real model version, or the literal {@code "AI curation"} —
     * never a person who did not curate it. So {@code editorial} and {@code creator} with no author row fall
     * back to {@code ai} rather than borrowing a name, and so does a {@code model} that names no model.
     */
    private static Map<String, Object> curatedByOf(Map<String, Object> row, Map<String, Object> seo) {
        String author = Json.str(row, "author_display_name");
        String type = token(seo.get("curated_by"), CURATED_BY);
        if ("model".equals(type)) {
            String model = blankToNull(seo.get("model"));
            return Json.map("type", model == null ? "ai" : "model",
                    "name", model == null ? AI_CURATION : model);
        }
        if (type == null) {
            type = author == null ? "ai" : "creator";
        }
        if ("ai".equals(type) || author == null) {
            return Json.map("type", "ai", "name", AI_CURATION);
        }
        return Json.map("type", type, "name", author);
    }

    /** The author as stored — a real account or nothing. Never a persona. */
    private static Map<String, Object> authorOf(Map<String, Object> row) {
        String id = Json.str(row, "author_id");
        String name = Json.str(row, "author_display_name");
        if (id == null || name == null) {
            return null;
        }
        return Json.map("user_id", id, "display_name", name);
    }

    /** The stored {@code seo} object minus the keys this view already promotes, so nothing is echoed twice. */
    private static Map<String, Object> seoOf(Map<String, Object> row) {
        Map<String, Object> seo = new LinkedHashMap<>(Json.jsonObject(row, "seo"));
        for (String key : List.of("generated_by", "curated_by", "reviewed_by_human", "city", "category",
                "model")) {
            seo.remove(key);
        }
        return seo;
    }

    /** §8's rule stated once: an unreviewed guide is noindex whatever the row's own {@code seo} says. */
    private static boolean noIndexOf(Map<String, Object> row) {
        Map<String, Object> seo = Json.jsonObject(row, "seo");
        return !isTrue(seo.get("reviewed_by_human")) || isTrue(seo.get("noindex"));
    }

    private static String noindexReasonOf(Map<String, Object> row) {
        Map<String, Object> seo = Json.jsonObject(row, "seo");
        if (!isTrue(seo.get("reviewed_by_human"))) {
            return "not reviewed by a human (§27)";
        }
        return isTrue(seo.get("noindex")) ? "seo.noindex is set on the row" : null;
    }

    // ---- small derivations ------------------------------------------------

    /** §8: {@code credit} is nullable and stays nullable — an uncredited photo must not gain a photographer. */
    private static Map<String, Object> coverOf(Map<String, Object> row, Map<String, Object> seo) {
        String url = blankToNull(Json.str(row, "cover_url"));
        Map<String, Object> cover = seo.get("cover") instanceof Map<?, ?> map ? asMap(map) : Map.of();
        if (url == null) {
            url = blankToNull(cover.get("url"));
        }
        if (url == null) {
            return null;
        }
        return Json.map("url", url, "alt", blankToNull(cover.get("alt")),
                "credit", blankToNull(cover.get("credit")));
    }

    private static List<UUID> merchantIdsOf(List<Object> items) {
        List<UUID> ids = new ArrayList<>();
        for (Object element : items) {
            if (element instanceof Map<?, ?> raw) {
                UUID id = merchantIdOf(asMap(raw));
                if (id != null && !ids.contains(id)) {
                    ids.add(id);
                }
            }
        }
        return ids;
    }

    /** A stored item that points at a merchant, or null when it is a block or another subject type. */
    private static UUID merchantIdOf(Map<String, Object> item) {
        Object subjectType = item.get("subject_type");
        if (subjectType != null && !"merchant".equals(String.valueOf(subjectType))) {
            return null;
        }
        Object subjectId = item.get("subject_id");
        if (subjectId == null) {
            return null;
        }
        try {
            return UUID.fromString(String.valueOf(subjectId));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Every card the row cites, keyed by merchant id, from one {@link MerchantCards#cardsByIds} call. */
    private Map<String, Map<String, Object>> cardIndex(List<UUID> ids, TenantContext tenant, Instant asOf) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        if (ids.isEmpty()) {
            return out;
        }
        for (Map<String, Object> card : cards.cardsByIds(tenant, ids, asOf)) {
            out.put(String.valueOf(card.get("id")), card);
        }
        return out;
    }

    private static Map<String, Object> asMap(Map<?, ?> raw) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) {
            out.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return out;
    }

    private static String token(Object value, List<String> allowed) {
        String text = blankToNull(value);
        if (text == null) {
            return null;
        }
        String lower = text.toLowerCase();
        return allowed.contains(lower) ? lower : null;
    }

    /** {@code seo} values are jsonb, so a boolean arrives as JSON true or the string "true" (§8). */
    private static boolean isTrue(Object value) {
        return Boolean.TRUE.equals(value) || (value != null && "true".equalsIgnoreCase(String.valueOf(value)));
    }

    private static String blankToNull(Object value) {
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }

    private static void cache(HttpServletResponse response, TenantContext tenant) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, CACHE);
        // Slugs are unique per tenant, so a shared cache must not serve one market's guide to another.
        response.setHeader(HttpHeaders.VARY, "X-Tenant");
    }
}
