package com.nexus.admin;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPlatformRole;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §9 — {@code GET /api/v1/admin/search/analytics}.
 *
 * <p>What search demand the market is expressing, read from the telemetry the SDK already writes:
 * the daily {@code searches / sessions / fulfilled_intents} series from {@code v_north_star}, and the
 * raw event-name breakdown underneath it. It is deliberately descriptive rather than scored — there is
 * no "search quality" number in the schema, and inventing one from a count would be exactly the kind of
 * fabricated metric §109 exists to prevent.
 *
 * <p>The window is bounded (1–90 days) and the top-N breakdown is bounded by the caller's {@code limit},
 * so this is never an unbounded scan of {@code events}. Permission and audit come from
 * {@link RequiresPlatformRole}, the same guard {@code ModerationController} uses.
 */
@RestController
@RequestMapping("/api/v1/admin/search")
public class AdminSearchAnalyticsController {

    private static final int DEFAULT_WINDOW_DAYS = 30;
    private static final int MAX_WINDOW_DAYS = 90;

    private final AdminSearchAnalyticsRepository analytics;
    private final Paging paging;

    public AdminSearchAnalyticsController(AdminSearchAnalyticsRepository analytics, Paging paging) {
        this.analytics = analytics;
        this.paging = paging;
    }

    @GetMapping("/analytics")
    @RequiresPlatformRole
    public Map<String, Object> analytics(@RequestParam(required = false) String days,
                                         @RequestParam(required = false) String limit,
                                         HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        int windowDays = windowDays(days);
        int size = paging.limit(limit);

        Map<String, Object> totalsRow = analytics.totals(tenant, windowDays);
        List<Map<String, Object>> daily = new ArrayList<>();
        for (Map<String, Object> row : analytics.daily(tenant, windowDays, MAX_WINDOW_DAYS)) {
            daily.add(Json.map(
                    "day", Json.str(row, "day"),
                    "sessions", Json.longOf(row, "sessions"),
                    "searches", Json.longOf(row, "searches"),
                    "fulfilled_intents", Json.longOf(row, "fulfilled_intents")));
        }
        List<Map<String, Object>> byEvent = new ArrayList<>();
        for (Map<String, Object> row : analytics.byEventName(tenant, windowDays, size)) {
            byEvent.add(Json.map(
                    "name", Json.str(row, "name"),
                    "events", Json.longOf(row, "events"),
                    "sessions", Json.longOf(row, "sessions")));
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("window_days", windowDays);
        out.put("totals", Json.map(
                "searches", Json.longOf(totalsRow, "searches"),
                "sessions", Json.longOf(totalsRow, "sessions"),
                "fulfilled_intents", Json.longOf(totalsRow, "fulfilled_intents"),
                "active_days", Json.longOf(totalsRow, "active_days")));
        out.put("daily", daily);
        out.put("by_event", byEvent);
        out.put("limits", Json.map("window_days_max", MAX_WINDOW_DAYS, "by_event_limit", size));
        out.put("as_of", Instant.now().toString());
        out.put("source", "events (§58) + v_north_star (DATABASE.md §3.12). A search is events.name = "
                + "'search'; a fulfilled intent is a reserve|purchase|favorite|cart_add event.");
        out.put("note", "Descriptive counts only. There is no search-quality score in the schema and none "
                + "is derived here; events are observations and never feed organic ranking (§66).");
        return out;
    }

    private static int windowDays(String raw) {
        if (raw == null || raw.isBlank()) {
            return DEFAULT_WINDOW_DAYS;
        }
        int parsed;
        try {
            parsed = Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation("days must be an integer", Json.map("field", "days"));
        }
        if (parsed < 1) {
            throw ApiException.validation("days must be >= 1", Json.map("field", "days"));
        }
        return Math.min(parsed, MAX_WINDOW_DAYS);
    }
}
