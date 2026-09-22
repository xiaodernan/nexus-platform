package com.nexus.platform;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Cursor pagination (§1): {@code ?limit=&cursor=} → {@code {items, next_cursor, total_estimate}}.
 * Cursors are opaque base64 offsets ({@code o:<n>}); the offset is a server-side detail, never a
 * documented contract. {@code limit} is clamped to {@code nexus.pagination.max-limit} (100).
 *
 * <p>Sorting/filtering is whitelist-only: {@link #orderBy} maps a client token to a fixed SQL
 * fragment from a map the caller supplies. Client text is never concatenated into SQL.
 */
@Component
public class Paging {

    private final int defaultLimit;
    private final int maxLimit;

    public Paging(@Value("${nexus.pagination.default-limit:20}") int defaultLimit,
                  @Value("${nexus.pagination.max-limit:100}") int maxLimit) {
        this.defaultLimit = defaultLimit;
        this.maxLimit = maxLimit;
    }

    public int maxLimit() {
        return maxLimit;
    }

    public int limit(String raw) {
        if (raw == null || raw.isBlank()) {
            return defaultLimit;
        }
        int parsed;
        try {
            parsed = Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation("limit must be an integer", Json.map("field", "limit"));
        }
        if (parsed < 1) {
            throw ApiException.validation("limit must be >= 1", Json.map("field", "limit"));
        }
        return Math.min(parsed, maxLimit);
    }

    public int offset(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return 0;
        }
        String decoded = Json.decodeCursor(cursor);
        if (!decoded.startsWith("o:")) {
            throw ApiException.validation("cursor is not recognised", Json.map("cursor", cursor));
        }
        try {
            int n = Integer.parseInt(decoded.substring(2));
            return Math.max(0, n);
        } catch (NumberFormatException e) {
            throw ApiException.validation("cursor is not recognised", Json.map("cursor", cursor));
        }
    }

    /** Next cursor, or null when this looks like the last page. */
    public String nextCursor(int offset, int returned, int limit) {
        if (returned < limit) {
            return null;
        }
        return Json.encodeCursor("o:" + (offset + returned));
    }

    public Map<String, Object> page(List<Map<String, Object>> items, int offset, int limit, long totalEstimate) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("next_cursor", nextCursor(offset, items.size(), limit));
        out.put("total_estimate", totalEstimate);
        return out;
    }

    /** Whitelisted ORDER BY: unknown tokens are a 422, never a fragment of client text. */
    public String orderBy(Map<String, String> whitelist, String token, String fallbackKey) {
        if (token == null || token.isBlank()) {
            return whitelist.get(fallbackKey);
        }
        String key = token.trim().toLowerCase();
        boolean descending = false;
        if (key.startsWith("-")) {
            descending = true;
            key = key.substring(1);
        }
        String fragment = whitelist.get(key);
        if (fragment == null) {
            throw ApiException.validation("Unsupported sort field '" + token + "'",
                    Json.map("allowed", new TreeMap<>(whitelist).keySet().stream().toList()));
        }
        return fragment + (descending ? " desc" : " asc");
    }

    /**
     * {@link #orderBy} with an explicit null placement. Postgres sorts NULL first when descending, so a
     * merchant with no rating would top a "best rated" page: a value the data does not have must sink,
     * not win. Same whitelist rule, same 422 for an unknown token.
     */
    public String orderByNullsLast(Map<String, String> whitelist, String token, String fallbackKey) {
        return orderBy(whitelist, token, fallbackKey) + " nulls last";
    }

    /** Whitelisted enum filter (returns null for "no filter"). */
    public static String enumFilter(String raw, List<String> allowed, String field) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String v = raw.trim().toLowerCase();
        if (!allowed.contains(v)) {
            throw ApiException.validation("Value for " + field + " must be one of " + allowed,
                    Json.map("field", field, "allowed", allowed));
        }
        return v;
    }

    public static boolean booleanFilter(String raw) {
        return raw != null && (raw.equalsIgnoreCase("true") || raw.equals("1") || raw.equalsIgnoreCase("yes"));
    }
}
