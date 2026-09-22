package com.nexus.growth;

import com.nexus.platform.ApiException;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/merchant/customers?merchant_id=} — the §23 Customers screen for one business.
 * RBAC is declared, not implied: {@code read_analytics} is checked against {@code permission_grants}
 * for the merchant resolved from the query parameter, so staff of merchant A cannot pull merchant
 * B's customer book, and a cross-tenant merchant id reads as 404 (D5, no enumeration).
 *
 * <p>Sourcing honesty (§56, D6): a customer here is a person with a completed order or
 * reservation at this merchant — nothing else. Page-view telemetry never appears in this list, and
 * a merchant with no transactions receives an empty page that says so.
 */
@RestController
@RequestMapping("/api/v1/merchant")
public class MerchantCustomersController {

    private static final List<String> SEGMENTS = List.of("all", "repeat", "new");

    private final CustomerRepository customers;
    private final Paging paging;

    public MerchantCustomersController(CustomerRepository customers, Paging paging) {
        this.customers = customers;
        this.paging = paging;
    }

    @GetMapping("/customers")
    @RequiresPermission(value = "read_analytics", merchant = "param:merchant_id")
    public Map<String, Object> customers(@RequestParam(required = false) String merchant_id,
                                         @RequestParam(required = false, defaultValue = "all") String segment,
                                         @RequestParam(required = false) String limit,
                                         @RequestParam(required = false) String cursor,
                                         HttpServletRequest request, HttpServletResponse response) {
        UUID merchantId = Json.uuidOrNull(merchant_id);
        if (merchantId == null) {
            throw ApiException.validation("Query parameter 'merchant_id' must be a uuid",
                    Json.map("field", "merchant_id"));
        }
        String seg = Paging.enumFilter(segment, SEGMENTS, "segment");
        if (seg == null) {
            seg = "all";
        }
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> merchant = customers.merchantRow(tenant, merchantId)
                .orElseThrow(() -> ApiException.notFound("merchant_not_found", "No such business"));

        int size = paging.limit(limit);
        int offset = paging.offset(cursor);
        List<Map<String, Object>> rows = customers.customers(tenant, merchantId, seg, size, offset);
        long total = customers.countCustomers(tenant, merchantId, seg);

        List<Map<String, Object>> items = rows.stream().map(r -> {
            BigDecimal spend = Json.dec(r, "spend_amount");
            String currency = Json.str(r, "spend_currency");
            return Json.map(
                    "customer_id", Json.str(r, "user_id"),
                    "display_name", Json.str(r, "display_name"),
                    "email", Json.str(r, "email"),
                    "transactions", Json.longOf(r, "transactions"),
                    "orders", Json.longOf(r, "orders"),
                    "reservations", Json.longOf(r, "reservations"),
                    "spend", Json.money(spend == null ? BigDecimal.ZERO : spend,
                            currency == null || currency.isBlank() ? tenant.currency() : currency),
                    "first_seen_at", Json.ts(r, "first_seen_at"),
                    "last_seen_at", Json.ts(r, "last_seen_at"),
                    "repeat", (Json.longOf(r, "transactions") == null ? 0 : Json.longOf(r, "transactions")) >= 2);
        }).toList();

        Map<String, Object> page = paging.page(items, offset, size, total);
        page.put("merchant_id", merchantId.toString());
        page.put("merchant", Json.map("slug", Json.str(merchant, "slug"),
                "display_name", Json.str(merchant, "display_name")));
        page.put("segment", seg);
        page.put("source", "orders + reservations (completed transactions only)");
        page.put("definition", Json.map(
                "customer", "a tenant user with at least one order (status not cancelled/refunded) or "
                        + "reservation (status not cancelled) at this merchant",
                "spend", "sum(orders.total) excluding cancelled/refunded orders; reservations do not add spend",
                "repeat", "two or more qualifying transactions"));
        page.put("computed_at", java.time.Instant.now().toString());
        page.put("data_origin", Json.str(merchant, "data_origin"));
        DemoFlags.markOrigin(response, Json.str(merchant, "data_origin"));
        return page;
    }
}
