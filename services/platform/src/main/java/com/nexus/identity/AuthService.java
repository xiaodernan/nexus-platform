package com.nexus.identity;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.JwtService;
import com.nexus.platform.Json;
import com.nexus.platform.PasswordHasher;
import com.nexus.platform.Principal;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TokenRegistry;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Register / login / refresh / logout / demo-session token flows (API_CONTRACT §3).
 *
 * <p>Passwords are Argon2id. Access tokens are 15m HS256 JWTs, refresh tokens 30d and rotating with
 * reuse detection via {@link TokenRegistry}. No secret ever lands in a response body beyond the
 * tokens themselves.
 */
@Service
public class AuthService {

    private final IdentityRepository users;
    private final PasswordHasher hasher;
    private final JwtService jwt;
    private final TokenRegistry registry;
    private final AuditService audit;
    private final OAuthVerifierRegistry oauth;

    public AuthService(IdentityRepository users, PasswordHasher hasher, JwtService jwt, TokenRegistry registry,
                       AuditService audit, OAuthVerifierRegistry oauth) {
        this.users = users;
        this.hasher = hasher;
        this.jwt = jwt;
        this.registry = registry;
        this.audit = audit;
        this.oauth = oauth;
    }

    public record TokenBundle(String accessToken, String refreshToken, long expiresIn, String csrfToken,
                              String sessionId) {
    }

    public Map<String, Object> register(TenantContext tenant, String email, String password, String displayName,
                                        String locale, boolean acceptTerms, HttpServletRequest request) {
        if (!acceptTerms) {
            throw ApiException.validation("accept_terms must be true to register", Json.map("field", "accept_terms"));
        }
        if (users.findUserByEmail(tenant, email).isPresent()) {
            // 409 with a generic message; the email is echoed only to the caller who just typed it.
            throw ApiException.conflict("email_taken", "That email is already registered in this tenant", Map.of());
        }
        UUID id = users.insertUser(tenant, email, hasher.hash(password), displayName, locale, "consumer", false);
        users.linkIdentity(tenant, id, "password", email);
        Map<String, Object> row = users.requireUser(tenant, id);
        TokenBundle bundle = issueTokens(tenant, id, Json.str(row, "role"), null);
        audit.record(tenant, "user", id, "register", "user", id, null, null, userView(tenant, row),
                Json.map("locale", locale), Req0.ip(request), Req0.userAgent(request));
        return withTokens(userView(tenant, row), bundle);
    }

    public Map<String, Object> login(TenantContext tenant, String email, String password, HttpServletRequest request) {
        Optional<Map<String, Object>> found = users.findUserByEmail(tenant, email);
        if (found.isEmpty()) {
            audit.record(tenant, "anonymous", null, "login_failed", "user", null, null, null, null,
                    Json.map("email", email), Req0.ip(request), Req0.userAgent(request));
            throw ApiException.unauthorized("invalid_credentials", "Email or password is incorrect");
        }
        Map<String, Object> row = found.get();
        String hash = Json.str(row, "password_hash");
        if (hash == null || !hasher.matches(password, hash)) {
            audit.record(tenant, "user", Json.uuid(row, "id"), "login_failed", "user", Json.uuid(row, "id"), null,
                    null, null, Json.map(), Req0.ip(request), Req0.userAgent(request));
            throw ApiException.unauthorized("invalid_credentials", "Email or password is incorrect");
        }
        if (!"active".equals(Json.str(row, "status"))) {
            throw ApiException.forbidden("Account is not active", Json.map("status", Json.str(row, "status")));
        }
        UUID id = Json.uuid(row, "id");
        users.touchLastLogin(tenant, id);
        TokenBundle bundle = issueTokens(tenant, id, Json.str(row, "role"), null);
        audit.record(tenant, "user", id, "login", "user", id, null, null, null, Json.map(),
                Req0.ip(request), Req0.userAgent(request));
        return withTokens(userView(tenant, users.requireUser(tenant, id)), bundle);
    }

