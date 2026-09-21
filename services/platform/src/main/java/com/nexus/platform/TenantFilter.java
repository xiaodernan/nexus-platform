package com.nexus.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Tenant resolution (§1, D5): {@code X-Tenant} header → hostname first label → configured default.
 * Resolution happens before any handler runs, so no query can execute without a tenant.
 */
public class TenantFilter extends OncePerRequestFilter {

    private final TenantService tenants;
    private final String defaultSlug;
    private final boolean fromHostname;

    public TenantFilter(TenantService tenants,
                        @Value("${nexus.tenant.default-slug:hong-kong}") String defaultSlug,
                        @Value("${nexus.tenant.resolve-from-hostname:true}") boolean fromHostname) {
        this.tenants = tenants;
        this.defaultSlug = defaultSlug;
        this.fromHostname = fromHostname;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String slug = request.getHeader("X-Tenant");
        if ((slug == null || slug.isBlank()) && fromHostname) {
            slug = fromHost(request);
        }
        if (slug == null || slug.isBlank()) {
            slug = defaultSlug;
        }
        TenantContext ctx = tenants.resolve(slug);
        if (ctx == null) {
            // Unknown tenant is an enumeration-safe 404, not a 403.
            writeTenantError(response, 404, "tenant_not_found",
                    "Unknown tenant '" + slug + "'. Send X-Tenant: <slug> or use a known hostname.");
            return;
        }
        request.setAttribute(Req.ATTR_TENANT, ctx);
        MDC.put("tenant_id", ctx.idString());
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove("tenant_id");
        }
    }

    private static String fromHost(HttpServletRequest request) {
        String host = request.getHeader("X-Forwarded-Host");
        if (host == null || host.isBlank()) {
            host = request.getHeader("Host");
        }
        if (host == null || host.isBlank()) {
            return null;
        }
        String first = host.split(",")[0].trim().split("\\.")[0].split(":")[0];
        // localhost / IP-shaped hosts are not tenant slugs.
        if (first.isEmpty() || first.equals("localhost") || first.matches("\\d+")) {
            return null;
        }
        return first;
    }

    private void writeTenantError(HttpServletResponse response, int status, String code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        response.getWriter().write(Json.write(ApiExceptionHandler.envelope(code, message, java.util.Map.of(),
                RequestIds.current())));
    }
}
