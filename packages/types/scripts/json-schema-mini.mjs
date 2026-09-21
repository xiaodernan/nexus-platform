/**
 * json-schema-mini.mjs — a dependency-free, offline JSON Schema **draft 2020-12** subset
 * validator.
 *
 * Why hand-written: `@nexus/types` must build and test with only `typescript`, `tsx` and
 * `@types/node` installed (no `ajv`, no network). The subset implemented here is exactly the
 * keyword set used by `src/schemas/*.json`, and nothing else:
 *
 *   validation   : type, enum, const, required, properties, patternProperties,
 *                  additionalProperties (bool | schema), propertyNames, minProperties,
 *                  maxProperties, items, prefixItems, additionalItems, contains, minItems,
 *                  maxItems, uniqueItems, pattern, format (date-time | date | time | uuid | email
 *                  | uri), minLength, maxLength, minimum, maximum, exclusiveMinimum,
 *                  exclusiveMaximum, multipleOf
 *   applicators  : allOf, anyOf, oneOf, not, if / then / else — boolean sub-schemas included
 *   references   : `$ref` with JSON-Pointer fragments, plain-name `$anchor`s, and cross-document
 *                  refs resolved through {@link SchemaStore} keyed by `$id`
 *   ignored      : `$schema`, `$id`, `$comment`, `$defs`, `definitions`, `title`, `description`,
 *                  `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `x-*`
 *
 * `unevaluatedProperties` is deliberately NOT supported: `src/schemas/*.json` avoids it so that
 * `additionalProperties: false` can never be defeated by an `allOf` branch.
 *
 * Per the spec, type-specific keywords only apply to matching instances (a `pattern` never
 * rejects `null`), which is what makes `{"type":["string","null"],"pattern":…}` usable for the
 * nullable-but-shaped fields of spec §8.
 *
 * @module
 */

/** The draft this mini-validator targets; asserted by `src/tests/schemas.test.ts`. */
export const SUPPORTED_DRAFT = "https://json-schema.org/draft/2020-12/schema";

const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_KEYS = new Set(["items", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else"]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Where relative `$ref`s and bare file names resolve to. */
const URI_BASE = "https://nexus.dev/schemas/";

const FORMAT_PATTERNS = {
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})?$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/,
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const escapeToken = (token) => String(token).replace(/~/g, "~0").replace(/\//g, "~1");
const unescapeToken = (token) => token.replace(/~1/g, "/").replace(/~0/g, "~");

/** JSON type name of an instance value, splitting `integer` from `number`. */
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return typeof value;
  }
}

/** Deterministic stringify; used for `enum` / `const` / `uniqueItems` comparisons. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** One validation failure. `code` is the violated keyword (or a custom rule id). */
export class ValidationIssue extends Error {
  /**
   * @param {string} instancePath JSON Pointer to the offending value
   * @param {string} keyword violated keyword / rule id
   * @param {string} message human-readable explanation
   * @param {string} [schemaPath] JSON Pointer into the schema
   */
  constructor(instancePath, keyword, message, schemaPath = "#") {
    super(`${instancePath || "#"}: ${message}`);
    this.name = "ValidationIssue";
    this.instancePath = instancePath;
    this.keyword = keyword;
    this.code = keyword;
    this.message = message;
    this.schemaPath = schemaPath;
  }
}

/**
 * Schema documents addressable by `$id`, by basename (`"intent"`) and by file name
 * (`"intent.json"`), so `src/schemas/*.json` may `$ref` each other offline.
 */
export class SchemaStore {
  /** @type {Map<string, {doc: object, id?: string, file?: string, anchors: Record<string, any>}>} */
  #byId = new Map();
  /** @type {Map<string, {doc: object, id?: string, file?: string, anchors: Record<string, any>}>} */
  #byName = new Map();

