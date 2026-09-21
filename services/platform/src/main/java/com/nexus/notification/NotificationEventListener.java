package com.nexus.notification;

import com.nexus.notification.event.DomainEvents;
import com.nexus.platform.TenantContext;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * The only bridge from "something happened in a domain" to "someone gets told about it" (§123-125).
 *
 * <p>Producers publish {@link DomainEvents} and know nothing about this module. Nothing here may
 * throw back into the publisher: a failed notification must never roll back or fail the business
 * action that earned it, so every branch is caught and logged.
 */
@Component
public class NotificationEventListener {

    private static final Logger log = LoggerFactory.getLogger(NotificationEventListener.class);

    private final NotificationService notifications;

    public NotificationEventListener(NotificationService notifications) {
        this.notifications = notifications;
    }

    @EventListener
    public void on(DomainEvents.NexusDomainEvent event) {
        try {
            TenantContext tenant = notifications.tenantById(event.tenantId());
            if (tenant == null) {
                // Fail closed: without a resolvable tenant there is no inbox to write into, and
                // guessing one would put a row in the wrong market.
                log.warn("notification_dropped template={} reason=tenant_unresolved tenant_id={}",
                        event.template(), event.tenantId());
                return;
            }
            dispatch(tenant, event);
        } catch (RuntimeException e) {
            log.warn("notification_failed template={} type={} message={}", event.template(),
                    e.getClass().getSimpleName(), e.getMessage());
        }
    }

    private void dispatch(TenantContext tenant, DomainEvents.NexusDomainEvent event) {
        switch (event) {
            case DomainEvents.LeadCaptured e -> notifications.notifyMerchant(tenant, e.merchantId(),
                    e.template(), withId(e.payload(), "conversation_id", e.conversationId()));
            case DomainEvents.HandoffRequested e -> {
                Map<String, Object> base = withId(withId(e.payload(), "handoff_id", e.handoffId()),
                        "conversation_id", e.conversationId());
                notifications.notifyMerchant(tenant, e.merchantId(), e.template(), withMerchant(base, e.merchantId()));
                notifications.notifyUser(tenant, e.userId(), e.template(), withMerchant(base, e.merchantId()));
            }
            case DomainEvents.HandoffResolved e -> notifications.notifyUser(tenant, e.userId(), e.template(),
                    withId(withId(e.payload(), "handoff_id", e.handoffId()), "conversation_id", e.conversationId()));
            case DomainEvents.ReviewCreated e -> notifications.notifyMerchant(tenant, e.merchantId(), e.template(),
                    withIfAbsent(withId(e.payload(), "review_id", e.reviewId()), "rating", e.rating()));
            case DomainEvents.ReservationChanged e -> {
                Map<String, Object> base = withId(e.payload(), "reservation_id", e.reservationId());
                notifications.notifyUser(tenant, e.userId(), e.template(), base);
                notifications.notifyMerchant(tenant, e.merchantId(), e.template(), base);
            }
            case DomainEvents.OrderStatusChanged e -> {
                Map<String, Object> base = withId(e.payload(), "order_id", e.orderId());
                notifications.notifyUser(tenant, e.userId(), e.template(), base);
                notifications.notifyMerchant(tenant, e.merchantId(), e.template(), base);
            }
        }
    }

    // ---- payload helpers: real ids plus what the emitter supplied, never invented text -------------

    private static Map<String, Object> withId(Map<String, Object> supplied, String key, Object value) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (supplied != null) {
            out.putAll(supplied);
        }
        if (value != null) {
            out.put(key, value);
        }
        return out;
    }

    private static Map<String, Object> withIfAbsent(Map<String, Object> in, String key, Object value) {
        if (value != null) {
            in.putIfAbsent(key, value);
        }
        return in;
    }

    private static Map<String, Object> withMerchant(Map<String, Object> in, Object merchantId) {
        return withIfAbsent(in, "merchant_id", merchantId);
    }
}
