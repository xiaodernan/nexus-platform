package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.math.BigDecimal;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.http.ResponseEntity;

/**
 * D587 — the shipped write path stored every un-strengthed preference at the ranker's no-evidence
 * number, so declaring a preference and then saying nothing about its strength bought a row that
 * answers nothing.
 *
 * <p>{@code upsertPreference} bound {@code weight == null ? 0.5 : weight}, and {@code
 * user_preferences.weight} is {@code NOT NULL DEFAULT 0.500}, so 0.5 was the platform's own answer for
 * "the caller did not say". In the ranker that number is not a weak signal, it is the absence of one:
 * every matcher reflects a weight around 0.5 (D527), so the distance from neutral carries the strength
 * and 0.5 carries none. Measured against the fixture lane (a satisfying merchant and a non-satisfying
 * one, one candidate each, same query):
 *
 * <pre>
 *   access/accessible   no row 0.493735   w=0.5 0.493735   w=0.7 0.505735 / 0.481735
 *   view/scenic         no row 0.493735   w=0.5 0.493735   w=0.7 0.505735 / 0.481735
 *   style/ambience      no row 0.493735   w=0.5 0.493735   w=0.7 0.505735 / 0.493735
 * </pre>
 *
 * <p>Three of the seven branches the ranker has a clause for — {@code apps/ai/tests/
 * test_a_preference_written_through_the_api_is_not_read_as_silence.py} carries all fourteen cells and
 * is the door that reads this file's own constant.
 *
 * <p>At 0.5 the candidate scores to the last decimal exactly what it scores for a user who has no
 * preference row at all. §32 promises the preference is remembered and shown to the user; it was, and
 * it changed nothing — a memory the product lists and does not use. The caller's silence had been
 * recorded as a claim of neutrality.
 *
 * <p>Two rules now hold on this path, and this door walks both:
 * <ul>
 *   <li>an absent strength on a NEW declared row is stored at {@link
 *       IdentityRepository#DECLARED_PREFERENCE_WEIGHT}, not at the neutral point;</li>
 *   <li>an absent strength on a row that EXISTS leaves the stored weight alone — which is what {@code
 *       PATCH /preferences/{id}} already did with {@code coalesce(:weight, weight)}. The two write
 *       paths disagreed about what silence means, and the POST path was the one that destroyed the
 *       number: re-declaring a preference a second time, with no strength in the body, reset a stated
 *       0.9 to 0.5.</li>
 * </ul>
 *
 * <p>An explicit number is still stored as given, including below neutral (D527 reads that as weak
 * evidence FOR, not against). And an {@code inferred} row written with no strength still lands at the
 * neutral point — that half is recorded here as the debt it is and filed in PLAN, not folded into this
 * unit's answer.
 *
 * <p>Arms, each mutating one shipped clause and restoring byte-for-byte; the counts are what the run
 * printed, not what was expected:
 * <ul>
 *   <li>D — the default reverted to exactly what shipped, {@code weight == null ? 0.5 : weight}, with
 *       the coalesce still in place: <b>1 failure</b>, {@code
 *       aSilentDeclarationIsStoredAsEvidence} ("0.5 is the number the ranker reads as silence").</li>
 *   <li>B — the {@code coalesce} off the DO UPDATE, default still 0.7: <b>1 failure</b>, {@code
 *       silenceDoesNotResetAStatedStrength} ("the second POST stated no strength; the first one did").
 *       </li>
 * </ul>
 *
 * <p>One row each, and that split is the finding: the dead default and the strength-erasing update
 * were two independent defects sharing a column, so no single arm can stand in for the other. The
 * three remaining rows stayed green under both arms — an explicit number, the PATCH agreement and the
 * inference debt are not what these two clauses vouch for.
 */
class PreferenceWeightDoorTest extends NexusIntegrationTest {

