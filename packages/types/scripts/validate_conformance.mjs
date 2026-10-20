/**
 * validate_conformance.mjs — the TS ⇄ JSON Schema ⇄ fixture conformance gate for `@nexus/types`.
 *
 * `gen_schemas.mjs` proves each schema is *self-consistent* (parses, draft 2020-12, only keywords
 * the offline validator understands, resolvable `$ref`s). This script proves the three
 * descriptions of the same contract agree with each other:
 *
 *   1. `src/schemas/*.json` == `dist/schemas/*.json` byte-for-byte after re-serialisation, and
 *      `dist/schemas/manifest.json`'s `sha256` still matches what is on disk (a stale
 *      `gen:schemas`, or a hand-edit to a build artefact, is a build error).
 *   2. every path in `SCHEMA_ENUM_BINDINGS` resolves through `$ref`/`items`/`allOf`/`anyOf`/`oneOf`
 *      to at least one `enum`, and each such enum equals the `NEXUS_ENUMS` vocabulary it is bound
 *      to — so a value added on one side only fails here.
 *   3. every fixture case behaves as declared: `expect: "valid"` must validate with zero issues,
 *      `expect: "invalid"` must fail, and **every** id in `expect_rule_ids` must appear among the
 *      failing codes. Asserting the ids rather than "some error" is what makes a rule that stops
 *      firing fail the build even when something else still rejects the instance (`rules.mjs`).
 *   4. coverage: every schema named by a binding or a rule has a fixture file, every rule is
 *      exercised by at least one case, every rule id a fixture names exists, and no schema
 *      declares a non-snake_case property name.
 *
 * Offline and dependency-free: only `node:*`, the sibling modules in this folder and `dist/`.
 * Run after `npm run build && npm run gen:schemas`.
 *
 *   node scripts/validate_conformance.mjs [--json] [--strict-warnings]
 *
 * Exit 0 = conformant, 1 = failures (printed, grouped by section). Warnings never fail the run
 * unless `--strict-warnings`.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { SchemaStore, SUPPORTED_DRAFT, validate } from "./json-schema-mini.mjs";
import { buildRules, findNonSnakeKeys } from "./rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SRC_SCHEMAS = join(PKG_ROOT, "src", "schemas");
const DIST_SCHEMAS = join(PKG_ROOT, "dist", "schemas");
const FIXTURE_DIR = join(PKG_ROOT, "fixtures");

/** Emitted by `gen_schemas.mjs`; used as the canonical serialisation for the src/dist comparison. */
const serialise = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

const isObj = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/* ------------------------------------------------------------------ report -- */

class Report {
  constructor() {
    /** @type {Array<{section: string, subject: string, message: string}>} */
    this.failures = [];
    /** @type {Array<{section: string, subject: string, message: string}>} */
    this.warnings = [];
    /** @type {Record<string, number>} */
    this.counters = {};
    this.startedAt = Date.now();
  }

  /** @param {string} key @param {number} [n] */
  bump(key, n = 1) {
    this.counters[key] = (this.counters[key] ?? 0) + n;
  }

  fail(section, subject, message) {
    this.failures.push({ section, subject, message });
  }

  warn(section, subject, message) {
    this.warnings.push({ section, subject, message });
  }

  get ok() {
      return this.failures.length === 0;
  }

