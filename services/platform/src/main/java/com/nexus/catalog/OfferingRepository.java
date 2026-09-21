package com.nexus.catalog;

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

/**
 * Offerings = the shared catalogue shape for products, services and experiences, which is what lets a
 * single universal cart hold all three (§41). Tenant-owned via {@code offerings.tenant_id}.
 */
@Repository
public class OfferingRepository {

    private static final String COLUMNS = """
            o.id, o.merchant_id, o.tenant_id, o.kind, o.slug, o.name, o.name_zh, o.description, o.description_zh,
            o.price_amount, o.currency, o.price_model, o.price_min, o.price_max, o.price_source, o.price_updated_at,
            o.stock_quantity, o.stock_updated_at, o.bookable, o.min_party_size, o.max_party_size,
            o.duration_minutes, o.images, o.attributes, o.constraints, o.options, o.status, o.popularity_score,
            o.rating_agg, o.review_count, o.created_at, o.updated_at, m.slug as merchant_slug,
            m.display_name as merchant_name, m.data_origin as merchant_data_origin
            """;

    private final TenantJdbc jdbc;

    public OfferingRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Map<String, Object>> find(TenantContext tenant, UUID id) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + " from offerings o "
                + "join merchants m on m.id = o.merchant_id where o.id = :id and o.tenant_id = :tenant_id",
                Json.map("id", id));
    }

    public Map<String, Object> require(TenantContext tenant, UUID id) {
        return find(tenant, id).orElseThrow(() -> ApiException.notFound("offering_not_found", "No such offering"));
    }

    public Optional<Map<String, Object>> findBySlug(TenantContext tenant, UUID merchantId, String slug) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + " from offerings o "
                        + "join merchants m on m.id = o.merchant_id "
                        + "where o.merchant_id = :merchant_id and o.slug = :slug and o.tenant_id = :tenant_id",
                Json.map("merchant_id", merchantId, "slug", slug));
    }

    public List<Map<String, Object>> listByMerchant(TenantContext tenant, UUID merchantId, String status, String kind,
                                                    int limit, int offset) {
        StringBuilder sql = new StringBuilder("select " + COLUMNS + " from offerings o "
                + "join merchants m on m.id = o.merchant_id where o.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("tenant_id", tenant.tenantId());
        params.put("merchant_id", merchantId);
        sql.append(" and o.merchant_id = :merchant_id");
        if (status != null) {
            sql.append(" and o.status = :status");
            params.put("status", status);
        }
        if (kind != null) {
            sql.append(" and o.kind = :kind");
            params.put("kind", kind);
        }
        sql.append(" order by o.created_at desc, o.name asc limit :limit offset :offset");
        params.put("limit", limit);
        params.put("offset", offset);
        return jdbc.forTenant(tenant, sql.toString(), params);
    }

    public long countByMerchant(TenantContext tenant, UUID merchantId, String status, String kind) {
        StringBuilder sql = new StringBuilder("select count(*) from offerings o where o.tenant_id = :tenant_id "
                + "and o.merchant_id = :merchant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("tenant_id", tenant.tenantId());
        params.put("merchant_id", merchantId);
        if (status != null) {
            sql.append(" and o.status = :status");
            params.put("status", status);
        }
        if (kind != null) {
            sql.append(" and o.kind = :kind");
            params.put("kind", kind);
        }
        return jdbc.countForTenant(tenant, sql.toString(), params);
    }

    public UUID insert(TenantContext tenant, UUID merchantId, Map<String, Object> f) {
        Map<String, Object> row = jdbc.insertForTenant(tenant, """
                insert into offerings (merchant_id, tenant_id, kind, category_id, slug, name, name_zh, description,
                                       description_zh, price_amount, currency, price_model, price_min, price_max,
                                       price_source, stock_quantity, bookable, min_party_size, max_party_size,
                                       duration_minutes, images, attributes, constraints, options, status)
                values (:merchant_id, :tenant_id, :kind, cast(:category_id as uuid), :slug, :name,
                        cast(:name_zh as text), cast(:description as text), cast(:description_zh as text),
                        cast(:price_amount as numeric), :currency, :price_model, cast(:price_min as numeric),
                        cast(:price_max as numeric), :price_source, cast(:stock_quantity as integer), :bookable,
                        cast(:min_party_size as smallint), cast(:max_party_size as smallint),
                        cast(:duration_minutes as integer), cast(:images as jsonb), cast(:attributes as jsonb),
                        cast(:constraints as jsonb), cast(:options as jsonb), :status)
                returning id
                """, Json.map("merchant_id", merchantId,
                "kind", f.getOrDefault("kind", "product"),
                "category_id", f.get("category_id"),
                "slug", f.get("slug"), "name", f.get("name"), "name_zh", f.get("name_zh"),
                "description", f.get("description"), "description_zh", f.get("description_zh"),
                "price_amount", f.get("price_amount"), "currency", f.getOrDefault("currency", "HKD"),
                "price_model", f.getOrDefault("price_model", "fixed"),
                "price_min", f.get("price_min"), "price_max", f.get("price_max"),
                "price_source", f.getOrDefault("price_source", "merchant"),
                "stock_quantity", f.get("stock_quantity"),
                "bookable", f.getOrDefault("bookable", false),
                "min_party_size", f.get("min_party_size"), "max_party_size", f.get("max_party_size"),
                "duration_minutes", f.get("duration_minutes"),
                "images", json(f.get("images"), "[]"), "attributes", json(f.get("attributes"), "{}"),
                "constraints", json(f.get("constraints"), "{}"), "options", json(f.get("options"), "[]"),
                "status", f.getOrDefault("status", "active")));
        return Json.uuid(row, "id");
    }

    public int update(TenantContext tenant, UUID id, Map<String, Object> f) {
        return jdbc.updateForTenant(tenant, """
                update offerings o
                set name            = coalesce(cast(:name as text), name),
                    name_zh         = coalesce(cast(:name_zh as text), name_zh),
                    description     = coalesce(cast(:description as text), description),
                    description_zh  = coalesce(cast(:description_zh as text), description_zh),
                    price_amount    = coalesce(cast(:price_amount as numeric), price_amount),
                    price_model     = coalesce(cast(:price_model as text), price_model),
                    price_min       = coalesce(cast(:price_min as numeric), price_min),
                    price_max       = coalesce(cast(:price_max as numeric), price_max),
                    price_source    = coalesce(cast(:price_source as text), price_source),
                    price_updated_at = case when cast(:price_amount as numeric) is null then price_updated_at else now() end,
                    stock_quantity  = coalesce(cast(:stock_quantity as integer), stock_quantity),
                    stock_updated_at = case when cast(:stock_quantity as integer) is null
                                            then stock_updated_at else now() end,
                    bookable        = coalesce(cast(:bookable as boolean), bookable),
                    min_party_size  = coalesce(cast(:min_party_size as smallint), min_party_size),
                    max_party_size  = coalesce(cast(:max_party_size as smallint), max_party_size),
                    duration_minutes = coalesce(cast(:duration_minutes as integer), duration_minutes),
                    kind            = coalesce(cast(:kind as text), kind),
                    status          = coalesce(cast(:status as text), status),
                    images          = coalesce(cast(:images as jsonb), images),
                    attributes      = coalesce(cast(:attributes as jsonb), attributes),
                    constraints     = coalesce(cast(:constraints as jsonb), constraints),
                    options         = coalesce(cast(:options as jsonb), options),
                    updated_at      = now()
                where o.id = :id and o.tenant_id = :tenant_id
                """, Json.map("id", id,
                "name", f.get("name"), "name_zh", f.get("name_zh"),
                "description", f.get("description"), "description_zh", f.get("description_zh"),
                "price_amount", f.get("price_amount"), "price_model", f.get("price_model"),
                "price_min", f.get("price_min"), "price_max", f.get("price_max"),
                "price_source", f.get("price_source"), "stock_quantity", f.get("stock_quantity"),
                "bookable", f.get("bookable"), "min_party_size", f.get("min_party_size"),
                "max_party_size", f.get("max_party_size"), "duration_minutes", f.get("duration_minutes"),
                "kind", f.get("kind"), "status", f.get("status"),
                "images", jsonOrNull(f.get("images")), "attributes", jsonOrNull(f.get("attributes")),
                "constraints", jsonOrNull(f.get("constraints")), "options", jsonOrNull(f.get("options"))));
    }

    public int archive(TenantContext tenant, UUID id) {
        return jdbc.updateForTenant(tenant, """
                update offerings set status = 'archived', updated_at = now()
                where id = :id and tenant_id = :tenant_id
                """, Json.map("id", id));
    }

    /** Active offerings of a merchant (consumer menu view). */
    public List<Map<String, Object>> activeForMerchant(TenantContext tenant, UUID merchantId, int limit, int offset,
                                                      String orderBy) {
        return jdbc.forTenant(tenant, "select " + COLUMNS + " from offerings o "
                + "join merchants m on m.id = o.merchant_id "
                + "where o.tenant_id = :tenant_id and o.merchant_id = :merchant_id and o.status = 'active' "
                + "order by " + orderBy + " limit :limit offset :offset",
                Json.map("merchant_id", merchantId, "limit", limit, "offset", offset));
    }

    public long countActive(TenantContext tenant, UUID merchantId) {
        return jdbc.countForTenant(tenant, """
                select count(*) from offerings o
                where o.tenant_id = :tenant_id and o.merchant_id = :merchant_id and o.status = 'active'
                """, Json.map("merchant_id", merchantId));
    }

    public static Map<String, Object> view(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("offering_id", Json.str(row, "id"));
        out.put("merchant_id", Json.str(row, "merchant_id"));
        out.put("kind", Json.str(row, "kind"));
        out.put("slug", Json.str(row, "slug"));
        out.put("name", Json.str(row, "name"));
        out.put("name_zh", Json.str(row, "name_zh"));
        out.put("description", Json.str(row, "description"));
        out.put("description_zh", Json.str(row, "description_zh"));
        out.put("price", Json.money(row, "price_amount", "currency"));
        out.put("currency", Json.str(row, "currency"));
        out.put("price_model", Json.str(row, "price_model"));
        out.put("price_min", Json.dec(row, "price_min"));
        out.put("price_max", Json.dec(row, "price_max"));
        out.put("price_source", Json.str(row, "price_source"));
        out.put("price_updated_at", Json.ts(row, "price_updated_at"));
        out.put("stock", Json.integer(row, "stock_quantity") == null ? null
                : Json.map("quantity", Json.integer(row, "stock_quantity"), "updated_at",
                        Json.ts(row, "stock_updated_at")));
        out.put("bookable", Json.bool(row, "bookable"));
        out.put("min_party_size", Json.integer(row, "min_party_size"));
        out.put("max_party_size", Json.integer(row, "max_party_size"));
        out.put("duration_minutes", Json.integer(row, "duration_minutes"));
        out.put("images", Json.jsonArray(row, "images"));
        out.put("attributes", Json.jsonObject(row, "attributes"));
        out.put("constraints", Json.jsonObject(row, "constraints"));
        out.put("options", Json.jsonArray(row, "options"));
        out.put("status", Json.str(row, "status"));
        out.put("rating", Json.map("value", Json.dec(row, "rating_agg"), "count", Json.integer(row, "review_count")));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        out.put("flags", Json.map("demo", com.nexus.platform.DemoFlags.isDemo(Json.str(row, "merchant_data_origin")),
                "estimated_price", "estimated".equals(Json.str(row, "price_source"))));
        return out;
    }

    private static String json(Object value, String whenNull) {
        return value == null ? whenNull : (value instanceof String s ? s : Json.write(value));
    }

    private static String jsonOrNull(Object value) {
        return value == null ? null : (value instanceof String s ? s : Json.write(value));
    }
}
