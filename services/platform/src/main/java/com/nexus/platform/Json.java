package com.nexus.platform;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Array;
import java.sql.Time;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.postgresql.util.PGobject;

/**
 * JSON + row-mapping helpers. Responses are assembled as explicit {@code Map}s so key names are
 * literally snake_case as the contract demands (§1) rather than relying on a naming strategy, and
 * so money is always the {@code {"amount":"128.00","currency":"HKD"}} object, never a float.
 */
public final class Json {

    /** Lenient mapper used for jsonb columns, JWT payloads and cached request bodies. */
    public static final ObjectMapper MAPPER = new ObjectMapper()
            .registerModule(new com.fasterxml.jackson.datatype.jsr310.JavaTimeModule())
            .disable(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    private Json() {
    }

    // ---- builders --------------------------------------------------------

    /** {@code J.map("k1", v1, "k2", v2)} — insertion-ordered. A null value renders as JSON null. */
    public static Map<String, Object> map(Object... kv) {
        if (kv.length % 2 != 0) {
            throw new IllegalArgumentException("expected key/value pairs");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            out.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return out;
    }

    public static Map<String, Object> money(BigDecimal amount, String currency) {
        if (amount == null) {
            return null;
        }
        return map("amount", amount.setScale(2, RoundingMode.HALF_UP).toPlainString(), "currency", currency);
    }

    public static String snake(String camel) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < camel.length(); i++) {
            char c = camel.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) {
                    sb.append('_');
                }
                sb.append(Character.toLowerCase(c));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    public static Map<String, Object> parseObject(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            return MAPPER.readValue(json, new TypeReference<LinkedHashMap<String, Object>>() {
            });
        } catch (Exception e) {
            throw ApiException.validation("Body is not a valid JSON object", Map.of("reason", "json_parse"));
        }
    }

    public static JsonNode tree(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (Exception e) {
            return MAPPER.nullNode();
        }
    }

    public static String write(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (Exception e) {
            throw ApiException.internal("Failed to serialise value", e);
        }
    }

    public static ObjectNode objectNode() {
        return MAPPER.createObjectNode();
    }

    // ---- row accessors (JdbcTemplate Map rows) ---------------------------

    public static String str(Map<String, Object> row, String column) {
        Object v = row.get(column);
        return v == null ? null : String.valueOf(v);
    }

    public static String requiredStr(Map<String, Object> row, String column) {
        String v = str(row, column);
        return v == null ? "" : v;
    }

    public static UUID uuid(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        if (v instanceof UUID u) {
            return u;
        }
        return RequestIds.asUuidOrNull(String.valueOf(v));
    }

    public static UUID uuidOrNull(String raw) {
        return RequestIds.asUuidOrNull(raw);
    }

    public static BigDecimal dec(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        if (v instanceof BigDecimal b) {
            return b;
        }
        return new BigDecimal(String.valueOf(v));
    }

    /** Money object straight off a row: value column + currency column. */
    public static Map<String, Object> money(Map<String, Object> row, String amountColumn, String currencyColumn) {
        BigDecimal amount = dec(row, amountColumn);
        String currency = str(row, currencyColumn);
        return money(amount, currency == null ? "HKD" : currency);
    }

    public static Integer integer(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        if (v instanceof Number n) {
            return n.intValue();
        }
        return Integer.valueOf(String.valueOf(v));
    }

    public static Long longOf(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        return v instanceof Number n ? n.longValue() : Long.valueOf(String.valueOf(v));
    }

    public static Boolean bool(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        if (v instanceof Boolean b) {
            return b;
        }
        return "t".equalsIgnoreCase(String.valueOf(v)) || "true".equalsIgnoreCase(String.valueOf(v));
    }

    /** ISO-8601 UTC string (contract §1). */
    public static String ts(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        if (v instanceof Timestamp t) {
            return t.toInstant().toString();
        }
        if (v instanceof java.time.OffsetDateTime odt) {
            return odt.toInstant().toString();
        }
        return String.valueOf(v);
    }

    public static String time(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        if (v instanceof Time t) {
            return t.toLocalTime().toString();
        }
        return String.valueOf(v);
    }

    /** jsonb column → Map/List/String/Number as appropriate. */
    public static Object json(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return null;
        }
        String raw = v instanceof PGobject p ? p.getValue() : String.valueOf(v);
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return MAPPER.readValue(raw, Object.class);
        } catch (Exception e) {
            return raw;
        }
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> jsonObject(Map<String, Object> row, String column) {
        Object v = json(row, column);
        return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    public static List<Object> jsonArray(Map<String, Object> row, String column) {
        Object v = json(row, column);
        return v instanceof List ? (List<Object>) v : new ArrayList<>();
    }

    /** text[] column → List<String>. */
    public static List<String> textArray(Map<String, Object> row, String column) {
        Object v = row.get(column);
        if (v == null) {
            return List.of();
        }
        try {
            Object inner = v instanceof Array a ? a.getArray() : v;
            if (inner instanceof Object[] arr) {
                List<String> out = new ArrayList<>();
                for (Object o : arr) {
                    out.add(o == null ? null : String.valueOf(o));
                }
                return out;
            }
        } catch (Exception e) {
            throw ApiException.internal("Failed to read array column " + column, e);
        }
        return List.of(String.valueOf(v));
    }

    public static String csv(Collection<String> values) {
        return values == null ? "" : String.join(",", values);
    }

    // ---- cursor ----------------------------------------------------------

    public static String encodeCursor(String payload) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    public static String decodeCursor(String cursor) {
        try {
            return new String(Base64.getUrlDecoder().decode(cursor), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw ApiException.validation("cursor is not valid", Map.of("cursor", cursor));
        }
    }
}
