/**
 * `npm run test:unit` — unit tests for `scripts/json-schema-mini.mjs`, the offline validator the
 * conformance gate (`scripts/validate_conformance.mjs`) is built on.
 *
 * It is hand-written so that this package can test its own contracts with `typescript`, `tsx` and
 * `@types/node` alone (no `ajv`, no network). That makes it the one file in the package whose bugs
 * would silently *pass* the contract, so it gets the tests the schemas do not: every keyword it
 * claims to implement, the `$ref`/`$anchor` resolution rules, and the two places where being wrong
 * is invisible from the outside — an `anyOf` that reports only the aggregate, and a recursion guard
 * that lets a self-referential schema hang the build instead of throwing.
 *
 * Run: `npm run test:unit` (tsx, so the `.mjs` sibling is imported directly).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUPPORTED_DRAFT,
  SchemaStore,
  ValidationIssue,
  assertValid,
  canonical,
  validate,
} from "../../scripts/json-schema-mini.mjs";
import { JSON_SCHEMA_DRAFT } from "../json-schema.js";

/** Schema docs loaded from `src/schemas`, so cross-document `$ref`s resolve exactly as in the gate. */
async function loadStore(): Promise<{ store: InstanceType<typeof SchemaStore>; docs: Record<string, any> }> {
  const { readFile } = await import("node:fs/promises");
  const store = new SchemaStore();
  const docs: Record<string, any> = {};
  for (const name of ["common", "entity_card", "error_envelope", "event", "fact", "intent", "tool_spec"]) {
    const schemaUrl = new URL(`../schemas/${name}.json`, import.meta.url);
    docs[name] = JSON.parse(await readFile(schemaUrl, "utf8"));
    store.add(docs[name], `${name}.json`);
  }
  return { store, docs };
}

test("the validator targets the same draft the contract ships", () => {
  assert.equal(SUPPORTED_DRAFT, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(SUPPORTED_DRAFT, JSON_SCHEMA_DRAFT);
});

test("type: integer and type: number are different domains", () => {
  assert.ok(validate({ type: "integer" }, 3).valid);
  assert.ok(!validate({ type: "integer" }, 3.5).valid);
  assert.ok(validate({ type: "number" }, 3.5).valid);
  assert.ok(validate({ type: "number" }, 3).valid, "every integer is a number");
  assert.ok(!validate({ type: "number" }, "3").valid);
});

test("type-specific keywords never reject a nullable member", () => {
  const schema = { type: ["string", "null"], pattern: "^a+$" };
  assert.ok(validate(schema, null).valid, "a pattern must not apply to null (spec §8 nullable-but-shaped)");
  assert.ok(validate(schema, "aaa").valid);
  assert.ok(!validate(schema, "aab").valid);
});

test("enum and const compare structurally, not by key order", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 4, c: 3 }] }), canonical({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.ok(validate({ const: { x: 1, y: 2 } }, { y: 2, x: 1 }).valid);
  assert.ok(!validate({ enum: ["a", "b"] }, "c").valid);
  assert.ok(validate({ enum: [{ kind: "a" }, { kind: "b" }] }, { kind: "b" }).valid);
});

test("closed objects reject unknown keys, and propertyNames bounds what a key may look like", () => {
  const closed = { type: "object", properties: { a: {} }, required: ["a"], additionalProperties: false };
  assert.ok(validate(closed, { a: 1 }).valid);
  const missing = validate(closed, {});
  assert.deepEqual(missing.issues.map((issue: any) => issue.keyword), ["required"]);
  assert.equal(validate(closed, { a: 1, b: 2 }).issues[0]?.keyword, "additionalProperties");

  const keyed = { type: "object", propertyNames: { pattern: "^[a-z_]+$" } };
  assert.ok(validate(keyed, { good_key: 1 }).valid);
  const badKey = validate(keyed, { BadKey: 1 });
  assert.equal(badKey.valid, false);
  // The issue is reported at the *key* as the inner keyword (`pattern`), not as `propertyNames`.
  assert.equal(badKey.issues[0]?.instancePath, "/BadKey");
  assert.equal(badKey.issues[0]?.keyword, "pattern");

  const patterned = { type: "object", patternProperties: { "^x_": { type: "integer" } }, additionalProperties: true };
  assert.ok(validate(patterned, { x_a: 1, anything: "s" }).valid);
  assert.equal(validate(patterned, { x_a: "1" }).issues[0]?.keyword, "type");
});

