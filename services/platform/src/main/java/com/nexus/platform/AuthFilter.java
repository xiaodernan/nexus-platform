package com.nexus.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Resolves the caller — bearer JWT, {@code nexus_session} cookie, or a merchant API key — into a
 * {@link Principal} request attribute. Anonymous requests pass through unauthenticated; enforcement
 * is declarative ({@code @RequiresAuth} / {@code @RequiresPermission} / {@code @RequiresPlatformRole}).
 */
public class AuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(AuthFilter.class);

    private final JwtService jwt;
    private final ObjectProvider<ApiKeyVerifier> apiKeys;
    private final String cookieName;

    public AuthFilter(JwtService jwt, ObjectProvider<ApiKeyVerifier> apiKeys,
                      @org.springframework.beans.factory.annotation.Value("${nexus.jwt.cookie-name:nexus_session}")
                      String cookieName) {
        this.jwt = jwt;
        this.apiKeys = apiKeys;
        this.cookieName = cookieName;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        TenantContext tenant = Req.tenant(request);
        String bearer = bearer(request);
        try {
            if (bearer != null && bearer.startsWith("nx_")) {
                ApiKeyVerifier verifier = apiKeys.getIfAvailable();
                Optional<Principal> resolved = verifier == null ? Optional.empty() : verifier.verify(bearer, tenant);
                if (resolved.isEmpty()) {
                    throw ApiException.unauthorized("invalid_api_key", "API key is unknown, revoked, or scoped to another tenant");
                }
                request.setAttribute(Req.ATTR_PRINCIPAL, resolved.get());
                ApiKeyVerifier v = verifier;
                if (v != null && resolved.get().subjectId() != null) {
                    v.touch(resolved.get().subjectId());
                }
            } else if (bearer != null) {
                request.setAttribute(Req.ATTR_PRINCIPAL, principalFromToken(bearer, tenant, "bearer"));
            } else {
                String cookie = Req.readCookie(request, cookieName);
                if (cookie != null && !cookie.isBlank()) {
                    request.setAttribute(Req.ATTR_PRINCIPAL, principalFromToken(cookie, tenant, "cookie"));
                }
            }
        } catch (ApiException e) {
            // Expired/invalid credentials are a 401 at the boundary, not a silent downgrade to anonymous:
            // a caller who sent a token must learn it failed.
            log.info("auth_rejected code={} message={}", e.code(), e.getMessage());
            response.setStatus(e.status());
            response.setContentType("application/json");
            response.setCharacterEncoding("UTF-8");
            response.getWriter().write(Json.write(ApiExceptionHandler.envelope(e.code(), e.getMessage(),
                    e.details(), RequestIds.current())));
            return;
        }
        chain.doFilter(request, response);
    }

    private Principal principalFromToken(String token, TenantContext tenant, String method) {
        Map<String, Object> claims = jwt.verify(token);
        if (!"access".equals(JwtService.stringClaim(claims, "typ"))) {
            throw ApiException.unauthorized("wrong_token_type", "A refresh token cannot be used to call APIs");
        }
        String tid = JwtService.stringClaim(claims, "tid");
        if (tid == null || !tid.equals(tenant.idString())) {
            throw ApiException.unauthorized("tenant_mismatch", "This session belongs to another tenant");
        }
        UUID userId = RequestIds.asUuidOrNull(JwtService.stringClaim(claims, "sub"));
        if (userId == null) {
            throw ApiException.unauthorized("invalid_token", "Token subject is malformed");
        }
        return new Principal("user", userId, userId, tenant.tenantId(),
                JwtService.stringClaim(claims, "role"),
                RequestIds.asUuidOrNull(JwtService.stringClaim(claims, "mer")),
                JwtService.stringClaim(claims, "sid"),
                JwtService.stringClaim(claims, "jti"),
                method);
    }

    private static String bearer(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header == null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return null;
        }
        String value = header.substring(7).trim();
        return value.isEmpty() ? null : value;
    }
}
