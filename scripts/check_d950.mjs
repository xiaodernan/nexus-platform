#!/usr/bin/env node
/**
 * NEXUS D950 — the dead-consumer pending-reclamation seam for nexus-events stays wired.
 *
 * D928/D929 shipped a Redis Streams carrier and a bare-XREAD tail; D931 added an opt-in consumer group
 * that splits the stream, ACKs each delivered entry and replays THIS consumer's OWN unacked pending. It
 * said out loud what it did NOT do: "no XAUTOCLAIM/XCLAIM of a DEAD consumer's pending entries — only a
 * live consumer replays its own." A consumer that claimed entries and crashed before its XACK left them
 * PENDING forever. D950 adds an OPT-IN third arm (default OFF, so D929/D931 ship byte-for-byte) that
 * calls the real Lettuce {@code xautoclaim(...)}, follows the returned cursor, ACKs each rescued entry
 * only after a successful ring push, bounds the sweep per poll, and exposes a `reclaimed` counter over
 * `GET /events/group`. The behaviour is MEASURED by `events_claim_smoke.sh` (which COMPILES the actual
 * EventsReader.java + EventsRing.java and drives the real XAUTOCLAIM against live Redis) and its
 * falsifier (which removes the reclaim call from a temp source copy and requires the PEL-drain assertion
 * to redden), plus `EventsClaimReaderTest`.
 *
 * THIS reader holds the parts that could silently disappear: the real xautoclaim CALL (a comment naming
 * it is not a call), the min-idle-time argument that keeps a slow-but-live consumer from being robbed,
 * the bounded cursor loop, the ACK-after-push discipline, the opt-in DEFAULT FALSE, the four surviving
 * constructors, the `reclaimed`/knob exposure, the config knobs, the unit test, the smoke + falsifier
 * load-bearing assertions, and the CI/ATLAS/CLOUD/census/ledger wiring. It runs on source text only; it
 * starts no JVM and touches no Redis — the smoke owns that.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory — the
 * xautoclaim call erased, min-idle-time dropped, the reclaim arm unwired from pollGroup, the opt-in
 * default flipped TRUE, the reclaimed counter removed from groupState, the recovery assertion weakened,
 * the falsifier's remove-call flipped, the D931 "no XAUTOCLAIM" clause restored, and a deleted CI entry —
 * and requires EACH to redden while the real plane holds. A seam whose proof can vanish unnoticed is not
 * a seam.
 *
 * WHAT THIS DOES NOT SAY: that any smoke ran today, that the PEL was actually drained (the smoke measures
 * that on a live plane), that group/claim mode is enabled in any shipped deployment (both default OFF),
 * or that reclamation is exactly-once / fences the old owner (it is at-least-once; not claimed).
 *
 * Usage:  node scripts/check_d950.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const READER = 'services/cloud/events-service/src/main/java/com/nexus/cloud/events/EventsReader.java';
const YAML = 'services/cloud/events-service/src/main/resources/application.yaml';
const TEST = 'services/cloud/events-service/src/test/java/com/nexus/cloud/events/EventsClaimReaderTest.java';
const SMOKE = 'scripts/events_claim_smoke.sh';
const FALSIFIER = 'scripts/falsify_events_claim_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD_DOC = 'docs/CLOUD.md';
const CENSUS = 'docs/cloud_claims.yaml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d950.mjs';
const PATHS = [READER, YAML, TEST, SMOKE, FALSIFIER, CI, ATLAS, CLOUD_DOC, CENSUS, STATUS, SELF];

/** Pure over a (path -> text) map; file existence is passed in as a Set of paths. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the events-claim plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };
  const countAtLeast = (p, needle, n, label) => {
    const c = t(p).split(needle).length - 1;
    if (c < n) offenders.push(`MISSING — ${p}: ${label} (found ${c}, need >= ${n} of ${JSON.stringify(needle)})`);
    else notes.push(`held ${label} (${c})`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the REAL Lettuce xautoclaim primitive is CALLED, with the idle threshold and a bounded cursor. */
  has(READER, 'connection.sync().xautoclaim(STREAM_KEY, claimArgs)', 'the real XAUTOCLAIM command is issued');
  has(READER, 'XAutoClaimArgs.Builder', 'the claim is built with XAutoClaimArgs');
  has(READER, '.xautoclaim(me, claimMinIdleMs, cursor)', 'the min-idle-time threshold is passed into the claim');
  has(READER, '.count(claimBatchSize)', 'the sweep is bounded by COUNT per batch');
  has(READER, 'CLAIM_CURSOR_START = "0-0"', 'the cursor starts at 0-0');
  has(READER, 'CLAIM_MAX_BATCHES_HARD_CAP', 'a hard cap bounds work per poll (OS-friendly)');
  has(READER, 'batch < claimMaxBatches', 'the cursor loop is bounded by claimMaxBatches');
  has(READER, 'cursor = next', 'the server cursor is FOLLOWED, not re-scanned');
  has(READER, 'ClaimedMessages', 'the ClaimedMessages result is consumed');
  has(READER, 'messages.isEmpty()', 'an empty batch ends the sweep');
  absent(READER, 'computeIfAbsent', 'no computeIfAbsent mapping-function lock smuggled in');

  /* 2 — ACK only after a successful ring push; the reclaimed counter makes recovery observable. */
  has(READER, 'ring.push(msg.getId(), msg.getBody());', 'each rescued entry is pushed to the ring');
  has(READER, 'reclaimed.incrementAndGet();', 'the reclaimed counter increments per rescue');
  has(READER, 'connection.sync().xack(STREAM_KEY, groupName, msg.getId())', 'the rescued entry is XACKd');
  has(READER, 'out.put("reclaimed", reclaimed.get());', 'the LIVE reclaimed counter is exposed over /events/group (not a hardcoded 0)');
  has(READER, 'out.put("claim_enabled"', 'claim_enabled is exposed');
  has(READER, 'out.put("claim_min_idle_ms"', 'the idle threshold is exposed');
  has(READER, 'public long reclaimedCount()', 'a public reclaimedCount() accessor exists for the harness');
  has(READER, 'if (n != null && n > 0)', 'ACK only counts when Redis actually acked');

  /* 3 — the third arm is wired INSIDE pollGroup, gated on group AND claim. */
  has(READER, 'reclaimDeadPending(me);', 'the reclaim arm is called from pollGroup');
  has(READER, 'if (groupEnabled && claimEnabled)', 'both flags gate the reclaim arm');
  has(READER, 'drain(me, args, XReadArgs.StreamOffset.from(STREAM_KEY, PENDING_OFFSET))', 'D931 replay arm survives');
  has(READER, 'drain(me, args, XReadArgs.StreamOffset.from(STREAM_KEY, NEW_OFFSET))', 'D931 new arm survives');
  has(READER, 'PENDING_OFFSET = "0"', 'the replay offset is unchanged');
  has(READER, 'NEW_OFFSET = ">"', 'the new offset is unchanged');
  absent(READER, 'no XAUTOCLAIM/XCLAIM of a DEAD consumer', 'the source does not carry the stale no-claim prose as a live claim');

  /* 4 — opt-in DEFAULT FALSE and bounded knobs; all four constructor shapes survive. */
  has(READER, '@Value("${nexus.events.claim-enabled:false}") boolean claimEnabled', 'claim mode is OPT-IN (default false)');
  has(READER, '@Autowired', 'exactly one Spring constructor is annotated');
  has(READER, 'CLAIM_MAX_BATCHES_HARD_CAP = 64', 'the hard cap is pinned at 64');
  has(READER, 'claimBatchSize < 1L ? 1L : claimBatchSize', 'an invalid batch size is clamped');
  // The 12-arg @Autowired constructor plus the D931/D939 8-arg, D931 7-arg and D929 4-arg shapes.
  countAtLeast(READER, 'public EventsReader(', 4, 'all four constructor shapes survive');
  has(YAML, 'claim-enabled: ${NEXUS_EVENTS_CLAIM_ENABLED:false}', 'yaml claim knob defaults false');
  has(YAML, 'claim-min-idle-ms: ${NEXUS_EVENTS_CLAIM_MIN_IDLE_MS:60000}', 'yaml idle threshold is configurable');
  has(YAML, 'claim-batch-size: ${NEXUS_EVENTS_CLAIM_BATCH_SIZE:50}', 'yaml batch size is configurable');
  has(YAML, 'claim-max-batches: ${NEXUS_EVENTS_CLAIM_MAX_BATCHES:8}', 'yaml max batches is configurable');

  /* 5 — the MEASURED proof, its contrast arms and its falsifier (single flipped variable). */
  has(SMOKE, 'dependency:build-classpath', 'the smoke builds the real dependency classpath offline');
  has(SMOKE, 'javac -encoding UTF-8', 'the smoke COMPILES the actual source, not a mock');
  has(SMOKE, 'EventsReader.java', 'the smoke compiles the actual EventsReader.java');
  has(SMOKE, 'EventsRing.java', 'the smoke compiles the actual EventsRing.java');
  has(SMOKE, 'xreadgroup', 'the smoke strands entries under a dead consumer with a raw XREADGROUP');
  has(SMOKE, 'reclaimDeadPending(me);', 'the smoke guards the reclaim call it compiles from');
  // The load-bearing recovery assertion and its red label (the falsifier greps this exact token).
  has(SMOKE, '[ "$(v RECLAIMED)" = "$N" ]', 'the smoke asserts reclaimed == N');
  has(SMOKE, '[ "$(v PEL_END)" = "0" ]', 'the smoke asserts the PEL drains to 0');
  has(SMOKE, 'RECOVERY RED', 'the recovery assertion carries a greppable RED label');
  has(SMOKE, 'run_arm contrast false', 'the smoke runs the claim-OFF contrast arm');
  has(SMOKE, '[ "$(v2 PEL_END)" = "$N" ]', 'the contrast arm asserts the dead consumer stays PENDING');
  has(SMOKE, 'run_arm threshold true 600000', 'the smoke runs the huge-min-idle threshold arm');
  has(SMOKE, '[ "$(v3 RECLAIMED)" = "0" ]', 'the threshold arm asserts a fresh entry is not stolen');
  has(SMOKE, 'run_arm bounded true 0 7 2 1 8', 'the smoke runs the bounded-batch drain arm');
  has(FALSIFIER, 'NEXUS_EVENTS_CLAIM_OFF=1', 'the falsifier flips exactly one variable: the reclaim call removed');
  has(FALSIFIER, 'grep -q "RECOVERY RED"', 'the falsifier requires a RED attributable to the recovery assertion');
  has(FALSIFIER, 'main smoke stayed GREEN', 'the falsifier fails if the claim is not falsifiable');
  has(TEST, 'claimOnReclaimsDeadPendingWhileClaimOffLeavesItStranded', 'the unit test measures reclaim vs the claim-OFF contrast');
  has(TEST, 'theMinIdleThresholdProtectsAFreshlyPendingEntry', 'the unit test measures the min-idle gate');
  has(TEST, 'aBoundedBatchStillDrainsTheWholePelAcrossPolls', 'the unit test measures bounded drain');

  /* 6 — wiring into CI, the human page, the machine census and the ledger. */
  has(CI, 'node scripts/check_d950.mjs --self-test', 'CI runs this reader with its self-test');
  has(CI, 'events_claim_smoke.sh', 'CI runs the claim smoke');
  has(CI, 'falsify_events_claim_smoke.sh', 'CI runs the claim falsifier');
  has(ATLAS, 'scripts/events_claim_smoke.sh', 'ATLAS lists the claim smoke');
  has(ATLAS, 'scripts/falsify_events_claim_smoke.sh', 'ATLAS lists the claim falsifier');
  has(ATLAS, 'scripts/check_d950.mjs', 'ATLAS lists this reader');
  has(CLOUD_DOC, 'events_claim_smoke.sh', 'CLOUD.md lists the claim smoke');
  has(CLOUD_DOC, 'falsify_events_claim_smoke.sh', 'CLOUD.md lists the claim falsifier');
  has(CLOUD_DOC, 'check_d950.mjs', 'CLOUD.md lists this reader in the gate table');
  has(CENSUS, '- id: D950', 'the machine census indexes D950');
  has(CENSUS, 'honesty_anchor: D950', 'D950 binds an exact honesty anchor');
  has(STATUS, '## 950. D950', 'the ledger holds §950');
  has(CLOUD_DOC, 'D950', 'CLOUD.md records the D950 seam');
  // The D931 not-claimed clause must be NARROWED, not silently deleted: claim mode exists but is opt-in.
  absent(CLOUD_DOC, 'no `XAUTOCLAIM`/`XCLAIM` of a DEAD consumer', 'the stale blanket no-claim clause is gone');

  return { offenders, notes, unchecked: null, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) {
      present.add(p);
      files.set(p, readFileSync(abs, 'utf8'));
    }
  }
  return { files, present };
}

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const mutate = (path, from, to) => {
    const f = new Map(real);
    const text = f.get(path);
    if (!text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${path}` };
    f.set(path, text.replace(from, to));
    return { files: f };
  };
  const arms = [
    ['xautoclaim call erased', mutate(READER, 'connection.sync().xautoclaim(STREAM_KEY, claimArgs)', 'connection.sync()./*claim*/noop(STREAM_KEY, claimArgs)')],
    ['min-idle-time dropped', mutate(READER, '.xautoclaim(me, claimMinIdleMs, cursor)', '.xautoclaim(me, 0L, cursor)')],
    ['reclaim arm unwired', mutate(READER, '            reclaimDeadPending(me);', '            /* reaped */')],
    ['opt-in default flipped', mutate(YAML, 'CLAIM_ENABLED:false', 'CLAIM_ENABLED:true')],
    ['reclaimed counter removed', mutate(READER, 'out.put("reclaimed", reclaimed.get());', 'out.put("reclaimed", 0L);')],
    ['recovery assertion weakened', mutate(SMOKE, '[ "$(v PEL_END)" = "0" ]', '[ "$(v PEL_END)" -ge 0 ]')],
    ['falsifier stops removing', mutate(FALSIFIER, 'NEXUS_EVENTS_CLAIM_OFF=1', 'NEXUS_EVENTS_CLAIM_OFF=0')],
    ['stale no-claim clause restored', mutate(CLOUD_DOC, 'D950 NARROWS', 'no `XAUTOCLAIM`/`XCLAIM` of a DEAD consumer. D950 NARROWS')],
    ['CI entry deleted', (() => {
      const f = new Map(real);
      f.set(CI, f.get(CI).replace('node scripts/check_d950.mjs --self-test && ', ''));
      return { files: f };
    })()],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(30)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(30)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught} (${arms.length} arms)`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE EVENTS-CLAIM WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D950 dead-consumer claim seam wired, ${result.notes.length} holds`);
process.exit(0);
