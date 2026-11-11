#!/usr/bin/env node
/**
 * NEXUS D931 — the consumer-group reliability seam for nexus-events stays wired.
 *
 * D928/D929 shipped a Redis Streams carrier and a bare-XREAD tail reader, and said out loud that it
 * had NO consumer groups, NO acks and NO replay. D931 adds an OPT-IN group mode (default OFF, so
 * D929's tail semantics and seven tests are untouched) using the real primitives:
 * {@code XGROUP CREATE … MKSTREAM}, {@code XREADGROUP … >} for the at-most-once split across a group,
 * {@code XACK} only after a successful ring push, and {@code XREADGROUP … 0} to replay this consumer's
 * own unacked entries. {@code GET /events/group} exposes delivered / acked / pending so the property is
 * observable. The behaviour is MEASURED by {@code events_group_smoke.sh} (two live readers split N,
 * sum == N) and its falsifier (tails double it to 2N), plus {@code EventsGroupReaderTest}.
 *
 * THIS reader holds the parts that could silently disappear: the real Lettuce group calls (a comment
 * naming XACK is not an XACK), the opt-in default, the observable endpoint, the replay offsets, the
 * two-reader split assertion and its falsifier, the unit-test twin, and the CI/ATLAS/CLOUD/census
 * wiring. It runs on source text only; it starts no JVM and touches no Redis — the smoke owns that.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory — an
 * XACK erased, the opt-in default flipped to TRUE, the /events/group mapping removed, the smoke's
 * SPLIT assertion weakened, the falsifier's group-disable flipped, the honesty clause reverted to
 * "does not participate in consumer groups", and a deleted CI entry — and requires EACH to redden
 * while the real plane holds. A seam whose proof can vanish unnoticed is not a seam.
 *
 * WHAT THIS DOES NOT SAY: that any smoke ran today, that the two-reader sum was actually N (the smoke
 * measures that on a live plane), that group HA / XAUTOCLAIM of a DEAD consumer works (not claimed), or
 * that the default deployment uses groups (it does not — default OFF).
 *
 * Usage:  node scripts/check_events_group.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const READER = 'services/cloud/events-service/src/main/java/com/nexus/cloud/events/EventsReader.java';
const VIEW = 'services/cloud/events-service/src/main/java/com/nexus/cloud/events/EventsViewController.java';
const YAML = 'services/cloud/events-service/src/main/resources/application.yaml';
const TEST = 'services/cloud/events-service/src/test/java/com/nexus/cloud/events/EventsGroupReaderTest.java';
const SMOKE = 'scripts/events_group_smoke.sh';
const FALSIFIER = 'scripts/falsify_events_group_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD_DOC = 'docs/CLOUD.md';
const CENSUS = 'docs/cloud_claims.yaml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_events_group.mjs';
const PATHS = [READER, VIEW, YAML, TEST, SMOKE, FALSIFIER, CI, ATLAS, CLOUD_DOC, CENSUS, STATUS, SELF];

/** Pure over a (path -> text) map; file existence is passed in as a Set of paths. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the events-group plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the real Lettuce primitives are CALLED, not merely named in a comment. */
  has(READER, 'xgroupCreate(', 'XGROUP CREATE is issued');
  has(READER, 'XGroupCreateArgs.Builder.mkstream()', 'group creation uses MKSTREAM');
  has(READER, 'xreadgroup(', 'XREADGROUP is issued');
  has(READER, 'xack(', 'XACK is issued only after a ring push');
  has(READER, 'xpending(', 'XPENDING is read for the pending count');
  has(READER, 'Consumer.from(groupName, consumerName)', 'each reader is a distinct named consumer');
  has(READER, 'PENDING_OFFSET = "0"', 'replay offset 0 is declared');
  has(READER, 'NEW_OFFSET = ">"', 'new-message offset > is declared');
  absent(READER, 'does not participate in consumer groups', 'reader does not carry the stale no-group prose');

  /* 2 — opt-in: the flag defaults false, so D929's tail path is still the shipped default. */
  has(YAML, 'group-enabled: ${NEXUS_EVENTS_GROUP_ENABLED:false}', 'group mode is OPT-IN (default false)');
  has(YAML, 'group-name: ${NEXUS_EVENTS_GROUP_NAME:', 'group name is configurable');
  has(YAML, 'consumer-name: ${NEXUS_EVENTS_CONSUMER_NAME:', 'consumer name is configurable');
  has(READER, 'if (groupEnabled) {', 'the tail path is preserved behind the flag');
  has(READER, 'pollTail()', 'the D929 bare-XREAD path still exists');

  /* 3 — the property is observable over HTTP. */
  has(VIEW, '@GetMapping("/events/group")', 'the /events/group endpoint is mapped');
  has(VIEW, 'reader.groupState()', 'the endpoint reads the live group state');
  has(READER, 'out.put("delivered"', 'delivered count is exposed');
  has(READER, 'out.put("acked"', 'acked count is exposed');
  has(READER, 'out.put("pending"', 'pending count is exposed');

  /* 4 — the MEASURED proof and its falsifier, with the single flipped variable. */
  has(SMOKE, 'NEXUS_EVENTS_GROUP_ENABLED="$GROUP_FLAG"', 'the smoke drives the group flag');
  has(SMOKE, 'redis XADD nexus:events', 'the smoke publishes real entries to the live stream');
  has(SMOKE, 'NEXUS_EVENTS_CONSUMER_NAME="$2"', 'the two readers get distinct consumer names');
  // The load-bearing assertion: sum == N, and the falsifier flips exactly group-enabled.
  has(SMOKE, 'if [ "$sum" -ne "$N" ]', 'the smoke asserts the two-reader sum equals N exactly');
  has(SMOKE, 'sum == N', 'the smoke states what SPLIT proves');
  has(FALSIFIER, 'NEXUS_EVENTS_GROUP_OFF=1', 'the falsifier flips group-enabled off');
  has(FALSIFIER, 'grep -q "sum=.*!= N="', 'the falsifier requires a RED attributable to the split');
  has(FALSIFIER, 'main smoke stayed GREEN', 'the falsifier fails if the claim is not falsifiable');
  has(TEST, 'isEqualTo(n)', 'the unit test asserts same-group readers split N, not 2N');
  has(TEST, 'xpending', 'the unit test measures the pending/replay property');

  /* 5 — wiring into CI, the human page, the machine census and the ledger. */
  has(CI, 'node scripts/check_events_group.mjs --self-test', 'CI runs this reader with its self-test');
  has(CI, 'events_group_smoke.sh', 'CI runs the group smoke');
  has(CI, 'falsify_events_group_smoke.sh', 'CI runs the group falsifier');
  has(ATLAS, 'scripts/events_group_smoke.sh', 'ATLAS lists the group smoke');
  has(ATLAS, 'scripts/falsify_events_group_smoke.sh', 'ATLAS lists the group falsifier');
  has(ATLAS, 'scripts/check_events_group.mjs', 'ATLAS lists this reader');
  has(CLOUD_DOC, 'events_group_smoke.sh', 'CLOUD.md lists the group smoke');
  has(CLOUD_DOC, 'falsify_events_group_smoke.sh', 'CLOUD.md lists the group falsifier');
  has(CENSUS, '- id: D931', 'the machine census indexes D931');
  has(CENSUS, 'honesty_anchor: D931', 'D931 binds an exact honesty anchor');
  has(STATUS, '## 931. D931', 'the ledger holds §931');
  // The D929 not-claimed clause must be NARROWED, not silently deleted: group mode exists but is opt-in.
  has(CLOUD_DOC, 'D931', 'CLOUD.md records the D931 seam');
  absent(CLOUD_DOC, 'does NOT participate in consumer groups', 'the stale blanket no-group clause is gone');

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
    ['XACK erased', mutate(READER, 'connection.sync().xack(', 'connection.sync()./*xack*/noop(')],
    ['opt-in default flipped', mutate(YAML, 'GROUP_ENABLED:false', 'GROUP_ENABLED:true')],
    ['endpoint removed', mutate(VIEW, '@GetMapping("/events/group")', '@GetMapping("/events/none")')],
    ['split assertion weakened', mutate(SMOKE, 'if [ "$sum" -ne "$N" ]', 'if [ "$sum" -lt "$N" ]')],
    ['falsifier stop flipping', mutate(FALSIFIER, 'NEXUS_EVENTS_GROUP_OFF=1', 'NEXUS_EVENTS_GROUP_OFF=0')],
    ['stale no-group clause restored', mutate(CLOUD_DOC, 'does NOT backpressure into the platform',
      'does NOT participate in consumer groups, does NOT backpressure into the platform')],
    ['CI entry deleted', (() => {
      const f = new Map(real);
      f.set(CI, f.get(CI).replace('node scripts/check_events_group.mjs --self-test && ', ''));
      return { files: f };
    })()],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(34)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(34)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught}`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE EVENTS-GROUP WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D931 consumer-group seam wired, ${result.notes.length} holds`);
process.exit(0);
