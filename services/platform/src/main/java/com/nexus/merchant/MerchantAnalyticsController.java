package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/merchant/analytics?from&to&metric} (contract §5, spec §56).
 *
 * <p>The read answers a question the overview deliberately does not: <em>what happened between these
 * two instants</em>. The overview serves the lifetime funnel projection (D15); this serves a window,
 * measured from {@code events}, {@code reservations} and {@code orders}, with the source of every
 * block named in the payload.
 *
 * <p>Three honesty rules are enforced here rather than left to the console:
 *
 * <ul>
 *   <li>A window with no rows answers zeros and says so with {@code degraded:false} — "no traffic" and
 *       "we could not read the traffic" are different facts, and only one of them is a zero.</li>
 *   <li>{@code metric} is validated against a closed list; an unknown one is a 422, not a silently
 *       ignored parameter that returns the default block.</li>
 *   <li>{@code from} must precede {@code to}, and the window is capped at {@link #MAX_WINDOW_DAYS} so
 *       an analytics read cannot become an unbounded scan of the event table.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v1/merchant")
public class MerchantAnalyticsController {

    /** A year is already far more than the console plots; the cap keeps the scan bounded. */
    private static final int MAX_WINDOW_DAYS = 366;
    private static final int DEFAULT_WINDOW_DAYS = 30;
    private static final List<String> METRICS =
            List.of("all", "views", "clicks", "actions", "reservations", "orders", "revenue");

    /** Event names that count as a click, and as an action, in the funnel vocabulary of §56. */
    private static final List<String> CLICK_EVENTS = List.of("click");
    private static final List<String> VIEW_EVENTS = List.of("view");
    private static final List<String> ACTION_EVENTS =
            List.of("favorite", "compare", "cart_add", "checkout", "purchase", "reserve", "share", "review");

    private final MerchantAnalyticsRepository analytics;

    public MerchantAnalyticsController(MerchantAnalyticsRepository analytics) {
        this.analytics = analytics;
    }

    @GetMapping("/analytics")
    @RequiresPermission(value = MerchantPermissions.READ_ANALYTICS, merchant = "param:merchant_id")
    public Map<String, Object> analytics(@RequestParam(required = false) String merchant_id,
                                         @RequestParam(required = false) String from,
                                         @RequestParam(required = false) String to,
                                         @RequestParam(required = false) String metric,
                                         HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = requireUuid(merchant_id, "merchant_id");
        String selected = metric(metric);

        Instant toInstant = to == null || to.isBlank() ? Instant.now() : parseInstant(to, "to", true);
        Instant fromInstant = from == null || from.isBlank()
                ? toInstant.minus(Duration.ofDays(DEFAULT_WINDOW_DAYS))
                : parseInstant(from, "from", false);
        if (!fromInstant.isBefore(toInstant)) {
            throw ApiException.validation("from must be before to", Json.map("field", "from"));
        }
        if (Duration.between(fromInstant, toInstant).toDays() > MAX_WINDOW_DAYS) {
            throw ApiException.validation("the window may span at most " + MAX_WINDOW_DAYS + " days",
                    Json.map("field", "from", "max_days", MAX_WINDOW_DAYS));
        }

        List<Map<String, Object>> byEvent = analytics.eventCounts(tenant, merchantId, fromInstant, toInstant);
        long views = sumOf(byEvent, VIEW_EVENTS);
        long clicks = sumOf(byEvent, CLICK_EVENTS);
        long actions = sumOf(byEvent, ACTION_EVENTS);
        Map<String, Object> reservations = analytics.reservations(tenant, merchantId, fromInstant, toInstant);
        Map<String, Object> orders = analytics.orders(tenant, merchantId, fromInstant, toInstant);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId);
        out.put("window", Json.map(
                "from", fromInstant.toString(),
                "to", toInstant.toString(),
                "days", Duration.between(fromInstant, toInstant).toDays(),
                "metric", selected));
        out.put("metrics", Json.map(
                "views", views,
                "clicks", clicks,
                "actions", actions,
                "reservations", longOrZero(reservations, "bookings"),
                "orders", longOrZero(orders, "orders"),
                "revenue", money(orders.get("revenue"), str(orders, "currency"))));
        out.put("reservations_detail", Json.map(
                "bookings", longOrZero(reservations, "bookings"),
                "honoured", longOrZero(reservations, "honoured"),
                "cancelled", longOrZero(reservations, "cancelled"),
                "booked_value", money(reservations.get("booked_value"), str(reservations, "currency"))));
        out.put("orders_detail", Json.map(
                "orders", longOrZero(orders, "orders"),
                "voided", longOrZero(orders, "voided"),
                "revenue", money(orders.get("revenue"), str(orders, "currency"))));
        out.put("by_event", byEvent.stream().map(row -> Json.map(
                "name", Json.str(row, "name"),
                "events", Json.longOf(row, "events"),
                "sessions", Json.longOf(row, "sessions"))).toList());
        out.put("series", analytics.dailySeries(tenant, merchantId, fromInstant, toInstant));
        out.put("degraded", false);
        out.put("source", "events(subject_type='merchant') + reservations(created_at) + orders(created_at)");
        out.put("note", "Counts are measured over the window; a window with no rows is a real zero. "
                + "Revenue excludes cancelled and refunded orders, and the excluded count is reported.");
        return out;
    }

    // ==================================================================== helpers

    private static long sumOf(List<Map<String, Object>> rows, List<String> names) {
        long total = 0;
        for (Map<String, Object> row : rows) {
            String name = Json.str(row, "name");
            if (name != null && names.contains(name.toLowerCase(Locale.ROOT))) {
                Long n = Json.longOf(row, "events");
                total += n == null ? 0 : n;
            }
        }
        return total;
    }

    private static long longOrZero(Map<String, Object> row, String column) {
        Long n = Json.longOf(row, column);
        return n == null ? 0 : n;
    }

    private static Map<String, Object> money(Object amount, String currency) {
        BigDecimal value = amount == null ? BigDecimal.ZERO : new BigDecimal(String.valueOf(amount));
        return Json.money(value, currency == null ? "HKD" : currency);
    }

    private static String str(Map<String, Object> row, String column) {
        return Json.str(row, column);
    }

    private static String metric(String raw) {
        if (raw == null || raw.isBlank()) {
            return "all";
        }
        String value = raw.trim().toLowerCase(Locale.ROOT);
        if (!METRICS.contains(value)) {
            throw ApiException.validation("metric must be one of " + METRICS, Json.map("field", "metric"));
        }
        return value;
    }

    /** Accepts a full ISO-8601 instant, or a bare date (interpreted as that day's start in UTC). */
    private static Instant parseInstant(String raw, String field, boolean endOfDay) {
        String value = raw.trim();
        try {
            return Instant.parse(value);
        } catch (java.time.format.DateTimeParseException ignored) {
            // fall through to the date form
        }
        try {
            LocalDate date = LocalDate.parse(value);
            return endOfDay ? date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
                    : date.atStartOfDay(ZoneOffset.UTC).toInstant();
        } catch (java.time.format.DateTimeParseException e) {
            throw ApiException.validation(field + " must be an ISO-8601 instant or a date",
                    Json.map("field", field));
        }
    }

    private static UUID requireUuid(Object raw, String field) {
        UUID parsed = Json.uuidOrNull(raw == null ? null : String.valueOf(raw));
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }
}
