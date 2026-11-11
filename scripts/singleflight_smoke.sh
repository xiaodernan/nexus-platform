#!/usr/bin/env bash
# NEXUS D944 — singleflight request coalescing, measured on the REAL JVM thread scheduler.
#
# "On the wire" here means real OS threads + real CompletableFuture + a real CountDownLatch schedule — NOT a
# mock and NOT a Redis command (singleflight is an in-process primitive). The harness is COMPILED FROM THE
# ACTUAL Singleflight.java SOURCE, so a copy cannot drift from what ApiKeyService runs.
#
#   1. compile the source Singleflight.java + a generated harness (N=16 threads) with javac
#   2. all N threads arrive at run() before any enters the loader (allAtGate), then the owner's loader blocks
#      on `release`; followers must JOIN the owner's future, not enter the loader
#   3. the harness prints LOADS=<loader invocations> WAITERS=<callers that got the shared value>
#   4. assert LOADS == 1 and WAITERS == N — N concurrent cold misses collapsed into ONE backing-store call
#   5. a SECOND scenario proves failure propagation + in-flight cleanup: a throwing loader's exception reaches
#      all N joiners, and the NEXT run() succeeds (the failed future was removed, no dead-future lockout)
#
# The FALSIFIER is scripts/falsify_singleflight_smoke.sh: it deletes the atomic putIfAbsent coalescing from a
# TEMP COPY of the source (the real file is untouched), recompiles, and requires the SAME "LOADS == 1"
# assertion to go RED — proving the green is attributable to the in-flight merge, not a test that cannot fail.
#
# NOT CLAIMED: cross-process/cross-node coalescing (the table is per-JVM); caching of values (this is not a
# cache, callers layer it over their own); any latency/throughput number (no benchmark); or that a real
# Postgres stampede was measured (the loader is a controlled counter, not a database).
#
# Usage:  bash scripts/singleflight_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/services/platform/src/main/java/com/nexus/platform/Singleflight.java"
BUILD="${TMPDIR:-/tmp}/nexus-singleflight-$$"
N=16
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() { rm -rf "$BUILD" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -f "$SRC" ] || fail "Singleflight.java not found at $SRC"
command -v javac >/dev/null 2>&1 || fail "javac not available"
grep -q 'putIfAbsent' "$SRC" || fail "the source no longer uses the atomic putIfAbsent coalescing"

mkdir -p "$BUILD/src/com/nexus/platform" "$BUILD/classes" || fail "could not create build dir"
cp "$SRC" "$BUILD/src/com/nexus/platform/Singleflight.java"

