package com.nexus.notification;

import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Dev/test email transport: logs the rendered message and reports itself as not live (DECISIONS D6 —
 * a green test run must never be mistaken for "mail was sent"). A real transport replaces it by
 * declaring itself {@code @Primary} (or by removing this bean); nothing else changes.
 */
@Component
public class LoggingEmailProvider implements EmailProvider {

    private static final Logger log = LoggerFactory.getLogger(LoggingEmailProvider.class);

    @Override
    public boolean live() {
        return false;
    }

    @Override
    public boolean send(UUID notificationId, String to, String template, String subject, String body,
                        Map<String, Object> payload) {
        log.info("dev_email notification_id={} to={} template={} subject={} body={} (NOT SENT — no SMTP configured)",
                notificationId, to, template, subject, body);
        return false;
    }
}
