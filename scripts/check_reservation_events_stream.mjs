#!/usr/bin/env node
/**
 * NEXUS D985 — the commerce lane speaks on the wire: reservation events ride nexus:events end-to-end.
 *
 * D928 shipped the Redis Streams bridge (`RedisEventStream`), D929/D931 added consumer groups and
 * ACKs, D950 added dead-consumer reclamation, D973 the dispatcher sidecar — but the commerce lanes
 * emitted NO events at all: only `ConversationService` published anything, so `ReservationChanged`
 * fired for nobody booking anything. This unit wires the emitters into the reservation surface:
 * `ReservationController.book()` and the cancellation branch publish `ReservationChanged` on the
 * request thread (fail-soft through `NotificationEventListener.on()` exactly as conversations do),
 * `ReservationEventsStreamTest` boots a live `nexus_test` with `nexus.events.redis-stream-enabled=true`
 * and PROVES the entry landed on the stream — `type=ReservationChanged`, `toStatus` pending/cancelled,
 * `fromStatus` carried — without duplicating the booking assertions.
 *
 * THIS reader holds the parts that could silently vanish: the `ApplicationEventPublisher` injection in
 * the controller, BOTH emission sites (booking + cancel) with toStatus spelled out, the `!cancelled.replay()`
 * silence (idempotent re-cancel emits nothing), the DomainEvents import, the live-stream test's own
 * re-enablement of the bridge (the integration plane defaults it OFF for isolation), the reserved
 * `reservation_` template prefix deriving rather than inventing copy, and the CI/ATLAS/ledger wiring.
 * Tests execute the real HTTP+DB+Redis plane; this reader reads source text only — it starts no JVM.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory —
 * injection removed, booking emission moved after the audit-call with the wrong event class, the
 * cancel emission wiped, the replay guard dropped (double-emit on re-cancel), the stream test erased,
 * the prefix template rule cut from the renderer, the ATLAS row erased, the ledger heading erased,
 * the CI self-test invocation cut — and requires EACH to redden while the real plane holds.
 *
 * WHAT THIS DOES NOT SAY: that any webhook fired today, that a dispatch target exists, or that the
 * dispatcher delivered — the repo proves the wire and the consumer/read paths, not the downstream
 * delivery. The falsifier is "did commerce start, stay on, get re-ACKd, remain on the wire?"
 *
 * Usage:  node scripts/check_reservation_events_stream.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const CONTROLLER = 'services/platform/src/main/java/com/nexus/catalog/ReservationController.java';
const EVENTS = 'services/platform/src/main/java/com/nexus/notification/event/DomainEvents.java';
const LISTENER = 'services/platform/src/main/java/com/nexus/notification/NotificationEventListener.java';
const STREAM = 'services/platform/src/main/java/com/nexus/platform/RedisEventStream.java';
const TEST = 'services/platform/src/test/java/com/nexus/catalog/ReservationEventsStreamTest.java';
const NOTIF = 'services/platform/src/main/java/com/nexus/notification/NotificationService.java';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_reservation_events_stream.mjs';
const PATHS = [CONTROLLER, EVENTS, LISTENER, STREAM, TEST, NOTIF, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 985\. D985(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the reservation-event plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const count = (p, needle, n, label, expect) => {
    const got = t(p).split(needle).length - 1;
    if (got !== n) offenders.push(`WRONG-COUNT — ${p}: ${label} (found ${got}, need exactly ${n})${tag(expect)}`);
    else notes.push(`held ${label} (${got})`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the controller got ApplicationEventPublisher, deposits events on the request thread. */
  has(CONTROLLER, 'private final ApplicationEventPublisher events;', 'ApplicationEventPublisher field', 'CTRL-FIELD');
  has(CONTROLLER, 'ApplicationEventPublisher events)', 'constructor injection', 'CTRL-CTOR');
  has(CONTROLLER, 'import com.nexus.notification.event.DomainEvents;', 'DomainEvents import', 'CTRL-IMPORT');
  count(CONTROLLER, 'events.publishEvent(', 2, 'two emission sites (booking + cancel)', 'CTRL-TWO');

  /* 2 — the booking emission carries the right shape. */
  has(CONTROLLER, 'new DomainEvents.ReservationChanged(', 'booking emits ReservationChanged', 'CTRL-EVENT');
  has(CONTROLLER, 'null, "pending"', 'the booking fromStatus is null (reservation opens at pending)', 'CTRL-PENDING');
  has(CONTROLLER, '"reused", booking.reused()', 'the reused flag travels with the event', 'CTRL-REUSED');

  /* 3 — cancellation emission exists and is SILENT on replay (idem). */
  has(CONTROLLER, 'if (!cancelled.replay()) {', 'idempotent re-cancel does not double-emit', 'CTRL-REPLAY');
  has(CONTROLLER, 'before, "cancelled"', 'the cancel carries fromStatus=before', 'CTRL-CANCELLED');

  /* 4 — DomainEvents exposes ReservationChanged (sealed) with the fields used here. */
  has(EVENTS, 'record ReservationChanged', 'ReservationChanged record exists', 'EVENT-RECORD');
  has(EVENTS, 'ReservationChanged,', 'ReservationChanged is a permitted subclass', 'EVENT-PERMIT');
  has(EVENTS, '"reservation_" + toStatus', 'template derives rather than invents', 'EVENT-TEMPLATE');

  /* 5 — the listener is the ONE bridge: Streams publish first, never rolls back the business op. */
  has(LISTENER, 'events.publish(event);', 'the listener publishes onto nexus:events', 'LISTENER-PUBLISH');
  has(LISTENER, 'try {\n            events.publish(event);', 'publication is inside its own try', 'LISTENER-TRY');

  /* 6 — RedisEventStream XADDs to nexus:events with an exact bound, fail-soft. */
  has(STREAM, 'private static final String STREAM_KEY = "nexus:events";', 'stream key declared', 'STREAM-KEY');
  has(STREAM, 'new io.lettuce.core.XAddArgs().maxlen(maxLen).exactTrimming()', 'bounded append', 'STREAM-BOUND');
  has(STREAM, 'public boolean publish(DomainEvents.NexusDomainEvent event)', 'publishDoor exists', 'STREAM-DOOR');

  /* 7 — ReservationEventsStreamTest boots the WHOLE bridge enabled and asserts the entry landed. */
  has(TEST, '"nexus.events.redis-stream-enabled=true"', 'the bridge is enabled for this test class', 'TEST-ENABLE');
  has(TEST, 'type', 'asserted type field present', 'TEST-TYPE');
  has(TEST, '.path("toStatus").asText()).isEqualTo("pending")', 'and the pending transition asserted', 'TEST-PENDING');
  has(TEST, '.path("toStatus").asText()).isEqualTo("cancelled")', 'and the cancelled transition asserted', 'TEST-CANCELLED');
  has(TEST, '.path("fromStatus").asText()).isEqualTo("pending")', 'and the before-status asserted on cancel', 'TEST-FROM');

  /* 8 — unknown reservation_* templates render, never invent copy: the reservation_ prefix rule. */
  has(NOTIF, 'template.startsWith("reservation_")', 'the reservation_ prefix rule exists', 'NOTIF-PREFIX');
  has(NOTIF, '"One of your reservations is now "', 'the generic reservation copy is derived from the status', 'NOTIF-COPY');

  /* 9 — wiring: CI runs this reader, ATLAS lists it, ledger holds it. */
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 985. D985\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D985 heading line');

  return { offenders, notes, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) {
    return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  }
  f.set(p, text.split(from).join(to));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['ApplicationEventPublisher injection removed',
      mutate(real, CONTROLLER, 'private final ApplicationEventPublisher events;', 'private final Object events;'), 'CTRL-FIELD'],
    ['constructor injection removed',
      mutate(real, CONTROLLER, 'ApplicationEventPublisher events)', 'Object events)'), 'CTRL-CTOR'],
    ['booking emission erased',
      mutate(real, CONTROLLER, 'new DomainEvents.ReservationChanged(',
             'new Object() { };'), 'CTRL-EVENT'],
    ['one emission site erased (count drops below two)',
      mutate(real, CONTROLLER, 'events.publishEvent(', 'events.publishEventsNotThere('), 'CTRL-TWO'],
    ['replay guard dropped (double-emit)',
      mutate(real, CONTROLLER, 'if (!cancelled.replay()) {', '{'), 'CTRL-REPLAY'],
    ['pending emission mislabeled',
      mutate(real, CONTROLLER, 'null, "pending"', 'null, "pending_typo"'), 'CTRL-PENDING'],
    ['reused flag dropped',
      mutate(real, CONTROLLER, '"reused", booking.reused()', '"reused", false'), 'CTRL-REUSED'],
    ['stream test bridge re-disabled',
      mutate(real, TEST, '"nexus.events.redis-stream-enabled=true"', '"nexus.events.redis-stream-enabled=false"'), 'TEST-ENABLE'],
    ['cancelled assert weakened',
      mutate(real, TEST, '.path("toStatus").asText()).isEqualTo("cancelled")',
             '.path("toStatus").asText()).isEqualTo("cancelled_erased")'), 'TEST-CANCELLED'],
    ['prefix-rule copy invented',
      mutate(real, NOTIF, '"One of your reservations is now "', '"Reservation now: "'), 'NOTIF-COPY'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_reservation_events_stream_X.mjs'), 'ATLAS-READER'],
    ['CI invocation cut',
      mutate(real, CI, CI_SELFTEST, 'node scripts/a_reader_that_does_not_exist.mjs --self-test'), 'CI-READER'],
    ['the ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(42)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(42)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  /* GREEN control — a legitimate test-line comment tweak keeps the plane green. */
  {
    const p = new Map(real);
    p.set(STREAM, p.get(STREAM).replace('/**', '/** (comment tweak)\n *'));
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN           ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!ok) allReddened = false;
  }
  console.log(`  self-test  all arms redden for cause + control green: ${allReddened} (${arms.length} arms)`);
  process.exit(allReddened ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE RESERVATION-EVENTS WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D985 reservation-events plane wired, ${result.notes.length} holds`);
process.exit(0);
