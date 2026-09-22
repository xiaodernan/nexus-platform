package com.nexus.testsupport;

import com.nexus.platform.JwtService;
import java.net.http.HttpClient;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

/**
 * Shared fixture plumbing for the platform integration tests: a real Postgres schema
 * ({@code nexus_test}, created by {@code scripts/db_apply_migrations.sh}) and a real HTTP stack, so
 * what is asserted is what a client actually receives — tenant resolution, the auth filter, the
 * {@code @RequiresPermission} interceptor, the error envelope and the SQL.
 *
 * <p>Every test gets its own tenant: the whole point of the suite is that a row belonging to another
 * tenant reads as absent, which can only be proven with two tenants in one database.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:postgresql://127.0.0.1:5433/nexus_test",
        "spring.datasource.username=nexus_app",
        "spring.datasource.password=nexus_dev_app_only",
        "spring.flyway.enabled=false",
        "nexus.redis.enabled=false",
        "nexus.ratelimit.enabled=false",
        "nexus.jwt.secret=nexus-test-only-secret-0123456789abcdef",
        "nexus.tenant.default-slug=hong-kong",
        "NEXUS_AI_INTERNAL_TOKEN=nexus-test-ai-internal-token-1234567890"
})
public abstract class NexusIntegrationTest {

    @LocalServerPort
    protected int port;

    @Autowired
    protected NamedParameterJdbcTemplate jdbc;

    @Autowired
    protected JwtService jwt;

    protected final RestTemplate http = plainRestTemplate();

    private static RestTemplate plainRestTemplate() {
        // The JDK client, not HttpURLConnection: the latter drops the error body on POSTs that the
        // server rejects before reading it, which would make "the envelope says internal_token_missing"
        // unassertable. Error handling is off so the tests read 4xx/5xx like any real client.
        RestTemplate template = new RestTemplate(clientFactory());
        template.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) {
                return false;
            }

            @Override
            protected boolean hasError(HttpStatusCode status) {
                return false;
            }
        });
        return template;
    }

    private static JdkClientHttpRequestFactory clientFactory() {
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());
        factory.setReadTimeout(Duration.ofSeconds(30));
        return factory;
    }

    protected String url(String path) {
        return "http://127.0.0.1:" + port + path;
    }

    // ---------------------------------------------------------------- tenants / people

    protected record Tenant(UUID id, String slug) {
    }

    protected Tenant newTenant(String label) {
        UUID id = UUID.randomUUID();
        String slug = "t-" + label + "-" + System.nanoTime();
        jdbc.update("insert into tenants (id, slug, name, country_code) values (:id, :slug, :name, 'HK')",
                new MapSqlParameterSource("id", id).addValue("slug", slug).addValue("name", "Test tenant " + label));
        return new Tenant(id, slug);
    }

    protected UUID newUser(Tenant tenant, String email, String role) {
        UUID id = UUID.randomUUID();
        String address = email.contains("@") ? email : email + "@example.test";
        jdbc.update("""
                insert into users (id, tenant_id, email, display_name, role, status)
                values (:id, :tenant, :email, :name, :role, 'active')
                """, new MapSqlParameterSource("id", id).addValue("tenant", tenant.id())
                .addValue("email", address).addValue("name", "User " + address.substring(0, address.indexOf('@')))
                .addValue("role", role));
        return id;
    }

    protected UUID newMerchant(Tenant tenant, String slug, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into merchants (id, tenant_id, slug, legal_name, display_name, status, data_origin)
                values (:id, :tenant, :slug, :legal, :display, :status, 'demo')
                """, new MapSqlParameterSource("id", id).addValue("tenant", tenant.id()).addValue("slug", slug)
                .addValue("legal", slug.toUpperCase() + " Ltd").addValue("display", "Demo " + slug)
                .addValue("status", status));
        return id;
    }

    protected UUID newLocation(Tenant tenant, UUID merchantId, double lat, double lng, String district) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into locations (id, merchant_id, tenant_id, address_line1, city, district, lat, lng)
                values (:id, :m, :tenant, :addr, 'Hong Kong', :district, :lat, :lng)
                """, new MapSqlParameterSource("id", id).addValue("m", merchantId).addValue("tenant", tenant.id())
                .addValue("addr", "1 Demo Street").addValue("district", district)
                .addValue("lat", lat).addValue("lng", lng));
        return id;
    }

    /** Membership + grant in one call: the two together are what authorises a merchant staff write. */
    protected UUID staff(Tenant tenant, UUID merchantId, UUID userId, String... permissions) {
        jdbc.update("""
                insert into merchant_users (merchant_id, user_id, role, status)
                values (:m, :u, 'manager', 'active')
                on conflict (merchant_id, user_id) do update set status = 'active'
                """, new MapSqlParameterSource("m", merchantId).addValue("u", userId));
        for (String permission : permissions) {
            jdbc.update("""
                    insert into permission_grants (subject_type, subject_id, merchant_id, permission)
                    values ('merchant_user', :u, :m, :p)
                    on conflict (subject_type, subject_id, merchant_id, permission) do nothing
                    """, new MapSqlParameterSource("u", userId).addValue("m", merchantId).addValue("p", permission));
        }
        return userId;
    }

    protected void revokeAll(UUID merchantId, UUID userId, String permission) {
        jdbc.update("delete from permission_grants where subject_type = 'merchant_user' and subject_id = :u "
                        + "and merchant_id = :m and permission = :p",
                new MapSqlParameterSource("u", userId).addValue("m", merchantId).addValue("p", permission));
    }

    /** Access token for the subject, exactly as AuthFilter expects: sub + tid + typ=access + role. */
    protected String token(Tenant tenant, UUID userId, String role) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("role", role);
        return jwt.sign(jwt.claims("access", userId.toString(), tenant.id().toString(),
                "sid-" + userId, UUID.randomUUID().toString(), extra));
    }

    // ---------------------------------------------------------------- HTTP

    protected HttpHeaders json(Tenant tenant, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Tenant", tenant.slug());
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return headers;
    }

    protected ResponseEntity<String> get(Tenant tenant, String token, String path) {
        return exchange(HttpMethod.GET, tenant, token, path, null);
    }

    /**
     * A GET whose path is taken literally — no URI-template expansion. A real client percent-encodes a
     * query value ({@code district=Sha%20Tin}); sending that through the template form re-encodes the
     * {@code %}, so the server would see a value with a literal {@code %20} in it and the test would
     * assert against a request nobody makes.
     */
    protected ResponseEntity<String> getRaw(Tenant tenant, String token, String path) {
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.GET,
                new HttpEntity<>(json(tenant, token)), String.class);
    }

    protected ResponseEntity<String> post(Tenant tenant, String token, String path, Object body) {
        return exchange(HttpMethod.POST, tenant, token, path, body);
    }

    protected ResponseEntity<String> put(Tenant tenant, String token, String path, Object body) {
        return exchange(HttpMethod.PUT, tenant, token, path, body);
    }

    protected ResponseEntity<String> exchange(HttpMethod method, Tenant tenant, String token, String path,
                                              Object body) {
        HttpEntity<Object> entity = new HttpEntity<>(body, json(tenant, token));
        return http.exchange(url(path), method, entity, String.class);
    }

    // ---------------------------------------------------------------- row probes

    protected Map<String, Object> row(String sql, Map<String, Object> params) {
        MapSqlParameterSource src = new MapSqlParameterSource();
        params.forEach(src::addValue);
        return jdbc.queryForMap(sql, src);
    }

    protected long count(String sql, Map<String, Object> params) {
        MapSqlParameterSource src = new MapSqlParameterSource();
        params.forEach(src::addValue);
        Long n = jdbc.queryForObject(sql, src, Long.class);
        return n == null ? 0 : n;
    }

    protected static String nowIso() {
        return Timestamp.from(Instant.now()).toInstant().toString();
    }
}
