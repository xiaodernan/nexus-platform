package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * The one merchant → {@code EntityCard} projection in the platform (API_CONTRACT §2).
 *
 * <p>Directory pages, guides and collections all render the same card, so they read the same columns
 * through the same SQL: {@link #COLUMNS} + {@link #LATERAL_JOINS} + {@link #card}. Duplicating that
 * select is how two surfaces end up disagreeing about what "4.6 · 213 reviews" meant.
 *
 * <p>Three rules the shape of this projection encodes:
 * <ul>
 *   <li><b>§19</b> — a rendered number carries its fact. {@code price} and {@code rating} are read
 *       alongside the {@code facts} rows that back them ({@code price_fact_id} / {@code rating_fact_id}),
 *       and a merchant with zero reviews has no rating at all rather than a {@code 0.00} one.</li>
 *   <li><b>§5 / AGENT_CONTRACT</b> — the open/closed state is <em>computed</em> from
 *       {@code business_hours} against the instant the read was made, and the card says which instant
 *       ({@code open.as_of}). Nothing here stores or guesses an opening state.</li>
 *   <li><b>§66</b> — the projection has no placement input. {@code flags.sponsored} is a literal
 *       {@code false} because this query reads no campaign, coupon, plan or spend column at all, so no
 *       paid slot can appear through it.</li>
 * </ul>
 */
@Component
public class MerchantCards {

    /**
     * The merchant attributes {@link #COLUMNS} joins a lateral for, in card order. A name with no
     * lateral on a given row simply yields no fact — {@link #factsOf} never pads the array.
     */
    public static final List<String> MERCHANT_FACT_ATTRIBUTES = List.of("price", "rating", "opening_hours");

    /**
     * "Open right now", computed from {@code business_hours} against the caller-supplied instant.
     * {@code weekday} is 0=Mon..6=Sun per the column comment, and a row that crosses midnight is open
     * on either side of it. Requires the {@code as_of}, {@code tz} and {@code now_time} parameters.
     */
    public static final String OPEN_NOW = String.join("\n",
            "  exists (select 1 from business_hours bh",
            "           where bh.merchant_id = m.id",
            "             and bh.weekday = (extract(isodow from (:as_of::timestamptz at time zone :tz::text)) - 1)::smallint",
            "             and ((bh.crosses_midnight = false and :now_time >= bh.opens_at",
            "                               and :now_time <  bh.closes_at)",
            "               or (bh.crosses_midnight = true  and (:now_time >= bh.opens_at",
            "                                              or :now_time <  bh.closes_at))))");

    /** The per-merchant columns a card is built from — every one of them a real column or the open-state computation. */
    public static final String COLUMNS = String.join("\n",
            "       m.id, m.slug, m.display_name, m.display_name_zh, m.category_primary, m.description, m.tags,",
            "       m.avg_price_hkd, m.rating_agg, m.review_count, m.data_origin, m.ownership_verified,",
            "       m.updated_at, m.images,",
            "       loc.district, loc.city,",
            OPEN_NOW + " as is_open,",
            "       pf.id as price_fact_id, pf.value as price_fact_value, pf.source as price_fact_source,",
            "       pf.confidence as price_fact_confidence, pf.observed_at as price_fact_observed_at,",
            "       pf.expires_at as price_fact_expires_at, pf.stale as price_fact_stale,",
            "       rf.id as rating_fact_id, rf.value as rating_fact_value, rf.source as rating_fact_source,",
            "       rf.confidence as rating_fact_confidence, rf.observed_at as rating_fact_observed_at,",
            "       rf.expires_at as rating_fact_expires_at, rf.stale as rating_fact_stale",
            // D25: the hours claim as a §2 Fact. `open` is computed from `business_hours` below, and the
            // fact is that same statement in provenanced form — without it the badge has nothing to cite.
            "       ,hf.id as opening_hours_fact_id, hf.value as opening_hours_fact_value,",
            "       hf.source as opening_hours_fact_source, hf.confidence as opening_hours_fact_confidence,",
            "       hf.observed_at as opening_hours_fact_observed_at, hf.expires_at as opening_hours_fact_expires_at,",
            "       hf.stale as opening_hours_fact_stale");

    /**
     * The laterals behind {@link #COLUMNS}. {@code m} must already be in the FROM clause; the joins are
     * LEFT so a merchant without a location, an image or a fact still renders (with those fields null).
     */
    public static final String LATERAL_JOINS = String.join("\n",
            "left join lateral (",
            "       select l.district, l.city from locations l",
            "       where l.merchant_id = m.id and l.tenant_id = m.tenant_id",
            "       order by l.is_primary desc, l.created_at limit 1",
            "     ) loc on true",
            "left join lateral (",
            "       select f.id, f.value, f.source, f.confidence, f.observed_at, f.expires_at, f.stale",
            "       from facts f",
            "       where f.merchant_id = m.id and f.subject_type = 'merchant' and f.subject_id = m.id",
            "         and f.attribute = 'price'",
            "       order by f.observed_at desc limit 1",
            "     ) pf on true",
            "left join lateral (",
            "       select f.id, f.value, f.source, f.confidence, f.observed_at, f.expires_at, f.stale",
            "       from facts f",
            "       where f.merchant_id = m.id and f.subject_type = 'merchant' and f.subject_id = m.id",
            "         and f.attribute = 'rating'",
            "       order by f.observed_at desc limit 1",
            "     ) rf on true",
            "left join lateral (",
            "       select f.id, f.value, f.source, f.confidence, f.observed_at, f.expires_at, f.stale",
            "       from facts f",
            "       where f.merchant_id = m.id and f.subject_type = 'merchant' and f.subject_id = m.id",
            "         and f.attribute = 'opening_hours'",
            "       order by f.observed_at desc limit 1",
            "     ) hf on true");

    private final TenantJdbc jdbc;

    public MerchantCards(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- reads -----------------------------------------------------------

    /**
     * Cards for a set of merchant ids, in the order the caller asked for them. A guide or collection
     * lists its own order (API_CONTRACT §8: an ordered jsonb array), so the order is restored in Java
     * rather than left to the database. Ids that resolve to no published merchant simply do not appear
     * in the result — the caller drops them from the list, and this method never pads a payload with a
     * placeholder row (§8 "unresolvable ids drop the item, they never render a placeholder card").
     */
    public List<Map<String, Object>> rowsByIds(TenantContext tenant, List<UUID> ids, Instant asOf) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        List<Map<String, Object>> rows = jdbc.forTenant(tenant, String.join("\n",
                "select " + COLUMNS,
                "from merchants m",
                LATERAL_JOINS,
                "where m.tenant_id = :tenant_id and m.status = 'published' and m.id in (:ids)"),
                cardParams(asOf, tenant.timezone(), ids));
        Map<UUID, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Map<String, Object> row : rows) {
            UUID id = Json.uuid(row, "id");
            if (id != null) {
                byId.put(id, row);
            }
        }
        List<Map<String, Object>> ordered = new ArrayList<>();
        for (UUID id : ids) {
            Map<String, Object> row = byId.get(id);
            if (row != null) {
                ordered.add(row);
            }
        }
        return ordered;
    }

    /** The same rows as {@link #rowsByIds}, already turned into cards. */
    public List<Map<String, Object>> cardsByIds(TenantContext tenant, List<UUID> ids, Instant asOf) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : rowsByIds(tenant, ids, asOf)) {
            out.add(card(row, tenant.currency(), asOf));
        }
        return out;
    }

    /** The three parameters {@link #OPEN_NOW} needs; callers merge these into their own map. */
    public static Map<String, Object> openStateParams(Instant asOf, String timezone) {
        return Json.map("as_of", Timestamp.from(asOf),
                "now_time", localTimeOf(asOf, timezone),
                "tz", timezone == null || timezone.isBlank() ? "UTC" : timezone);
    }

    private static Map<String, Object> cardParams(Instant asOf, String timezone, List<UUID> ids) {
        Map<String, Object> params = new LinkedHashMap<>(openStateParams(asOf, timezone));
        params.put("ids", ids);
        return params;
    }

    // ---- the projection --------------------------------------------------

    /**
     * One row of {@link #COLUMNS} → the §2 card. {@code asOf} is the instant the open state was computed
     * against, and travels with it, because "open" without a timestamp is a claim about a moment nobody
     * observed.
     */
    public static Map<String, Object> card(Map<String, Object> row, String currency, Instant asOf) {
        UUID merchantId = Json.uuid(row, "id");
        BigDecimal price = Json.dec(row, "avg_price_hkd");
        List<Map<String, Object>> facts = factsOf(row);
        boolean demo = DemoFlags.isDemo(Json.str(row, "data_origin"));
        Map<String, Object> card = new LinkedHashMap<>();
        card.put("card_type", "merchant");
        card.put("id", merchantId == null ? null : merchantId.toString());
        card.put("slug", Json.str(row, "slug"));
        card.put("title", Json.str(row, "display_name"));
        card.put("subtitle", subtitleOf(row));
        card.put("description", Json.str(row, "description"));
        card.put("image", imageOf(row));
        card.put("price", price == null ? null : Json.map("amount",
                price.setScale(2, RoundingMode.HALF_UP).toPlainString(), "currency", currency,
                "model", "per_person"));
        card.put("rating", rating(Json.dec(row, "rating_agg"), Json.integer(row, "review_count")));
        // AGENT_CONTRACT §5: a computed state, stamped with the instant it was computed against. The
        // text is the view's job (it is localised copy), so it is not emitted here. It cites the
        // merchant's hours fact because that fact and these rows are the same statement — which is
        // also why `MerchantService.addHours` records the whole week rather than the interval it was
        // given (D25). An edit that left the fact behind expires it out of its own TTL, and the view
        // then stops presenting the state as current rather than citing a claim nobody made.
        card.put("open", Json.map("is_open", Boolean.TRUE.equals(Json.bool(row, "is_open")),
                "as_of", asOf == null ? null : asOf.toString(),
                "source_fact_id", Json.str(row, "opening_hours_fact_id")));
        card.put("facts", facts);
        // §66: this projection reads no placement field at all, so "sponsored" is a fact about the
        // query rather than a default — no paid slot can appear through a card built here.
        card.put("flags", Json.map("sponsored", false, "demo", demo,
                "unverified", Boolean.FALSE.equals(Json.bool(row, "ownership_verified"))));
        return card;
    }

    /**
     * A merchant with zero reviews has no rating; showing {@code 0.00} would be a claim the data never
     * made (§19), so the field is null and the card renders without one.
     */
    public static Map<String, Object> rating(BigDecimal value, Integer count) {
        if (value == null || count == null || count == 0) {
            return null;
        }
        return Json.map("value", value, "count", count);
    }

    /** The price, rating and hours facts attached to one merchant row, in the §2 {@code Fact} shape. */
    public static List<Map<String, Object>> factsOf(Map<String, Object> row) {
        return factsOf(row, "merchant", MERCHANT_FACT_ATTRIBUTES);
    }

    /**
     * The {@code <attribute>_fact_*} columns a query joined in, rebuilt as §2 {@code Fact} objects.
     * A row that joined no lateral for an attribute contributes no fact for it — the array is never
     * padded with a placeholder, because an unbacked "fact" is the §19 failure this shape exists to
     * prevent. The subject columns are derived, not selected: each lateral joins on
     * {@code f.subject_id = <the row's own id>}, so a fact's subject can only ever be the row that
     * carries it.
     */
    public static List<Map<String, Object>> factsOf(Map<String, Object> row, String subjectType,
                                                   List<String> attributes) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String attribute : attributes) {
            String id = Json.str(row, attribute + "_fact_id");
            if (id == null) {
                continue;
            }
            Map<String, Object> fact = new LinkedHashMap<>();
            fact.put("fact_id", id);
            fact.put("subject_type", subjectType);
            fact.put("subject_id", Json.str(row, "id"));
            fact.put("attribute", attribute);
            fact.put("value", Json.json(row, attribute + "_fact_value"));
            fact.put("source", Json.str(row, attribute + "_fact_source"));
            fact.put("confidence", Json.dec(row, attribute + "_fact_confidence"));
            fact.put("observed_at", Json.ts(row, attribute + "_fact_observed_at"));
            fact.put("expires_at", Json.ts(row, attribute + "_fact_expires_at"));
            fact.put("stale", Json.bool(row, attribute + "_fact_stale"));
            out.add(fact);
        }
        return out;
    }

    /** `district` + `category_primary`, both columns; null when the row genuinely has neither. */
    public static String subtitleOf(Map<String, Object> row) {
        String category = blankToNull(Json.str(row, "category_primary"));
        String district = blankToNull(Json.str(row, "district"));
        if (category == null) {
            return district;
        }
        return district == null ? category : category + " · " + district;
    }

    /** The first image of {@code merchants.images}, with its own credit — or null. */
    public static Map<String, Object> imageOf(Map<String, Object> row) {
        Object first = Json.jsonArray(row, "images").stream().findFirst().orElse(null);
        if (!(first instanceof Map<?, ?> map)) {
            return null;
        }
        String url = map.get("url") == null ? null : String.valueOf(map.get("url"));
        if (url == null || url.isBlank()) {
            return null;
        }
        // Credit falls back to the row's own origin so a seeded image cannot read as a real photograph.
        String credit = map.get("credit") == null ? "synthetic" : String.valueOf(map.get("credit"));
        String alt = map.get("alt") == null ? null : String.valueOf(map.get("alt"));
        return Json.map("url", url, "alt", alt, "credit", credit);
    }

    /**
     * The first slug-shaped tag: the same column the §29 route grammar is built from, so a listing's
     * {@code subcategory} and the aisle it appears under cannot disagree.
     */
    public static String firstTag(List<String> tags) {
        for (String value : tags) {
            if (value != null && value.matches("^[a-z0-9][a-z0-9_-]{0,63}$")) {
                return value;
            }
        }
        return null;
    }

    /** Opening hours are wall-clock facts about the market, so the comparison is made in the tenant's own clock. */
    public static LocalTime localTimeOf(Instant asOf, String timezone) {
        try {
            return asOf.atZone(ZoneId.of(timezone == null || timezone.isBlank() ? "UTC" : timezone))
                    .toLocalTime().withNano(0);
        } catch (Exception e) {
            throw ApiException.internal("Unknown tenant timezone " + timezone, e);
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
