#!/usr/bin/env bash
# NEXUS D944 — falsifier for singleflight_smoke.sh.
#
# The main smoke proves N concurrent misses for ONE key collapse into ONE loader invocation, on real JVM
# threads compiled from the ACTUAL Singleflight.java. The load-bearing line is the ATOMIC in-flight merge:
#   CompletableFuture<V> mine = inflight.putIfAbsent(key, fresh);
# Only the thread whose putIfAbsent returns null becomes the owner; every peer receives the owner's future and
# joins it instead of loading. Delete that merge and the coalescing disappears.
#
# This arm makes a TEMP COPY of the source (the real file is untouched) and replaces that ONE line with
#   CompletableFuture<V> mine = null; inflight.put(key, fresh);
# — every caller now sees "mine == null", believes it owns the load, and runs the loader. The SAME harness,
# SAME N, SAME schedule, SAME javac then reports LOADS=N instead of 1, so the "LOADS == 1" assertion REDDENS.
# A control binary compiled from the INTACT source still reports LOADS=1, proving the control is clean and the
# red is attributable to exactly one deleted merge — not a broken harness or a machine that cannot fail.
#
# Exit 0 = removing the merge restores the N-fold stampede (the coalescing claim is load-bearing) => falsifiable.
# Exit 1 = the merge-less source still collapsed to 1 (the assertion cannot fail) => do not claim D944.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/services/platform/src/main/java/com/nexus/platform/Singleflight.java"
BUILD="${TMPDIR:-/tmp}/nexus-singleflight-falsify-$$"
N=16
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() { rm -rf "$BUILD" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -f "$SRC" ] || fail "Singleflight.java not found at $SRC"
command -v javac >/dev/null 2>&1 || { echo "SKIP: javac not available — cannot run the falsifier"; exit 2; }

mkdir -p "$BUILD/broken/com/nexus/platform" "$BUILD/intact/com/nexus/platform" "$BUILD/classes-broken" "$BUILD/classes-intact" \
  || fail "could not create build dirs"
cp "$SRC" "$BUILD/intact/com/nexus/platform/Singleflight.java"

# ---- plant the ONE corruption in a temp copy: defeat the atomic in-flight merge ------------------------
python - "$SRC" "$BUILD/broken/com/nexus/platform/Singleflight.java" <<'PY' || fail "could not plant the merge-removal corruption"
import sys
src = open(sys.argv[1], encoding='utf-8').read()
needle = 'CompletableFuture<V> mine = inflight.putIfAbsent(key, fresh);'
if needle not in src:
    sys.exit("the atomic putIfAbsent merge line was not found — cannot plant the falsifier")
broken = src.replace(
    needle,
    'CompletableFuture<V> mine = null; inflight.put(key, fresh); // FALSIFIER: no merge, every caller loads',
    1)
assert broken != src, "the merge line was not replaced"
assert 'inflight.putIfAbsent(key, fresh)' not in broken, "the executable merge survived removal"
assert 'FALSIFIER: no merge' in broken, "the corruption marker was not planted"
open(sys.argv[2], 'w', encoding='utf-8').write(broken)
print("planted: putIfAbsent -> unconditional put (no in-flight merge)")
PY

# ---- the SAME harness for both binaries: N threads, one cold key, loader counter ------------------------
cat > "$BUILD/Harness.java" <<'JAVA'
import com.nexus.platform.Singleflight;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class Harness {
    private static void await(CountDownLatch latch, long secs) {
        try {
            if (!latch.await(secs, TimeUnit.SECONDS)) throw new IllegalStateException("await timeout");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("await interrupted", e);
        }
    }

    public static void main(String[] args) throws Exception {
        int n = Integer.parseInt(System.getProperty("n", "16"));
        Singleflight<String, String> sf = new Singleflight<>();
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(n);
        CountDownLatch ownerEntered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(n);
        List<Future<String>> results = new ArrayList<>();
        try {
            for (int i = 0; i < n; i++) {
                results.add(pool.submit(() -> {
                    allAtGate.countDown();
                    return sf.run("cold:key", () -> {
                        loads.incrementAndGet();
                        ownerEntered.countDown();
                        await(release, 10);
                        return "v";
                    });
                }));
            }
            if (!allAtGate.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("gate timeout");
            if (!ownerEntered.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("loader timeout");
            Thread.sleep(120);
            release.countDown();
            for (Future<String> f : results) f.get(5, TimeUnit.SECONDS);
            System.out.println("LOADS=" + loads.get());
        } finally {
            pool.shutdownNow();
        }
    }
}
JAVA

javac -d "$BUILD/classes-broken" "$BUILD/broken/com/nexus/platform/Singleflight.java" "$BUILD/Harness.java" \
  || fail "the merge-less source did not compile (the corruption must not be a syntax error)"
javac -d "$BUILD/classes-intact" "$BUILD/intact/com/nexus/platform/Singleflight.java" "$BUILD/Harness.java" \
  || fail "the intact control source did not compile"

echo "== MERGE-LESS source (N=$N real threads) =="
BROKEN=$(java -cp "$BUILD/classes-broken" -Dn="$N" Harness 2>&1) || fail "broken harness crashed: $BROKEN"
echo "$BROKEN" | sed 's/^/  /'
broken_loads=$(echo "$BROKEN" | awk -F= '/^LOADS=/{print $2}')
[ -n "$broken_loads" ] || fail "no LOADS emitted by the merge-less harness"
# The "LOADS == 1" assertion from the main smoke MUST redden here.
[ "$broken_loads" -gt 1 ] || fail "merge-less source still collapsed to LOADS=$broken_loads — the coalescing claim is NOT falsifiable here"
[ "$broken_loads" -eq "$N" ] || fail "expected LOADS=$N with no merge, got $broken_loads"

echo "== INTACT source control (N=$N real threads) =="
INTACT=$(java -cp "$BUILD/classes-intact" -Dn="$N" Harness 2>&1) || fail "intact harness crashed: $INTACT"
echo "$INTACT" | sed 's/^/  /'
intact_loads=$(echo "$INTACT" | awk -F= '/^LOADS=/{print $2}')
[ "$intact_loads" -eq 1 ] || fail "the intact source did NOT collapse to LOADS=1 (got $intact_loads) — the control is not clean"

echo "PASS: deleting the single putIfAbsent merge restores the N-fold stampede (LOADS=$broken_loads=$N) while the intact source still coalesces to LOADS=1 — D944's coalescing claim is falsifiable and the atomic merge is load-bearing"
