package com.nexus.platform;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Declarative RBAC against {@code permission_grants} — the source of truth (D5, AGENT_CONTRACT §8).
 *
 * <p>{@link #merchant()} says how the target merchant is resolved for the grant check:
 * <ul>
 *   <li>{@code ""} — tenant/platform scoped grant ({@code permission_grants.merchant_id IS NULL})</li>
 *   <li>{@code param:<name>} — path variable or query parameter holding a merchant id</li>
 *   <li>{@code body:<field>} — JSON field of the (cached) request body holding a merchant id</li>
 *   <li>{@code offering:<name>} / {@code order:<name>} / {@code campaign:<name>}
 *       / {@code conversation:<name>} / {@code reservation:<name>} / {@code importjob:<name>}
 *       — id of a child row whose merchant is looked up (tenant-checked)</li>
 *   <li>{@code business:<name>} — id of a {@code merchants} row owned by the caller's tenant</li>
 * </ul>
 *
 * <p>Denial → 403 {@code forbidden} + {@code audit_logs(action='permission_denied')}; a merchant that
 * is not in the caller's tenant → 404 (no enumeration).
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiresPermission {

    String value();

    String merchant() default "";
}
