package com.nexus.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Rate limits the three scopes the contract cares about (§1, §47): auth endpoints per client IP,
 * AI-ish endpoints per principal, and every write per principal (or IP when anonymous).
 *
 * <p>A scope is declared here as a path prefix, and {@code RateLimitScopeRoutesTest} refuses a prefix this
 * service's own router does not serve. Until D49 that rule had no teeth, and the AI scope carried
 * {@code /api/v1/ai/} — a prefix this service's OpenAPI description and {@code API_CONTRACT} §7 both disclaim to
 * the AI service, so the line could only ever charge a bucket to a request that then 404s. The AI-ish door this
 * build does serve is {@code /api/v1/merchant/ai-agent}. A future route elsewhere has to say so here, which is
 * what the gate is for; leaving a dead prefix in place would have been the same unread promise from the other
 * side.
 */
public class RateLimitFilter extends OncePerRequestFilter {

    private final RateLimiter limiter;
    private final int authRequests;
    private final Duration authWindow;
    private final int aiRequests;
    private final Duration aiWindow;
    private final int writeRequests;
    private final Duration writeWindow;

    public RateLimitFilter(RateLimiter limiter,
                           @Value("${nexus.ratelimit.auth-requests:10}") int authRequests,
                           @Value("${nexus.ratelimit.auth-window-seconds:300}") long authWindowSeconds,
                           @Value("${nexus.ratelimit.ai-requests:20}") int aiRequests,
                           @Value("${nexus.ratelimit.ai-window-seconds:60}") long aiWindowSeconds,
                           @Value("${nexus.ratelimit.write-requests:60}") int writeRequests,
                           @Value("${nexus.ratelimit.write-window-seconds:60}") long writeWindowSeconds) {
        this.limiter = limiter;
        this.authRequests = authRequests;
        this.authWindow = Duration.ofSeconds(authWindowSeconds);
        this.aiRequests = aiRequests;
        this.aiWindow = Duration.ofSeconds(aiWindowSeconds);
        this.writeRequests = writeRequests;
        this.writeWindow = Duration.ofSeconds(writeWindowSeconds);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        if (path == null || !path.startsWith("/api/v1/")) {
            chain.doFilter(request, response);
            return;
        }
        Principal principal = Req.principalOrNull(request);
        String actor = principal != null ? principal.subjectId().toString() : Req.clientIp(request);
        boolean mutating = switch (request.getMethod()) {
            case "POST", "PUT", "PATCH", "DELETE" -> true;
            default -> false;
        };

        try {
            if (path.startsWith("/api/v1/auth/")) {
                apply(response, limiter.check("auth-ip", Req.clientIp(request), authRequests, authWindow));
            }
            if (path.startsWith("/api/v1/merchant/ai-agent")) {
                apply(response, limiter.check("ai", actor, aiRequests, aiWindow));
            }
            if (mutating && !path.startsWith("/api/v1/auth/")) {
                apply(response, limiter.check("write", actor, writeRequests, writeWindow));
            }
        } catch (ApiException e) {
            response.setStatus(e.status());
            response.setHeader("Retry-After", String.valueOf(e.details().getOrDefault("retry_after", 1)));
            response.setContentType("application/json");
            response.getWriter().write(Json.write(ApiExceptionHandler.envelope(e.code(), e.getMessage(),
                    e.details(), RequestIds.current())));
            return;
        }
        chain.doFilter(request, response);
    }

    private static void apply(HttpServletResponse response, RateLimiter.Outcome out) {
        response.setHeader("X-RateLimit-Limit", String.valueOf(out.limit()));
        response.setHeader("X-RateLimit-Remaining", String.valueOf(out.remaining()));
        if (!out.allowed()) {
            throw ApiException.rateLimited("Rate limit exceeded, slow down.", out.retryAfterSeconds());
        }
    }
}