  print({ json }) {
    const bySection = new Map();
    for (const entry of [...this.failures, ...this.warnings]) {
      if (!bySection.has(entry.section)) bySection.set(entry.section, []);
      bySection.get(entry.section).push(entry);
    }
    const summary = {
      ok: this.ok,
      duration_ms: Date.now() - this.startedAt,
      counters: this.counters,
      failures: this.failures.length,
      warnings: this.warnings.length,
    };
    if (json) {
      console.log(JSON.stringify({ ...summary, detail: [...this.failures, ...this.warnings] }, null, 2));
      return;
    }
    const c = this.counters;
    console.log(
      `conformance: ${c.artefact_pairs ?? 0} schemas, ${c.bindings ?? 0} enum bindings, ` +
        `${c.cases ?? 0} fixture cases (${c.invalid_cases ?? 0} negative), ${c.rules ?? 0} custom rules, ` +
        `${c.checks ?? 0} checks in ${summary.duration_ms}ms`,
    );
    for (const [section, entries] of bySection) {
      for (const entry of entries) {
        const kind = this.failures.includes(entry) ? "FAIL" : "WARN";
        console.log(`  ${kind} [${section}] ${entry.subject}: ${entry.message}`);
      }
    }
    console.log(
      this.failures.length === 0
        ? `conformance OK — TS enums, JSON Schemas and fixtures agree${this.warnings.length ? ` (${this.warnings.length} warning(s))` : ""}.`
        : `conformance FAILED — ${this.failures.length} failure(s), ${this.warnings.length} warning(s).`,
    );
  }
}

/* ------------------------------------------------------------- artefacts -- */

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * `src/schemas` vs `dist/schemas` vs the manifest, and the schema documents keyed by basename.
 * @returns {Promise<{docs: Map<string, object>, store: SchemaStore}>}
 */
async function checkArtefacts(report) {
  const docs = new Map();
  const store = new SchemaStore();
  const srcFiles = (await readdir(SRC_SCHEMAS)).filter((f) => f.endsWith(".json")).sort();
  if (srcFiles.length === 0) {
    report.fail("artefacts", "src/schemas", "no schema files found");
    return { docs, store };
  }
  let manifest = null;
  try {
    manifest = await readJson(join(DIST_SCHEMAS, "manifest.json"));
  } catch {
    report.fail("artefacts", "dist/schemas/manifest.json", "missing — run `npm run gen:schemas` first");
  }
  const emitted = new Map((manifest?.schemas ?? []).map((entry) => [entry.file, entry]));

  for (const file of srcFiles) {
    const name = file.replace(/\.json$/, "");
    let doc;
    try {
      doc = await readJson(join(SRC_SCHEMAS, file));
    } catch (error) {
      report.fail("artefacts", `src/schemas/${file}`, `does not parse: ${error.message}`);
      continue;
    }
    docs.set(name, doc);
    store.add(doc, file);
    report.bump("artefact_pairs");

    let dist;
    try {
      dist = await readFile(join(DIST_SCHEMAS, file), "utf8");
    } catch {
      report.fail("artefacts", `dist/schemas/${file}`, "missing — run `npm run gen:schemas`");
      continue;
    }
    if (serialise(doc) !== dist) {
      report.fail("artefacts", `dist/schemas/${file}`, "differs from src/schemas — the generated copy is stale");
    }
    const entry = emitted.get(file);
    if (!entry) {
      report.fail("artefacts", "dist/schemas/manifest.json", `no entry for ${file}`);
    } else if (createHash("sha256").update(dist).digest("hex") !== entry.sha256) {
      report.fail("artefacts", `dist/schemas/${file}`, "sha256 does not match the manifest — a build artefact was edited by hand");
    }
    if (doc.$schema !== SUPPORTED_DRAFT) {
      report.fail("artefacts", file, `$schema is ${JSON.stringify(doc.$schema)}, expected ${SUPPORTED_DRAFT}`);
    }
  }

  for (const entry of emitted.values()) {
    if (!docs.has(entry.name)) report.fail("artefacts", `dist/schemas/${entry.file}`, "is not generated from src/schemas");
  }
  return { docs, store };
}

/* ------------------------------------------------------- enum bindings -- */

/** Schema branches that a property may be declared inside. */
const BRANCH_KEYS = ["allOf", "anyOf", "oneOf"];

