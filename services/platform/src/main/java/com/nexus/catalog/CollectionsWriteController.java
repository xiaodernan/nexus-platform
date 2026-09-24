package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §8's write: {@code POST /api/v1/collections}, and it writes a <em>draft</em>.
 *
 * <p>The §8 question this route answers — and the one D50 left open — is who owns a published guide. The
 * workspace permission chain cannot: {@code collections} has {@code tenant_id}, {@code author_id} and no
 * merchant column, so no {@code @RequiresPermission} exists that could guard a row the schema cannot attribute
 * to a business. That question is about <em>publication</em>, and it stays open. It does not block the draft:
 * a row that no read serves is not a row whose owner has been decided, so this route writes the one state
 * nobody has to agree about and refuses, by construction rather than by a permission I would have to invent,
 * to do anything §27 reserves for a human.
 *
 * <p>Three rules, and where each one's teeth are:
 * <ul>
 *   <li><b>The trust-bearing columns are literals in the {@code INSERT}, not body fields.</b>
 *       {@code author_id} is the session's subject, {@code visibility} is {@code 'private'},
 *       {@code published_at} is null, {@code data_origin} is {@code 'user'} and {@code seo} is empty — so
 *       provenance, publication and the demo badge are all things that <em>happened</em> to this row rather
 *       than things its author declared. A caller that sends any of them gets a {@code 422}
 *       {@code field_not_settable} naming why, not a silent drop: an ignored field teaches the client that
 *       the field works.</li>
 *   <li><b>Publication is not routed.</b> There is no {@code .../publish} here and no {@code PATCH} of
 *       {@code published_at}. §27's "a human authorizes publication" therefore holds because no HTTP verb in
 *       this build stamps the column, which is a stronger statement than a comment saying it should — and
 *       {@code CollectionDraftWriteTest} is the witness in both directions: a row created here is invisible to
 *       all four §8 reads, stays invisible when only {@code visibility} is flipped in SQL, and appears only
 *       once both facts hold.</li>
 *   <li><b>Replay is settled by the index.</b> {@code UNIQUE (tenant_id, slug)} is V1's, so a double-tapped
 *       submit is one row and a {@code 409 slug_taken} that names the id behind it — the same choice D45 made
 *       for a retried reservation, and the reason this route asks for no {@code Idempotency-Key}: a stored
 *       answer would be a second record of the same fact, and the constraint is the one that cannot lie.</li>
 * </ul>
 *
 * <p>The response is {@link CollectionsController}'s own read projection of the stored row plus the fields
 * only a write can state, so the author sees the draft exactly as a directory will once it is published —
 * including the parts of it that are currently {@code null}.
 */
@RestController
public class CollectionsWriteController {

    /** What the body may name. Everything else is refused, not ignored. */
    private static final Set<String> ACCEPTED =
            Set.of("kind", "slug", "title", "title_zh", "description", "cover_url", "items");

    /** Keys a caller might send that this route writes as literals — each refusal says which. */
    private static final Map<String, String> RESERVED = Map.of(
            "visibility", "a draft is 'private' here; §27 makes publication a human decision",
            "published_at", "stamping it IS the publication, and no route in this build stamps it",
            "data_origin", "'user' — this door is only reachable by a person, so the origin is not theirs to declare",
            "author_id", "the authenticated caller, read off the session and never off the body",
            "tenant_id", "the request's resolved tenant",
            "seo", "provenance and human-review claims belong to whoever publishes (§27/§108)");

