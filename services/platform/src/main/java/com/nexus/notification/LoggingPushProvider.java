package com.nexus.notification;

import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Dev/test push transport — logs, never pretends to reach a device. See {@link PushProvider}. */
@Component
public class LoggingPushProvider implements PushProvider {

    private static final Logger log = LoggerFactory.getLogger(LoggingPushProvider.class);

    @Override
    public boolean live() {
        return false;
    }

    @Override
    public boolean send(UUID notificationId, String token, String template, String title, String body,
                        Map<String, Object> payload) {
        log.info("dev_push notification_id={} token={} template={} title={} body={} (NOT SENT — no APNs/FCM configured)",
                notificationId, token == null || token.isBlank() ? "<none registered>" : token, template, title, body);
        return false;
    }
}