/** Follow a `$ref` (and any chain of them) to the node it names. */
function deref(node, entry, store, budget = 12) {
  let current = node;
  let currentEntry = entry;
  const seen = new Set();
  while (isObj(current) && typeof current.$ref === "string" && budget-- > 0) {
    if (seen.has(current.$ref)) break;
    seen.add(current.$ref);
    const hit = store.resolve(current.$ref, currentEntry?.doc, currentEntry);
    current = hit.node;
    currentEntry = hit.entry;
  }
  return { node: current, entry: currentEntry };
}

/** All nodes a single path segment names, searched through the applicator branches. */
function descend(nodes, segment, store, out = [], depth = 0) {
  if (depth > 8) return out;
  const isArray = segment.endsWith("[]");
  const name = isArray ? segment.slice(0, -2) : segment;
  const hit = [];
  for (const holder of nodes) {
    if (!isObj(holder.node)) continue;
    const { node, entry } = deref(holder.node, holder.entry, store);
    if (!isObj(node)) continue;
    const declared = isObj(node.properties) ? node.properties[name] : undefined;
    if (declared !== undefined) hit.push({ node: declared, entry });
    for (const key of BRANCH_KEYS) {
      if (Array.isArray(node[key])) descend(node[key].map((sub) => ({ node: sub, entry })), segment, store, out, depth + 1);
    }
    for (const key of ["then", "else"]) {
      if (isObj(node[key])) descend([{ node: node[key], entry }], segment, store, out, depth + 1);
    }
  }
  if (!isArray) {
    out.push(...hit);
    return out;
  }
  for (const holder of hit) {
    const { node, entry } = deref(holder.node, holder.entry, store);
    const items = Array.isArray(node.items) ? node.items : isObj(node.items) ? node.items : node.prefixItems?.[0];
    if (items !== undefined) out.push({ node: items, entry });
  }
  return out;
}

/** Every `enum` declared at or beneath a `{node, entry}` holder, through nullable wrappers. */
function collectEnums(holder, store, found = [], depth = 0, seen = new Set()) {
  let { node, entry } = holder;
  if (depth > 10 || seen.has(node)) return found;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) collectEnums({ node: child, entry }, store, found, depth + 1, seen);
    return found;
  }
  if (!isObj(node)) return found;
  let current = node;
  let currentEntry = entry;
  if (typeof current.$ref === "string") {
    const hit = deref(current, currentEntry, store);
    current = hit.node;
    currentEntry = hit.entry;
  }
  if (Array.isArray(current?.enum)) found.push({ enum: current.enum, at: current });
  const branch = (value) => {
    if (Array.isArray(value)) for (const child of value) collectEnums({ node: child, entry: currentEntry }, store, found, depth + 1, seen);
    else if (isObj(value)) collectEnums({ node: value, entry: currentEntry }, store, found, depth + 1, seen);
  };
  for (const key of [...BRANCH_KEYS, "prefixItems", "not", "if", "then", "else", "items"]) branch(current?.[key]);
  return found;
}

/**
 * `SCHEMA_ENUM_BINDINGS` — each bound path must exist in the schema and carry the TS vocabulary.
 */
