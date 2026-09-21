package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/** Merchants, locations, business hours and membership. All tenant-predicated. */
@Repository
public class MerchantRepository {

    public static final String COLUMNS = """
            m.id, m.tenant_id, m.slug, m.legal_name, m.display_name, m.display_name_zh, m.description,
            m.category_primary, m.status, m.ownership_verified, m.data_origin, m.contact, m.socials,
            m.avg_price_hkd, m.price_band, m.rating_agg, m.review_count, m.popularity_score, m.tags,
            m.attributes, m.images, m.seo, m.ai_agent_enabled, m.plan, m.created_at, m.updated_at
            """;

    private final TenantJdbc jdbc;

    public MerchantRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- merchants ------------------------------------------------------

    public Optional<Map<String, Object>> find(TenantContext tenant, UUID id) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + " from merchants m "
                + "where m.id = :id and m.tenant_id = :tenant_id", Json.map("id", id));
    }

    public Optional<Map<String, Object>> findBySlug(TenantContext tenant, String slug) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + " from merchants m "
                + "where m.slug = :slug and m.tenant_id = :tenant_id", Json.map("slug", slug));
    }

    public Map<String, Object> require(TenantContext tenant, UUID id) {
        return find(tenant, id).orElseThrow(() -> ApiException.notFound("merchant_not_found", "No such merchant"));
    }

    public boolean slugTaken(TenantContext tenant, String slug) {
        return !jdbc.forTenant(tenant, "select m.id from merchants m where m.slug = :slug and m.tenant_id = :tenant_id",
                Json.map("slug", slug)).isEmpty();
    }

    public UUID insert(TenantContext tenant, Map<String, Object> f) {
        Map<String, Object> row = jdbc.insertForTenant(tenant, """
                insert into merchants (tenant_id, slug, legal_name, display_name, display_name_zh, description,
                                       category_primary, status, data_origin, contact, socials, avg_price_hkd,
                                       price_band, tags, attributes, images, seo, plan)
                values (:tenant_id, :slug, :legal_name, :display_name, cast(:display_name_zh as text),
                        cast(:description as text), cast(:category_primary as text), :status, :data_origin,
                        cast(:contact as jsonb), cast(:socials as jsonb), cast(:avg_price_hkd as numeric),
                        cast(:price_band as text), string_to_array(:tags, ','), cast(:attributes as jsonb),
                        cast(:images as jsonb), cast(:seo as jsonb), :plan)
                returning id
                """, Json.map("slug", f.get("slug"), "legal_name", f.get("legal_name"),
                "display_name", f.get("display_name"), "display_name_zh", f.get("display_name_zh"),
                "description", f.get("description"), "category_primary", f.get("category_primary"),
                "status", f.getOrDefault("status", "draft"), "data_origin", f.getOrDefault("data_origin", "merchant"),
                "contact", jsonOr(f.get("contact"), "{}"), "socials", jsonOr(f.get("socials"), "{}"),
                "avg_price_hkd", f.get("avg_price_hkd"), "price_band", f.get("price_band"),
                "tags", Json.csv(strings(f.get("tags"))), "attributes", jsonOr(f.get("attributes"), "{}"),
                "images", jsonOr(f.get("images"), "[]"), "seo", jsonOr(f.get("seo"), "{}"),
                "plan", f.getOrDefault("plan", "free")));
        return Json.uuid(row, "id");
    }

    public int updateProfile(TenantContext tenant, UUID id, Map<String, Object> f) {
        return jdbc.updateForTenant(tenant, """
                update merchants m
                set legal_name = coalesce(cast(:legal_name as text), legal_name),
                    display_name = coalesce(cast(:display_name as text), display_name),
                    display_name_zh = coalesce(cast(:display_name_zh as text), display_name_zh),
                    description = coalesce(cast(:description as text), description),
                    category_primary = coalesce(cast(:category_primary as text), category_primary),
                    contact = coalesce(cast(:contact as jsonb), contact),
                    socials = coalesce(cast(:socials as jsonb), socials),
                    avg_price_hkd = coalesce(cast(:avg_price_hkd as numeric), avg_price_hkd),
                    price_band = coalesce(cast(:price_band as text), price_band),
                    tags = case when cast(:tags_provided as boolean) is true then string_to_array(:tags, ',') else tags end,
                    attributes = coalesce(cast(:attributes as jsonb), attributes),
                    images = coalesce(cast(:images as jsonb), images),
                    seo = coalesce(cast(:seo as jsonb), seo),
                    updated_at = now()
                where m.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", id, "legal_name", f.get("legal_name"), "display_name", f.get("display_name"),
                "display_name_zh", f.get("display_name_zh"), "description", f.get("description"),
                "category_primary", f.get("category_primary"),
                "contact", jsonOrNull(f.get("contact")), "socials", jsonOrNull(f.get("socials")),
                "avg_price_hkd", f.get("avg_price_hkd"), "price_band", f.get("price_band"),
                "tags", Json.csv(strings(f.get("tags"))),
                "tags_provided", f.containsKey("tags"),
                "attributes", jsonOrNull(f.get("attributes")), "images", jsonOrNull(f.get("images")),
                "seo", jsonOrNull(f.get("seo"))));
    }

    public int setStatus(TenantContext tenant, UUID id, String status, boolean ownershipVerified) {
        return jdbc.updateForTenant(tenant, """
                update merchants m set status = :status, ownership_verified = :ownership_verified, updated_at = now()
                where m.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", id, "status", status, "ownership_verified", ownershipVerified));
    }

    public int setAiAgentEnabled(TenantContext tenant, UUID id, boolean enabled) {
        return jdbc.updateForTenant(tenant, """
                update merchants m set ai_agent_enabled = :enabled, updated_at = now()
                where m.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", id, "enabled", enabled));
    }

    public List<Map<String, Object>> list(TenantContext tenant, List<String> statuses, int limit, int offset,
                                          String orderBy) {
        StringBuilder sql = new StringBuilder("select " + COLUMNS + " from merchants m "
                + "where m.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("limit", limit);
        params.put("offset", offset);
        if (statuses != null && !statuses.isEmpty()) {
            sql.append(" and m.status = any(string_to_array(:statuses, ','))");
            params.put("statuses", Json.csv(statuses));
        }
        sql.append(" order by " + orderBy + " limit :limit offset :offset");
        return jdbc.forTenant(tenant, sql.toString(), params);
    }

    // ---- locations + hours ---------------------------------------------

    public List<Map<String, Object>> locations(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, """
                select l.id, l.merchant_id, l.label, l.address_line1, l.address_line2, l.district, l.area, l.city,
                       l.postcode, l.lat, l.lng, l.mtr_station, l.mtr_walk_min, l.is_primary, l.geo_properties,
                       l.created_at, l.tenant_id
                from locations l where l.merchant_id = :merchant_id and l.tenant_id = :tenant_id
                order by l.is_primary desc, l.created_at
                """, Json.map("merchant_id", merchantId));
    }

    public UUID insertLocation(TenantContext tenant, UUID merchantId, Map<String, Object> f) {
        Map<String, Object> row = jdbc.insertForTenant(tenant, """
                insert into locations (merchant_id, tenant_id, label, address_line1, address_line2, district, area,
                                       city, postcode, lat, lng, mtr_station, mtr_walk_min, is_primary, geo_properties)
                values (:merchant_id, :tenant_id, cast(:label as text), :address_line1, cast(:address_line2 as text),
                        cast(:district as text), cast(:area as text), :city, cast(:postcode as text),
                        cast(:lat as numeric), cast(:lng as numeric), cast(:mtr_station as text),
                        cast(:mtr_walk_min as integer), :is_primary, cast(:geo_properties as jsonb))
                returning id
                """, Json.map("merchant_id", merchantId, "label", f.get("label"),
                "address_line1", f.get("address_line1"), "address_line2", f.get("address_line2"),
                "district", f.get("district"), "area", f.get("area"), "city", f.get("city"),
                "postcode", f.get("postcode"), "lat", f.get("lat"), "lng", f.get("lng"),
                "mtr_station", f.get("mtr_station"), "mtr_walk_min", f.get("mtr_walk_min"),
                "is_primary", f.getOrDefault("is_primary", true),
                "geo_properties", jsonOr(f.get("geo_properties"), "{}")));
        return Json.uuid(row, "id");
    }

    public List<Map<String, Object>> businessHours(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, """
                select bh.id, bh.merchant_id, bh.location_id, bh.weekday, bh.opens_at, bh.closes_at,
                       bh.crosses_midnight, bh.source, bh.updated_at, m.tenant_id
                from business_hours bh join merchants m on m.id = bh.merchant_id
                where bh.merchant_id = :merchant_id and m.tenant_id = :tenant_id
                order by bh.weekday, bh.opens_at
                """, Json.map("merchant_id", merchantId));
    }

    public int upsertBusinessHours(TenantContext tenant, UUID merchantId, UUID locationId, int weekday,
                                   String opensAt, String closesAt, boolean crossesMidnight) {
        // business_hours has no tenant column: verified merchant anchor above + merchant join predicate here.
        return jdbc.updateForTenant(tenant, """
                insert into business_hours (merchant_id, location_id, weekday, opens_at, closes_at, crosses_midnight)
                select b.merchant_id, cast(:location_id as uuid), :weekday, cast(:opens_at as time),
                       cast(:closes_at as time), :crosses_midnight
                from (select m.id as merchant_id from merchants m
                      where m.id = :merchant_id and m.tenant_id = :tenant_id) b
                on conflict (merchant_id, location_id, weekday, opens_at) do update
                  set closes_at = excluded.closes_at, crosses_midnight = excluded.crosses_midnight,
                      source = 'merchant', updated_at = now()
                """, Json.map("merchant_id", merchantId, "location_id", locationId, "weekday", weekday,
                "opens_at", opensAt, "closes_at", closesAt, "crosses_midnight", crossesMidnight));
    }

    // ---- membership -----------------------------------------------------

    public Optional<Map<String, Object>> membership(TenantContext tenant, UUID merchantId, UUID userId) {
        return jdbc.firstForTenant(tenant, """
                select mu.id, mu.merchant_id, mu.user_id, mu.role, mu.status, mu.created_at, m.tenant_id
                from merchant_users mu join merchants m on m.id = mu.merchant_id
                where mu.merchant_id = :merchant_id and mu.user_id = :user_id and m.tenant_id = :tenant_id
                """, Json.map("merchant_id", merchantId, "user_id", userId));
    }

    public UUID addMember(TenantContext tenant, UUID merchantId, UUID userId, String role) {
        // merchant_users has no tenant column; the merchant row is verified by the caller's grant check.
        Map<String, Object> row = jdbc.crossTenantReturning("""
                insert into merchant_users (merchant_id, user_id, role, status)
                select m.id, :user_id, :role, 'active'
                from merchants m where m.id = :merchant_id and m.tenant_id = :tenant_id
                on conflict (merchant_id, user_id) do update set role = excluded.role
                returning id
                """, Json.map("user_id", userId, "role", role, "merchant_id", merchantId,
                "tenant_id", tenant.tenantId()));
        return Json.uuid(row, "id");
    }

    public int updateMember(TenantContext tenant, UUID memberId, String role, String status) {
        return jdbc.updateForTenant(tenant, """
                update merchant_users mu set role = coalesce(cast(:role as text), role),
                                               status = coalesce(cast(:status as text), status)
                from merchants m
                where mu.id = :id and m.id = mu.merchant_id and m.tenant_id = :tenant_id
                """, Json.map("id", memberId, "role", role, "status", status));
    }

    public int removeMember(TenantContext tenant, UUID memberId) {
        return jdbc.updateForTenant(tenant, """
                delete from merchant_users mu using merchants m
                where mu.id = :id and m.id = mu.merchant_id and m.tenant_id = :tenant_id
                """, Json.map("id", memberId));
    }

    public List<Map<String, Object>> members(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, """
                select mu.id, mu.role, mu.status, mu.created_at, u.id as user_id, u.display_name, u.email,
                       u.avatar_url, m.tenant_id
                from merchant_users mu join merchants m on m.id = mu.merchant_id
                join users u on u.id = mu.user_id
                where mu.merchant_id = :merchant_id and m.tenant_id = :tenant_id
                order by mu.created_at
                """, Json.map("merchant_id", merchantId));
    }

    public List<UUID> merchantIdsForUser(TenantContext tenant, UUID userId) {
        return jdbc.forTenant(tenant, """
                select mu.merchant_id as merchant_id from merchant_users mu join merchants m on m.id = mu.merchant_id
                where mu.user_id = :user_id and m.tenant_id = :tenant_id and mu.status = 'active'
                """, Json.map("user_id", userId)).stream()
                .map(r -> Json.uuid(r, "merchant_id")).toList();
    }

    // ---- views ----------------------------------------------------------

    public static Map<String, Object> view(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", Json.str(row, "id"));
        out.put("slug", Json.str(row, "slug"));
        out.put("legal_name", Json.str(row, "legal_name"));
        out.put("display_name", Json.str(row, "display_name"));
        out.put("display_name_zh", Json.str(row, "display_name_zh"));
        out.put("description", Json.str(row, "description"));
        out.put("category_primary", Json.str(row, "category_primary"));
        out.put("status", Json.str(row, "status"));
        out.put("ownership_verified", Json.bool(row, "ownership_verified"));
        out.put("data_origin", Json.str(row, "data_origin"));
        out.put("contact", Json.jsonObject(row, "contact"));
        out.put("socials", Json.jsonObject(row, "socials"));
        out.put("price", Json.map("average", Json.dec(row, "avg_price_hkd"), "band", Json.str(row, "price_band"),
                "currency", "HKD"));
        out.put("rating", Json.map("value", Json.dec(row, "rating_agg"), "count", Json.integer(row, "review_count")));
        out.put("tags", Json.textArray(row, "tags"));
        out.put("attributes", Json.jsonObject(row, "attributes"));
        out.put("images", Json.jsonArray(row, "images"));
        out.put("seo", Json.jsonObject(row, "seo"));
        out.put("ai_agent_enabled", Json.bool(row, "ai_agent_enabled"));
        out.put("plan", Json.str(row, "plan"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        out.put("flags", Json.map("demo", com.nexus.platform.DemoFlags.isDemo(Json.str(row, "data_origin")),
                "unverified", !Boolean.TRUE.equals(Json.bool(row, "ownership_verified")),
                "sponsored", false));
        return out;
    }

    public static Map<String, Object> locationView(Map<String, Object> row) {
        return Json.map("location_id", Json.str(row, "id"), "label", Json.str(row, "label"),
                "address_line1", Json.str(row, "address_line1"), "address_line2", Json.str(row, "address_line2"),
                "district", Json.str(row, "district"), "area", Json.str(row, "area"), "city", Json.str(row, "city"),
                "postcode", Json.str(row, "postcode"),
                "geo", Json.map("lat", Json.dec(row, "lat"), "lng", Json.dec(row, "lng")),
                "mtr", Json.map("station", Json.str(row, "mtr_station"), "walk_minutes",
                        Json.integer(row, "mtr_walk_min")),
                "is_primary", Json.bool(row, "is_primary"), "geo_properties", Json.json(row, "geo_properties"));
    }

    private static String jsonOr(Object value, String whenNull) {
        return value == null ? whenNull : (value instanceof String s ? s : Json.write(value));
    }

    private static String jsonOrNull(Object value) {
        return value == null ? null : (value instanceof String s ? s : Json.write(value));
    }

    private static List<String> strings(Object value) {
        if (value == null) {
            return List.of();
        }
        if (value instanceof List<?> list) {
            return list.stream().map(String::valueOf).toList();
        }
        if (value instanceof String s) {
            return s.isBlank() ? List.of() : List.of(s.split(","));
        }
        return List.of(String.valueOf(value));
    }
}