  /**
   * @param {object} doc parsed schema document
   * @param {string} [sourceName] file name or path the document was read from
   * @returns {this}
   */
  add(doc, sourceName) {
    if (!isObject(doc)) throw new Error("schema document must be an object");
    const entry = { doc, id: typeof doc.$id === "string" ? doc.$id : undefined, anchors: {} };
    collectAnchors(doc, entry.anchors);
    if (entry.id) this.#byId.set(entry.id, entry);
    const names = new Set();
    if (entry.id) names.add(entry.id.replace(/^.*\//, ""));
    if (sourceName) names.add(String(sourceName).replace(/\\/g, "/").split("/").pop());
    for (const name of names) {
      if (!name) continue;
      this.#byName.set(name, entry);
      this.#byName.set(name.replace(/\.json$/, ""), entry);
    }
    entry.file = sourceName;
    return this;
  }

  /** @returns {string[]} every registered `$id`. */
  ids() {
    return [...this.#byId.keys()];
  }

  /** @returns {Array<{doc: object, id?: string, file?: string}>} all documents, in insertion order. */
  documents() {
    return [...new Set([...this.#byId.values(), ...this.#byName.values()])].map((e) => ({
      doc: e.doc,
      id: e.id,
      file: e.file,
    }));
  }

  /** @returns {entry|undefined} */
  find(ref) {
    if (!ref) return undefined;
    const direct = this.#byId.get(ref) ?? this.#byName.get(ref);
    if (direct) return direct;
    try {
      const abs = new URL(ref, URI_BASE).href;
      const hit = this.#byId.get(abs) ?? this.#byName.get(abs.replace(/^.*\//, ""));
      if (hit) return hit;
    } catch {
      /* not URL-like; fall through */
    }
    const bare = String(ref).replace(/^.*\//, "").replace(/\.json$/, "");
    return this.#byName.get(bare);
  }

  /**
   * Resolve a `$ref` string against the document it appears in.
   * @returns {{doc: object, node: object|boolean, entry: object}}
   */
  resolve(ref, currentDoc, currentEntry) {
    if (typeof ref !== "string" || ref === "") throw new Error(`invalid $ref: ${JSON.stringify(ref)}`);
    const hashAt = ref.indexOf("#");
    const base = hashAt === -1 ? ref : ref.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : ref.slice(hashAt + 1);

    let entry = base === "" ? currentEntry ?? this.#entryOfDoc(currentDoc) : this.find(base);
    if (!entry && base !== "") {
      try {
        entry = this.find(new URL(base, currentEntry?.id ?? URI_BASE).href);
      } catch {
        entry = undefined;
      }
    }
    if (!entry) throw new Error(`unresolved $ref "${ref}"`);
    const node = fragment === "" || fragment === "/" ? entry.doc : resolveFragment(entry, fragment);
    if (node === undefined) throw new Error(`unresolved $ref "${ref}" (empty target)`);
    return { doc: entry.doc, node, entry };
  }

  #entryOfDoc(doc) {
    for (const entry of new Set([...this.#byId.values(), ...this.#byName.values()])) {
      if (entry.doc === doc) return entry;
    }
    return undefined;
  }
}

/** Index `$anchor` keywords and top-level `$defs/<name>` entries for plain-name refs. */
function collectAnchors(node, anchors, depth = 0) {
  if (!isObject(node) || depth > 16) return;
  if (typeof node.$anchor === "string" && !(node.$anchor in anchors)) anchors[node.$anchor] = node;
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (isObject(map)) {
      for (const [name, child] of Object.entries(map)) {
        if (!(name in anchors)) anchors[name] = child;
        collectAnchors(child, anchors, depth + 1);
      }
    }
  }
  for (const key of SCHEMA_KEYS) if (isObject(node[key])) collectAnchors(node[key], anchors, depth + 1);
  for (const key of SCHEMA_ARRAY_KEYS) {
    if (Array.isArray(node[key])) for (const child of node[key]) collectAnchors(child, anchors, depth + 1);
  }
}

function resolveFragment(entry, fragment) {
  if (fragment.startsWith("/")) {
    const tokens = fragment.slice(1).split("/").map(unescapeToken);
    /** @type {any} */
    let cursor = entry.doc;
    for (const token of tokens) {
      if (Array.isArray(cursor)) cursor = cursor[Number(token)];
      else if (isObject(cursor)) cursor = cursor[token];
      else return undefined;
      if (cursor === undefined) return undefined;
    }
    return cursor;
  }
  const anchor = fragment.startsWith("$") ? fragment.slice(1) : fragment;
  return entry.anchors[anchor];
}

/**
 * Validate an instance against a schema.
 *
 * @param {object|boolean} schema root schema document (or sub-schema)
 * @param {unknown} instance the payload under test
 * @param {{store?: SchemaStore, entry?: object, maxIssues?: number, depth?: number}} [options]
 * @returns {{valid: boolean, issues: ValidationIssue[]}}
 */
export function validate(schema, instance, options = {}) {
  const store = options.store ?? new SchemaStore();
  const maxIssues = options.maxIssues ?? 100;

  /**
   * @returns {ValidationIssue[]} issues produced by this sub-schema (never mutates shared state,
   * so `anyOf` / `oneOf` / `if` branches can be probed cheaply)
   */
  function walk(node, value, ip, sp, entry, depth) {
    if (node === true || node === undefined) return [];
    if (node === false) {
      return [new ValidationIssue(ip, "false", "this position is disallowed by the schema (boolean schema `false`)", sp)];
    }
    if (!isObject(node)) throw new Error(`invalid schema node at ${sp}: ${JSON.stringify(node)}`);
    if (depth > 60) throw new Error(`schema recursion exceeded 60 levels at ${sp}`);

    if (typeof node.$ref === "string") {
      const hit = store.resolve(node.$ref, entry?.doc, entry);
      return walk(hit.node, value, ip, `${sp}/$ref`, hit.entry, depth + 1);
    }

    const out = [];
    const add = (keyword, message, at = ip) => {
      if (out.length < maxIssues) out.push(new ValidationIssue(at, keyword, message, sp));
      return out;
    };

    /* ---- type / enum / const ------------------------------------------------- */
    if (node.type !== undefined) {
      const actual = jsonType(value);
      /** @type {string[]} */
      const allowed = Array.isArray(node.type) ? node.type : [node.type];
      const ok = allowed.some((t) => (t === "number" ? actual === "number" || actual === "integer" : t === actual));
      if (!ok) {
        add("type", `expected ${allowed.join(" | ")}, got ${actual}`);
        return out;
      }
    }
    if (Array.isArray(node.enum)) {
      const target = canonical(value);
      if (!node.enum.some((candidate) => canonical(candidate) === target)) {
        add("enum", `${truncate(target)} is not one of [${node.enum.map((v) => truncate(canonical(v))).join(", ")}]`);
      }
    }
    if ("const" in node && canonical(node.const) !== canonical(value)) {
      add("const", `value must be ${truncate(canonical(node.const))}`);
    }

    /* ---- strings ------------------------------------------------------------- */
    if (typeof value === "string") {
      const length = [...value].length;
      if (isPositive(node.minLength) && length < node.minLength) add("minLength", `string is shorter than ${node.minLength}`);
      if (isPositive(node.maxLength) && length > node.maxLength) add("maxLength", `string is longer than ${node.maxLength}`);
      if (typeof node.pattern === "string") {
        const re = toRegExp(node.pattern);
        if (!re.test(value)) add("pattern", `does not match pattern /${node.pattern}/`);
      }
      if (typeof node.format === "string") {
        const re = FORMAT_PATTERNS[node.format];
        if (re && !re.test(value)) add("format", `not a valid ${node.format}: ${truncate(JSON.stringify(value))}`);
      }
    }

    /* ---- numbers ------------------------------------------------------------- */
    if (typeof value === "number" && Number.isFinite(value)) {
      if (typeof node.minimum === "number" && value < node.minimum) add("minimum", `${value} < minimum ${node.minimum}`);
      if (typeof node.maximum === "number" && value > node.maximum) add("maximum", `${value} > maximum ${node.maximum}`);
      if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) {
        add("exclusiveMinimum", `${value} <= exclusiveMinimum ${node.exclusiveMinimum}`);
      }
      if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) {
        add("exclusiveMaximum", `${value} >= exclusiveMaximum ${node.exclusiveMaximum}`);
      }
      if (typeof node.multipleOf === "number" && node.multipleOf > 0) {
        const ratio = value / node.multipleOf;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) add("multipleOf", `${value} is not a multiple of ${node.multipleOf}`);
      }
    }

    /* ---- objects ------------------------------------------------------------- */
    if (isObject(value)) {
      const declared = isObject(node.properties) ? node.properties : {};
      const patterns = isObject(node.patternProperties) ? node.patternProperties : {};
      for (const required of Array.isArray(node.required) ? node.required : []) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) {
          add("required", `missing required property "${required}"`);
        }
      }
      const keys = Object.keys(value);
      if (isPositive(node.minProperties) && keys.length < node.minProperties) add("minProperties", `fewer than ${node.minProperties} properties`);
      if (isPositive(node.maxProperties) && keys.length > node.maxProperties) add("maxProperties", `more than ${node.maxProperties} properties`);
      for (const key of keys) {
        const childIp = `${ip}/${escapeToken(key)}`;
        let matched = false;
        if (Object.prototype.hasOwnProperty.call(declared, key)) {
          matched = true;
          push(out, walk(declared[key], value[key], childIp, `${sp}/properties/${escapeToken(key)}`, entry, depth + 1), maxIssues);
        }
        for (const [pattern, sub] of Object.entries(patterns)) {
          if (toRegExp(pattern).test(key)) {
            matched = true;
            push(out, walk(sub, value[key], childIp, `${sp}/patternProperties/${escapeToken(pattern)}`, entry, depth + 1), maxIssues);
          }
        }
        if (matched) continue;
        if (node.additionalProperties === false) {
          add("additionalProperties", `property "${key}" is not part of the contract (closed object)`);
        } else if (node.additionalProperties !== undefined) {
          push(
            out,
            walk(node.additionalProperties, value[key], childIp, `${sp}/additionalProperties`, entry, depth + 1),
            maxIssues,
          );
        }
      }
      if (node.propertyNames !== undefined) {
        for (const key of keys) {
          push(
            out,
            walk(node.propertyNames, key, `${ip}/${escapeToken(key)}`, `${sp}/propertyNames`, entry, depth + 1),
            maxIssues,
          );
        }
      }
    }