    /**
     * The slug is the §8 lookup key ({@code /collections/{slug}}) and a URL segment, so it is exact-matched:
     * anything a reader cannot retype from the address bar — upper case, spaces, an accent, a leading hyphen —
     * is refused rather than stored and unreachable.
     */
    private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9-]{1,95}$");

    private static final int TITLE_MAX = 200;
    private static final int DESCRIPTION_MAX = 4000;
    private static final int COVER_MAX = 512;
    private static final int NOTE_MAX = 500;
    private static final int ITEMS_MAX = 200;

    /** The subject labels an item may cite — the same four the favourites door accepts, and no fifth. */
    private static final List<String> SUBJECT_TYPES = List.of("merchant", "offering", "guide", "collection");

    private final CollectionsRepository collections;
    private final AuditService audit;

    public CollectionsWriteController(CollectionsRepository collections, AuditService audit) {
        this.collections = collections;
        this.audit = audit;
    }

    @PostMapping("/api/v1/collections")
    @RequiresAuth
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createDraft(@RequestBody Map<String, Object> body, HttpServletRequest request,
                                           HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        UUID author = Req.userId(request);

        refuseUnsettable(body);
        String kind = requireKind(body.get("kind"));
        String slug = requireSlug(body.get("slug"));
        String title = requireTitle(body.get("title"));
        String titleZh = requireOptional("title_zh", body.get("title_zh"), TITLE_MAX);
        String description = requireOptional("description", body.get("description"), DESCRIPTION_MAX);
        String coverUrl = requireCoverUrl(body.get("cover_url"));
        String items = requireItems(body.get("items"));

        UUID id;
        try {
            id = Json.uuid(collections.insertDraft(tenant, author, kind, slug, title, titleZh, description,
                    coverUrl, items), "id");
        } catch (DuplicateKeyException raced) {
            throw slugTaken(tenant, slug, author);
        }

        Map<String, Object> row = collections.anyRowById(tenant, id)
                .orElseThrow(() -> ApiException.internal("collection vanished after insert", null));
        audit.record(request, "create_collection_draft", "collection", id, null, null,
                Json.map("slug", slug, "kind", kind, "visibility", Json.str(row, "visibility")),
                Json.map("author_id", author.toString()));

        Map<String, Object> out = new LinkedHashMap<>(CollectionsController.summary(row));
        out.put("visibility", Json.str(row, "visibility"));
        out.put("data_origin", Json.str(row, "data_origin"));
        out.put("author", CollectionsController.authorOf(row));
        out.put("status", "draft");
        out.put("status_note", "written, not published: visibility='private' and published_at is null, and §8's "
                + "directory requires both facts plus attribution, so no consumer read serves this row.");
        out.put("authorisation_basis", "the caller's own access token (§7). author_id came from the session and "
                + "visibility/published_at/data_origin/seo are literals in the insert, so this route cannot be "
                + "asked to publish a row, attribute it to someone else, or badge it as demo content.");
        out.put("publish_requires", List.of("visibility = 'public'", "published_at IS NOT NULL",
                "attribution: author_id points at a real account — already true for this row"));
        out.put("publish_requires_note", "§27 reserves publication for a human decision, and this build serves "
                + "no verb that stamps published_at; the row becomes readable by a stranger through SQL a "
                + "publisher runs, not through HTTP.");
        out.put("replay", "a second POST with this slug in this tenant answers 409 slug_taken from "
                + "collections_tenant_id_slug_key (V1's UNIQUE (tenant_id, slug)); no Idempotency-Key is "
                + "demanded, because the constraint is what makes the retry one row.");
        out.put("as_of", Instant.now().toString());

        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        return out;
    }

    // ---- the refusal that is not a silent drop ---------------------------

    /**
     * A key this route does not write is named and refused, with the reason when the key is a reserved one and
     * with the accepted list when it is not — so a typo cannot come back later as "my {@code published_at} was
     * ignored". {@code Set.of} has no order, so the refusal walks a sorted view and reports the same key first
     * on every run.
     */
    private static void refuseUnsettable(Map<String, Object> body) {
        List<String> keys = new ArrayList<>(body.keySet());
        keys.sort(null);
        for (String key : keys) {
            if (ACCEPTED.contains(key)) {
                continue;
            }
            String reserved = RESERVED.get(key);
            throw ApiException.validation("Field '" + key + "' is not something POST /api/v1/collections writes",
                    Json.map("field", key,
                            "reason", reserved == null
                                    ? "this route reads only " + ACCEPTED.stream().sorted().toList()
                                    : reserved,
                            "accepted_fields", ACCEPTED.stream().sorted().toList()));
        }
    }

    /** The index said duplicate; the caller is owed the row it collided with, not just the word. */
    private ApiException slugTaken(TenantContext tenant, String slug, UUID author) {
        Map<String, Object> existing = collections.anyRowBySlug(tenant, slug).orElse(null);
        if (existing == null) {
            // The row went away between the failed insert and this read. Saying so is honest; saying
            // "your draft is already there" would be a claim about a row this request cannot see.
            return ApiException.conflict("slug_taken", "That slug is already used in this tenant",
                    Json.map("slug", slug, "existing", "none visible to this request"));
        }
        UUID owner = Json.uuid(existing, "author_id");
        return ApiException.conflict("slug_taken", "That slug is already used in this tenant",
                Json.map("slug", slug,
                        "existing_id", Json.str(existing, "id"),
                        "existing_kind", Json.str(existing, "kind"),
                        "existing_visibility", Json.str(existing, "visibility"),
                        "existing_published", existing.get("published_at") != null,
                        "owned_by_caller", owner != null && owner.equals(author),
                        "replay_guard", "collections_tenant_id_slug_key"));
    }

    // ---- validation ------------------------------------------------------

    /** Absent kind is V1's own column default, stated here so the row and the response agree. */
    private static String requireKind(Object raw) {
        if (raw == null) {
            return "collection";
        }
        String value = text(raw);
        if (!CollectionsController.KINDS.contains(value)) {
            throw ApiException.validation("kind must be one of " + CollectionsController.KINDS,
                    Json.map("field", "kind", "allowed", CollectionsController.KINDS, "received", value));
        }
        return value;
    }

    private static String requireSlug(Object raw) {
        String value = text(raw);
        if (value.isEmpty()) {
            throw ApiException.validation("slug is required — it is the §8 lookup key and the URL a reader sees",
                    Json.map("field", "slug", "required", true, "pattern", SLUG.pattern()));
        }
        if (!SLUG.matcher(value).matches()) {
            throw ApiException.validation("slug must be lowercase letters, digits and interior hyphens, 2 to 96 "
                    + "characters, because §8 resolves it by exact match",
                    Json.map("field", "slug", "pattern", SLUG.pattern(), "received", value));
        }
        return value;
    }

    private static String requireTitle(Object raw) {
        String value = text(raw);
        if (value.isEmpty()) {
            throw ApiException.validation("title is required", Json.map("field", "title", "required", true));
        }
        return requireLength("title", value, TITLE_MAX);
    }

    private static String requireOptional(String field, Object raw, int max) {
        if (raw == null) {
            return null;
        }
        String value = text(raw);
        return value.isEmpty() ? null : requireLength(field, value, max);
    }

    private static String requireLength(String field, String value, int max) {
        if (value.length() > max) {
            throw ApiException.validation(field + " must be at most " + max + " characters",
                    Json.map("field", field, "max_length", max, "received", value.length()));
        }
        return value;
    }

    /**
     * A cover is shown to strangers, so this refuses anything that is not a path or an http(s) URL: a
     * {@code data:} URI or a {@code javascript:} value reaching an {@code <img src>} is how an author's draft
     * becomes somebody else's payload. An absent cover stays absent — §8's projection prints
     * {@code cover_image: null} rather than a placeholder, and this route must not be the thing that breaks
     * that by substituting one.
     */
    private static String requireCoverUrl(Object raw) {
        if (raw == null) {
            return null;
        }
        String value = text(raw);
        if (value.isEmpty()) {
            return null;
        }
        boolean rooted = value.startsWith("/") && !value.startsWith("//");
        boolean absolute = value.startsWith("http://") || value.startsWith("https://");
        if (!rooted && !absolute) {
            throw ApiException.validation("cover_url must be a path starting with '/' or an http(s) URL",
                    Json.map("field", "cover_url", "received", value));
        }
        return requireLength("cover_url", value, COVER_MAX);
    }

    /**
     * Items are stored as written, in order — V1's column is a flat {@code [{subject_type,subject_id,note}]}
     * array and a typed block is a real element of it (§8/D34), so this validates shape only. Resolving an id
     * is the read's job, and the read already names what it could not resolve on {@code dropped_item_ids}; a
     * draft whose cited shop is unpublished is therefore an honest draft, not a broken one. A non-object
     * element is refused here even though the read tolerates it: that tolerance exists for rows this build
     * cannot rewrite, and a write that accepts {@code 42} as an item would store something no editor can fix.
     */
    private static String requireItems(Object raw) {
        if (raw == null) {
            return "[]";
        }
        if (!(raw instanceof List<?> list)) {
            throw ApiException.validation("items must be an array of objects",
                    Json.map("field", "items", "received", shape(raw)));
        }
        if (list.size() > ITEMS_MAX) {
            throw ApiException.validation("items must hold at most " + ITEMS_MAX + " entries",
                    Json.map("field", "items", "max_items", ITEMS_MAX, "received", list.size()));
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            Object element = list.get(i);
            String field = "items[" + i + "]";
            if (!(element instanceof Map<?, ?> map)) {
                throw ApiException.validation("items[" + i + "] is " + shape(element) + ", not an object",
                        Json.map("field", field, "shape", shape(element)));
            }
            Map<String, Object> item = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                item.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            requireSubject(field, item);
            requireNote(field, item);
            out.add(item);
        }
        return Json.write(out);
    }

    /** A cited subject must be one of the four labels, and its id must be one id. */
    private static void requireSubject(String field, Map<String, Object> item) {
        Object type = item.get("subject_type");
        if (type == null) {
            if (item.get("subject_id") != null) {
                throw ApiException.validation(field + " cites a subject_id without saying what it is",
                        Json.map("field", field + ".subject_type", "allowed", SUBJECT_TYPES));
            }
            return;                                        // a typed block: prose, not a reference
        }
        String value = text(type);
        if (!SUBJECT_TYPES.contains(value)) {
            throw ApiException.validation(field + ".subject_type must be one of " + SUBJECT_TYPES,
                    Json.map("field", field + ".subject_type", "allowed", SUBJECT_TYPES, "received", value));
        }
        Object id = item.get("subject_id");
        if (id == null || Json.uuidOrNull(text(id)) == null) {
            throw ApiException.validation(field + ".subject_id must be a uuid, so the §8 read can resolve it",
                    Json.map("field", field + ".subject_id", "subject_type", value, "received", id));
        }
    }

    private static void requireNote(String field, Map<String, Object> item) {
        Object note = item.get("note");
        if (note != null) {
            requireLength(field + ".note", text(note), NOTE_MAX);
        }
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static String shape(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String) {
            return "a string";
        }
        if (value instanceof Number) {
            return "a number";
        }
        if (value instanceof Boolean) {
            return "a boolean";
        }
        if (value instanceof List) {
            return "an array";
        }
        return value.getClass().getSimpleName();
    }
}
