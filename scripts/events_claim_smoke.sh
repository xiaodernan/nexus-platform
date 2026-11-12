#!/usr/bin/env bash
# NEXUS D950 — dead-consumer pending reclamation, measured on the wire against a live Redis Stream.
#
# "On the wire" means the ACTUAL Lettuce XAUTOCLAIM command against the live nexus-platform-redis on
# :6380 — not a mock. The reader under test is COMPILED FROM THE ACTUAL EventsReader.java SOURCE (plus
# its real EventsRing.java), so a stale copy cannot drift from what the service ships.
#
#   1. build the events-service dependency classpath OFFLINE (mvn dependency:build-classpath)
#   2. javac the real EventsReader.java + EventsRing.java + a generated ClaimHarness against it
#   3. the harness, against live Redis, on a UNIQUE stream+group:
#      a. publish N entries, then have a consumer "dead-consumer" claim them with a raw XREADGROUP
#         and NEVER XACK — modelling a process that crashed between claim and ack (PEL = N; stranded)
#      b. construct a LIVE reader with claim ON + min-idle 0 and pollOnce()
#      c. assert the reader reclaimed all N (reclaimed == N), saw them (total_seen == N),
#         and the PEL is drained (XPENDING == 0)  <-- THE load-bearing recovery assertion
#      d. SAME setup, claim OFF (D931 behaviour): the dead consumer's entries stay PENDING (PEL == N)
#      e. SAME setup, claim ON + a HUGE min-idle: a FRESH pending entry is NOT stolen (PEL == N)
#      f. bound check: batch=2/maxBatches=1 over 7 stranded entries drains them across repeated polls
#
# The reader emits machine-readable lines: STRANDED=.. RECLAIMED=.. TOTAL_SEEN=.. PEL_END=.. and
# RECLAIM_ARM=<on|off> / THRESHOLD_ARM / BOUNDED_ARM. This script owns every assertion over those lines.
#
# The FALSIFIER is scripts/falsify_events_claim_smoke.sh: it compiles a TEMP COPY of the source with
# the `reclaimDeadPending(me)` call removed from pollGroup(), recompiles, and requires the SAME
# "PEL drained / reclaimed == N" assertion to go RED — proving the green is attributable to the third
# arm actually running, not to a harness that cannot fail. One flipped variable (the call), intact control.
#
# NOT CLAIMED: that a real dead JVM was killed (the "crash" is a raw XREADGROUP that never ACKs, which
# is exactly the server-side state a crash leaves); leader election / fencing of the old consumer;
# a dead-letter queue; exactly-once (XAUTOCLAIM is at-least-once — a slow-but-live consumer whose entry
# exceeds min-idle may have it duplicated); any latency/throughput number; or that any shipped deployment
# enables group or claim mode (both default OFF).
#
# Usage:  bash scripts/events_claim_smoke.sh
#         NEXUS_EVENTS_CLAIM_OFF=1 bash scripts/events_claim_smoke.sh   # must FAIL (the falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
SRC_DIR="$CLOUD/events-service/src/main/java/com/nexus/cloud/events"
MVN="${MVN:-mvn}"
BUILD="${TMPDIR:-/tmp}/nexus-events-claim-$$"
N="${NEXUS_EVENTS_CLAIM_N:-6}"
URL="redis://127.0.0.1:6380/0"
CLAIM_OFF="${NEXUS_EVENTS_CLAIM_OFF:-0}"

fail() { echo "FAIL: $*" >&2; echo "build dir: $BUILD" >&2; exit 1; }
cleanup() { rm -rf "$BUILD" >/dev/null 2>&1 || true; }
trap cleanup EXIT

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380"
command -v javac >/dev/null 2>&1 || fail "javac not available"
command -v java >/dev/null 2>&1 || fail "java not available"
[ -f "$SRC_DIR/EventsReader.java" ] || fail "EventsReader.java not found"
grep -q 'xautoclaim(' "$SRC_DIR/EventsReader.java" || fail "the source no longer calls xautoclaim()"
grep -q 'reclaimDeadPending' "$SRC_DIR/EventsReader.java" || fail "the source no longer wires the reclaim arm"

mkdir -p "$BUILD/src/com/nexus/cloud/events" "$BUILD/classes" || fail "could not create build dir"
# The falsifier replaces this copy's pollGroup() call with a no-op; the repository file is untouched.
SRC_COPY="$BUILD/src/com/nexus/cloud/events/EventsReader.java"
cp "$SRC_DIR/EventsReader.java" "$SRC_COPY"
cp "$SRC_DIR/EventsRing.java" "$BUILD/src/com/nexus/cloud/events/EventsRing.java"
if [ "$CLAIM_OFF" = "1" ]; then
    grep -q 'reclaimDeadPending(me);' "$SRC_COPY" || fail "falsifier: could not find the reclaim call to remove"
    python - "$SRC_COPY" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = '            reclaimDeadPending(me);'
