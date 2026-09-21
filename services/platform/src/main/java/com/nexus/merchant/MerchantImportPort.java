package com.nexus.merchant;

import java.util.List;
import java.util.Map;

/**
 * Extraction port for AI merchant imports (§5.1, §22). Two implementations:
 * {@link HeuristicImportAdapter} (offline, deterministic line parser) and
 * {@link HttpImportAdapter} (calls the AI service, falls back to the heuristic adapter on failure —
 * the failure ladder in API_CONTRACT §1).
 *
 * <p>Nothing an adapter produces is published: proposals come back as {@code draft} offerings that a
 * human has to approve, because "Nothing is published without merchant review" (§5.1).
 */
public interface MerchantImportPort {

    record ProposedOffering(String name, String nameZh, String kind, java.math.BigDecimal price, String currency,
                            String priceModel, String description, double confidence, String evidence) {
    }

    record Extraction(List<ProposedOffering> proposals, String extractor, boolean degraded, String note) {
    }

    /**
     * @param sourceType {@code url} | {@code text} | {@code file}
     * @param sourceValue url (allow-listed scheme, private addresses blocked) or raw text
     * @param files       uploaded files, name → decoded text content (non-text files are skipped and reported)
     */
    Extraction extract(String sourceType, String sourceValue, Map<String, String> files);

    String name();

    /** Adapters must state their own confidence ceiling so the UI can phrase results as uncertain. */
    default double confidenceCeiling() {
        return 0.9;
    }

    static String describe(List<ProposedOffering> proposals) {
        return proposals.size() + " proposals";
    }

    List<String> SUPPORTED_SOURCE_TYPES = List.of("url", "text", "file");
}
