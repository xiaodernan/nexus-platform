package com.nexus.notification;

import java.util.Map;
import java.util.UUID;

/**
 * Email transport port (§123-125). Keeping the platform behind an interface is what lets the dev
 * profile run with a logging stub: nothing in this codebase sends mail to a real address unless a
 * live implementation is wired in and {@link #live()} says so.
 *
 * <p>Transactional mail only. Marketing consent ({@code users.marketing_opt_in}) is never consulted
 * here, and a provider must not be handed a recipient the caller did not resolve from the subject's
 * own account row.
 */
public interface EmailProvider {

    /** True when a real transport is configured; the dev implementation returns false. */
    default boolean live() {
        return false;
    }

    /**
     * @param to      address from the recipient's own {@code users.email}
     * @param template render key, so the provider can pick a server-side template rather than trusting
     *                 caller-built HTML
     * @return whether the transport accepted the message; failures are recorded, never thrown onward
     */
    boolean send(UUID notificationId, String to, String template, String subject, String body,
                 Map<String, Object> payload);
}
