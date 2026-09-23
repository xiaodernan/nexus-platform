package com.nexus.platform;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks endpoints where {@code Idempotency-Key} is required (§1: checkout, payment, reservation
 * create, review create, campaign publish). The interceptor enforces presence and tenant/subject
 * binding; {@link IdempotencyService} stores and replays the response inside the transactional
 * handler, because only the handler knows the response shape.
 *
 * <p>Of the five operations §1 names, two are served by this build and only one of those requires the key —
 * review create. Four of the markers on the running router are not in that list at all: {@code events},
 * {@code member}, {@code api_key} and {@code moderation_resolve} each wrap their answer in
 * {@link IdempotencyService#run}, so each needs the header the replay depends on. A retried reservation create
 * is safe without one — {@code reservations_slot_user_uniq} (V2) makes one live hold per person per slot a
 * database rule and {@code POST /api/v1/reservations} answers the retry with the same code at 200 instead of
 * 201 — and checkout, payment and campaign publish have no route here yet, so nothing declares them.
 * {@code IdempotencyPairingTest} reads the source for {@code run("scope"} call sites and refuses a
 * scope whose handler does not carry this annotation with the same string.
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Idempotent {

    String scope();
}
