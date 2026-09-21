package com.nexus.platform;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.servers.Server;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Generated spec at {@code /v3/api-docs} (UI at /swagger-ui) — API_CONTRACT §11 build output. */
@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI nexusOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("NEXUS platform API")
                        .version("v1")
                        .description("Commerce core: auth/RBAC, merchants, catalog, carts, orders, "
                                + "reservations, payments, growth, analytics, admin. AI surfaces "
                                + "(/ai/v1/**, /mcp, /api/v1/ai/**) belong to the AI service."))
                .servers(List.of(new Server().url("/").description("This deployment")))
                .components(new Components()
                        .addSecuritySchemes("bearer", new SecurityScheme()
                                .type(SecurityScheme.Type.HTTP).scheme("bearer").bearerFormat("JWT")
                                .description("Access JWT (HS256 in dev). Claims: sub, tid, typ, sid, jti, iat, exp."))
                        .addSecuritySchemes("cookieAuth", new SecurityScheme()
                                .type(SecurityScheme.Type.APIKEY).in(SecurityScheme.In.COOKIE).name("nexus_session")
                                .description("HttpOnly session cookie; state-changing requests also need X-CSRF-Token."))
                        .addSecuritySchemes("merchantApiKey", new SecurityScheme()
                                .type(SecurityScheme.Type.APIKEY).in(SecurityScheme.In.HEADER).name("Authorization")
                                .description("Merchant API key as `Bearer nx_live_...`; checked against scopes."))
                        .addSecuritySchemes("tenant", new SecurityScheme()
                                .type(SecurityScheme.Type.APIKEY).in(SecurityScheme.In.HEADER).name("X-Tenant")
                                .description("Market/tenant slug, e.g. hong-kong.")))
                .addSecurityItem(new SecurityRequirement().addList("bearer"))
                .addSecurityItem(new SecurityRequirement().addList("tenant"));
    }
}
