package com.nexus.platform;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;

/** Typed accessors for the request attributes the filters install. */
public final class Req {

    public static final String ATTR_TENANT = "nexus.tenant";
    public static final String ATTR_PRINCIPAL = "nexus.principal";
    public static final String ATTR_SESSION_ID = "nexus.session_id";

    private Req() {
    }

    public static TenantContext tenant(HttpServletRequest request) {
        Object v = request.getAttribute(ATTR_TENANT);
        if (v instanceof TenantContext tc) {
            return tc;
        }
        throw ApiException.internal("Tenant filter did not run for " + request.getRequestURI(), null);
    }

    /** Null when the caller is anonymous. */
    public static Principal principalOrNull(HttpServletRequest request) {
        Object v = request.getAttribute(ATTR_PRINCIPAL);
        return v instanceof Principal p ? p : null;
    }

    public static Principal principal(HttpServletRequest request) {
        Principal p = principalOrNull(request);
        if (p == null) {
            throw ApiException.unauthorized("unauthorized", "A valid bearer token or nexus_session cookie is required");
        }
        return p;
    }

    public static UUID userId(HttpServletRequest request) {
        return principal(request).userId();
    }

    /** Anonymous cart session id: client-provided {@code X-Session-Id} or a fresh uuid. */
    public static String sessionId(HttpServletRequest request) {
        Object cached = request.getAttribute(ATTR_SESSION_ID);
        if (cached instanceof String s) {
            return s;
        }
        String header = request.getHeader("X-Session-Id");
        String sid = (header != null && header.matches("[A-Za-z0-9_-]{8,64}")) ? header : UUID.randomUUID().toString();
        request.setAttribute(ATTR_SESSION_ID, sid);
        return sid;
    }

    public static String requestId(HttpServletRequest request) {
        Object v = request.getAttribute("nexus.request_id");
        return v == null ? "unknown" : String.valueOf(v);
    }

    public static String clientIp(HttpServletRequest request) {
        String fwd = request.getHeader("X-Forwarded-For");
        if (fwd != null && !fwd.isBlank()) {
            return fwd.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    /** True when auth came from the cookie rather than an explicit bearer token → CSRF applies. */
    public static boolean cookieAuth(HttpServletRequest request) {
        Principal p = principalOrNull(request);
        return p != null && "cookie".equals(p.authMethod());
    }

    public static void requireCsrfForCookieWrites(HttpServletRequest request) {
        if (!cookieAuth(request)) {
            return;
        }
        String method = request.getMethod();
        if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
            return;
        }
        String header = request.getHeader("X-CSRF-Token");
        String cookie = readCookie(request, "nexus_csrf");
        if (header == null || cookie == null || !header.equals(cookie)) {
            throw ApiException.forbidden("CSRF token missing or mismatched for cookie-authenticated write",
                    Map.of("expected_header", "X-CSRF-Token"));
        }
    }

    public static String readCookie(HttpServletRequest request, String name) {
        if (request.getCookies() == null) {
            return null;
        }
        for (var c : request.getCookies()) {
            if (name.equals(c.getName())) {
                return c.getValue();
            }
        }
        return null;
    }
}
