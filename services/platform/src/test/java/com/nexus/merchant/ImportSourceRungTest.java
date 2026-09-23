package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nexus.platform.ApiException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * §1's ladder includes {@code ai_unavailable(503)}, and before this unit no test anywhere in
 * {@code src/test/java} had produced it — the same silence D47 found one rung over, but with a different cause.
 * There the promise had machinery that nothing exercised; here the machinery is reachable and its only two
 * raisers ({@link HeuristicImportAdapter#fetch}) sit behind {@code MerchantImportController} and
 * {@code MerchantContentController}, both of which belong to another live stream. So the rung gets a witness at
 * the seam this build owns — the adapter itself — and the fact that no HTTP door in tracked code reaches it
 * stays a report rather than someone else's file being edited to make a test pass.
 *
 * <p>The two branches are asserted together on purpose. A test that only ever saw the 503 would also pass if
 * the internal-address guard grew teeth enough to refuse everything, which is the failure mode that rule (the
 * code names it AGENT_CONTRACT §3's search_web rule) most needs defending.
 */
class ImportSourceRungTest {

    private final HeuristicImportAdapter adapter = new HeuristicImportAdapter();

    @Test
    @DisplayName("A source that cannot be fetched answers the 503 rung; a source inside the network answers 422")
    void anUnreachableSourceAnswersAiUnavailable() {
        // 192.0.2.1 is TEST-NET-1 (RFC 5737): a literal address that is not site-local, so the DNS-rebind guard
        // lets the attempt through, and that routes nowhere, so the client's own connect timeout answers.
        assertThatThrownBy(() -> adapter.fetch("http://192.0.2.1:8/"))
                .isInstanceOfSatisfying(ApiException.class, failure -> {
                    assertThat(failure.status()).isEqualTo(503);
                    assertThat(failure.code()).isEqualTo("ai_unavailable");
                });

        assertThatThrownBy(() -> adapter.fetch("http://127.0.0.1:9/"))
                .as("the neighbour branch: an internal host is refused before anything is dialed")
                .isInstanceOfSatisfying(ApiException.class, failure -> {
                    assertThat(failure.status()).isEqualTo(422);
                    assertThat(failure.code()).isEqualTo("validation_error");
                });

        assertThatThrownBy(() -> adapter.fetch("ftp://example.test/menu"))
                .as("and a scheme that is not http(s) is a refusal, not a degradation")
                .isInstanceOfSatisfying(ApiException.class, failure -> {
                    assertThat(failure.status()).isEqualTo(422);
                    assertThat(failure.code()).isEqualTo("validation_error");
                });
    }
}
