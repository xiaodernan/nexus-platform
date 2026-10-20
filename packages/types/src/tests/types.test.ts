/**
 * `npm run test:unit` — the runtime surface of `@nexus/types`: the one type guard, the agent budget
 * numbers, and the *citations* the package is built on.
 *
 * The last group is the reason this file exists. This package is a mirror of three other
 * artefacts (`docs/API_CONTRACT.md`, `docs/AGENT_CONTRACT.md`, `infra/db/migrations/*.sql`), and
 * ~90 of its comments quote a line number in the V1 schema. A mirror cannot be checked against its
 * source by a type system, so the citations are read back off disk and asserted to still name the
 * column they claim: two of them were already off by one when this test was written, and a comment
 * that points at the wrong line is worse than no comment — it reads like evidence.
 *
 * Run: `npm run test:unit`.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { SUPPORTED_DRAFT } from "../../scripts/json-schema-mini.mjs";
import {
  DEFAULT_PLAN_BUDGET,
  MAX_LLM_CALLS_PER_REQUEST,
  MAX_REASONING_CALLS_PER_REQUEST,
  MAX_TOOL_CALLS_PER_REQUEST,
  REQUEST_TIMEOUT_MS,
  TOOL_TIMEOUT_MS,
  WEB_TOOL_TIMEOUT_MS,
} from "../tools.js";
import { JSON_SCHEMA_DRAFT } from "../json-schema.js";
import {
  ERROR_CODE_STATUS,
  FRESHNESS_TTL_SECONDS,
  NEXUS_ENUMS,
  SCHEMA_ENUM_BINDINGS,
  TYPES_PACKAGE_VERSION,
  errorHttpStatus,
  isApiErrorEnvelope,
  ladderErrorCode,
} from "../index.js";

test("the package root re-exports every domain module", async () => {
  assert.equal(TYPES_PACKAGE_VERSION, "0.1.0");
  assert.ok(NEXUS_ENUMS && SCHEMA_ENUM_BINDINGS && FRESHNESS_TTL_SECONDS && isApiErrorEnvelope, "barrel values must survive the re-export");
  const modules = (await readdir(new URL("..", import.meta.url)))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && file !== "index.ts")
    .map((file) => file.replace(/\.ts$/, ""));
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const reExported = new Set(
    [...source.matchAll(/export \* from "\.\/([A-Za-z0-9_-]+)\.js"/g)].map((match) => match[1]),
  );
  assert.ok(modules.length >= 18, `expected ~19 domain modules, found ${modules.length}`);
  assert.deepEqual(
    modules.filter((name) => !reExported.has(name)).sort(),
    [],
    "every module in src/ must be reachable from the barrel, or a consumer cannot import it",
  );
});

test("isApiErrorEnvelope accepts §1 bodies and refuses look-alikes", () => {
  const body = { error: { code: "not_found", message: "no such merchant", details: {}, request_id: "req_1" } };
  assert.equal(isApiErrorEnvelope(body), true);
  assert.equal(isApiErrorEnvelope(JSON.parse(JSON.stringify(body))), true, "a re-parsed response is the same shape");
  const rejects: unknown[] = [
    null,
    undefined,
    "not_found",
    [],
    {},
    { error: null },
    { error: "not_found" },
    { error: {} },
    { error: { code: 404, message: "x" } },
    { error: { code: "not_found" } },
    { code: "not_found", message: "x" },
    { errors: [{ code: "not_found" }] },
  ];
  for (const value of rejects) {
    assert.equal(isApiErrorEnvelope(value), false, `${JSON.stringify(value)} must not type as the §1 envelope`);
  }
  // The guard is deliberately loose (code/message only): a BFF must recognise an error even when
  // `details` is missing, so the closed status table is enforced elsewhere, not here.
  assert.equal(ERROR_CODE_STATUS.not_found, 404);
});

test("ladderErrorCode resolves D27 resource codes by suffix and refuses everything else", () => {
  // The rules that read a status off a wire code, and the SDK's failure ladder, both go through this
  // function — so the suffix table is only safe if a near-miss answers null rather than a guess.
  const cases: Array<[string, string | null]> = [
    ["not_found", "not_found"],
    ["merchant_not_found", "not_found"],
    ["review_summary_not_found", "not_found"],
    ["idempotency_key_conflict", "conflict"],
    ["forbidden", "forbidden"],
    ["conversation_forbidden", "forbidden"],
    ["validation_error", "validation_error"],
    ["ai_unavailable", "ai_unavailable"],
    // rejected: no ladder suffix, a suffix that may not be specialised, or not a snake_case resource
    ["validation_failed", null],
    ["notfound", null],
    ["_not_found", null],
    ["merchant_validation_error", null],
    ["merchant_not_found_now", null],
    ["Merchant_not_found", null],
    ["merchant__not_found", null],
    ["", null],
  ];
  for (const [code, ladder] of cases) {
    assert.equal(ladderErrorCode(code), ladder, `${JSON.stringify(code)} must resolve to ${JSON.stringify(ladder)}`);
  }
  assert.equal(errorHttpStatus("slot_not_found"), 404);
  assert.equal(errorHttpStatus("idempotency_key_conflict"), 409);
  assert.equal(errorHttpStatus("banana"), 500, "an unknown code must never be served as a 4xx the client guessed");
});

test("agent budgets are ordered so the outer timeout can never fire inside a tool call", () => {
  assert.ok(TOOL_TIMEOUT_MS <= REQUEST_TIMEOUT_MS, "a tool must finish before its request is abandoned");
  assert.ok(WEB_TOOL_TIMEOUT_MS > TOOL_TIMEOUT_MS, "AGENT §3: `search_web` gets its own, longer budget");
  assert.ok(WEB_TOOL_TIMEOUT_MS <= REQUEST_TIMEOUT_MS, "even the slowest tool must fit the request");
  assert.equal(MAX_REASONING_CALLS_PER_REQUEST, 1, "AGENT §9 caps reasoning calls at one per request");
  assert.ok(MAX_TOOL_CALLS_PER_REQUEST > MAX_LLM_CALLS_PER_REQUEST);
  assert.deepEqual(
    { ...DEFAULT_PLAN_BUDGET },
    {
      max_tool_calls: MAX_TOOL_CALLS_PER_REQUEST,
      max_llm_calls: MAX_LLM_CALLS_PER_REQUEST,
      tool_timeout_ms: TOOL_TIMEOUT_MS,
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      max_reasoning_calls: MAX_REASONING_CALLS_PER_REQUEST,
      max_cost_usd: null,
    },
    "the default budget must be the constants, not a copy that can drift",
  );
  assert.equal(DEFAULT_PLAN_BUDGET.max_cost_usd, null, "spec §102: no cost ceiling is implied, only configured");
});

test("the schemas, the validator and the contract all name the same draft", () => {
  assert.equal(JSON_SCHEMA_DRAFT, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(JSON_SCHEMA_DRAFT, SUPPORTED_DRAFT);
});

test("every `V1 line NNNN` citation still points at the column it names", async () => {
  const sqlUrl = new URL("../../../../infra/db/migrations/V1__init.sql", import.meta.url);
  const sql = (await readFile(sqlUrl, "utf8")).split("\n");
  assert.ok(sql.length > 500, `expected the V1 schema to be substantial, read ${sql.length} lines from ${sqlUrl}`);

  // Table names come from the DDL itself, so the checker cannot drift from the migration.
  const tables = new Set<string>();
  for (const line of sql) {
    const [, qualified] = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_.]+)/i.exec(line) ?? [];
    if (qualified) tables.add(qualified.split(".").pop() ?? qualified);
  }
  assert.ok(tables.size > 50, `expected V1 to declare 50+ tables, found ${tables.size}`);

  const dir = new URL("..", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  let citations = 0;
  let checked = 0;
  const stale: string[] = [];
  for (const file of files) {
    const lines = (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
    lines.forEach((line, index) => {
      const cited = /\bline (\d{2,4})\b/.exec(line);
      const lineNo = Number(cited?.[1] ?? NaN);
      if (!Number.isFinite(lineNo)) return;
      citations += 1;
      // Identifiers are taken from the citing line only: a comment block's neighbours describe
      // other columns, and matching those would bless citations that point at the wrong table.
      const ids = [...line.matchAll(/`([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?[^`]*`/g)]
        .map((m) => ({ table: m[1] as string, column: m[2] }))
        .filter((id) => tables.has(id.table) || tables.has(id.column ?? ""));
      if (ids.length === 0) return;
      checked += 1;
      const row = lineNo <= sql.length ? (sql[lineNo - 1] ?? "") : "";
      const names = ids.map((id) => id.column ?? id.table);
      const constraintRow = /CHECK|UNIQUE|PRIMARY KEY/i.test(row) && /check|constraint|unique/i.test(line);
      if (!names.some((name) => row.includes(name)) && !constraintRow) {
        stale.push(`${file}:${index + 1} cites V1:${lineNo} for ${names.join("/")} → "${row.trim().slice(0, 60)}"`);
      }
    });
  }
  assert.ok(citations >= 90, `the package should cite V1 ~90 times, found ${citations}`);
  assert.ok(checked >= 80, `only ${checked} citations name a V1 table/column — the check would be near-vacuous`);
  assert.deepEqual(stale, [], `stale V1 citations:\n${stale.join("\n")}`);
});