assert old in s, 'falsifier: reclaim call token absent from temp source'
s = s.replace(old, '            /* FALSIFIER: reclaim arm removed */', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
    echo "  FALSIFIER ARM: removed the reclaimDeadPending(me) call from the temp source copy"
fi

echo "== generating offline dependency classpath =="
timeout 180 "$MVN" -o -q -f "$CLOUD/pom.xml" -pl events-service \
    org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath \
    -Dmdep.outputFile="$BUILD/cp.txt" >"$BUILD/mvn.log" 2>&1 \
    || { echo "  offline classpath build failed — retrying with network" ;
         timeout 240 "$MVN" -q -f "$CLOUD/pom.xml" -pl events-service \
         org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath \
         -Dmdep.outputFile="$BUILD/cp.txt" >"$BUILD/mvn.log" 2>&1 \
         || { tail -20 "$BUILD/mvn.log"; fail "maven dependency:build-classpath"; } }
CP="$(cat "$BUILD/cp.txt")"
[ -n "$CP" ] || fail "empty dependency classpath"
# Git Bash on Windows runs the Windows javac and the Maven classpath uses ';'; Linux CI uses ':'.
SEP=':'; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=';' ;; esac
FULL_CP="$BUILD/classes$SEP$CP"

echo "== compiling the ACTUAL EventsReader.java + EventsRing.java + harness =="
cat > "$BUILD/src/ClaimHarness.java" <<'JAVA'
import com.nexus.cloud.events.EventsReader;
import io.lettuce.core.Consumer;
import io.lettuce.core.RedisClient;
import io.lettuce.core.XGroupCreateArgs;
import io.lettuce.core.XReadArgs;
import io.lettuce.core.api.StatefulRedisConnection;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Drives the REAL EventsReader against live Redis. args: mode claimEnabled minIdleMs n batch maxBatches polls. */
public final class ClaimHarness {
    private static final String URL = "redis://127.0.0.1:6380/0";
    private static final String STREAM = "nexus:events";

    public static void main(String[] args) {
        String mode = args[0];
        boolean claim = Boolean.parseBoolean(args[1]);
        long minIdle = Long.parseLong(args[2]);
        int n = Integer.parseInt(args[3]);
        long batch = Long.parseLong(args[4]);
        int maxBatches = Integer.parseInt(args[5]);
        int polls = Integer.parseInt(args[6]);

        RedisClient setup = RedisClient.create(URL);
        StatefulRedisConnection<String, String> conn = setup.connect();
        String group = "g-d950-" + UUID.randomUUID();
        try {
            conn.sync().del(STREAM);
            conn.sync().xgroupCreate(XReadArgs.StreamOffset.from(STREAM, "0"), group,
                    XGroupCreateArgs.Builder.mkstream());
            for (int i = 0; i < n; i++) {
                Map<String, String> body = new HashMap<>();
                body.put("template", "lead_new");
                body.put("i", Integer.toString(i));
                conn.sync().xadd(STREAM, body);
            }
            // The "crash": a consumer claims all N with raw XREADGROUP and NEVER acks. This is exactly
            // the server-side PEL state a process that died between claim and ack leaves behind.
            conn.sync().xreadgroup(Consumer.from(group, "dead-consumer"),
                    new XReadArgs().count(500), XReadArgs.StreamOffset.from(STREAM, ">"));
            long stranded = conn.sync().xpending(STREAM, group).getCount();
            System.out.println("STRANDED=" + stranded);

            EventsReader reader = new EventsReader(true, URL, 5L, 128,
                    true, group, "rescuer", claim, minIdle, batch, maxBatches,
                    new SimpleMeterRegistry());
            for (int p = 0; p < polls; p++) {
                reader.pollOnce();
            }
            long pelEnd = conn.sync().xpending(STREAM, group).getCount();
            System.out.println("RECLAIMED=" + reader.reclaimedCount());
            System.out.println("TOTAL_SEEN=" + reader.totalSeen());
            System.out.println("PEL_END=" + pelEnd);
            System.out.println("CLAIM_MIN_IDLE_MS=" + reader.claimMinIdleMs());
            System.out.println("ARM=" + mode);
            reader.closeQuietly();
        } finally {
            conn.sync().del(STREAM);
            conn.close();
            setup.shutdown();
        }
        System.exit(0); // Netty's event-loop threads otherwise delay a forked JVM's exit (D931 note)
    }
}
JAVA

javac -encoding UTF-8 -cp "$FULL_CP" -d "$BUILD/classes" \
    "$SRC_COPY" "$BUILD/src/com/nexus/cloud/events/EventsRing.java" "$BUILD/src/ClaimHarness.java" \
    >"$BUILD/javac.log" 2>&1 || { cat "$BUILD/javac.log"; fail "javac compilation"; }
echo "  compiled (javac clean)"

run_arm() { # $1=mode $2=claim $3=minIdle $4=n $5=batch $6=maxBatches $7=polls
    java -cp "$FULL_CP" ClaimHarness "$1" "$2" "$3" "$4" "$5" "$6" "$7" 2>"$BUILD/run-$1.err"
}

# ---- arm (a): claim ON + min-idle 0 -> the dead consumer's N pending entries are RECLAIMED ----------
echo "== ARM reclaim: claim=true min-idle=0 N=$N =="
R=$(run_arm reclaim true 0 "$N" 50 8 1) || fail "reclaim arm process failed"
echo "$R" | grep -E '^(STRANDED|RECLAIMED|TOTAL_SEEN|PEL_END|ARM)=' | sed 's/^/  /'
v() { echo "$R" | grep -E "^$1=" | head -1 | cut -d= -f2; }
[ "$(v STRANDED)" = "$N" ] || fail "reclaim arm premise: expected $N stranded, got $(v STRANDED)"
[ "$(v RECLAIMED)" = "$N" ] || fail "RECOVERY RED: reclaimed=$(v RECLAIMED) != N=$N — the dead consumer's entries were NOT rescued"
[ "$(v TOTAL_SEEN)" = "$N" ] || fail "the ring did not see all $N rescued entries: total_seen=$(v TOTAL_SEEN)"
[ "$(v PEL_END)" = "0" ] || fail "RECOVERY RED: PEL=$(v PEL_END) != 0 — entries still stranded; XAUTOCLAIM/XACK arm did not drain"
echo "  RECOVERY HOLDS: reclaimed=$N, total_seen=$N, PEL=0"

if [ "$CLAIM_OFF" = "1" ]; then
    # The falsifier's whole point: with the reclaim call removed, the SAME recovery assertion must RED.
    fail "FALSE: with the reclaim arm removed the PEL still drained — the recovery claim is not falsifiable"
fi

# ---- arm (b): claim OFF (D931) -> the dead consumer's entries stay PENDING ------------------------
echo "== ARM contrast: claim=false (D931 behaviour) =="
R2=$(run_arm contrast false 0 "$N" 50 8 2) || fail "contrast arm process failed"
echo "$R2" | grep -E '^(STRANDED|RECLAIMED|TOTAL_SEEN|PEL_END|ARM)=' | sed 's/^/  /'
v2() { echo "$R2" | grep -E "^$1=" | head -1 | cut -d= -f2; }
[ "$(v2 RECLAIMED)" = "0" ] || fail "claim OFF still reclaimed $(v2 RECLAIMED) entries — the opt-in default is not inert"
[ "$(v2 TOTAL_SEEN)" = "0" ] || fail "claim OFF saw $(v2 TOTAL_SEEN) entries — D931's replay must not read a DEAD consumer's PEL"
[ "$(v2 PEL_END)" = "$N" ] || fail "claim OFF: expected the dead consumer's $N entries to stay PENDING, got $(v2 PEL_END)"
echo "  OPT-IN HOLDS: claim=false reclaims nothing; the dead consumer's $N entries stay PENDING (the D931 seam)"

# ---- arm (c): claim ON + HUGE min-idle -> a FRESH pending entry is NOT stolen --------------------
echo "== ARM threshold: claim=true min-idle=600000 =="
R3=$(run_arm threshold true 600000 "$N" 50 8 1) || fail "threshold arm process failed"
echo "$R3" | grep -E '^(STRANDED|RECLAIMED|PEL_END|CLAIM_MIN_IDLE_MS|ARM)=' | sed 's/^/  /'
v3() { echo "$R3" | grep -E "^$1=" | head -1 | cut -d= -f2; }
[ "$(v3 RECLAIMED)" = "0" ] || fail "min-idle gate RED: reclaimed=$(v3 RECLAIMED) fresh entries — a slow-but-live consumer could be robbed"
[ "$(v3 PEL_END)" = "$N" ] || fail "min-idle gate RED: PEL=$(v3 PEL_END) — fresh entries were claimed despite a huge threshold"
echo "  THRESHOLD HOLDS: a fresh pending entry is not stolen; min-idle is load-bearing"

# ---- arm (d): bounded batches still drain the whole PEL across repeated polls --------------------
echo "== ARM bounded: batch=2 maxBatches=1 N=7 polls=8 =="
R4=$(run_arm bounded true 0 7 2 1 8) || fail "bounded arm process failed"
echo "$R4" | grep -E '^(STRANDED|RECLAIMED|TOTAL_SEEN|PEL_END|ARM)=' | sed 's/^/  /'
v4() { echo "$R4" | grep -E "^$1=" | head -1 | cut -d= -f2; }
[ "$(v4 STRANDED)" = "7" ] || fail "bounded arm premise: expected 7 stranded, got $(v4 STRANDED)"
[ "$(v4 PEL_END)" = "0" ] || fail "bounded arm RED: PEL=$(v4 PEL_END) — repeated bounded sweeps did not drain the PEL"
[ "$(v4 RECLAIMED)" = "7" ] || fail "bounded arm RED: reclaimed=$(v4 RECLAIMED) != 7"
echo "  BOUNDED HOLDS: the cursor is followed, not re-scanned; bounded work drains the whole PEL"

echo "PASS: XAUTOCLAIM rescues all $N dead-consumer pending entries (PEL N->0, reclaimed=N); claim OFF + huge min-idle both leave the PEL intact; bounded sweeps drain it — D950 closes D931's dead-consumer seam on the wire"