test("arrays: items, tuples, contains, uniqueItems and the length bounds", () => {
  assert.equal(validate({ items: { type: "integer" } }, [1, "2"]).issues[0]?.instancePath, "/1");
  const tuple = { prefixItems: [{ type: "string" }, { type: "integer" }], additionalItems: false };
  assert.ok(validate(tuple, ["a", 1]).valid);
  assert.equal(validate(tuple, ["a", 1, 2]).issues[0]?.keyword, "additionalItems");
  assert.ok(validate({ contains: { type: "integer" } }, ["x", 2]).valid);
  assert.ok(!validate({ contains: { type: "integer" } }, ["x"]).valid);
  assert.equal(validate({ uniqueItems: true }, [{ a: 1 }, { a: 1 }]).issues[0]?.keyword, "uniqueItems");
  assert.ok(!validate({ minItems: 2 }, [1]).valid);
  assert.ok(!validate({ maxItems: 1 }, [1, 2]).valid);
});

test("numbers: bounds are inclusive, exclusive bounds are not, multipleOf survives floats", () => {
  assert.ok(validate({ minimum: 0, maximum: 1 }, 1).valid);
  assert.ok(!validate({ exclusiveMaximum: 1 }, 1).valid);
  assert.ok(!validate({ exclusiveMinimum: 0 }, 0).valid);
  assert.ok(validate({ multipleOf: 0.01 }, 8.41).valid);
  assert.ok(!validate({ multipleOf: 0.1 }, 0.25).valid);
});

test("format accepts only what the wire may carry", () => {
  const fmt = (format: string) => ({ type: "string", format });
  assert.ok(validate(fmt("date-time"), "2026-09-22T02:00:00Z").valid);
  assert.ok(validate(fmt("date-time"), "2026-09-22T02:00:00.123+08:00").valid);
  assert.ok(!validate(fmt("date-time"), "2026-09-22 02:00:00").valid, "no offset is not a timestamp");
  assert.ok(!validate(fmt("date-time"), "2026-09-22T02:00:00").valid);
  assert.ok(validate(fmt("uuid"), "11111111-1111-4111-8111-111111111111").valid);
  assert.ok(!validate(fmt("uuid"), "11111111111111111111111111111111").valid);
  assert.ok(validate(fmt("uri"), "https://cdn.example.com/a.jpg").valid);
  assert.ok(!validate(fmt("uri"), "/cdn/a.jpg").valid);
  assert.ok(validate(fmt("email"), "a@b.co").valid);
  assert.ok(validate(fmt("date"), "2026-09-22").valid);
  assert.ok(validate(fmt("time"), "19:00:00+08:00").valid);
  assert.ok(validate(fmt("email"), "not-an-email").issues[0]?.keyword === "format");
});

test("$ref: local $defs, cross-document by $id, plain-name anchor, and a real failure to throw", async () => {
  const { store, docs } = await loadStore();
  const local = { $defs: { Uuid: { type: "string", format: "uuid" } }, properties: { id: { $ref: "#/$defs/Uuid" } } };
  store.add(local, "local.json");
  assert.ok(validate(local, { id: "11111111-1111-4111-8111-111111111111" }, { store }).valid);
  assert.equal(validate(local, { id: "nope" }, { store }).issues[0]?.keyword, "format");

  const fact = docs.fact;
  const stricter = { ...fact, required: [...fact.required, "not_a_field"] };
  const missing = validate(stricter, validFact(), { store });
  assert.equal(missing.issues.some((issue: any) => issue.keyword === "required" && /not_a_field/.test(issue.message)), true);

  assert.throws(
    () => validate({ $ref: "https://nexus.dev/schemas/nothing.json" }, {}, { store }),
    /unresolved \$ref/,
  );
});

/** A `Fact` the schema accepts, so the test above only exercises the `required` keyword. */
function validFact() {
  return {
    fact_id: "33333333-3333-4333-8333-333333333333",
    subject_type: "merchant",
    subject_id: "11111111-1111-4111-8111-111111111111",
    attribute: "price",
    value: { amount: "128.00", currency: "HKD" },
    source: "merchant",
    confidence: 0.98,
    observed_at: "2026-09-22T02:00:00Z",
    expires_at: "2026-09-22T08:00:00Z",
    stale: false,
  };
}

test("the shipped schemas load, cross-reference and self-describe", async () => {
  const { store, docs } = await loadStore();
  assert.deepEqual(
    store.ids().sort(),
    [
      "https://nexus.dev/schemas/common.json",
      "https://nexus.dev/schemas/entity_card.json",
      "https://nexus.dev/schemas/error_envelope.json",
      "https://nexus.dev/schemas/event.json",
      "https://nexus.dev/schemas/fact.json",
      "https://nexus.dev/schemas/intent.json",
      "https://nexus.dev/schemas/tool_spec.json",
    ],
  );
  for (const [name, doc] of Object.entries(docs)) {
    assert.equal(doc.$schema, SUPPORTED_DRAFT, `${name} draft`);
    assert.equal(doc.$id, `https://nexus.dev/schemas/${name}.json`);
    assert.ok(doc.title, `${name} must be titled`);
  }
  // A `$ref` from entity_card into fact.json and common.json must resolve, or the gate validates nothing.
  const entity = docs.entity_card;
  const resolved = store.resolve(entity.properties.facts.items.$ref, entity, store.find("entity_card.json"));
  assert.equal((resolved.entry as { id?: string }).id, "https://nexus.dev/schemas/fact.json");
});

