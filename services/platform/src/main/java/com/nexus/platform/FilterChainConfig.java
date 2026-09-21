package com.nexus.platform;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

/** Filter order is load-bearing: request id → tenant → auth → body cache → rate limit. */
@Configuration
public class FilterChainConfig {

    @Bean
    public FilterRegistrationBean<RequestIdFilter> requestIdFilter() {
        FilterRegistrationBean<RequestIdFilter> bean = new FilterRegistrationBean<>(new RequestIdFilter());
        bean.addUrlPatterns("/*");
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 10);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<TenantFilter> tenantFilter(TenantService tenants,
                                                             @Value("${nexus.tenant.default-slug:hong-kong}")
                                                             String defaultSlug,
                                                             @Value("${nexus.tenant.resolve-from-hostname:true}")
                                                             boolean fromHostname) {
        FilterRegistrationBean<TenantFilter> bean =
                new FilterRegistrationBean<>(new TenantFilter(tenants, defaultSlug, fromHostname));
        // Only /api/v1 needs a tenant; OpenAPI + actuator-ish probes stay tenant-free.
        bean.addUrlPatterns("/api/v1/*");
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 20);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<AuthFilter> authFilter(JwtService jwt, ObjectProvider<ApiKeyVerifier> apiKeys,
                                                         @Value("${nexus.jwt.cookie-name:nexus_session}")
                                                         String cookieName) {
        FilterRegistrationBean<AuthFilter> bean =
                new FilterRegistrationBean<>(new AuthFilter(jwt, apiKeys, cookieName));
        bean.addUrlPatterns("/api/v1/*");
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 30);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<CachedBodyFilter> cachedBodyFilter() {
        FilterRegistrationBean<CachedBodyFilter> bean = new FilterRegistrationBean<>(new CachedBodyFilter());
        bean.addUrlPatterns("/api/v1/*");
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 40);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<RateLimitFilter> rateLimitFilter(
            RateLimiter limiter,
            @Value("${nexus.ratelimit.auth-requests:10}") int authRequests,
            @Value("${nexus.ratelimit.auth-window-seconds:300}") long authWindow,
            @Value("${nexus.ratelimit.ai-requests:20}") int aiRequests,
            @Value("${nexus.ratelimit.ai-window-seconds:60}") long aiWindow,
            @Value("${nexus.ratelimit.write-requests:60}") int writeRequests,
            @Value("${nexus.ratelimit.write-window-seconds:60}") long writeWindow) {
        FilterRegistrationBean<RateLimitFilter> bean = new FilterRegistrationBean<>(new RateLimitFilter(
                limiter, authRequests, authWindow, aiRequests, aiWindow, writeRequests, writeWindow));
        bean.addUrlPatterns("/api/v1/*");
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 50);
        return bean;
    }
}
