/**
 * `npm run test:unit` — cross-enum invariants that no single schema can state.
 *
 * `scripts/validate_conformance.mjs` proves `TS enum === JSON Schema enum` *per property*. What it
 * cannot see is the relationship **between** vocabularies: that the freshness table only speaks
 * about attributes that exist, that the conflict order is a re-ordering rather than a
 * re-invention, that a north-star conversion is an event the platform can actually record. Those
 * are the places where two files can each be internally correct and jointly impossible — and the
 * joint impossibility is what the §19/§20 claim-grade rules depend on.
 *
 * Run: `npm run test:unit`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_NAME,
  ERROR_CODE,
  ERROR_CODE_STATUS,
  FACT_ATTRIBUTE,
  FACT_SOURCE,
  FACT_SOURCE_PRIORITY,
  MCP_TOOL_NAME,
  NORTH_STAR_CONVERSION_EVENT,
  NORTH_STAR_WINDOW_MINUTES,
  NEXUS_ENUMS,
  PERMISSION_NAME,
  RESOURCE_ERROR_SUFFIX,
  SCHEMA_ENUM_BINDINGS,
  TOOL_NAME,
  AUDIT_ACTION,
  EVENT_NAME,
  type NexusEnumName,
} from "../enums.js";
import {
  CONFIDENCE_FLOOR_OMIT,
  CONFIDENCE_FLOOR_PHRASE,
  FRESHNESS_TTL_SECONDS,
  REVIEW_SUMMARY_NEW_REVIEW_TRIGGER,
} from "../fact.js";

/** Property path → registered enum name, flattened for the "does this vocabulary exist" check. */
function bindingTargets(): Array<{ schema: string; path: string; name: string }> {
  const out: Array<{ schema: string; path: string; name: string }> = [];
  for (const [schema, paths] of Object.entries(SCHEMA_ENUM_BINDINGS)) {
    for (const [path, name] of Object.entries(paths)) out.push({ schema, path, name });
  }
  return out;
}

