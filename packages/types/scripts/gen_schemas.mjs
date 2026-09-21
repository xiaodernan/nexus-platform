/**
 * gen_schemas.mjs — materialise the hand-written contracts in `src/schemas/*.json` into
 * `dist/schemas/`, so consumers (`apps/web`, `apps/ai`, `services/platform`) can import them
 * through the package export map (`@nexus/types/schemas/intent.json`) without a TS build step.
 *
 * It is a *generator* in the sense that matters here: it validates what it copies. Every document
 * must
 *   1. parse as JSON,
 *   2. declare `$schema` = draft 2020-12 and a `https://nexus.dev/schemas/<name>.json` `$id`,
 *   3. only contain keywords the offline mini-validator understands (an unsupported keyword is a
 *      silent no-op at validation time, so it is a build error instead),
 *   4. keep every `$ref` resolvable inside the emitted set (offline, no network fetches).
 *
 * Output: `dist/schemas/<name>.json` + `dist/schemas/manifest.json`
 * (`{name, $id, sha256, bytes, title}` per file).
 *
 * Run: `node scripts/gen_schemas.mjs` (or `npm run gen:schemas`). No dependencies.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_DRAFT, SchemaStore } from "./json-schema-mini.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SRC_DIR = join(PKG_ROOT, "src", "schemas");
const OUT_DIR = join(PKG_ROOT, "dist", "schemas");

/** Keywords `scripts/json-schema-mini.mjs` implements; anything else in a schema is a build error. */
const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

/** `$ref` targets must never point at the network. */
const ALLOWED_REF_HOST = "https://nexus.dev/schemas/";

/** @returns {Promise<string[]>} `*.json` in `src/schemas`, sorted for deterministic output. */
async function listSchemaFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

/** Walk a schema document collecting `{jsonPointer, keyword}` for every unknown keyword. */
function findUnsupportedKeywords(node, pointer = "#", hits = []) {
  if (Array.isArray(node)) {
    node.forEach((child, index) => findUnsupportedKeywords(child, `${pointer}/${index}`, hits));
    return hits;
  }
  if (node === null || typeof node !== "object") return hits;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-") || key.startsWith("$comment")) continue;
    if (!SUPPORTED_KEYWORDS.has(key) && pointer !== "#") {
      // Only complain about keyword-looking keys inside schema positions; `properties`/`$defs`
      // children are data keys (an API field name), not keywords.
      const parentKeyword = pointer.split("/").pop();
      const insideSchemaPosition = !["properties", "$defs", "definitions", "patternProperties"].includes(parentKeyword);
      if (insideSchemaPosition) hits.push({ pointer, keyword: key });
    }
    findUnsupportedKeywords(value, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, hits);
  }
  return hits;
}

/** Walk a schema document collecting every `$ref` string with its location. */
function findRefs(node, out = [], pointer = "#") {
  if (Array.isArray(node)) {
    node.forEach((child, index) => findRefs(child, out, `${pointer}/${index}`));
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") out.push({ pointer, ref: value });
    else findRefs(value, out, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  }
  return out;
}

async function main() {
  const names = await listSchemaFiles(SRC_DIR);
  if (names.length === 0) throw new Error(`no schemas found in ${SRC_DIR}`);

  /** @type {Record<string, object>} */
  const docs = {};
  for (const name of names) {
    const raw = await readFile(join(SRC_DIR, name), "utf8");
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${name}: invalid JSON — ${error.message}`);
    }
    docs[name] = doc;
  }

  const problems = [];
  const store = new SchemaStore();

  for (const name of names) {
    const doc = docs[name];
    const expectedId = `${ALLOWED_REF_HOST}${name}`;
    if (doc.$schema !== SUPPORTED_DRAFT) {
      problems.push(`${name}: $schema must be "${SUPPORTED_DRAFT}", got ${JSON.stringify(doc.$schema)}`);
    }
    if (doc.$id !== expectedId) problems.push(`${name}: $id must be "${expectedId}", got ${JSON.stringify(doc.$id)}`);
    if (typeof doc.title !== "string" || doc.title.length === 0) problems.push(`${name}: missing "title"`);
    if (typeof doc.description !== "string" || doc.description.length < 40) {
      problems.push(`${name}: "description" must cite the contract section (>= 40 chars)`);
    }
    for (const hit of findUnsupportedKeywords(doc)) {
      problems.push(`${name}: unsupported keyword "${hit.keyword}" at ${hit.pointer}`);
    }
    store.add(doc, name);
  }

  // `$ref`s must resolve offline, inside this package.
  for (const name of names) {
    for (const { pointer, ref } of findRefs(docs[name])) {
      if (ref.startsWith("http") && !ref.startsWith(ALLOWED_REF_HOST)) {
        problems.push(`${name}: $ref "${ref}" at ${pointer} points outside ${ALLOWED_REF_HOST}`);
        continue;
      }
      try {
        store.resolve(ref, docs[name], store.find(name));
      } catch (error) {
        problems.push(`${name}: $ref "${ref}" at ${pointer} is unresolvable — ${error.message}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`gen:schemas FAILED (${problems.length} problem(s))`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const manifest = { $schema: SUPPORTED_DRAFT, generator: "scripts/gen_schemas.mjs", draft: SUPPORTED_DRAFT, schemas: [] };
  for (const name of names) {
    const body = `${JSON.stringify(docs[name], null, 2)}\n`;
    await writeFile(join(OUT_DIR, name), body, "utf8");
    manifest.schemas.push({
      file: name,
      name: name.replace(/\.json$/, ""),
      id: docs[name].$id,
      title: docs[name].title,
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  }
  manifest.schemas.sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`gen:schemas OK — ${names.length} schemas -> dist/schemas/`);
  for (const entry of manifest.schemas) console.log(`  ${entry.file.padEnd(22)} ${String(entry.bytes).padStart(6)}B  ${entry.sha256.slice(0, 12)}`);
  console.log(`  manifest.json          (draft 2020-12, ${manifest.schemas.length} entries)`);
}

await main();
