package com.nexus.analytics;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/** Read-only analytics queries. Nothing here writes, and nothing here invents a number. */
@Repository
public class AnalyticsRepository {

    private final TenantJdbc jdbc;

    public AnalyticsRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * The funnel projection the merchant overview is required to use (STATUS.md ruling D15).
     *
     * <p>The <em>counts</em> come straight from {@code v_merchant_funnel}. Its {@code revenue} column
     * does not, and cannot: the view left-joins events, reservations and orders in one statement, so
     * {@code sum(o.total)} is multiplied by the event × reservation fan-out (a merchant with 6 tracked
     * events and one HK$480 order reports 2,880 — measured, not theorised). Revenue is therefore
     * re-aggregated from {@code orders} with the same status filter the view uses, and the endpoint
     * labels the definition in the payload instead of hiding it. Fixing the view itself belongs to the
     * shared migration stream; see "not finished" in {@code services/platform/README.md}.
     */
    public Map<String, Object> merchantFunnel(TenantContext tenant, UUID merchantId) {
        return jdbc.firstForTenant(tenant, """
                select v.merchant_id, v.views, v.clicks, v.actions, v.reservations, v.orders,
                       (select coalesce(sum(o.total), 0) from orders o
                         where o.merchant_id = v.merchant_id and o.tenant_id = :tenant_id
                           and o.status not in ('cancelled', 'refunded'))        as revenue,
                       (select min(o.currency) from orders o
                         where o.merchant_id = v.merchant_id and o.tenant_id = :tenant_id
                           and o.status not in ('cancelled', 'refunded'))       as currency
                from v_merchant_funnel v
                where v.tenant_id = :tenant_id and v.merchant_id = :merchant_id
                """, Json.map("merchant_id", merchantId)).orElse(null);
    }

    /** Identity + honesty columns for the same screen. */
    public Map<String, Object> merchantProfile(TenantContext tenant, UUID merchantId) {
        return jdbc.firstForTenant(tenant, """
                select m.id, m.slug, m.display_name, m.display_name_zh, m.status, m.data_origin, m.plan,
                       m.rating_agg, m.review_count, m.category_primary, m.tenant_id,
                       (select count(*) from locations l where l.merchant_id = m.id and l.tenant_id = :tenant_id)
                           as location_count
                from merchants m
                where m.id = :merchant_id and m.tenant_id = :tenant_id
                """, Json.map("merchant_id", merchantId)).orElse(null);
    }

    /**
     * Grid-clustered markers for the map (spec §38). The bounding box is an indexable range scan on
     * {@code locations(lat,lng)}; distance is the haversine expression below, evaluated in SQL against
     * the caller-supplied centre — the bbox+haversine design fixed by DECISIONS D3 (no PostGIS in this
     * image). Only published merchants appear: an unreleased listing must not surface on a public map.
     *
     * <p>{@code :cell} is the cluster size in degrees, derived from {@code zoom} by the service and
     * bound as a number; every other client value is a bound parameter too, so no SQL is concatenated.
     */
    public List<Map<String, Object>> clusteredMarkers(TenantContext tenant, double cell, double latMin,
                                                      double latMax, double lngMin, double lngMax,
                                                      double centerLat, double centerLng, int limit) {
        String sql = """
                with clustered as (
                  select round(cast(l.lat / :cell as numeric)) * :cell as clat,
                         round(cast(l.lng / :cell as numeric)) * :cell as clng,
                         count(*)                          as location_count,
                         count(distinct l.merchant_id)     as merchant_count,
                         array_agg(distinct l.merchant_id::text order by l.merchant_id::text) as merchant_ids,
                         min(l.district)                   as district,
                         min(m.slug)                       as sample_slug,
                         min(m.display_name)               as sample_name
                  from locations l
                  join merchants m on m.id = l.merchant_id
                  where l.tenant_id = :tenant_id
                    and l.lat between :lat_min and :lat_max
                    and l.lng between :lng_min and :lng_max
                    and m.status = 'published'
                  group by 1, 2
                )
                select c.clat, c.clng, c.location_count, c.merchant_count, c.merchant_ids, c.district,
                       c.sample_slug, c.sample_name,
                       2 * 6371000 * asin(least(1.0, sqrt(
                           power(sin(radians((:center_lat - c.clat) / 2)), 2)
                           + cos(radians(:center_lat)) * cos(radians(c.clat))
                             * power(sin(radians((:center_lng - c.clng) / 2)), 2)
                       ))) as distance_m
                from clustered c
                order by distance_m asc, c.clat asc, c.clng asc
                limit :limit
                """;
        return jdbc.forTenant(tenant, sql, Json.map("cell", cell, "lat_min", latMin, "lat_max", latMax,
                "lng_min", lngMin, "lng_max", lngMax, "center_lat", centerLat, "center_lng", centerLng,
                "limit", limit));
    }

    /** Raw points behind the clusters, so the client can drill in without a second request shape. */
    public long countLocationsInBbox(TenantContext tenant, double latMin, double latMax, double lngMin,
                                     double lngMax) {
        return jdbc.countForTenant(tenant, """
                select count(*)
                from locations l join merchants m on m.id = l.merchant_id
                where l.tenant_id = :tenant_id
                  and l.lat between :lat_min and :lat_max
                  and l.lng between :lng_min and :lng_max
                  and m.status = 'published'
                """, Json.map("lat_min", latMin, "lat_max", latMax, "lng_min", lngMin, "lng_max", lngMax));
    }
}
