package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nexus.testsupport.NexusIntegrationTest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * {@code @Idempotent} and {@code IdempotencyService.run} are two halves of one promise, written in two
 * different places inside the same handler: the annotation is what makes the interceptor demand an
 * {@code Idempotency-Key}, and the call is what makes that key decide whether the work runs. Having only one
 * of the two is worse than having neither, because a call with no key does not skip idempotency — it claims
 * the row {@code <scope>|null}, which every keyless caller of that route then shares: the same account gets
 * somebody else's stored answer replayed instead of its own work done, and a different account is refused
 * with {@code idempotency_key_conflict} until the TTL ends. {@code POST /api/v1/admin/moderation/{id}/resolve}
 * shipped that way (D45).
 *
 * <p>The gate therefore reads the source rather than the router. A replay is a call in a method body, which
 * reflection cannot see, and the pairing lives one line apart inside one file — so the scan asks the only
 * question that matters mechanically: for every {@code .run("<scope>", <key>, …)} in {@code src/main/java},
 * does an {@code @Idempotent(scope = "<the same scope>")} appear above it in that file?
 *
 * <p>The check runs in one direction on purpose. An {@code @Idempotent} with no {@code run} asks a caller for
 * a token it does not use — wasteful, and {@code POST /api/v1/reservations} is the honest example of the shape
 * (a retried booking is settled by {@code reservations_slot_user_uniq}, not by a stored response) — whereas a
 * {@code run} with no {@code @Idempotent} corrupts an answer. Only the second one is refused here.
 */
class IdempotencyPairingTest extends NexusIntegrationTest {

    private static final Path MAIN = Path.of("src/main/java");

    /** {@code idempotency.run("scope", <key expression>, …)} — the second argument is the caller's header. */
    private static final Pattern REPLAY = Pattern.compile("\\.run\\(\\s*\"([A-Za-z0-9_]+)\"\\s*,");

    /** Both spellings the codebase uses for the marker: {@code @Idempotent} and the fully-qualified form. */
    private static final Pattern MARKER =
            Pattern.compile("@(?:[a-zA-Z.]*\\.)?Idempotent\\s*\\(\\s*scope\\s*=\\s*\"([A-Za-z0-9_]+)\"\\s*\\)");

    @Autowired
    IdempotencyService idempotency;

    private record Replay(Path file, int line, String scope) {
    }

    @Test
    @DisplayName("Every recorded replay sits under a marker that makes its key arrive")
    void replaysDeclareTheKeyTheyDependOn() throws IOException {
        assertThat(MAIN).as("the gate reads the handlers from the source tree, not from a list").isDirectory();

        List<Path> files;
        try (var paths = Files.walk(MAIN)) {
            files = paths.filter(p -> p.toString().endsWith(".java")).sorted().toList();
        }
        List<Replay> replays = new ArrayList<>();
        List<String> unpaired = new ArrayList<>();
        for (Path file : files) {
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            List<Integer> markerLines = new ArrayList<>();
            List<String> markerScopes = new ArrayList<>();
            for (int i = 0; i < lines.size(); i++) {
                Matcher marker = MARKER.matcher(lines.get(i));
                if (marker.find()) {
                    markerLines.add(i);
                    markerScopes.add(marker.group(1));
                }
                Matcher replay = REPLAY.matcher(lines.get(i));
                if (replay.find()) {
                    String scope = replay.group(1);
                    replays.add(new Replay(file, i + 1, scope));
                    if (!declaredAbove(markerLines, markerScopes, i, scope)) {
                        unpaired.add(file + ":" + (i + 1) + " runs scope '" + scope + "' with no @Idempotent");
                    }
                }
            }
        }

        assertThat(replays).as("recorded replays found in " + MAIN).isNotEmpty();
        assertThat(unpaired).as("replays whose handler never required Idempotency-Key (D45)").isEmpty();
        assertThat(replays.stream().map(Replay::scope).toList())
                .as("the five doors this build answers a replay for")
                .contains("review", "events", "member", "api_key", "moderation_resolve");
    }

    @Test
    @DisplayName("A blank key is refused before a claim row exists, so `scope|null` cannot be shared")
    void aMissingKeyCannotBecomeASharedClaim() {
        String scope = "pairing-" + System.nanoTime();
        UUID owner = UUID.randomUUID();

        AtomicBoolean ran = new AtomicBoolean(false);
        assertThatThrownBy(() -> idempotency.run(scope, null, owner, () -> {
            ran.set(true);
            return Map.of("executed", true);
        })).isInstanceOfSatisfying(ApiException.class, failure -> {
            assertThat(failure.status()).as("a caller cannot reach this by sending anything").isEqualTo(500);
            assertThat(failure.getMessage()).contains("@Idempotent(scope = '" + scope + "')");
        });
        assertThat(ran).as("the work behind a refused claim never executes").isFalse();
        assertThatThrownBy(() -> idempotency.run(scope, "   ", owner, () -> Map.of("executed", true)))
                .isInstanceOf(ApiException.class);

        // The two assertions above would also pass if `run` never wrote anything at all, so the same scope is
        // then used the way it is meant to be used: a key claims, a second call with that key replays.
        AtomicBoolean second = new AtomicBoolean();
        assertThat(idempotency.run(scope, "k1", owner, () -> Map.of("executed", true)))
                .containsEntry("executed", true);
        Map<String, Object> replay = idempotency.run(scope, "k1", owner, () -> {
            second.set(true);
            return Map.of("executed", false);
        });
        assertThat(replay).containsEntry("executed", true).containsEntry("idempotent_replay", true);
        assertThat(second).as("a replay returns the stored answer without doing the work again").isFalse();
        assertThat(count("select count(*) from idempotency_keys where key like :pattern",
                Map.of("pattern", scope + "|%"))).as("exactly one claim, from the one real key").isEqualTo(1);

        jdbc.update("delete from idempotency_keys where key like :pattern",
                Map.of("pattern", scope + "|%"));
    }

    /** Was this scope declared by a marker earlier in the same file — i.e. on the handler that calls {@code run}? */
    private static boolean declaredAbove(List<Integer> markerLines, List<String> markerScopes, int replayLine,
                                         String scope) {
        for (int at = 0; at < markerLines.size(); at++) {
            if (markerLines.get(at) < replayLine && markerScopes.get(at).equals(scope)) {
                return true;
            }
        }
        return false;
    }
}