    /* ---- arrays -------------------------------------------------------------- */
    if (Array.isArray(value)) {
      if (isPositive(node.minItems) && value.length < node.minItems) add("minItems", `fewer than ${node.minItems} items`);
      if (isPositive(node.maxItems) && value.length > node.maxItems) add("maxItems", `more than ${node.maxItems} items`);
      if (node.uniqueItems === true) {
        const seenItems = new Set();
        value.forEach((item, index) => {
          const key = canonical(item);
          if (seenItems.has(key)) add("uniqueItems", `item ${index} duplicates an earlier item`, ip);
          else seenItems.add(key);
        });
      }
      if (Array.isArray(node.prefixItems)) {
        value.forEach((item, index) => {
          if (index < node.prefixItems.length) {
            push(out, walk(node.prefixItems[index], item, `${ip}/${index}`, `${sp}/prefixItems/${index}`, entry, depth + 1), maxIssues);
          } else if (node.additionalItems === false) {
            add("additionalItems", `item ${index} exceeds the declared tuple`, `${ip}/${index}`);
          } else if (node.additionalItems !== undefined) {
            push(out, walk(node.additionalItems, item, `${ip}/${index}`, `${sp}/additionalItems`, entry, depth + 1), maxIssues);
          } else if (node.items !== undefined) {
            push(out, walk(node.items, item, `${ip}/${index}`, `${sp}/items`, entry, depth + 1), maxIssues);
          }
        });
      } else if (node.items !== undefined) {
        value.forEach((item, index) => {
          push(out, walk(node.items, item, `${ip}/${index}`, `${sp}/items`, entry, depth + 1), maxIssues);
        });
      }
      if (isObject(node.contains) && !value.some((item) => walk(node.contains, item, ip, `${sp}/contains`, entry, depth + 1).length === 0)) {
        add("contains", "no array item satisfies `contains`");
      }
    }

