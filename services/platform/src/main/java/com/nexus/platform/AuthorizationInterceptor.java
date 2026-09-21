package com.nexus.platform;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Enforces {@code @RequiresAuth}, {@code @RequiresPermission}, {@code @RequiresPlatformRole} and the
 * presence of {@code Idempotency-Key} (plus the CSRF double-submit check for cookie writes).
 */
public class AuthorizationInterceptor implements HandlerInterceptor {

    private static final Logger log = LoggerFactory.getLogger(AuthorizationInterceptor.class);

    private final PermissionService permissions;
    private final WorkspaceAccess workspace;
    private final AuditService audit;

    public AuthorizationInterceptor(PermissionService permissions, WorkspaceAccess workspace, AuditService audit) {
        this.permissions = permissions;
        this.workspace = workspace;
        this.audit = audit;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }
        RequiresAuth auth = find(method, RequiresAuth.class);
        RequiresPermission perm = find(method, RequiresPermission.class);
        RequiresPlatformRole role = find(method, RequiresPlatformRole.class);
        Idempotent idem = method.getMethodAnnotation(Idempotent.class);
        if (auth == null && perm == null && role == null && idem == null) {
            return true;
        }

        TenantContext tenant = Req.tenant(request);
        Principal principal = Req.principalOrNull(request);
        boolean needsPrincipal = auth != null || perm != null || role != null;
        if (needsPrincipal && principal == null) {
            throw ApiException.unauthorized("unauthorized", "Sign in to call this endpoint");
        }
        if (principal != null) {
            Req.requireCsrfForCookieWrites(request);
        }

        if (role != null) {
            if (!principal.hasPlatformRole(role.value())) {
                audit.denied(request, "platform_role:" + String.join("|", role.value()), null,
                        "role=" + principal.role());
                throw ApiException.forbidden("This endpoint requires a platform role",
                        Json.map("required_roles", java.util.List.of(role.value())));
            }
            audit.record(request, "admin_access", "endpoint", null, null, null, null,
                    Json.map("path", request.getRequestURI()));
        }

        if (perm != null) {
            java.util.UUID merchantId = workspace.resolveMerchantId(tenant, request, method, perm.merchant());
            String subjectType = principal.subjectType();
            // merchant_users act with subject_type='merchant_user' too: check both spellings of the same
            // human subject, since grants are written for the membership row's role holder.
            boolean allowed = permissions.has(tenant, subjectType, principal.subjectId(), merchantId, perm.value())
                    || (!"merchant_user".equals(subjectType)
                        && permissions.has(tenant, "merchant_user", principal.subjectId(), merchantId, perm.value()))
                    || (principal.userId() != null && !principal.userId().equals(principal.subjectId())
                        && permissions.has(tenant, "user", principal.userId(), merchantId, perm.value()));
            if (!allowed) {
                audit.denied(request, perm.value(), merchantId,
                        "subject=" + subjectType + ":" + principal.subjectId());
                log.info("permission_denied permission={} merchant={} subject_type={}", perm.value(), merchantId,
                        subjectType);
                throw ApiException.forbidden("You do not have permission '" + perm.value() + "' for this merchant",
                        Json.map("permission", perm.value(), "merchant_id", merchantId));
            }
            request.setAttribute("nexus.merchant_scope", merchantId);
        }

        if (idem != null) {
            String key = request.getHeader("Idempotency-Key");
            if (key == null || key.isBlank() || key.length() > 200) {
                throw ApiException.validation("Idempotency-Key header is required for this operation",
                        Json.map("header", "Idempotency-Key", "scope", idem.scope()));
            }
        }
        return true;
    }

    private static <A extends java.lang.annotation.Annotation> A find(HandlerMethod method, Class<A> type) {
        A onMethod = method.getMethodAnnotation(type);
        return onMethod != null ? onMethod : method.getBeanType().getAnnotation(type);
    }
}