function checkBindings(enums, bindings, { docs, store }, report) {
  for (const [schemaName, paths] of Object.entries(bindings)) {
    const root = docs.get(schemaName);
    if (!root) {
      report.fail("bindings", schemaName, "has bindings but no such schema in src/schemas");
      continue;
    }
    const entry = store.find(`${schemaName}.json`);
    for (const [path, enumName] of Object.entries(paths)) {
      report.bump("bindings");
      const vocabulary = enums[enumName];
      if (!Array.isArray(vocabulary)) {
        report.fail("bindings", `${schemaName}.${path}`, `binds to "${enumName}", which is not in NEXUS_ENUMS`);
        continue;
      }
      let nodes;
      try {
        nodes = path.split(".").reduce((acc, segment) => descend(acc, segment, store), [{ node: root, entry }]);
      } catch (error) {
        report.fail("bindings", `${schemaName}.${path}`, `could not be resolved: ${error.message}`);
        continue;
      }
      if (nodes.length === 0) {
        report.fail("bindings", `${schemaName}.${path}`, "names a property that no schema node declares");
        continue;
      }
      const found = nodes.flatMap((holder) => collectEnums(holder, store));
      if (found.length === 0) {
        report.fail("bindings", `${schemaName}.${path}`, `is bound to ${enumName} but constrains no enum — the schema stopped checking it`);
        continue;
      }
      const wanted = new Set(vocabulary);
      for (const { enum: values } of found) {
        const missing = [...wanted].filter((value) => !values.includes(value));
        const extra = values.filter((value) => !wanted.has(value));
        report.bump("checks");
        if (missing.length || extra.length) {
          const parts = [];
          if (missing.length) parts.push(`schema omits ${missing.join(", ")}`);
          if (extra.length) parts.push(`schema allows unknown ${extra.join(", ")}`);
          report.fail("bindings", `${schemaName}.${path}`, `${enumName} mismatch — ${parts.join("; ")}`);
        } else if (values.join("|") !== vocabulary.join("|")) {
          report.bump("checks");
          report.warn("bindings", `${schemaName}.${path}`, `${enumName} members agree but are ordered differently (documentation drift only)`);
        }
      }
    }
  }
}

/* ----------------------------------------------------------- fixtures --- */

/** Instance pointers have array indices in them; the schema side only knows "each item". */
const normalisePointer = (pointer) =>
  pointer.split("/").map((token) => (/^\d+$/.test(token) ? "*" : token)).join("/");

/**
 * Pointers of the objects a schema **closes** (`additionalProperties: false`). API §1's blanket
 * snake_case rule is the runner's to enforce exactly there: a closed object has a known key set, so
 * every key in it is a wire field. An open position may legitimately carry keys the contract does
 * not enumerate — `ToolSpec.input_schema` is a JSON Schema document, whose keys are JSON Schema
 * keywords — and where a schema wants its own key vocabulary it says so with `propertyNames` /
 * `patternProperties`, which the validator enforces.
 *
 * @returns {Set<string>} normalised pointers, each meaning "the keys of the object here are wire fields"
 */
function closedKeyPointers(root, entry, store) {
  const out = new Set();
  collectClosedKeys(root, entry, "", store, 0, new Set(), out);
  return out;
}

/** Depth-first walk of the schema side, marking every closed object position. */
function collectClosedKeys(node, entry, pointer, store, depth, seen, out) {
  if (depth > 24) return;
  let current, currentEntry;
  try {
    ({ node: current, entry: currentEntry } = deref(node, entry, store));
  } catch {
    return;
  }
  if (!isObj(current) || seen.has(current)) return;
  const path = new Set([...seen, current]);

  if (current.additionalProperties === false) out.add(normalisePointer(pointer));

  const at = (child, childPointer) => collectClosedKeys(child, currentEntry, childPointer, store, depth + 1, path, out);
  for (const [key, child] of Object.entries(isObj(current.properties) ? current.properties : {})) at(child, `${pointer}/${key}`);
  for (const key of ["items", "prefixItems", "contains"]) {
    const value = current[key];
    if (Array.isArray(value)) for (const child of value) at(child, `${pointer}/*`);
    else if (value !== undefined) at(value, `${pointer}/*`);
  }
  for (const key of [...BRANCH_KEYS, "if", "then", "else"]) {
    const value = current[key];
    if (Array.isArray(value)) for (const child of value) at(child, pointer);
    else if (value !== undefined) at(value, pointer);
  }
}

/** Does some schema at the object owning this key close it? */
function isCheckedKeyPointer(pointer, closed) {
  const segments = normalisePointer(pointer).split("/");
  return closed.has(segments.slice(0, segments.length - 1).join("/"));
}

