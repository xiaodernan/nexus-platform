package com.nexus.identity;

import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Auth endpoints — API_CONTRACT §3. Rate limited by {@code RateLimitFilter} (scope {@code auth-ip}). */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    /** Register body. Argon2id hashing happens server-side; nothing here is stored raw. */
    public record RegisterRequest(
            @NotBlank @Email @Size(max = 254) String email,
            @NotBlank @Size(min = 10, max = 256, message = "password must be at least 10 characters") String password,
            @NotBlank @Size(max = 120) String displayName,
            @Pattern(regexp = "^(en|zh-HK|zh-CN)$") String locale,
            @NotNull Boolean acceptTerms) {
    }

    public record LoginRequest(@NotBlank @Email String email, @NotBlank String password) {
    }

    public record OAuthRequest(@NotBlank @Size(max = 8192) String idToken) {
    }

    public record RefreshRequest(@NotBlank @Size(max = 8192) String refreshToken) {
    }

    public record DemoRequest(@Pattern(regexp = "^(consumer|merchant|admin)$") @NotBlank String role) {
    }

    private final AuthService auth;
    private final String cookieName;
    private final boolean demoEnabled;
    private final boolean secureCookies;

    public AuthController(AuthService auth,
                          @Value("${nexus.jwt.cookie-name:nexus_session}") String cookieName,
                          @Value("${nexus.demo.login-enabled:true}") boolean demoEnabled,
                          @Value("${nexus.cookies.secure:false}") boolean secureCookies) {
        this.auth = auth;
        this.cookieName = cookieName;
        this.demoEnabled = demoEnabled;
        this.secureCookies = secureCookies;
    }

    @PostMapping("/register")
    public Map<String, Object> register(@Valid @RequestBody RegisterRequest body, HttpServletRequest request,
                                        HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> out = auth.register(tenant, body.email().trim().toLowerCase(), body.password(),
                body.displayName().trim(), body.locale() == null ? "zh-HK" : body.locale(),
                Boolean.TRUE.equals(body.acceptTerms()), request);
        setSessionCookies(response, out, tenant);
        return out;
    }

    @PostMapping("/login")
    public Map<String, Object> login(@Valid @RequestBody LoginRequest body, HttpServletRequest request,
                                     HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> out = auth.login(tenant, body.email().trim().toLowerCase(), body.password(), request);
        setSessionCookies(response, out, tenant);
        return out;
    }

    @PostMapping("/oauth/{provider}")
    public Map<String, Object> oauth(@PathVariable String provider, @Valid @RequestBody OAuthRequest body,
                                     HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> out = auth.oauth(tenant, provider, body.idToken(), request);
        setSessionCookies(response, out, tenant);
        return out;
    }

    @PostMapping("/refresh")
    public Map<String, Object> refresh(@Valid @RequestBody RefreshRequest body, HttpServletRequest request,
                                       HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> out = auth.refresh(tenant, body.refreshToken(), request);
        setSessionCookies(response, out, tenant);
        return out;
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(HttpServletRequest request, HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        com.nexus.platform.Principal principal = Req.principalOrNull(request);
        auth.logout(tenant, request, principal == null ? null : principal.sid());
        expire(response, cookieName);
        expire(response, "nexus_csrf");
        return Json.map("status", "logged_out", "cleared", java.util.List.of(cookieName, "nexus_csrf"));
    }

    /** §87 demo session. Switch-gated: disabled by {@code nexus.demo.login-enabled=false}. */
    @PostMapping("/demo")
    public Map<String, Object> demo(@Valid @RequestBody DemoRequest body, HttpServletRequest request,
                                    HttpServletResponse response) {
        if (!demoEnabled) {
            throw com.nexus.platform.ApiException.forbidden("Demo logins are disabled on this deployment",
                    Json.map("setting", "nexus.demo.login-enabled"));
        }
        Map<String, Object> out = auth.demo(Req.tenant(request), body.role(), request);
        setSessionCookies(response, out, Req.tenant(request));
        DemoFlags.mark(response, true);
        return out;
    }

    @RequiresAuth
    @PostMapping("/session")
    public Map<String, Object> session(HttpServletRequest request) {
        com.nexus.platform.Principal p = Req.principal(request);
        return Json.map("subject_type", p.subjectType(), "user_id", String.valueOf(p.userId()),
                "tenant_id", String.valueOf(p.tenantId()), "role", p.role(), "session_id", p.sid(),
                "auth_method", p.authMethod());
    }

    private void setSessionCookies(HttpServletResponse response, Map<String, Object> out, TenantContext tenant) {
        Object accessToken = out.get("access_token");
        Object csrf = out.get("csrf_token");
        response.addHeader("Cache-Control", "no-store");
        if (accessToken instanceof String token) {
            // HttpOnly session cookie (§1); the SPA also keeps the bearer token for non-browser clients.
            response.addHeader("Set-Cookie", ResponseCookie.from(cookieName, token)
                    .httpOnly(true).secure(secureCookies).sameSite("Lax").path("/")
                    .maxAge(authAccessTtl(out)).build().toString());
        }
        if (csrf instanceof String token) {
            // Deliberately not HttpOnly: the client echoes it back in X-CSRF-Token (double-submit check).
            response.addHeader("Set-Cookie", ResponseCookie.from("nexus_csrf", token)
                    .httpOnly(false).secure(secureCookies).sameSite("Lax").path("/").maxAge(86400)
                    .build().toString());
        }
    }

    private static long authAccessTtl(Map<String, Object> out) {
        Object expiresIn = out.get("expires_in");
        return expiresIn instanceof Number n ? n.longValue() : 900L;
    }

    private void expire(HttpServletResponse response, String name) {
        response.addHeader("Set-Cookie", ResponseCookie.from(name, "").httpOnly(true)
                .sameSite("Lax").path("/").maxAge(0).build().toString());
    }
}