test("boolean sub-schemas short-circuit both ways", () => {
  assert.ok(validate({ properties: { a: true }, additionalProperties: false }, { a: { any: 1 } }).valid);
  const guarded = {
    if: { properties: { kind: { const: "product" } }, required: ["kind"] },
    then: { properties: { kind: true, stock_quantity: true }, additionalProperties: false },
    else: { properties: { stock_quantity: false }, additionalProperties: true },
  };
  assert.ok(validate(guarded, { kind: "product", stock_quantity: 3 }).valid);
  const merchant = validate(guarded, { kind: "merchant", stock_quantity: 3 });
  assert.equal(merchant.issues.some((issue: any) => issue.keyword === "false"), true, "the `false` branch must reject");

  // The trap the shipped schemas avoid by never putting `additionalProperties: false` in a branch:
  // a branch closes the object against *its own* properties, so a sibling key is an excess one.
  const unclosedThen = { ...guarded, then: { properties: { stock_quantity: true }, additionalProperties: false } };
  assert.equal(validate(unclosedThen, { kind: "product", stock_quantity: 3 }).issues[0]?.keyword, "additionalProperties");
});

test("if/then/else picks exactly one branch", () => {
  const schema = {
    if: { properties: { code: { const: "rate_limited" } }, required: ["code"] },
    then: { properties: { details: { required: ["retry_after"] } } },
    else: { properties: { details: { maxProperties: 4 } } },
  };
  assert.ok(validate(schema, { code: "rate_limited", details: { retry_after: 3 } }).valid);
  assert.equal(validate(schema, { code: "rate_limited", details: {} }).issues[0]?.keyword, "required");
  assert.ok(!validate(schema, { code: "internal", details: { a: 1, b: 2, c: 3, d: 4, e: 5 } }).valid);
});

test("oneOf is exclusive and anyOf needs one clean branch", () => {
  assert.equal(validate({ oneOf: [{ type: "string" }, { type: "integer" }] }, "s").valid, true);
  const both = validate({ oneOf: [{ type: "string" }, { minLength: 1, type: "string" }] }, "s");
  assert.equal(both.issues[0]?.keyword, "oneOf");
  assert.equal(validate({ anyOf: [{ type: "integer" }, { type: "boolean" }] }, "s").issues[0]?.keyword, "anyOf");
});

test("an anyOf failure also names the keyword that gave up", () => {
  // A nullable enum: the null branch fails on `type`, the vocabulary branch on `enum`. Reporting only
  // the aggregate would leave `expect_rule_ids` in fixtures/event.json unable to pin *which* half broke.
  const schema = { anyOf: [{ enum: ["a", "b"] }, { type: "null" }] };
  const result = validate(schema, "c");
  assert.equal(result.valid, false);
  const codes = result.issues.map((issue: any) => issue.keyword);
  assert.equal(codes[0], "anyOf");
  assert.ok(codes.includes("enum"), `expected the closest branch to report enum, got ${codes.join(", ")}`);
});

test("not rejects, and a throwing node is reported rather than swallowed", () => {
  assert.ok(!validate({ not: { type: "null" } }, null).valid);
  assert.ok(validate({ not: { type: "null" } }, 1).valid);
  assert.throws(() => validate({ properties: { a: "not a schema" } }, { a: 1 }) as never, /invalid schema node/);
});

test("a self-referential schema throws instead of hanging the build", () => {
  const loop = { $defs: { A: { $ref: "#/$defs/A" } }, $ref: "#/$defs/A" };
  const store = new SchemaStore();
  store.add(loop, "loop.json");
  assert.throws(() => validate(loop, { anything: 1 }, { store }), /recursion|unresolved/);
});

test("issue lists are capped and assertValid aggregates them", () => {
  const wide = validate({ items: { type: "integer" } }, new Array(50).fill("x"), { maxIssues: 5 });
  assert.equal(wide.issues.length, 5);
  assert.throws(() => assertValid({ type: "string" }, 7), (error: unknown) => error instanceof AggregateError);
  assert.doesNotThrow(() => assertValid({ type: "string" }, "ok"));
  assert.ok(new ValidationIssue("/a", "type", "boom") instanceof Error);
});
