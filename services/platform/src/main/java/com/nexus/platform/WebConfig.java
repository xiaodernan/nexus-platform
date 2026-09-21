package com.nexus.platform;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final PermissionService permissions;
    private final WorkspaceAccess workspace;
    private final AuditService audit;

    public WebConfig(PermissionService permissions, WorkspaceAccess workspace, AuditService audit) {
        this.permissions = permissions;
        this.workspace = workspace;
        this.audit = audit;
    }

    @Bean
    public AuthorizationInterceptor authorizationInterceptor() {
        return new AuthorizationInterceptor(permissions, workspace, audit);
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authorizationInterceptor()).addPathPatterns("/api/v1/**");
    }
}
