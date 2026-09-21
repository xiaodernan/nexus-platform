package com.nexus.notification;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Out-of-band delivery ports (§123-125). The platform decides <em>what</em> happened and which
 * channel the user opted into; the provider only knows how to push bytes at the outside world.
 *
 * <p>Both providers are best-effort by contract: a throw must never fail the request that produced
 * the event, so {@link NotificationService} catches and records {@code status='failed'} instead.
 */
public interface NotificationProvider {

    /** Matches {@code notifications.channel}: {@code email} | {@code push} | {@code whatsapp}. */
    String channel();

    /** True when a real transport is wired. The dev implementations log and return false. */
    default boolean live() {
        return false;
    }

    /**
     * Deliver one rendered notification.
     *
     * @param to destination address / device token / phone, resolved by the caller from the subject's
     *           own profile — never from the request body
     * @return {@code true} when the transport accepted the message
     */
    boolean send(UUID notificationId, String to, String template, String subject, String body,
                 Map<String, Object> payload);

    /**
     * Recipient resolution is separate from sending: an unread consumer cannot be emailed at all, and
     * the answer "there is no address on file" must be distinguishable from "the transport failed".
     */
    record Recipient(String address, boolean verified) {
    }

    /** Addresses this provider can reach for a user, in preference order. Empty = no delivery. */
    default List<Recipient> recipientsOf(UUID userId) {
        return List.of();
    }
}
