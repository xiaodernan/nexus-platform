package com.nexus.merchant;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * HTTP implementation of {@link MerchantImportPort}: posts the source to the AI service
 * ({@code POST /ai/v1/imports/extract}) and maps its proposals. When the AI service is unreachable or
 * answers badly, it degrades to {@link HeuristicImportAdapter} and reports {@code degraded:true} — the
 * failure ladder in API_CONTRACT §1, never a hang and never a silent fake.
 */
@Component
public class HttpImportAdapter implements MerchantImportPort {

    private static final Logger log = LoggerFactory.getLogger(HttpImportAdapter.class);

    private final HttpClient http;
    private final String baseUrl;
    private final HeuristicImportAdapter fallback;

    public HttpImportAdapter(@Value("${nexus.ai.base-url:http://localhost:8000}") String baseUrl,
                             @Value("${nexus.ai.timeout-ms:8000}") long timeoutMs,
                             HeuristicImportAdapter fallback) {
        this.baseUrl = baseUrl;
        this.fallback = fallback;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(Math.min(timeoutMs, 5000))).build();
    }

    @Override
    public String name() {
        return "ai_service_http";
    }

    @Override
    public Extraction extract(String sourceType, String sourceValue, Map<String, String> files) {
        Map<String, Object> payload = Json.map("source", Json.map("type", sourceType, "value", sourceValue),
                "files", files == null ? List.of() : files.entrySet().stream()
                        .map(e -> Json.map("name", e.getKey(), "text", e.getValue())).toList(),
                "contract_version", "v1");
        try {
            HttpResponse<String> response = http.send(HttpRequest
                    .newBuilder(URI.create(baseUrl + "/ai/v1/imports/extract"))
                    .timeout(Duration.ofMillis(8000))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(Json.write(payload), StandardCharsets.UTF_8))
                    .build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                log.warn("import_extract_non200 status={}", response.statusCode());
                return degrade("AI service answered " + response.statusCode());
            }
            JsonNode body = Json.tree(response.body());
            List<ProposedOffering> proposals = new ArrayList<>();
            for (JsonNode node : body.path("proposals")) {
                proposals.add(new ProposedOffering(
                        node.path("name").asText(null),
                        node.path("name_zh").asText(null),
                        node.path("kind").asText("product"),
                        node.hasNonNull("price") ? new BigDecimal(node.path("price").asText()) : null,
                        node.path("currency").asText("HKD"),
                        node.path("price_model").asText("fixed"),
                        node.path("description").asText(null),
                        node.path("confidence").asDouble(0.5),
                        node.path("evidence").asText(null)));
            }
            proposals.removeIf(p -> p.name() == null || p.name().isBlank());
            return new Extraction(proposals, name(), false, body.path("note").asText("extracted by ai service"));
        } catch (Exception e) {
            log.warn("import_extract_unavailable message={}", e.getMessage());
            return degrade("AI service unreachable (" + e.getClass().getSimpleName() + ")");
        }
    }

    private Extraction degrade(String why) {
        Extraction local = fallback.extract("text", null, Map.of());
        return new Extraction(local.proposals(), fallback.name() + "+fallback", true,
                why + " — degraded to the deterministic local parser (§1 failure ladder)");
    }

    /** Used when the caller asked for http mode but the payload has readable text we can still try. */
    Extraction withText(String sourceType, String sourceValue, Map<String, String> files) {
        return extract(sourceType, sourceValue, files);
    }
}
