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
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Idempotent {

    String scope();
}
