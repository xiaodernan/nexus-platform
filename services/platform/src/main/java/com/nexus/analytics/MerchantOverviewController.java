package com.nexus.analytics;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletResponse;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/merchant/businesses/{id}/overview} — STATUS.md ruling D15 puts this screen in the
 * analytics module and pins its source to {@code v_merchant_funnel}.
 *
 * <p>The funnel row is a projection over {@code events}/{@code reservations}/{@code orders}: a
 * merchant with no traffic simply gets zeroes, which is a real state, not a placeholder (DECISIONS D6
 * — empty is honest, fabricated is not). The response also says which funnel definition produced it
 * and when it was computed, so a caller can tell a live read from a cached one.
 */
@RestController
@RequestMapping("/api/v1/merchant/businesses")
public class MerchantOverviewController {

    private final AnalyticsRepository analytics;

    public MerchantOverviewController(AnalyticsRepository analytics) {
        this.analytics = analytics;
    }

    @GetMapping("/{id}/overview")
    @RequiresPermission(value = "read_analytics", merchant = "business:id")
    public Map<String, Object> overview(@PathVariable String id, jakarta.servlet.http.HttpServletRequest request,
                                        HttpServletResponse response) {
        UUID merchantId = Json.uuidOrNull(id);
        if (merchantId == null) {
            throw ApiException.validation("Path parameter 'id' must be a uuid", Json.map("field", "id"));
        }
        TenantContext tenant = com.nexus.platform.Req.tenant(request);
        Map<String, Object> profile = analytics.merchantProfile(tenant, merchantId);
        if (profile == null) {
            throw ApiException.notFound("merchant_not_found", "No such business");
        }
        Map<String, Object> funnel = analytics.merchantFunnel(tenant, merchantId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("slug", Json.str(profile, "slug"));
        out.put("display_name", Json.str(profile, "display_name"));
        out.put("status", Json.str(profile, "status"));
        out.put("plan", Json.str(profile, "plan"));
        out.put("category_primary", Json.str(profile, "category_primary"));
        out.put("location_count", Json.longOf(profile, "location_count"));
        out.put("rating", Json.dec(profile, "rating_agg"));
        out.put("review_count", Json.integer(profile, "review_count"));
        out.put("funnel", Map.of(
                "views", funnel == null ? 0 : Json.longOf(funnel, "views"),
                "clicks", funnel == null ? 0 : Json.longOf(funnel, "clicks"),
                "actions", funnel == null ? 0 : Json.longOf(funnel, "actions"),
                "reservations", funnel == null ? 0 : Json.longOf(funnel, "reservations"),
                "orders", funnel == null ? 0 : Json.longOf(funnel, "orders"),
                "revenue", money(funnel, tenant)));
        out.put("funnel_source", "v_merchant_funnel");
        out.put("revenue_definition", REVENUE_DEFINITION);
        out.put("computed_at", java.time.OffsetDateTime.now().toInstant().toString());
        out.put("data_origin", Json.str(profile, "data_origin"));
        com.nexus.platform.DemoFlags.markOrigin(response, Json.str(profile, "data_origin"));
        return out;
    }

    /** Stated in the payload because the view's own revenue column is unusable (see AnalyticsRepository). */
    private static final String REVENUE_DEFINITION =
            "sum(orders.total) per merchant, status not in (cancelled, refunded)";

    private static Map<String, Object> money(Map<String, Object> funnel, TenantContext tenant) {
        BigDecimal revenue = funnel == null ? BigDecimal.ZERO : Json.dec(funnel, "revenue");
        String currency = funnel == null ? null : Json.str(funnel, "currency");
        return Json.money(revenue == null ? BigDecimal.ZERO : revenue,
                currency == null || currency.isBlank() ? tenant.currency() : currency);
    }
}