test("every registered enum is a non-empty, duplicate-free list of strings", () => {
  const names = Object.keys(NEXUS_ENUMS) as NexusEnumName[];
  assert.ok(names.length > 90, `the registry should cover the whole contract, got ${names.length} enums`);
  const problems: string[] = [];
  for (const name of names) {
    const values = NEXUS_ENUMS[name] as readonly string[];
    if (!Array.isArray(values) || values.length === 0) problems.push(`${name}: empty`);
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) problems.push(`${name}: ${JSON.stringify(value)}`);
    }
    if (new Set(values).size !== values.length) problems.push(`${name}: duplicate member`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("each schema↔enum binding points at a vocabulary that exists", () => {
  const registered = new Set(Object.keys(NEXUS_ENUMS));
  const dangling = bindingTargets().filter((b) => !registered.has(b.name as NexusEnumName));
  assert.deepEqual(dangling, [], `bindings to unregistered enums: ${dangling.map((b) => `${b.schema}.${b.path} → ${b.name}`).join(", ")}`);
  // An empty bindings table would make the previous assertion vacuous, and the gate silent.
  assert.ok(bindingTargets().length >= 20, "the bindings table must keep covering the shipped schemas");
});

test("fact provenance: the conflict order re-sorts FACT_SOURCE, it never invents members", () => {
  assert.deepEqual([...FACT_SOURCE_PRIORITY].sort(), [...FACT_SOURCE].sort(), "priority must be a permutation");
  assert.equal(FACT_SOURCE_PRIORITY.length, new Set(FACT_SOURCE_PRIORITY).size);
  // AGENT_CONTRACT §4: "merchant (fresh) > observed > imported > third_party > inferred".
  assert.deepEqual(
    [...FACT_SOURCE_PRIORITY.slice(0, 5)],
    ["merchant", "observed", "imported", "third_party", "inferred"],
  );
  // `demo` is this package's addition (CONTRACT NOTES, spec §109/§155) and must rank last, so a
  // seeded value can never out-claim a merchant statement in a conflict.
  assert.equal(FACT_SOURCE_PRIORITY.at(-1), "demo");
  assert.ok(FACT_SOURCE.includes("demo") && FACT_SOURCE.length === 6);
});

test("the freshness table only describes attributes a fact can carry (AGENT §5, spec §20)", () => {
  const carried = new Set<string>(FACT_ATTRIBUTE);
  const orphaned = Object.keys(FRESHNESS_TTL_SECONDS).filter((attribute) => !carried.has(attribute));
  assert.deepEqual(orphaned, [], `attributes with a TTL but no vocabulary: ${orphaned.join(", ")}`);
  assert.equal(FRESHNESS_TTL_SECONDS.availability, 0, "availability is never cacheable (§20)");

  // Volatility order: an attribute that changes sooner must expire sooner, otherwise §20's
  // "stale ⇒ re-verify before claiming" degenerates into re-verifying prices hourly.
  const order = [
    FRESHNESS_TTL_SECONDS.inventory,
    FRESHNESS_TTL_SECONDS.popularity,
    FRESHNESS_TTL_SECONDS.price,
    FRESHNESS_TTL_SECONDS.opening_hours,
    FRESHNESS_TTL_SECONDS.description,
  ];
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    `expected strictly increasing TTLs, got ${order.join(", ")}`,
  );
  assert.equal(FRESHNESS_TTL_SECONDS.review_summary, FRESHNESS_TTL_SECONDS.opening_hours);
  for (const seconds of Object.values(FRESHNESS_TTL_SECONDS)) {
    assert.ok(Number.isInteger(seconds) && seconds >= 0, `${seconds} is not a whole non-negative number of seconds`);
  }
  assert.ok(REVIEW_SUMMARY_NEW_REVIEW_TRIGGER > 0);
});

test("the confidence bands are ordered and inside [0, 1] (AGENT §4)", () => {
  assert.ok(CONFIDENCE_FLOOR_OMIT < CONFIDENCE_FLOOR_PHRASE, "hedge must trigger before omit");
  assert.ok(CONFIDENCE_FLOOR_OMIT > 0 && CONFIDENCE_FLOOR_PHRASE <= 1);
});

test("error codes: the list, the status table and §1's literal statuses cannot drift apart", () => {
  assert.deepEqual([...ERROR_CODE].sort(), Object.keys(ERROR_CODE_STATUS).sort());
  assert.deepEqual(
    ERROR_CODE_STATUS,
    {
      validation_error: 422,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      rate_limited: 429,
      ai_unavailable: 503,
      internal: 500,
    },
    "API_CONTRACT §1 fixes both the codes and their statuses",
  );
  assert.equal(NEXUS_ENUMS.ErrorCode.length, 8);
  // DECISIONS D27: a resource code is a suffix of a ladder code, so every suffix must itself be one.
  // If a suffix were invented that §1 does not carry, `ladderErrorCode` would return a code whose HTTP
  // status no table row defines, and the derivation would break silently.
  for (const suffix of RESOURCE_ERROR_SUFFIX) {
    assert.ok((ERROR_CODE as readonly string[]).includes(suffix), `RESOURCE_ERROR_SUFFIX carries "${suffix}", which §1 does not define`);
  }
  assert.deepEqual([...RESOURCE_ERROR_SUFFIX], ["not_found", "conflict", "forbidden"]);
});

test("conversion events are events the platform can record (AGENT §10 north-star)", () => {
  const recordable = new Set<string>(EVENT_NAME);
  const missing = NORTH_STAR_CONVERSION_EVENT.filter((name) => !recordable.has(name));
  assert.deepEqual(missing, [], `north-star events absent from EVENT_NAME: ${missing.join(", ")}`);
  assert.equal(NORTH_STAR_WINDOW_MINUTES, 30, "§10 says 'within 30 min'");
  assert.ok(EVENT_NAME.includes("search"), "the denominator of v_north_star");
});

test("tools, permissions and audit actions are closed snake_case vocabularies", () => {
  const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  for (const [name, values] of [
    ["TOOL_NAME", TOOL_NAME],
    ["PERMISSION_NAME", PERMISSION_NAME],
    ["AUDIT_ACTION", AUDIT_ACTION],
    ["AGENT_NAME", AGENT_NAME],
  ] as const) {
    for (const value of values as readonly string[]) {
      assert.match(value, SNAKE, `${name} member is not snake_case`);
    }
    assert.equal(new Set(values).size, values.length, `${name} has duplicates`);
  }
  assert.equal(TOOL_NAME.length, 24, 'AGENT §3 says "implement exactly these" (24 names)');

  // API §10 publishes a narrower MCP surface: it may add composite entry points but may not
  // rename a canonical tool, or an external agent would be calling a name the registry lacks.
  const composites = ["search_nexus", "get_merchant", "check_availability"];
  const canonical = new Set<string>(TOOL_NAME);
  const unexplained = MCP_TOOL_NAME.filter((n) => !canonical.has(n) && !composites.includes(n));
  assert.deepEqual(unexplained, [], `MCP tools outside TOOL_NAME and outside §10's composites: ${unexplained.join(", ")}`);
});
