package com.nexus.cloud.insight;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

/**
 * D885 — the honesty of the aggregated view is the part that must never regress, so it is tested
 * without a Spring context or a running registry: the two clients are mocks, and the assertions are
 * about what the controller is willing to CLAIM.
 */
class PlaneControllerTest {

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("upstreams");
    }

    @Test
    void twoRealUpAnswersAreTheOnlyWayAllUpBecomesTrue() {
        PlatformHealthClient platform = mock(PlatformHealthClient.class);
        AiHealthClient ai = mock(AiHealthClient.class);
        when(platform.health()).thenReturn(Map.of("status", "UP", "request_id", "r1"));
        when(ai.health()).thenReturn(Map.of("status", "UP", "provider", "mock"));

        Map<String, Object> body = new PlaneController(platform, ai).plane();

        assertThat(body.get("all_up")).isEqualTo(true);
        assertThat(body.get("service")).isEqualTo("nexus-insight");
        List<Map<String, Object>> upstreams = rows(body);
        assertThat(upstreams).hasSize(2);
        assertThat(upstreams).allSatisfy(row -> {
            assertThat(row.get("status")).isEqualTo("UP");
            assertThat(row.get("source")).isEqualTo("upstream");
        });
        // Only the status is copied out; the rest of the upstream payload never crosses this door.
        assertThat(upstreams.get(0)).doesNotContainKey("request_id");
        assertThat(upstreams.get(1)).doesNotContainKey("provider");
    }

    @Test
    void aFallbackIsReportedUnavailableAndNeverImpersonatesHealth() {
        PlatformHealthClient platform = mock(PlatformHealthClient.class);
        AiHealthClient ai = mock(AiHealthClient.class);
        when(platform.health()).thenReturn(Map.of("status", "UP"));
        when(ai.health()).thenReturn(new AiHealthFallback().health());

        Map<String, Object> body = new PlaneController(platform, ai).plane();

        assertThat(body.get("all_up")).isEqualTo(false);
        Map<String, Object> aiRow = rows(body).get(1);
        assertThat(aiRow.get("status")).isEqualTo("unavailable");
        assertThat(aiRow.get("source")).isEqualTo("fallback");
        assertThat(aiRow.get("name")).isEqualTo("NEXUS-AI");
        assertThat(aiRow).doesNotContainKey("insight_fallback"); // marker is internal, not a claim
    }

    @Test
    void anExceptionIsNamedButNeverTurnedIntoAnUpAnswer() {
        PlatformHealthClient platform = mock(PlatformHealthClient.class);
        AiHealthClient ai = mock(AiHealthClient.class);
        when(platform.health()).thenThrow(new IllegalStateException("no instance"));
        when(ai.health()).thenReturn(Map.of("status", "UP"));

        Map<String, Object> body = new PlaneController(platform, ai).plane();

        assertThat(body.get("all_up")).isEqualTo(false);
        Map<String, Object> row = rows(body).get(0);
        assertThat(row.get("status")).isEqualTo("unavailable");
        assertThat(row.get("source")).isEqualTo("exception");
        assertThat(row.get("detail")).isEqualTo("IllegalStateException");
    }

    @Test
    void aResponseWithoutAStatusIsUnknownNotAssumedHealthy() {
        PlatformHealthClient platform = mock(PlatformHealthClient.class);
        AiHealthClient ai = mock(AiHealthClient.class);
        when(platform.health()).thenReturn(Map.of("something_else", "value"));
        when(ai.health()).thenReturn(null);

        Map<String, Object> body = new PlaneController(platform, ai).plane();

        assertThat(body.get("all_up")).isEqualTo(false);
        assertThat(rows(body).get(0).get("status")).isEqualTo("unknown");
        assertThat(rows(body).get(0).get("source")).isEqualTo("upstream-without-status");
        assertThat(rows(body).get(1).get("status")).isEqualTo("unknown");
        assertThat(rows(body).get(1).get("source")).isEqualTo("empty-response");
    }
}
