package com.nexus.notification;

import java.util.Map;
import java.util.UUID;

/**
 * Push transport port (§123-125). Same rule as {@link EmailProvider}: the dev implementation logs and
 * reports {@code live()==false}, so a green test run never implies a device was pinged.
 *
 * <p>Device tokens are not modelled in the fixed V1 schema (there is no {@code devices} table), which
 * is why push rows are written as {@code pending} and only marked {@code sent} by a live provider.
 * Recorded as a gap in the README rather than faked.
 */
public interface PushProvider {

    default boolean live() {
        return false;
    }

    /** @param token push registration token; empty when the subject has never registered a device. */
    boolean send(UUID notificationId, String token, String template, String title, String body,
                 Map<String, Object> payload);
}
