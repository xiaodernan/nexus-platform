/**
 * `@nexus/types` — the shared contract package for the NEXUS platform.
 *
 * Sources of truth, in the order the contracts themselves declare:
 *  - `docs/API_CONTRACT.md`   — HTTP shapes (§0-§11). §2 core shared objects, §7.1 Intent, §10 external surfaces.
 *  - `docs/AGENT_CONTRACT.md` — agent/tool/trust invariants. §3 tool registry, §10 event schema.
 *  - `infra/db/V1__init.sql`  — persisted column names/types (note: `docs/DECISIONS.md` line 4 calls
 *    this `infra/db/migrations/V1__init.sql`; the file on disk has no `migrations/` segment).
 *  - `docs/DECISIONS.md`      — binding stack/layout decisions (D1-D8).
 *  - The product spec (repo root `新建 文本文档.txt`) supplies the `§N` numbers quoted throughout.
 *
 * Rules this package enforces:
 *  1. **snake_case keys** on every wire object (API_CONTRACT §1) — checked by the conformance script.
 *  2. **Money is a string decimal + currency** (API §1/§2).
 *  3. **Uncertain fields are nullable, never defaulted** (spec §8 「必须允许不确定字段」/ API §8 note in §7.1).
 *  4. **Every rendered number traces to a fact** (AGENT_CONTRACT §4) — modelled by `Fact` and the
 *     custom rules in `scripts/validate_conformance.mjs`.
 *
 * The hand-written JSON Schemas for the six most cross-cutting objects live in
 * `src/schemas/*.json` (draft 2020-12) and are copied to `dist/schemas/` by `npm run gen:schemas`.
 */

export * from "./enums.js";
export * from "./common.js";
export * from "./json-schema.js";
export * from "./fact.js";
export * from "./card.js";
export * from "./intent.js";
export * from "./search.js";
export * from "./events.js";
export * from "./tools.js";
export * from "./errors.js";
export * from "./auth.js";
export * from "./merchant.js";
export * from "./commerce.js";
export * from "./review.js";
export * from "./conversation.js";
export * from "./growth.js";
export * from "./admin.js";
export * from "./external.js";
export * from "./ai.js";

/** Package version marker, kept in step with `package.json` for the contract tests. */
export const TYPES_PACKAGE_VERSION = "0.1.0";