    /** POST /api/v1/me/preferences, omitting any key the caller did not state. */
    private JsonNode declare(Tenant tenant, String token, String kind, String key, Object value, Double weight,
                             String source) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kind", kind);
        body.put("key", key);
        body.put("value", value);
        if (weight != null) {
            body.put("weight", weight);
        }
        if (source != null) {
            body.put("source", source);
        }
        ResponseEntity<String> answer = post(tenant, token, "/api/v1/me/preferences", body);
        assertThat(answer.getStatusCode()).as("the declaration must land; it said: %s", answer.getBody())
                .isEqualTo(HttpStatus.OK);
        return Json.tree(answer.getBody());
    }

    private Map<String, Object> storedRow(UUID userId, String kind, String key) {
        return jdbc.queryForMap("select weight, value::text as value, source from user_preferences"
                        + " where user_id = :u and kind = :k and key = :kk",
                new MapSqlParameterSource("u", userId).addValue("k", kind).addValue("kk", key));
    }

    private BigDecimal storedWeight(UUID userId, String kind, String key) {
        return new BigDecimal(String.valueOf(storedRow(userId, kind, key).get("weight")));
    }

    @Test
    @DisplayName("A declared preference with no stated strength is not stored at the ranker's no-evidence point")
    void aSilentDeclarationIsStoredAsEvidence() {
        Tenant tenant = newTenant("pref-weight");
        UUID person = newUser(tenant, "declare@pref-weight.test", "consumer");
        String token = token(tenant, person, "consumer");

        JsonNode answer = declare(tenant, token, "style", "ambience", Json.map("value", "quiet"), null, null);

        assertThat(answer.path("weight").asDouble())
                .as("0.5 is the number the ranker reads as silence; a caller who said \"quiet matters\" did not"
                        + " say \"no side matters\"")
                .isEqualTo(IdentityRepository.DECLARED_PREFERENCE_WEIGHT);
        assertThat(IdentityRepository.NEUTRAL_PREFERENCE_WEIGHT)
                .as("the default and the no-evidence point must stay different numbers, or this door guards"
                        + " nothing")
                .isNotEqualTo(IdentityRepository.DECLARED_PREFERENCE_WEIGHT);
        assertThat(storedWeight(person, "style", "ambience")).isEqualByComparingTo("0.700");

        BigDecimal shown = null;
        for (JsonNode row : Json.tree(get(tenant, token, "/api/v1/me/preferences").getBody())) {
            if ("style".equals(row.path("kind").asText()) && "ambience".equals(row.path("key").asText())) {
                shown = row.path("weight").decimalValue();
            }
        }
        assertThat(shown)
                .as("§32 shows the user this row, so the number it shows has to be the one the ranker acts on")
                .isNotNull().isEqualByComparingTo("0.700");
    }

    @Test
    @DisplayName("Re-declaring with no strength keeps the weight the owner last set, and changes the value")
    void silenceDoesNotResetAStatedStrength() {
        Tenant tenant = newTenant("pref-weight-keep");
        UUID person = newUser(tenant, "keep@pref-weight.test", "consumer");
        String token = token(tenant, person, "consumer");

        declare(tenant, token, "access", "accessible", Json.map("value", true), 0.9, null);
        JsonNode again = declare(tenant, token, "access", "accessible", Json.map("value", false), null, null);

        assertThat(again.path("weight").asDouble()).as("the second POST stated no strength; the first one did")
                .isEqualTo(0.9);
        assertThat(storedWeight(person, "access", "accessible")).isEqualByComparingTo("0.900");
        assertThat(String.valueOf(storedRow(person, "access", "accessible").get("value")))
                .as("the value the caller DID send still lands")
                .contains("false");
    }

    @Test
    @DisplayName("An explicit strength is stored as given, including below neutral")
    void anExplicitStrengthSurvivesTheWrite() {
        Tenant tenant = newTenant("pref-weight-explicit");
        UUID person = newUser(tenant, "explicit@pref-weight.test", "consumer");
        String token = token(tenant, person, "consumer");

        JsonNode answer = declare(tenant, token, "view", "scenic", Json.map("value", true), 0.3, null);

        assertThat(answer.path("weight").asDouble())
                .as("a caller who named 0.3 said something - D527 reads it as weak evidence FOR, and the write"
                        + " plane has no business rewriting it toward the floor")
                .isEqualTo(0.3);
        assertThat(storedWeight(person, "view", "scenic")).isEqualByComparingTo("0.300");
    }

    @Test
    @DisplayName("PATCH and POST agree that silence keeps the stored strength")
    void theTwoWritePathsAgree() {
        Tenant tenant = newTenant("pref-weight-patch");
        UUID person = newUser(tenant, "patch@pref-weight.test", "consumer");
        String token = token(tenant, person, "consumer");

        JsonNode created = declare(tenant, token, "budget", "per_person_max_hkd",
                Json.map("value", 200), 0.8, null);
        String id = created.path("id").asText();

        Map<String, Object> patchBody = new LinkedHashMap<>();
        patchBody.put("kind", "budget");
        patchBody.put("key", "per_person_max_hkd");
        patchBody.put("value", Json.map("value", 300));
        ResponseEntity<String> patched = http.exchange(URI.create(url("/api/v1/me/preferences/" + id)),
                HttpMethod.PATCH, new HttpEntity<>(patchBody, json(tenant, token)), String.class);
        assertThat(patched.getStatusCode()).as("PATCH said: %s", patched.getBody()).isEqualTo(HttpStatus.OK);

        assertThat(storedWeight(person, "budget", "per_person_max_hkd"))
                .as("PATCH coalesces an absent weight; POST must not be the path that silently zeroes it")
                .isEqualByComparingTo("0.800");
    }

    @Test
    @DisplayName("An inferred row written with no strength still answers the neutral point (recorded debt)")
    void inferenceStillAnswersNeutralAndThatIsFiled() {
        Tenant tenant = newTenant("pref-weight-inferred");
        UUID person = newUser(tenant, "inferred@pref-weight.test", "consumer");
        String token = token(tenant, person, "consumer");

        JsonNode answer = declare(tenant, token, "food", "cuisine_like", Json.map("value", "dim sum"), null,
                "inferred");

        assertThat(answer.path("weight").asDouble())
                .as("this is the half D587 did NOT fix: a guess the platform made with no stated confidence is"
                        + " stored where the ranker reads nothing. Whether inference should carry a floor is a"
                        + " personalization-quality question - see docs/PLAN.md")
                .isEqualTo(IdentityRepository.NEUTRAL_PREFERENCE_WEIGHT);
    }
}