    /* ---- applicators --------------------------------------------------------- */
    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((sub, index) => push(out, walk(sub, value, ip, `${sp}/allOf/${index}`, entry, depth + 1), maxIssues));
    }
    if (Array.isArray(node.anyOf)) {
      const branches = node.anyOf.map((sub, index) => walk(sub, value, ip, `${sp}/anyOf/${index}`, entry, depth + 1));
      if (!branches.some((branch) => branch.length === 0)) {
        const nested = branches.flat().slice(0, 6);
        add(
          "anyOf",
          nested.length > 0
            ? `no anyOf branch matched; closest: ${nested.map((e) => `${e.keyword} — ${e.message}`).join("; ")}`
            : "no anyOf branch matched",
        );
      }
    }
    if (Array.isArray(node.oneOf)) {
      const matches = [];
      node.oneOf.forEach((sub, index) => {
        if (walk(sub, value, ip, `${sp}/oneOf/${index}`, entry, depth + 1).length === 0) matches.push(index);
      });
      if (matches.length === 0) add("oneOf", "no oneOf branch matched");
      else if (matches.length > 1) add("oneOf", `exactly one oneOf branch may match, ${matches.length} did (${matches.join(", ")})`);
    }
    if (node.not !== undefined && walk(node.not, value, ip, `${sp}/not`, entry, depth + 1).length === 0) {
      add("not", "value matches the `not` schema, which is forbidden");
    }
    if (node.if !== undefined) {
      const passes = walk(node.if, value, ip, `${sp}/if`, entry, depth + 1).length === 0;
      const branch = passes ? node.then : node.else;
      if (branch !== undefined) push(out, walk(branch, value, ip, `${sp}/${passes ? "then" : "else"}`, entry, depth + 1), maxIssues);
    }

    return out;
  }

  const rootEntry =
    options.entry ??
    store.find(typeof schema?.$id === "string" ? schema.$id : undefined) ??
    { doc: schema, anchors: {} };
  const all = walk(schema, instance, "", "#", rootEntry, 0);
  return { valid: all.length === 0, issues: all.slice(0, maxIssues) };
}

/** Append `source` into `target`, capped. */
function push(target, source, cap) {
  for (const item of source) {
    if (target.length >= cap) return;
    target.push(item);
  }
}

const isPositive = (n) => typeof n === "number" && Number.isFinite(n);

function toRegExp(pattern) {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return new RegExp(pattern);
  }
}

const truncate = (text) => (text.length > 96 ? `${text.slice(0, 93)}...` : text);

/**
 * Convenience: validate and throw on the first issue.
 * @param {object|boolean} schema @param {unknown} instance @param {object} [options]
 */
export function assertValid(schema, instance, options = {}) {
  const result = validate(schema, instance, options);
  if (!result.valid) throw new AggregateError(result.issues.map((i) => new Error(`${i.instancePath}: ${i.message}`)), "schema validation failed");
  return result;
}
