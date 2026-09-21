package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Offline extraction: parses menu-ish text into proposed offerings with a price pattern per line.
 * Deterministic, clearly labelled {@code extractor:"heuristic_local"}, and the confidence ceiling is
 * 0.8 so imported values are phrased as uncertain (AGENT_CONTRACT §4: {@code confidence < 0.6} ⇒ say so).
 *
 * <p>URL sources go through {@link #fetch}, which is the only outbound call this component makes:
 * http(s) only, DNS-resolved address must not be private/loopback (SSRF guard), 10s cap, 1 MiB cap,
 * and the body is treated as untrusted data (§51) — instruction-shaped text is ignored.
 */
@Component
public class HeuristicImportAdapter implements MerchantImportPort {

    private static final Logger log = LoggerFactory.getLogger(HeuristicImportAdapter.class);
    private static final int MAX_BYTES = 1024 * 1024;
    private static final java.util.regex.Pattern PRICE = java.util.regex.Pattern.compile(
            "(?i)(?:^|[\\s,:$HK¥])(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*(?:hk\\$|\\$|元)?\\s*$");

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    @Override
    public String name() {
        return "heuristic_local";
    }

    @Override
    public double confidenceCeiling() {
        return 0.8;
    }

    @Override
    public Extraction extract(String sourceType, String sourceValue, java.util.Map<String, String> files) {
        StringBuilder text = new StringBuilder();
        List<String> skipped = new ArrayList<>();
        if ("text".equals(sourceType) || "url".equals(sourceType)) {
            if ("url".equals(sourceType)) {
                text.append(fetch(sourceValue));
            } else {
                text.append(sourceValue == null ? "" : sourceValue);
            }
        }
        if (files != null) {
            files.forEach((name, content) -> {
                if (content == null || content.isBlank()) {
                    skipped.add(name);
                } else {
                    text.append('\n').append(content);
                }
            });
        }
        List<ProposedOffering> proposals = parse(text.toString());
        String note = proposals.isEmpty()
                ? "No price-bearing lines were found. Empty is a valid result — nothing was invented (§D6)."
                : "Parse hints: " + proposals.size() + " lines matched a price pattern"
                        + (skipped.isEmpty() ? "" : "; files without readable text skipped: " + skipped);
        return new Extraction(proposals, name(), false, note);
    }

    /** Line shapes understood: "Roast duck .... 128", "$128 - Roast duck", "Duck, 128, HKD". */
    List<ProposedOffering> parse(String rawText) {
        List<ProposedOffering> out = new ArrayList<>();
        for (String line : rawText.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (trimmed.length() < 3 || trimmed.length() > 240) {
                continue;
            }
            if (looksLikeInstruction(trimmed)) {
                log.info("import_line_ignored_as_untrusted reason=prompt_injection_shape");
                continue;
            }
            BigDecimal price = extractPrice(trimmed);
            if (price == null) {
                continue;
            }
            String name = trimmed.replaceAll("[.,\\-–—\\s]+$", "");
            name = name.replaceAll("(?i)(hk\\$|\\$|元)\\s*\\d.*$", "").replaceAll("[.:,\\-–—]+$", "").trim();
            if (name.isBlank() || name.length() > 120) {
                continue;
            }
            String kind = kindHint(name);
            double confidence = name.length() > 40 ? 0.55 : 0.75;
            out.add(new ProposedOffering(name, null, kind, price, "HKD", "fixed", null, confidence, trimmed));
            if (out.size() >= 200) {
                break;
            }
        }
        return out;
    }

    private static BigDecimal extractPrice(String line) {
        var matcher = PRICE.matcher(line);
        BigDecimal best = null;
        while (matcher.find()) {
            String digits = matcher.group(1).replace(',', '.');
            try {
                BigDecimal value = new BigDecimal(digits);
                if (value.signum() > 0 && value.compareTo(new BigDecimal("1000000")) < 0) {
                    best = value;
                }
            } catch (NumberFormatException e) {
                // ignore malformed numeric text
            }
        }
        return best;
    }

    private static String kindHint(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.contains("service") || lower.contains("treatment") || lower.contains("lesson")
                || lower.contains("按摩") || lower.contains("課程")) {
            return "service";
        }
        if (lower.contains("tour") || lower.contains("experience") || lower.contains("套餐") || lower.contains("體驗")) {
            return "experience";
        }
        return "product";
    }

    /** §51: retrieved content never becomes an instruction, so imperative shapes are dropped. */
    private static boolean looksLikeInstruction(String line) {
        String l = line.toLowerCase(Locale.ROOT);
        return l.startsWith("ignore previous") || l.startsWith("you are now") || l.startsWith("system:")
                || l.startsWith("assistant:") || l.contains("<|") || l.startsWith("### instruction");
    }

    String fetch(String url) {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw ApiException.validation("Source URL is malformed", Json.map("field", "source.value"));
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw ApiException.validation("Only http(s) sources may be imported", Json.map("scheme", scheme));
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw ApiException.validation("Source URL has no host", Json.map("field", "source.value"));
        }
        try {
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isAnyLocalAddress()
                        || address.isLinkLocalAddress() || address.isMulticastAddress()) {
                    // DNS-rebind / internal-network guard (AGENT_CONTRACT §3 search_web rules).
                    throw ApiException.validation("Source host resolves to a private address and will not be fetched",
                            Json.map("host", host));
                }
            }
        } catch (java.net.UnknownHostException e) {
            throw ApiException.validation("Source host could not be resolved", Json.map("host", host));
        }
        try {
            HttpResponse<byte[]> response = http.send(
                    HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(10)).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() >= 300) {
                throw ApiException.validation("Source URL returned a redirect or error status",
                        Json.map("status", response.statusCode()));
            }
            byte[] body = response.body();
            return new String(body, 0, Math.min(body.length, MAX_BYTES), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw ApiException.aiUnavailable("Source URL could not be fetched: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApiException.aiUnavailable("Source fetch was interrupted");
        }
    }
}
