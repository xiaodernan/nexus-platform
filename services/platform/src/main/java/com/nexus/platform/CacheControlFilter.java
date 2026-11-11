package com.nexus.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * D935 — every `/api/v1` response carries an explicit freshness policy instead of relying on
 * heuristic caching rules.
 *
 * <p>Almost every JSON response this monolith emits is tenant-scoped or personal: catalog for one
 * tenant, one merchant's keys, one consumer's orders. HTTP's heuristic rules would only ever let an
 * intermediary cache a response with validators we do not send (no {@code Last-Modified}, no
 * {@code ETag} on these reads), so nothing was leaking today — but "no cache by accident" is a
 * sector the platform cannot audit or promise. §52's own rule is that authorisation and visibility
 * are what the code says out loud, and the freshness marking of a response is the same kind of
 * property.
 *
 * <p>This filter sets {@code Cache-Control: no-store} and {@code Pragma: no-cache} FIRST, before any
 * downstream handler runs. The handlers that want a public policy inside this mount — the catalog,
 * collections, SEO and geo reads, and `GET /api/v1/merchants/{slug}/ucp.json` — call {@code setHeader}
 * with the same name, and the later write REPLACES this one: the override is guaranteed by the servlet
 * contract, not by an allow-list here. The {@code .well-known/ucp} probe stays public outside this
 * mount. Error responses written by upstream filters (tenant refusals, rate-limit 429s, login 401s) get
 * the same mark because this filter is registered before them in the chain, on the same response object.
 */
public class CacheControlFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Pragma", "no-cache");
        try {
            chain.doFilter(request, response);
        } catch (ServletException | IOException | RuntimeException e) {
            // the header is already on the response; propagation carries the 5xx as usual
            throw e;
        }
    }
}