    /**
     * OAuth login (§3). The JWT is verified by an {@link OAuthTokenVerifier} chosen by provider; the
     * {@code dev} verifier is used outside production and is explicitly labelled in the response.
     */
    public Map<String, Object> oauth(TenantContext tenant, String provider, String idToken, HttpServletRequest request) {
        OAuthIdentity identity = oauth.verifierFor(provider)
                .orElseThrow(() -> ApiException.validation("Unsupported oauth provider",
                        Json.map("provider", provider, "supported", oauth.supported())))
                .verify(idToken)
                .orElseThrow(() -> ApiException.unauthorized("invalid_id_token",
                        "Provider token could not be verified (provider=" + provider + ")"));

        Optional<Map<String, Object>> link = users.findIdentity(tenant, provider, identity.subject());
        UUID userId;
        boolean created = false;
        if (link.isEmpty()) {
            Optional<Map<String, Object>> byEmail = identity.email() == null
                    ? Optional.empty() : users.findUserByEmail(tenant, identity.email());
            userId = byEmail.map(r -> Json.uuid(r, "id")).orElseGet(() -> {
                UUID id = users.insertUser(tenant, identity.email(), null, identity.displayName(),
                        identity.locale() == null ? "zh-HK" : identity.locale(), "consumer", false);
                return id;
            });
            users.linkIdentity(tenant, userId, provider, identity.subject());
            created = true;
        } else {
            userId = Json.uuid(link.get(), "user_id");
        }
        Map<String, Object> row = users.requireUser(tenant, userId);
        users.touchLastLogin(tenant, userId);
        TokenBundle bundle = issueTokens(tenant, userId, Json.str(row, "role"), null);
        audit.record(tenant, "user", userId, "login_oauth", "user", userId, null, null, null,
                Json.map("provider", provider, "created", created), Req0.ip(request), Req0.userAgent(request));
        Map<String, Object> out = withTokens(userView(tenant, row), bundle);
        out.put("oauth", Json.map("provider", provider, "verifier", oauth.verifierName(provider),
                "account_created", created));
        return out;
    }

    /** Rotation + reuse detection: an old refresh token revokes the whole family. */
    public Map<String, Object> refresh(TenantContext tenant, String refreshToken, HttpServletRequest request) {
        Map<String, Object> claims;
        try {
            claims = jwt.verify(refreshToken);
        } catch (ApiException e) {
            throw ApiException.unauthorized("invalid_refresh_token", "Refresh token rejected");
        }
        if (!"refresh".equals(JwtService.stringClaim(claims, "typ"))) {
            throw ApiException.unauthorized("invalid_refresh_token", "Expected a refresh token");
        }
        String sid = JwtService.stringClaim(claims, "sid");
        String jti = JwtService.stringClaim(claims, "jti");
        String sub = JwtService.stringClaim(claims, "sub");
        UUID userId = RequestIdsOrNull(sub);
        if (userId == null || sid == null || jti == null) {
            throw ApiException.unauthorized("invalid_refresh_token", "Refresh token is malformed");
        }
        if (!registry.accept(sid, jti)) {
            registry.revoke(sid);
            audit.record(tenant, "user", userId, "refresh_reuse_detected", "user", userId, null, null, null,
                    Json.map("sid", sid), Req0.ip(request), Req0.userAgent(request));
            throw ApiException.unauthorized("refresh_reuse_detected",
                    "This refresh token was already used; the session family has been revoked. Sign in again.");
        }
        Map<String, Object> row = users.requireUser(tenant, userId);
        if (!"active".equals(Json.str(row, "status"))) {
            throw ApiException.forbidden("Account is not active", Json.map("status", Json.str(row, "status")));
        }
        TokenBundle bundle = rotate(tenant, userId, Json.str(row, "role"), sid);
        audit.record(tenant, "user", userId, "refresh", "user", userId, null, null, null, Json.map(),
                Req0.ip(request), Req0.userAgent(request));
        return withTokens(userView(tenant, row), bundle);
    }

    public void logout(TenantContext tenant, HttpServletRequest request, String sid) {
        if (sid != null) {
            registry.revoke(sid);
        }
        Principal p = com.nexus.platform.Req.principalOrNull(request);
        if (p != null) {
            audit.record(tenant, p.subjectType(), p.subjectId(), "logout", "user", p.userId(), null, null, null,
                    Json.map(), Req0.ip(request), Req0.userAgent(request));
        }
    }