/** @returns {Promise<Array<{file: string, schema: string, cases: object[]}>>} */
async function loadFixtures(report) {
  let files;
  try {
    files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    report.fail("fixtures", "fixtures/", "missing — every wire schema needs a fixture file");
    return [];
  }
  const out = [];
  for (const file of files) {
    let doc;
    try {
      doc = await readJson(join(FIXTURE_DIR, file));
    } catch (error) {
      report.fail("fixtures", file, `does not parse: ${error.message}`);
      continue;
    }
    if (typeof doc.schema !== "string" || !Array.isArray(doc.cases)) {
      report.fail("fixtures", file, 'must be { schema: "<basename>", cases: [ { name, expect, expect_rule_ids, instance } ] }');
      continue;
    }
    out.push({ file, ...doc });
  }
  return out;
}

async function checkFixtures(docs, store, rules, fixtures, report) {
  const seenSchemas = new Set();
  const exercised = new Map(rules.map((rule) => [rule.id, 0]));

  for (const fixture of fixtures) {
    const root = docs.get(fixture.schema);
    if (!root) {
      report.fail("fixtures", fixture.file, `names schema "${fixture.schema}", which src/schemas does not define`);
      continue;
    }
    seenSchemas.add(fixture.schema);
    const applicable = rules.filter((rule) => rule.schemas.includes(fixture.schema) || rule.schemas.includes("*"));
    const ctx = { schemaName: fixture.schema, schemaProperties: isObj(root.properties) ? root.properties : {} };

    for (const testCase of fixture.cases) {
      report.bump("cases");
      const subject = `${fixture.schema}/${testCase.name ?? "<unnamed>"}`;
      if (testCase.expect !== "valid" && testCase.expect !== "invalid") {
        report.fail("fixtures", subject, `expect must be "valid" or "invalid", got ${JSON.stringify(testCase.expect)}`);
        continue;
      }
      if (testCase.expect === "invalid") report.bump("invalid_cases");
      const declared = Array.isArray(testCase.expect_rule_ids) ? testCase.expect_rule_ids : [];
      if (testCase.expect === "valid" && declared.length > 0) {
        report.fail("fixtures", subject, "is expected to validate, so expect_rule_ids must be empty");
      }
      for (const id of declared) {
        if (!exercised.has(id) && !isSchemaKeyword(id)) {
          report.fail("fixtures", subject, `expect_rule_ids names "${id}", which no rule in rules.mjs provides`);
        }
      }

      /** @type {Array<{code: string, message: string}>} */
      const failures = [];
      let rootEntry;
      try {
        const result = validate(root, testCase.instance, { store });
        for (const issue of result.issues) failures.push({ code: issue.keyword, message: `${issue.instancePath}: ${issue.message}` });
        rootEntry = store.find(`${fixture.schema}.json`);
      } catch (error) {
        failures.push({ code: "validator", message: `the validator threw: ${error.message}` });
      }
      if (rootEntry) {
        const closed = closedKeyPointers(root, rootEntry, store);
        for (const entry of findNonSnakeKeys(testCase.instance)) {
          if (!isCheckedKeyPointer(entry.pointer, closed)) continue;
          failures.push({ code: "snake_case_keys", message: `${entry.pointer}: "${entry.key}" is not snake_case (API §1)` });
        }
      }

      for (const rule of applicable) {
        let messages;
        try {
          messages = await rule.check(testCase.instance, ctx);
        } catch (error) {
          report.fail("rules", `${subject}`, `rule ${rule.id} threw: ${error.message}`);
          continue;
        }
        if (messages.length > 0) failures.push({ code: rule.id, message: messages.join("; ") });
      }
      for (const { code } of failures) if (exercised.has(code)) exercised.set(code, exercised.get(code) + 1);

      if (testCase.expect === "valid") {
        report.bump("checks");
        if (failures.length > 0) {
          report.fail(
            "fixtures",
            subject,
            `must validate, but failed: ${failures.slice(0, 4).map((f) => `${f.code} — ${f.message}`).join(" | ")}` +
              (failures.length > 4 ? ` (+${failures.length - 4} more)` : ""),
          );
        }
        continue;
      }

      if (failures.length === 0) {
        report.bump("checks");
        report.fail("fixtures", subject, "is expected to be rejected, but the schema and every rule accepted it");
        continue;
      }
      const codes = new Set(failures.map((f) => f.code));
      report.bump("checks", codes.size);
      for (const id of declared) {
        if (!codes.has(id)) report.fail("fixtures", subject, `expected failure "${id}" did not fire (got ${[...codes].join(", ")})`);
      }
      if (declared.length === 0) {
        report.warn("fixtures", subject, `a negative case with no expect_rule_ids (${[...codes].join(", ")}): name the rule so it cannot rot`);
      }
    }
  }
  return { seenSchemas, exercised };
}

