package com.nexus.admin;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The §9 admin console HTTP surface, over real HTTP and a real Postgres: the seven routes a previous
 * work stream left answering 404, plus the behaviours the contract demands of them.
 *
 * <p>What is pinned here is the difference between an admin surface and a set of handlers that happen to
 * be reachable: every route is role-gated (consumer → 403 in the §1 envelope, anonymous → 401), the one
 * write is audited and observable on the consumer side, unknown ids are 404 and malformed uuids are 422
 * (never a 500), lists are bounded and totally ordered, the AI reads answer from aggregate SQL and refuse
 * write instructions, an unknown {@code group_by} is a 422 rather than SQL, and the health screen reports
 * a probed dependency state rather than a hardcoded {@code ok}.
 *
 * <p>The moderation routes are deliberately not re-tested here: D39 delivered them in
 * {@code ModerationFlowTest} and this file reuses the same {@code @RequiresPlatformRole} guard rather than
 * asserting a second permission model.
 */
class AdminConsoleApiTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;
    private UUID consumerId;
    private String consumerToken;
    private UUID adminId;
    private String adminToken;
    private UUID opsId;
    private String opsToken;

    @BeforeEach
    void seedActors() {
        tenant = newTenant("admin");
        other = newTenant("admin-other");
        consumerId = newUser(tenant, "shopper-" + tag(), "consumer");
        consumerToken = token(tenant, consumerId, "consumer");
        adminId = newUser(tenant, "admin-" + tag(), "platform_admin");
        adminToken = token(tenant, adminId, "platform_admin");
        opsId = newUser(tenant, "ops-" + tag(), "platform_ops");
        opsToken = token(tenant, opsId, "platform_ops");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    // ---------------------------------------------------------------- 1. role gating

    @Test
    @DisplayName("Every admin route is role-gated: anonymous 401, consumer 403, platform_ops allowed")
    void everyAdminRouteIsRoleGated() {
        UUID throwaway = newMerchant(tenant, "gate-" + tag(), "published");
        newLocation(tenant, throwaway, 22.30, 114.17, "Sha Tin");

        // (method, path, body) for each controller's representative route.
        List<Map<String, Object>> routes = List.of(
                route("GET", "/api/v1/admin/ai/runs", null),
                route("GET", "/api/v1/admin/ai/costs?group_by=agent", null),
                route("POST", "/api/v1/admin/ai/ask", Json.map("question", "how many merchants are there")),
                route("GET", "/api/v1/admin/search/analytics", null),
                route("POST", "/api/v1/admin/merchants/" + throwaway + "/suspend", Json.map("reason", "gate")),
                route("GET", "/api/v1/admin/system/health", null),
                route("GET", "/api/v1/users/" + consumerId, null));

        for (Map<String, Object> r : routes) {
            String method = (String) r.get("method");
            String path = (String) r.get("path");
            Object body = r.get("body");

            ResponseEntity<String> anon = call(method, tenant, null, path, body);
            assertThat(anon.getStatusCode()).as("anonymous %s %s", method, path)
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
            assertThat(Json.tree(anon.getBody()).path("error").path("code").asText()).isEqualTo("unauthorized");

            ResponseEntity<String> asConsumer = call(method, tenant, consumerToken, path, body);
            assertThat(asConsumer.getStatusCode()).as("consumer %s %s", method, path)
                    .isEqualTo(HttpStatus.FORBIDDEN);
            JsonNode forbidden = Json.tree(asConsumer.getBody()).path("error");
            assertThat(forbidden.path("code").asText()).isEqualTo("forbidden");
            assertThat(forbidden.path("details").path("required_roles").toString()).contains("platform_admin");

            // platform_ops is the second allowed role, so at least one route is proven to accept it.
            ResponseEntity<String> asOps = call(method, tenant, opsToken, path, body);
            assertThat(asOps.getStatusCode().value()).as("ops %s %s", method, path)
                    .isNotIn(401, 403);
        }
    }

    // ---------------------------------------------------------------- 2 & 3. suspend: audit + consumer effect

    @Test
    @DisplayName("Suspending a merchant is audited and immediately stops its listings being served")
    void suspendIsAuditedAndStopsServingListings() {
        String slug = "suspend-me-" + tag();
        UUID merchant = newMerchant(tenant, slug, "published");
        newLocation(tenant, merchant, 22.31, 114.16, "Sha Tin");

        // Served before the write: this is the control, not an assumption.
        ResponseEntity<String> before = getRaw(tenant, null, "/api/v1/merchants/" + slug);
        assertThat(before.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(directorySlugs()).contains(slug);

        ResponseEntity<String> suspended = post(tenant, adminToken,
                "/api/v1/admin/merchants/" + merchant + "/suspend", Json.map("reason", "Repeated no-shows"));
        assertThat(suspended.getStatusCode()).as(suspended.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode outcome = Json.tree(suspended.getBody());
        assertThat(outcome.path("status").asText()).isEqualTo("suspended");
        assertThat(outcome.path("previous_status").asText()).isEqualTo("published");
        assertThat(outcome.path("changed").asBoolean()).isTrue();

        // Observable on the consumer side, with a real read.
        ResponseEntity<String> after = getRaw(tenant, null, "/api/v1/merchants/" + slug);
        assertThat(after.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(after.getBody()).path("error").path("code").asText())
                .isEqualTo("merchant_not_found");
        assertThat(directorySlugs()).doesNotContain(slug);

        // The audit row names the actor, the action and the subject.
        Map<String, Object> audit = row("""
                select actor_type, actor_id, action, subject_type, subject_id, before, after, metadata
                from audit_logs
                where action = 'merchant_suspend' and subject_id = :id and tenant_id = :t
                """, Map.of("id", merchant, "t", tenant.id()));
        assertThat(audit.get("actor_id")).isEqualTo(adminId);
        assertThat(audit.get("actor_type")).isEqualTo("user");
        assertThat(audit.get("subject_type")).isEqualTo("merchant");
        assertThat(String.valueOf(audit.get("before"))).contains("published");
        assertThat(String.valueOf(audit.get("after"))).contains("suspended");
    }

    // ---------------------------------------------------------------- 4. unknown / malformed ids

    @Test
    @DisplayName("An unknown id is 404 and a malformed uuid is 422 — never a 500")
    void unknownAndMalformedIdsFailCleanly() {
        ResponseEntity<String> unknownUser = getRaw(tenant, adminToken, "/api/v1/users/" + UUID.randomUUID());
        assertThat(unknownUser.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(unknownUser.getBody()).path("error").path("code").asText())
                .isEqualTo("user_not_found");

        ResponseEntity<String> malformedUser = getRaw(tenant, adminToken, "/api/v1/users/not-a-uuid");
        assertThat(malformedUser.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(malformedUser.getBody()).path("error").path("code").asText())
                .isEqualTo("validation_error");

        ResponseEntity<String> unknownMerchant = post(tenant, adminToken,
                "/api/v1/admin/merchants/" + UUID.randomUUID() + "/suspend", Json.map("reason", "x"));
        assertThat(unknownMerchant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(unknownMerchant.getBody()).path("error").path("code").asText())
                .isEqualTo("merchant_not_found");

        ResponseEntity<String> malformedMerchant = post(tenant, adminToken,
                "/api/v1/admin/merchants/not-a-uuid/suspend", Json.map("reason", "x"));
        assertThat(malformedMerchant.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A user that exists in another market is absent here, not forbidden (D5, no enumeration).
        UUID foreign = newUser(other, "foreign-" + tag(), "consumer");
        assertThat(getRaw(tenant, adminToken, "/api/v1/users/" + foreign).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---------------------------------------------------------------- 5. lists + costs

    @Test
    @DisplayName("AI runs are a bounded, stably ordered page; costs reject an unknown group_by with 422")
    void aiRunsAndCostsAreBoundedAndWhitelisted() {
        seedRun("search", "model-a", "0.010000", "succeeded", "2026-01-01T00:00:01Z");
        seedRun("search", "model-a", "0.020000", "succeeded", "2026-01-01T00:00:02Z");
        seedRun("analytics", "model-b", "0.005000", "failed", "2026-01-01T00:00:03Z");

        ResponseEntity<String> page = getRaw(tenant, adminToken, "/api/v1/admin/ai/runs?limit=2");
        assertThat(page.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(page.getBody());
        assertThat(body.path("items")).hasSize(2);
        assertThat(body.path("total_estimate").asLong()).isEqualTo(3);
        assertThat(body.path("next_cursor").isTextual()).isTrue();
        // Newest first: the two most recent starts, with the failed run on top.
        assertThat(body.path("items").get(0).path("agent").asText()).isEqualTo("analytics");
        assertThat(body.path("items").get(1).path("agent").asText()).isEqualTo("search");

        // Unknown group_by is refused, not interpolated.
        ResponseEntity<String> bogus = getRaw(tenant, adminToken, "/api/v1/admin/ai/costs?group_by=bogus");
        assertThat(bogus.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(bogus.getBody()).path("error").path("details").path("allowed").toString())
                .contains("agent").contains("model").contains("day");

        ResponseEntity<String> costs = getRaw(tenant, adminToken, "/api/v1/admin/ai/costs?group_by=agent");
        assertThat(costs.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode searchGroup = null;
        for (JsonNode g : Json.tree(costs.getBody()).path("groups")) {
            if ("search".equals(g.path("key").asText())) {
                searchGroup = g;
            }
        }
        assertThat(searchGroup).as("a group for agent 'search'").isNotNull();
        assertThat(searchGroup.path("runs").asLong()).isEqualTo(2);
        assertThat(searchGroup.path("cost_usd").asText()).isEqualTo("0.03");
        // The number matches what the database says, not a fixture constant.
        long expected = count("select count(*) from agent_runs where tenant_id = :t and agent = 'search'",
                Map.of("t", tenant.id()));
        assertThat(searchGroup.path("runs").asLong()).isEqualTo(expected);
    }

    // ---------------------------------------------------------------- 6. ask: read-only + honest degrade

    @Test
    @DisplayName("POST /admin/ai/ask answers from aggregate SQL, degrades honestly, and refuses a write")
    void askIsReadOnlyAndAnswersFromSql() {
        newMerchant(tenant, "ask-a-" + tag(), "published");
        newMerchant(tenant, "ask-b-" + tag(), "published");
        newMerchant(tenant, "ask-c-" + tag(), "suspended");
        seedEvent("search", "sess-" + tag());

        ResponseEntity<String> answer = post(tenant, adminToken, "/api/v1/admin/ai/ask",
                Json.map("question", "how many merchants are published?"));
        assertThat(answer.getStatusCode()).as(answer.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(answer.getBody());
        assertThat(body.path("read_only").asBoolean()).isTrue();
        assertThat(body.path("answer_source").asText()).isEqualTo("sql");
        // The platform ships no LLM client, so the answer is always SQL-backed and always reports that.
        // The reason names which configuration it found: no key at all, or a key with no client to use it.
        assertThat(body.path("degraded").asBoolean()).isTrue();
        assertThat(body.path("degraded_reason").asText())
                .isIn("no_llm_key_configured", "no_llm_client_in_platform_service");
        assertThat(body.path("model_used").isNull()).isTrue();

        // The published-merchant count is the database's, not a fixture constant.
        long expected = count("select count(*) from merchants where tenant_id = :t and status = 'published'",
                Map.of("t", tenant.id()));
        long reported = -1;
        for (JsonNode e : body.path("evidence")) {
            if ("merchants.published".equals(e.path("metric").asText())) {
                reported = e.path("value").asLong();
            }
        }
        assertThat(reported).isEqualTo(expected).isEqualTo(2);
        assertThat(body.path("answer").asText()).contains(String.valueOf(expected));

        // A question that would require a write is refused (§126), naming the verb.
        ResponseEntity<String> write = post(tenant, adminToken, "/api/v1/admin/ai/ask",
                Json.map("question", "suspend merchant " + UUID.randomUUID()));
        assertThat(write.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        JsonNode refusal = Json.tree(write.getBody()).path("error");
        assertThat(refusal.path("code").asText()).isEqualTo("validation_error");
        assertThat(refusal.path("details").path("reason").asText()).isEqualTo("read_only");
        assertThat(refusal.path("details").path("refused_verb").asText()).isEqualTo("suspend");

        ResponseEntity<String> empty = post(tenant, adminToken, "/api/v1/admin/ai/ask", Json.map());
        assertThat(empty.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ---------------------------------------------------------------- 7. search analytics

    /**
     * The endpoint reads the platform's own telemetry over a window, and this database is shared with
     * every other integration test in the suite — and with every previous run of it, because the
     * schema is not rebuilt between runs. An absolute total is therefore a claim about whatever else
     * happened to run first, and it goes stale the moment another test seeds an event. What this test
     * can honestly assert is the <em>delta it writes itself</em>; "2 more searches, 2 more sessions"
     * is a fact about this test either way.
     */
    @Test
    @DisplayName("Search analytics reports real counts from events, bounded by a window")
    void searchAnalyticsReportsRealCounts() {
        long searchesBefore = analyticsTotal("searches");
        long sessionsBefore = analyticsTotal("sessions");

        // One tag, captured once. `tag()` is `System.nanoTime()` in hex, so calling it per line made
        // "sess-a-…" three different session ids and the distinct-session count 3 — a test that could
        // never have passed, and whose failure looked like a bug in the endpoint.
        String tag = tag();
        seedEvent("search", "sess-a-" + tag);
        seedEvent("search", "sess-b-" + tag);
        seedEvent("view", "sess-a-" + tag);

        ResponseEntity<String> res = getRaw(tenant, adminToken, "/api/v1/admin/search/analytics?days=30");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("totals").path("searches").asLong() - searchesBefore).isEqualTo(2);
        assertThat(body.path("totals").path("sessions").asLong() - sessionsBefore).isEqualTo(2);
        assertThat(body.path("window_days").asInt()).isEqualTo(30);
        boolean sawSearchEvent = false;
        for (JsonNode e : body.path("by_event")) {
            if ("search".equals(e.path("name").asText())) {
                sawSearchEvent = true;
                // Seeded twice here; other tests in the suite seed search events too, so the row can
                // only be bounded from below without becoming a claim about their fixtures.
                assertThat(e.path("events").asLong()).isGreaterThanOrEqualTo(2);
            }
        }
        assertThat(sawSearchEvent).isTrue();

        assertThat(getRaw(tenant, adminToken, "/api/v1/admin/search/analytics?days=abc").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    /** One number from the endpoint's own totals block, read before (or after) this test writes. */
    private long analyticsTotal(String field) {
        JsonNode body = Json.tree(getRaw(tenant, adminToken, "/api/v1/admin/search/analytics?days=30").getBody());
        return body.path("totals").path(field).asLong();
    }

    // ---------------------------------------------------------------- 8. system health

    @Test
    @DisplayName("System health reports a probed database state, not a hardcoded ok")
    void systemHealthReportsRealDependencyState() {
        ResponseEntity<String> res = getRaw(tenant, adminToken, "/api/v1/admin/system/health");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(res.getBody());
        // This test only runs when Postgres answered, so "up" is a fact about the probe, not a constant.
        assertThat(body.path("dependencies").path("database").path("state").asText()).isEqualTo("up");
        assertThat(body.path("dependencies").path("database").path("latency_ms").asLong()).isGreaterThanOrEqualTo(0);
        assertThat(body.path("dependencies").path("key_value").path("state").asText())
                .isIn("redis", "in_memory");
        assertThat(body.path("dependencies").path("ai_service").path("probed").asBoolean()).isFalse();
        assertThat(body.path("status").asText()).isEqualTo("ok");
    }

    // ---------------------------------------------------------------- fixtures

    private Map<String, Object> route(String method, String path, Object body) {
        return Json.map("method", method, "path", path, "body", body);
    }

    private ResponseEntity<String> call(String method, Tenant t, String bearer, String path, Object body) {
        if ("POST".equals(method)) {
            return post(t, bearer, path, body);
        }
        return getRaw(t, bearer, path);
    }

    private void seedRun(String agent, String model, String cost, String status, String startedAt) {
        jdbc.update("""
                insert into agent_runs (id, tenant_id, agent, model, provider, status, cost_usd,
                                        prompt_tokens, completion_tokens, latency_ms, started_at, finished_at)
                values (:id, :t, :agent, :model, 'mock', :status, cast(:cost as numeric), 10, 5, 42,
                        cast(:started as timestamptz), cast(:started as timestamptz))
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                .addValue("agent", agent).addValue("model", model).addValue("status", status)
                .addValue("cost", cost).addValue("started", startedAt));
    }

    private void seedEvent(String name, String sessionId) {
        jdbc.update("""
                insert into events (event_id, tenant_id, actor_type, name, session_id, properties, occurred_at)
                values (:id, :t, 'anonymous', :name, :session, '{}'::jsonb, now())
                """, new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                .addValue("name", name).addValue("session", sessionId));
    }

    /** The slugs the consumer directory actually returns for this tenant. */
    private List<String> directorySlugs() {
        JsonNode page = Json.tree(getRaw(tenant, null, "/api/v1/merchants?limit=100").getBody());
        java.util.List<String> slugs = new java.util.ArrayList<>();
        for (JsonNode item : page.path("items")) {
            slugs.add(item.path("slug").asText());
        }
        return slugs;
    }
}