    /**
     * §87 demo session. Creates (once) a clearly-labelled synthetic account and hands back a scoped
     * session. The demo accounts have <em>no password</em>, so they can never be used against
     * {@code /auth/login}; the only way in is this endpoint, which is switch-gated.
     */
    public Map<String, Object> demo(TenantContext tenant, String role, HttpServletRequest request) {
        String email = switch (role) {
            case "consumer" -> "demo-consumer@example.hk";
            case "merchant" -> "demo-merchant@example.hk";
            case "admin" -> "demo-admin@example.hk";
            default -> throw ApiException.validation("role must be consumer|merchant|admin", Json.map("field", "role"));
        };
        String userRole = switch (role) {
            case "admin" -> "platform_admin";
            default -> "consumer";
        };
        Map<String, Object> row = users.findUserByEmail(tenant, email).orElseGet(() -> {
            UUID id = users.insertUser(tenant, email, null, "Demo " + role, "zh-HK", userRole, false);
            users.linkIdentity(tenant, id, "demo", email);
            return users.requireUser(tenant, id);
        });
        UUID userId = Json.uuid(row, "id");
        TokenBundle bundle = issueTokens(tenant, userId, Json.str(row, "role"), null);
        audit.record(tenant, "user", userId, "login_demo", "user", userId, null, null, null,
                Json.map("requested_role", role), Req0.ip(request), Req0.userAgent(request));
        Map<String, Object> out = withTokens(userView(tenant, row), bundle);
        out.put("flags", Json.map("demo", true, "synthetic", true));
        out.put("demo_notice", "Synthetic demo session (§87). No real account, payment or merchant data is involved.");
        return out;
    }

    // ---- tokens ---------------------------------------------------------

    TokenBundle issueTokens(TenantContext tenant, UUID userId, String role, UUID merchantId) {
        String sid = UUID.randomUUID().toString();
        String accessJti = UUID.randomUUID().toString();
        String refreshJti = UUID.randomUUID().toString();
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("role", role);
        if (merchantId != null) {
            extra.put("mer", merchantId.toString());
        }
        String access = jwt.sign(jwt.claims("access", userId.toString(), tenant.idString(), sid, accessJti, extra));
        String refresh = jwt.sign(jwt.claims("refresh", userId.toString(), tenant.idString(), sid, refreshJti, extra));
        registry.registerFamily(sid, refreshJti, Duration.ofSeconds(jwt.refreshTtlSeconds()));
        return new TokenBundle(access, refresh, jwt.accessTtlSeconds(), hasher.randomToken(16), sid);
    }

    private TokenBundle rotate(TenantContext tenant, UUID userId, String role, String sid) {
        String accessJti = UUID.randomUUID().toString();
        String refreshJti = UUID.randomUUID().toString();
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("role", role);
        String access = jwt.sign(jwt.claims("access", userId.toString(), tenant.idString(), sid, accessJti, extra));
        String refresh = jwt.sign(jwt.claims("refresh", userId.toString(), tenant.idString(), sid, refreshJti, extra));
        registry.rotate(sid, refreshJti, Duration.ofSeconds(jwt.refreshTtlSeconds()));
        return new TokenBundle(access, refresh, jwt.accessTtlSeconds(), hasher.randomToken(16), sid);
    }

    private static UUID RequestIdsOrNull(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    // ---- views ----------------------------------------------------------

    public static Map<String, Object> userView(TenantContext tenant, Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", Json.str(row, "id"));
        out.put("email", Json.str(row, "email"));
        out.put("display_name", Json.str(row, "display_name"));
        out.put("avatar_url", Json.str(row, "avatar_url"));
        out.put("locale", Json.str(row, "locale"));
        out.put("role", Json.str(row, "role"));
        out.put("status", Json.str(row, "status"));
        out.put("marketing_opt_in", Json.bool(row, "marketing_opt_in"));
        out.put("tenant", tenant.slug());
        out.put("currency", tenant.currency());
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("flags", Json.map("demo", false));
        return out;
    }

    static Map<String, Object> withTokens(Map<String, Object> user, TokenBundle bundle) {
        Map<String, Object> out = new LinkedHashMap<>(user);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("user", out);
        payload.put("access_token", bundle.accessToken());
        payload.put("refresh_token", bundle.refreshToken());
        payload.put("token_type", "Bearer");
        payload.put("expires_in", bundle.expiresIn());
        payload.put("csrf_token", bundle.csrfToken());
        payload.put("session_id", bundle.sessionId());
        return payload;
    }

    /** Small indirection so the service stays free of servlet-attribute plumbing. */
    static final class Req0 {
        static String ip(HttpServletRequest request) {
            return request == null ? null : com.nexus.platform.Req.clientIp(request);
        }

        static String userAgent(HttpServletRequest request) {
            return request == null ? null : request.getHeader("User-Agent");
        }
    }
}
