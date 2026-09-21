package com.nexus.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;

/** Assigns / echoes {@code X-Request-Id} and puts it in the MDC + structured log context (§1). */
public class RequestIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String inbound = request.getHeader("X-Request-Id");
        String requestId = (inbound != null && inbound.matches("[A-Za-z0-9._-]{1,64}"))
                ? inbound : UUID.randomUUID().toString();
        request.setAttribute("nexus.request_id", requestId);
        RequestIds.set(requestId);
        MDC.put("tenant_id", "");
        response.setHeader("X-Request-Id", requestId);
        try {
            chain.doFilter(request, response);
        } finally {
            RequestIds.clear();
            MDC.remove("tenant_id");
        }
    }
}
