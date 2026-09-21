package com.nexus.analytics;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/locations/geo?bbox=&zoom=} — the marker-clustering payload for the map (spec §38,
 * API_CONTRACT §4). Public and cacheable like the other consumer reads; it exposes only published
 * merchants' aggregate positions, never consumer or contact data.
 *
 * <p>{@code bbox} is {@code minLng,minLat,maxLng,maxLat} (GeoJSON order) and is the only filter. The
 * cluster grid is derived from {@code zoom} ({@code 360 / 2^zoom} degrees, Web-Mercator convention);
 * if a zoom still produces more than {@value #MAX_MARKERS} cells the grid is coarsened until it fits,
 * so the cap is honoured by clustering rather than by silently dropping merchants.
 *
 * <p>Distance is haversine, computed in SQL (DECISIONS D3: bbox prefilter + haversine sort, no
 * PostGIS). There is no {@code haversine()} database function in the fixed V1 schema, so the
 * expression is a constant in {@link AnalyticsRepository} with bound parameters — nothing the client
 * sends reaches the SQL text.
 */
@RestController
public class GeoController {

    static final int MAX_MARKERS = 100;
    private static final double MAX_SPAN_DEGREES = 3.0;
    private static final int MAX_ZOOM = 22;

    private final AnalyticsRepository analytics;

    public GeoController(AnalyticsRepository analytics) {
        this.analytics = analytics;
    }

    @GetMapping("/api/v1/locations/geo")
    public Map<String, Object> geo(@RequestParam(required = false) String bbox,
                                   @RequestParam(required = false) String zoom,
                                   HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        double[] box = parseBbox(bbox);
        int z = parseZoom(zoom);
        double latMin = Math.min(box[1], box[3]);
        double latMax = Math.max(box[1], box[3]);
        double lngMin = Math.min(box[0], box[2]);
        double lngMax = Math.max(box[0], box[2]);
        double centerLat = (latMin + latMax) / 2;
        double centerLng = (lngMin + lngMax) / 2;

        long total = analytics.countLocationsInBbox(tenant, latMin, latMax, lngMin, lngMax);
        double cell = cellForZoom(z);
        List<Map<String, Object>> rows = analytics.clusteredMarkers(tenant, cell, latMin, latMax, lngMin, lngMax,
                centerLat, centerLng, MAX_MARKERS + 1);
        // Coarsen until the page fits the cap; a dense viewport answers with bigger cells, not truncation.
        int attempts = 0;
        while (rows.size() > MAX_MARKERS && attempts < 6) {
            cell *= 2;
            attempts++;
            rows = analytics.clusteredMarkers(tenant, cell, latMin, latMax, lngMin, lngMax, centerLat, centerLng,
                    MAX_MARKERS + 1);
        }
        boolean truncated = rows.size() > MAX_MARKERS;
        if (truncated) {
            rows = rows.subList(0, MAX_MARKERS);
        }

        List<Map<String, Object>> markers = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            markers.add(marker(row));
        }
        // A map viewport is stable for a couple of minutes; caching it is the whole point of clustering.
        response.setHeader(HttpHeaders.CACHE_CONTROL, "public, max-age=120, stale-while-revalidate=600");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("markers", markers);
        out.put("marker_count", markers.size());
        out.put("total_locations", total);
        out.put("bbox", List.of(lngMin, latMin, lngMax, latMax));
        out.put("zoom", z);
        out.put("effective_zoom", attempts == 0 ? z : Math.max(1, z - attempts));
        out.put("cluster_cell_degrees", cell);
        // "clustered" describes the payload, not the request: it is true when at least one marker stands
        // for more than one location. `effective_zoom` is where the cap forced the grid to be coarsened.
        out.put("clustered", markers.stream().anyMatch(m -> ((Number) m.get("count")).longValue() > 1));
        out.put("truncated", truncated);
        out.put("generated_at", java.time.OffsetDateTime.now().toInstant().toString());
        return out;
    }

    private static Map<String, Object> marker(Map<String, Object> row) {
        List<String> ids = Json.textArray(row, "merchant_ids");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lat", Json.dec(row, "clat"));
        out.put("lng", Json.dec(row, "clng"));
        out.put("count", Json.longOf(row, "location_count"));
        out.put("merchant_count", Json.longOf(row, "merchant_count"));
        out.put("merchant_ids", ids.size() > 50 ? ids.subList(0, 50) : ids);
        out.put("district", Json.str(row, "district"));
        out.put("sample_slug", ids.size() == 1 ? Json.str(row, "sample_slug") : null);
        out.put("sample_name", ids.size() == 1 ? Json.str(row, "sample_name") : null);
        out.put("distance_m", Json.dec(row, "distance_m") == null ? null
                : Json.dec(row, "distance_m").setScale(0, java.math.RoundingMode.HALF_UP));
        return out;
    }

    /** Degrees per cluster cell at a Web-Mercator zoom level. */
    static double cellForZoom(int zoom) {
        return 360.0 / Math.pow(2, zoom);
    }

    private static int parseZoom(String raw) {
        if (raw == null || raw.isBlank()) {
            return 12;
        }
        int z;
        try {
            z = Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation("zoom must be an integer", Json.map("field", "zoom"));
        }
        if (z < 1 || z > MAX_ZOOM) {
            throw ApiException.validation("zoom must be between 1 and " + MAX_ZOOM,
                    Json.map("field", "zoom", "min", 1, "max", MAX_ZOOM));
        }
        return z;
    }

    /** Four finite numbers in GeoJSON order, within range, and no wider than {@value #MAX_SPAN_DEGREES}°. */
    static double[] parseBbox(String raw) {
        if (raw == null || raw.isBlank()) {
            throw ApiException.validation("bbox is required as minLng,minLat,maxLng,maxLat",
                    Json.map("field", "bbox"));
        }
        String[] parts = raw.split(",");
        if (parts.length != 4) {
            throw ApiException.validation("bbox must have exactly 4 comma-separated numbers",
                    Json.map("field", "bbox", "received", parts.length));
        }
        double[] v = new double[4];
        for (int i = 0; i < 4; i++) {
            try {
                v[i] = Double.parseDouble(parts[i].trim());
            } catch (NumberFormatException e) {
                throw ApiException.validation("bbox value '" + parts[i] + "' is not a number",
                        Json.map("field", "bbox", "index", i));
            }
            if (!Double.isFinite(v[i])) {
                throw ApiException.validation("bbox values must be finite numbers", Json.map("field", "bbox"));
            }
        }
        if (v[0] < -180 || v[2] > 180 || Math.abs(v[1]) > 90 || Math.abs(v[3]) > 90) {
            throw ApiException.validation("bbox is outside valid longitude/latitude range",
                    Json.map("field", "bbox", "lng_range", "-180..180", "lat_range", "-90..90"));
        }
        if (Math.abs(v[2] - v[0]) > MAX_SPAN_DEGREES || Math.abs(v[3] - v[1]) > MAX_SPAN_DEGREES) {
            throw ApiException.validation("bbox span is capped at " + MAX_SPAN_DEGREES + " degrees per axis",
                    Json.map("field", "bbox", "max_span_degrees", MAX_SPAN_DEGREES));
        }
        return v;
    }
}