# ---- the harness: compiled against the ACTUAL source, drives the loader-count scenarios -----------------
cat > "$BUILD/src/SfHarness.java" <<'JAVA'
import com.nexus.platform.Singleflight;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class SfHarness {
    private static final int N = Integer.parseInt(System.getProperty("n", "16"));

    /** CountDownLatch.await throws a checked InterruptedException; Supplier.get cannot declare it. */
    private static void await(CountDownLatch latch, long secs) {
        try {
            if (!latch.await(secs, TimeUnit.SECONDS)) throw new IllegalStateException("await timeout");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("await interrupted", e);
        }
    }

    public static void main(String[] args) throws Exception {
        coalesce();
        failureAndCleanup();
    }

    /** N concurrent misses for one cold key -> exactly ONE loader invocation, all get the shared value. */
    private static void coalesce() throws Exception {
        Singleflight<String, String> sf = new Singleflight<>();
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);
        CountDownLatch ownerEntered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(N);
        List<Future<String>> results = new ArrayList<>();
        try {
            for (int i = 0; i < N; i++) {
                results.add(pool.submit(() -> {
                    allAtGate.countDown();
                    return sf.run("cold:key", () -> {
                        loads.incrementAndGet();
                        ownerEntered.countDown();
                        await(release, 10);
                        return "shared-value";
                    });
                }));
            }
            if (!allAtGate.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("gate timeout");
            if (!ownerEntered.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("loader timeout");
            Thread.sleep(120); // let the N-1 followers reach join() before releasing the owner
            release.countDown();
            int ok = 0;
            for (Future<String> f : results) if ("shared-value".equals(f.get(5, TimeUnit.SECONDS))) ok++;
            System.out.println("LOADS=" + loads.get());
            System.out.println("WAITERS=" + ok);
        } finally {
            pool.shutdownNow();
        }
    }

    /** A throwing loader reaches EVERY joiner, and a subsequent run() reloads (in-flight entry was removed). */
    private static void failureAndCleanup() throws Exception {
        Singleflight<String, String> sf = new Singleflight<>();
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(N);
        List<Future<Throwable>> errors = new ArrayList<>();
        try {
            for (int i = 0; i < N; i++) {
                errors.add(pool.submit(() -> {
                    allAtGate.countDown();
                    try {
                        sf.run("fail:key", () -> {
                            loads.incrementAndGet();
                            await(release, 10);
                            throw new IllegalStateException("boom");
                        });
                        return null;
                    } catch (CompletionException e) {
                        return e.getCause();
                    }
                }));
            }
            if (!allAtGate.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("gate timeout");
            Thread.sleep(120);
            release.countDown();
            int sawBoom = 0;
            for (Future<Throwable> f : errors) {
                Throwable c = f.get(5, TimeUnit.SECONDS);
                if (c instanceof IllegalStateException && "boom".equals(c.getMessage())) sawBoom++;
            }
            System.out.println("SAW_FAILURE=" + sawBoom);
            System.out.println("FAIL_LOADS=" + loads.get());
            // The failed future must have been removed, so this is a NEW load, not a join of a dead future.
            // Its RETURN VALUE is the proof: a stale exceptionally-completed future would throw here.
            System.out.println("RECOVERY=" + sf.run("fail:key", () -> "recovered"));
        } finally {
            pool.shutdownNow();
        }
    }
}
JAVA

echo "== compiling the ACTUAL Singleflight.java + harness with javac =="
javac -d "$BUILD/classes" "$BUILD/src/com/nexus/platform/Singleflight.java" "$BUILD/src/SfHarness.java" \
  || fail "javac could not compile the source + harness"
echo "== running N=$N real JVM threads against the compiled source =="
OUT=$(java -cp "$BUILD/classes" -Dn="$N" SfHarness 2>&1) || fail "harness crashed: $OUT"
echo "$OUT" | sed 's/^/  /'

LOADS=$(echo "$OUT" | awk -F= '/^LOADS=/{print $2}')
WAITERS=$(echo "$OUT" | awk -F= '/^WAITERS=/{print $2}')
SAW_FAILURE=$(echo "$OUT" | awk -F= '/^SAW_FAILURE=/{print $2}')
FAIL_LOADS=$(echo "$OUT" | awk -F= '/^FAIL_LOADS=/{print $2}')
RECOVERY=$(echo "$OUT" | awk -F= '/^RECOVERY=/{print $2}')
AFTER_LOADS=$(echo "$OUT" | awk -F= '/^AFTER_LOADS=/{print $2}')
[ -n "$LOADS" ] && [ -n "$WAITERS" ] && [ -n "$SAW_FAILURE" ] || fail "harness did not emit the required counters"

# ---- assertions: the coalescing claim + failure propagation + in-flight cleanup ----------------------
[ "$LOADS" -eq 1 ] || fail "LOADS=$LOADS, expected 1 — N concurrent cold misses did NOT collapse into one load"
[ "$WAITERS" -eq "$N" ] || fail "WAITERS=$WAITERS, expected $N — not every caller received the shared value"
[ "$SAW_FAILURE" -eq "$N" ] || fail "SAW_FAILURE=$SAW_FAILURE, expected $N — the loader's failure did not reach all joiners"
[ "$FAIL_LOADS" -eq 1 ] || fail "FAIL_LOADS=$FAIL_LOADS, expected 1 — the failure scenario itself did not coalesce"
# The "never shortens"-style load-bearing cleanup proof: a subsequent run() returns a FRESH value. If the
# failed future had NOT been removed from the in-flight table, this join() would rethrow CompletionException
# and RECOVERY could never equal "recovered" — the call would be locked out forever.
[ "$RECOVERY" = "recovered" ] || fail "RECOVERY=$RECOVERY, expected 'recovered' — a failed future locked out the next call (in-flight entry was not cleared)"

echo "PASS: N=$N concurrent misses collapsed to LOADS=1 (WAITERS=$N); a failure reached $SAW_FAILURE/$N joiners and the in-flight entry was cleared (the next call returned a fresh '$RECOVERY') — D944 coalesces and stays live on real JVM threads"