/** Schema keywords the validator reports as a failure `code`, plus the runner's own `snake_case_keys`. */
function isSchemaKeyword(id) {
  return new Set([
    "type", "enum", "const", "required", "properties", "additionalProperties", "propertyNames",
    "minProperties", "maxProperties", "items", "prefixItems", "additionalItems", "contains",
    "minItems", "maxItems", "uniqueItems", "pattern", "format", "minLength", "maxLength",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf",
    "oneOf", "not", "if", "then", "else", "false", "validator", "snake_case_keys", "propertyNames",
  ]).has(id);
}

/* ------------------------------------------------------------ coverage --- */

function checkCoverage(docs, rules, bindings, fixtures, seenSchemas, exercised, report) {
  const required = new Set([...Object.keys(bindings), ...rules.flatMap((rule) => rule.schemas)]);
  for (const name of required) {
    if (!docs.has(name)) {
      report.fail("coverage", name, "is referenced by a binding or a rule but no schema file defines it");
    } else if (!seenSchemas.has(name)) {
      report.fail("coverage", `fixtures/${name}.json`, `is missing — ${name} carries bound enums and custom rules, so nothing tests them`);
    }
  }
  for (const fixture of fixtures) {
    if (!required.has(fixture.schema) && !docs.has(fixture.schema)) report.fail("coverage", fixture.file, "covers a schema that does not exist");
  }
  for (const [id, count] of exercised) {
    report.bump("rules");
    if (count === 0) report.fail("coverage", id, "is defined in rules.mjs but no fixture case asserts it — the rule is untested and will rot silently");
  }
}

/**
 * Draft 2020-12 keyword names. `tool_spec.json#/$defs/JsonSchemaDocument` describes a JSON Schema,
 * so the property names *inside that one node* are the keyword vocabulary and cannot be snake_case;
 * everywhere else a `properties` key is a wire field and API §1's rule applies.
 */
const JSON_SCHEMA_KEYWORD_NAMES = new Set([
  "$schema", "$id", "$ref", "$defs", "$anchor", "$comment", "definitions", "title", "description",
  "default", "examples", "deprecated", "readOnly", "writeOnly", "type", "enum", "const", "required",
  "properties", "patternProperties", "additionalProperties", "propertyNames", "minProperties",
  "maxProperties", "items", "prefixItems", "additionalItems", "contains", "minItems", "maxItems",
  "uniqueItems", "pattern", "format", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf", "oneOf", "not", "if",
  "then", "else",
]);

