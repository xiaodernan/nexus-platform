package com.nexus.cloud.dispatcher;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * A domain event reduced to the three fields the dispatcher needs: the stream id (as the
 * dispatcher's delivery id), the event type (for hook matching), and the body bytes (for the
 * signature). The full payload is an opaque string here — only the receiving endpoint cares about
 * the schema, and only the author of the upstream event knows it.
 *
 * <p>The body shippable over HTTP is canonicalised JSON: keys sorted, no insignificant whitespace,
 * values verbatim strings. That survives a round-trip through any JSON parser on the receiving end
 * and it is stable byte-for-byte for a given input — the signature check on the receiving side can
 * compare HMACs without canonicalising anything.
 */
public record DomainEvent(String id, String type, String tenantId, byte[] body, Map<String, String> headers) {

    public static DomainEvent fromStreamBody(String streamId, Map<String, String> body) {
        String type = body.getOrDefault("type", "unknown");
        String tenantId = body.getOrDefault("tenant_id", "");
        Map<String, String> tree = new TreeMap<>(body);
        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        boolean first = true;
        for (Map.Entry<String, String> entry : tree.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(escapeJson(entry.getKey())).append("\":\"")
              .append(escapeJson(entry.getValue())).append('"');
        }
        sb.append('}');
        Map<String, String> headers = new LinkedHashMap<>(body);
        return new DomainEvent(streamId, type, tenantId,
            sb.toString().getBytes(StandardCharsets.UTF_8), headers);
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
