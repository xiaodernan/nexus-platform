/**
 * A permissive JSON Schema (draft 2020-12) type for schemas that travel *inside* payloads
 * (`ToolSpec.input_schema`, MCP `inputSchema`, eval `expected`).
 *
 * Contract: AGENT_CONTRACT §3 — `input_schema={...} # JSON Schema, additionalProperties=false`.
 * The hand-written schemas in `src/schemas/*.json` are the canonical, validated artefacts; this
 * type only describes embedded sub-schemas so TS can hold them without losing fidelity.
 */
export interface JsonSchema {
  /** Draft identifier — always `https://json-schema.org/draft/2020-12/schema` in NEXUS. */
  $schema?: string;
  /** Schema URI — API_CONTRACT §1 snake_case applies to *data* keys; `$id` is a schema keyword. */
  $id?: string;
  /** Optional local reference anchor. */
  $anchor?: string;
  /** `$ref` pointer to a definition in the same document. */
  $ref?: string;
  /** Reusable sub-schemas, referenced as `#/$defs/<name>`. */
  $defs?: Record<string, JsonSchema>;
  /** Human-readable title for tooling/docs. */
  title?: string;
  /** Human-readable description; must not leak chain-of-thought (spec §116). */
  description?: string;
  /** Instance type(s). Use `["x","null"]` for nullable — never `default` a guess (spec §8). */
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  /** Closed value set. */
  enum?: unknown[];
  /** Single required value. */
  const?: unknown;
  /** Object members. */
  properties?: Record<string, JsonSchema>;
  /** Required member names. */
  required?: string[];
  /** `false` for every tool input schema — unlisted arguments are hard errors (AGENT §3). */
  additionalProperties?: boolean | JsonSchema;
  /** Regex-key members. */
  patternProperties?: Record<string, JsonSchema>;
  /** Constraint on member names, e.g. the snake_case rule from API_CONTRACT §1. */
  propertyNames?: JsonSchema;
  /** Minimum member count. */
  minProperties?: number;
  /** Maximum member count. */
  maxProperties?: number;
  /** Array item schema. */
  items?: JsonSchema | false;
  /** Tuple prefixes. */
  prefixItems?: JsonSchema[];
  /** Minimum item count. */
  minItems?: number;
  /** Maximum item count. */
  maxItems?: number;
  /** Require unique items. */
  uniqueItems?: boolean;
  /** String pattern (ECMA-262). */
  pattern?: string;
  /** String length bounds. */
  minLength?: number;
  /** @see minLength */
  maxLength?: number;
  /** Numeric bounds. */
  minimum?: number;
  /** @see minimum */
  maximum?: number;
  /** Exclusive numeric bounds. */
  exclusiveMinimum?: number;
  /** @see exclusiveMinimum */
  exclusiveMaximum?: number;
  /** Multiple-of constraint (money scale checks). */
  multipleOf?: number;
  /** Semantic format tag (`date-time`, `uuid`, `uri`). */
  format?: string;
  /** All-of composition. */
  allOf?: JsonSchema[];
  /** Any-of composition. */
  anyOf?: JsonSchema[];
  /** Exactly-one-of composition. */
  oneOf?: JsonSchema[];
  /** Negation. */
  not?: JsonSchema;
  /** Conditional applicator. */
  if?: JsonSchema;
  /** @see if */
  then?: JsonSchema;
  /** @see if */
  else?: JsonSchema;
  /** Default value — allowed for *presentation* defaults only; AI extractors must not use it to guess. */
  default?: unknown;
  /** Example instances for docs and fixture generation. */
  examples?: unknown[];
  /** `false` disables validation of the subtree. */
  [keyword: string]: unknown;
}

/** Draft 2020-12 scalar type names. */
export type JsonSchemaTypeName =
  | "null"
  | "boolean"
  | "object"
  | "array"
  | "number"
  | "integer"
  | "string";

/** The `$schema` value every NEXUS schema must carry. */
export const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