/** Every `properties` key in every schema must be snake_case (API_CONTRACT §1). */
function checkSchemaPropertyNames(docs, report) {
  const walk = (node, pointer, file, depth = 0) => {
    if (depth > 24 || !isObj(node) || Array.isArray(node)) return;
    if (isObj(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        if (!SNAKE_CASE.test(key) && !JSON_SCHEMA_KEYWORD_NAMES.has(key)) {
          report.fail("schema-names", `${file}${pointer}`, `property "${key}" is not snake_case`);
        }
        report.bump("checks");
        walk(child, `${pointer}/properties/${key}`, file, depth + 1);
      }
    }
    for (const key of ["items", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else"]) {
      if (node[key] !== undefined) walk(node[key], `${pointer}/${key}`, file, depth + 1);
    }
    for (const key of BRANCH_KEYS.concat("prefixItems", ["$defs", "definitions", "patternProperties"])) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${pointer}/${key}/${index}`, file, depth + 1));
      else if (isObj(value)) for (const [childKey, child] of Object.entries(value)) walk(child, `${pointer}/${key}/${childKey}`, file, depth + 1);
    }
  };
  for (const [name, doc] of docs) walk(doc, "#", `src/schemas/${name}.json`);
}

/* ------------------------------------------------------------------ main -- */

async function loadRuntime(report) {
  const modules = { enums: "dist/enums.js", fact: "dist/fact.js", errors: "dist/errors.js", tools: "dist/tools.js" };
  /** @type {Record<string, any>} */
  const runtime = {};
  const loaded = {};
  for (const [key, file] of Object.entries(modules)) {
    try {
      loaded[key] = await import(pathToFileURL(join(PKG_ROOT, file)).href);
    } catch (error) {
      report.fail("artefacts", file, `cannot be imported: ${error.message} — run \`npm run build\``);
      loaded[key] = {};
    }
  }
  const needed = {
    NEXUS_ENUMS: loaded.enums,
    SCHEMA_ENUM_BINDINGS: loaded.enums,
    FRESHNESS_TTL_SECONDS: loaded.fact,
    CONFIDENCE_FLOOR_PHRASE: loaded.fact,
    CONFIDENCE_FLOOR_OMIT: loaded.fact,
    ERROR_HTTP_STATUS: loaded.errors,
    ladderErrorCode: loaded.errors,
    TOOL_TIMEOUT_MS: loaded.tools,
    REQUEST_TIMEOUT_MS: loaded.tools,
    WEB_TOOL_TIMEOUT_MS: loaded.tools,
  };
  for (const [name, source] of Object.entries(needed)) {
    if (source[name] === undefined) report.fail("artefacts", name, "is not exported by the built runtime — rules.mjs cannot run without it");
    runtime[name] = source[name];
  }
  return runtime;
}

const report = new Report();
const args = new Set(process.argv.slice(2));

const runtime = await loadRuntime(report);
const { docs, store } = await checkArtefacts(report);
const rules = runtime.NEXUS_ENUMS ? buildRules(runtime) : [];

const ruleIds = new Set(rules.map((rule) => rule.id));
const duplicateIds = rules.map((r) => r.id).filter((id, index, all) => all.indexOf(id) !== index);
for (const id of new Set(duplicateIds)) report.fail("rules", id, "is defined more than once in rules.mjs");
for (const rule of rules) {
  if (typeof rule.check !== "function") report.fail("rules", rule.id, "has no check() function");
  if (!Array.isArray(rule.schemas) || rule.schemas.length === 0) report.fail("rules", rule.id, "declares no `schemas` to apply to");
  if (typeof rule.rationale !== "string" || rule.rationale.length < 40) {
    report.fail("rules", rule.id, "rationale must cite the contract section it enforces");
  }
  for (const name of rule.schemas ?? []) {
    if (name !== "*" && !docs.has(name)) report.fail("rules", rule.id, `applies to "${name}", which is not a schema in src/schemas`);
  }
}

checkBindings(runtime.NEXUS_ENUMS ?? {}, runtime.SCHEMA_ENUM_BINDINGS ?? {}, { docs, store }, report);
const fixtures = await loadFixtures(report);
const { seenSchemas, exercised } = await checkFixtures(docs, store, rules, fixtures, report);
checkCoverage(docs, rules, runtime.SCHEMA_ENUM_BINDINGS ?? {}, fixtures, seenSchemas, exercised, report);
checkSchemaPropertyNames(docs, report);

report.print({ json: args.has("--json") });
if (!report.ok || (args.has("--strict-warnings") && report.warnings.length > 0)) process.exitCode = 1;
