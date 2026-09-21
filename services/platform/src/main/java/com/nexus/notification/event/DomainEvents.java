package com.nexus.notification.event;

import java.util.Map;
import java.util.UUID;

/**
 * The domain events the notification module listens to (API_CONTRACT §123-125 of the spec: leads,
 * reservations, reviews, AI-could-not-answer handoffs, order status changes).
 *
 * <p>Producers publish these through Spring's {@code ApplicationEventPublisher} and know nothing
 * about notifications, channels, or providers — that indirection is the point, so the commerce
 * services stay free of growth/inbox concerns. Adding a consumer of a domain event must not require
 * editing the service that emits it.
 *
 * <p>{@code tenantId} travels with every event because the listener runs outside the request and
 * therefore outside {@code TenantContext}; a notification for a tenant the listener cannot prove is
 * dropped rather than guessed.
 */
public final class DomainEvents {

    private DomainEvents() {
    }

    /** Base for every event the inbox may render. */
    public sealed interface NexusDomainEvent permits LeadCaptured, ReservationChanged, ReviewCreated,
            HandoffRequested, HandoffResolved, OrderStatusChanged {

        /** Template key: also the {@code notifications.template} column value. */
        String template();

        UUID tenantId();
    }

    /** A consumer left contact details with a merchant (new lead). */
    public record LeadCaptured(UUID tenantId, UUID merchantId, UUID conversationId, String consumerName,
                               Map<String, Object> payload) implements NexusDomainEvent {
        @Override
        public String template() {
            return "lead_new";
        }
    }

    /** Reservation created / transitioned. Consumers get the status, the merchant gets the booking. */
    public record ReservationChanged(UUID tenantId, UUID userId, UUID merchantId, UUID reservationId,
                                     String fromStatus, String toStatus, Map<String, Object> payload)
            implements NexusDomainEvent {
        @Override
        public String template() {
            return "reservation_" + toStatus;
        }
    }

    /** A review landed; the merchant is told, the consumer is not (it was their own action). */
    public record ReviewCreated(UUID tenantId, UUID userId, UUID merchantId, UUID reviewId, Integer rating,
                                Map<String, Object> payload) implements NexusDomainEvent {
        @Override
        public String template() {
            return "review_new";
        }
    }

    /** The AI agent could not answer and escalated to a human (AGENT_CONTRACT §1 customer_service). */
    public record HandoffRequested(UUID tenantId, UUID userId, UUID merchantId, UUID conversationId,
                                   UUID handoffId, String reason, Map<String, Object> payload)
            implements NexusDomainEvent {
        @Override
        public String template() {
            return "handoff_requested";
        }
    }

    /** A merchant answered a handed-off thread; the consumer is told their question has been picked up. */
    public record HandoffResolved(UUID tenantId, UUID userId, UUID merchantId, UUID conversationId,
                                  UUID handoffId, Map<String, Object> payload) implements NexusDomainEvent {
        @Override
        public String template() {
            return "handoff_resolved";
        }
    }

    /** Order moved between statuses (§6 status machine). */
    public record OrderStatusChanged(UUID tenantId, UUID userId, UUID merchantId, UUID orderId,
                                     String fromStatus, String toStatus, Map<String, Object> payload)
            implements NexusDomainEvent {
        @Override
        public String template() {
            return "order_" + toStatus;
        }
    }
}
