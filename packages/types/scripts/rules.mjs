/**
 * rules.mjs — the **custom (schema-inexpressible) conformance rules** for `@nexus/types`.
 *
 * A JSON Schema can say "this field is a uuid and this set is closed"; it cannot say "this price
 * is a lie unless a fact says so". Those cross-object invariants live here, one entry per rule, so
 * `scripts/validate_conformance.mjs` (and `src/tests/schemas.test.ts`) apply exactly the same code
 * to every fixture.
 *
 * Each rule is `{ id, schemas, rationale, check(instance, ctx) }` where `check` returns an array of
 * human-readable failures (empty = satisfied). `schemas` is the list of schema basenames the rule
 * applies to (`"*"` = all).
 *
 * Rule ids are stable strings and are what fixtures assert via `expect_rule_ids`, so a rule that
 * stops firing fails the build even when something else still rejects the instance.
 *
 * Legend for `rationale`: `@contract` = the contract states it directly; `@derived` = the rule is
 * the only way to make two contract statements consistent (the derivation is spelled out).
 *
 * @module
 */

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Money-ish amount of a fact value, or `undefined` when the value is not a money/number. */
function factAmounts(value) {
  const out = [];
  if (isObj(value)) {
    for (const key of ["amount", "min", "max", "value"]) {
      const n = numOrNull(value[key]);
      if (n !== undefined && n !== null) out.push(n);
    }
  } else {
    const n = numOrNull(value);
    if (n !== null) out.push(n);
  }
  return out;
}

/** Collect `{attribute, value, fact_id}` for every fact backing a card. */
function factIndex(card) {
  const byAttribute = new Map();
  const ids = new Set();
  for (const fact of Array.isArray(card.facts) ? card.facts : []) {
    if (!isObj(fact)) continue;
    if (typeof fact.fact_id === "string") ids.add(fact.fact_id);
    const key = String(fact.attribute ?? "");
    if (!byAttribute.has(key)) byAttribute.set(key, []);
    byAttribute.get(key).push(fact);
  }
  return { byAttribute, ids };
}

/** The field → fact-attribute map for the "every rendered number is a fact" invariant. */
export const CARD_FACT_ATTRIBUTES = {
  price: ["price", "from_price", "price_range"],
  rating: ["rating"],
  availability: ["availability", "capacity"],
};

/**
 * @param {{NEXUS_ENUMS: Record<string, readonly string[]>, FRESHNESS_TTL_SECONDS: Record<string, number>, ERROR_HTTP_STATUS: Record<string, number>}} ts
 *   runtime registries loaded from `dist/enums.js` / `dist/fact.js` / `dist/errors.js`
 * @returns {Array<{id: string, schemas: string[], rationale: string, check: (instance: any, ctx: any) => string[]}>}
 */
export function buildRules(ts) {
  const { FRESHNESS_TTL_SECONDS, ERROR_HTTP_STATUS } = ts;
  const fallbackKinds = ts.NEXUS_ENUMS.FallbackKind ?? [];

  /** ---------------- intent (API_CONTRACT §7.1 / spec §8, AGENT §4) --------------- */
  const intentUnknowns = {
    id: "intent_unknowns_are_unsettled",
    schemas: ["intent"],
    rationale:
      "@contract spec §8 「必须允许不确定字段。不要强行猜测。」 — API_CONTRACT §7.1 lists the unfilled fields in " +
      "`unknowns`; a field named there must therefore be null / absent / empty, otherwise the extractor " +
      "guessed and then declared it unknown, which is the exact failure §8 forbids.",
    check(instance) {
      const failures = [];
      for (const field of Array.isArray(instance.unknowns) ? instance.unknowns : []) {
        const value = instance[field];
        const unset = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
        if (!unset) failures.push(`"${field}" is listed in unknowns but carries the value ${JSON.stringify(value)}`);
      }
      return failures;
    },
  };

  const intentLowConfidence = {
    id: "intent_low_confidence_dropped",
    schemas: ["intent"],
    rationale:
      "@contract AGENT_CONTRACT §4: confidence < 0.6 must be hedged, < 0.4 must be dropped. Dropping means the " +
      "field is null (and ideally listed in `unknowns`), never silently kept at a low score.",
    check(instance) {
      const failures = [];
      const confidence = isObj(instance.confidence) ? instance.confidence : {};
      for (const [field, score] of Object.entries(confidence)) {
        if (typeof score !== "number" || score >= ts.CONFIDENCE_FLOOR_OMIT) continue;
        const value = instance[field];
        const unset = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
        if (!unset) failures.push(`confidence.${field} = ${score} is below the 0.4 floor but "${field}" is still populated`);
      }
      return failures;
    },
  };

  const intentConfidenceKeys = {
    id: "intent_confidence_keys_are_fields",
    schemas: ["intent"],
    rationale:
      "@derived API_CONTRACT §7.1 types `confidence` as a per-field map, so its keys must be Intent field names; " +
      "free-form keys would let a score hide next to a field that does not exist.",
    check(instance, ctx) {
      const failures = [];
      const fields = new Set(Object.keys(ctx.schemaProperties ?? {}));
      if (fields.size === 0) return failures;
      for (const field of Object.keys(isObj(instance.confidence) ? instance.confidence : {})) {
        if (!fields.has(field)) failures.push(`confidence has a key "${field}" that is not an Intent field`);
      }
      for (const field of Array.isArray(instance.unknowns) ? instance.unknowns : []) {
        if (!fields.has(field)) failures.push(`unknowns has "${field}" which is not an Intent field`);
      }
      return failures;
    },
  };

  /** ---------------- fact (API §2, AGENT §4/§5, V1 `facts`) ---------------------- */
  const factTtl = {
    id: "fact_within_ttl",
    schemas: ["fact", "entity_card"],
    rationale:
      "@contract AGENT_CONTRACT §5 fixes a maximum cache TTL per attribute (price 6h, inventory 15m, " +
      "availability 0 …) — `FRESHNESS_TTL_SECONDS` in `src/fact.ts` is that table. An `expires_at` beyond the " +
      "ceiling would let a stale price read as current (spec §20).",
    check(instance, ctx) {
      const failures = [];
      const facts = ctx.schemaName === "fact" ? [instance] : Array.isArray(instance.facts) ? instance.facts : [];
      for (const fact of facts) {
        if (!isObj(fact)) continue;
        const ttl = FRESHNESS_TTL_SECONDS[fact.attribute];
        if (ttl === undefined || fact.expires_at === null || typeof fact.expires_at !== "string") continue;
        const observed = Date.parse(fact.observed_at ?? "");
        const expires = Date.parse(fact.expires_at);
        if (Number.isNaN(observed) || Number.isNaN(expires)) continue;
        const seconds = (expires - observed) / 1000;
        if (seconds < 0) failures.push(`${fact.attribute}: expires_at is before observed_at`);
        else if (seconds > ttl) {
          failures.push(`${fact.attribute}: cached for ${seconds}s, AGENT §5 allows at most ${ttl}s`);
        }
      }
      return failures;
    },
  };

  const factMoneyShape = {
    id: "fact_money_has_currency",
    schemas: ["fact", "entity_card"],
    rationale:
      "@contract API_CONTRACT §1: 「money as string decimal + currency」 — a bare object with an `amount` but no "
      + "`currency` is ambiguous, and §2's `Money` example always carries both.",
    check(instance, ctx) {
      const failures = [];
      const facts = ctx.schemaName === "fact" ? [instance] : Array.isArray(instance.facts) ? instance.facts : [];
      for (const fact of facts) {
        if (!isObj(fact) || !isObj(fact.value)) continue;
        if ("amount" in fact.value) {
          if (typeof fact.value.amount !== "string") {
            failures.push(`${fact.attribute}: Money.amount must be a decimal string, got ${typeof fact.value.amount}`);
          }
          if (typeof fact.value.currency !== "string") {
            failures.push(`${fact.attribute}: Money.value has no currency (API §1)`);
          }
        }
      }
      return failures;
    },
  };

  const factInferredCapped = {
    id: "fact_inferred_capped_confidence",
    schemas: ["fact", "entity_card"],
    rationale:
      "@derived AGENT_CONTRACT §4 orders sources `merchant > imported > observed > third-party > inferred`; the "
      + "only ordering that survives the numeric `confidence` field is that an inferred value may never claim "
      + "high confidence (>= 0.6 is the hedge floor, so inferred facts sit below it).",
    check(instance, ctx) {
      const failures = [];
      const facts = ctx.schemaName === "fact" ? [instance] : Array.isArray(instance.facts) ? instance.facts : [];
      for (const fact of facts) {
        if (!isObj(fact) || fact.source !== "inferred") continue;
        if (typeof fact.confidence === "number" && fact.confidence >= ts.CONFIDENCE_FLOOR_PHRASE) {
          failures.push(`${fact.attribute}: source "inferred" with confidence ${fact.confidence} — inferred facts stay below ${ts.CONFIDENCE_FLOOR_PHRASE}`);
        }
      }
      return failures;
    },
  };

  /** ---------------- entity_card (API §2, AGENT §4/§6) --------------------------- */
  const cardValuesBacked = {
    id: "entity_card_rendered_value_backed",
    schemas: ["entity_card"],
    rationale:
      "@contract API_CONTRACT §2 `facts` = 「Fact[] backing every rendered number」 and AGENT_CONTRACT §4 makes it "
      + "the renderer contract: a price, rating, availability or open/closed verdict with no matching fact must not "
      + "render. This is the rule the task calls out: 「an EntityCard rendering a price with no matching fact must FAIL」.",
    check(instance) {
      const failures = [];
      const { byAttribute, ids } = factIndex(instance);
      const matches = (field, value) => {
        const attributes = CARD_FACT_ATTRIBUTES[field] ?? [];
        const candidates = attributes.flatMap((attribute) => byAttribute.get(attribute) ?? []);
        if (candidates.length === 0) {
          failures.push(`renders "${field}" but no fact carries attribute ${attributes.join(" | ")}`);
          return;
        }
        const wanted = numOrNull(isObj(value) ? value.amount ?? value.value : value);
        if (wanted === null) return;
        const ok = candidates.some((fact) => factAmounts(fact.value).some((amount) => amount === wanted));
        if (!ok) {
          failures.push(
            `renders ${JSON.stringify(value)} but no backing fact states that number (facts say ${candidates
              .flatMap((fact) => factAmounts(fact.value))
              .join(", ") || "nothing numeric"})`,
          );
        }
      };

      if (isObj(instance.price) && instance.price.amount != null) matches("price", instance.price);
      if (isObj(instance.rating) && instance.rating.value != null) matches("rating", instance.rating);

      if (isObj(instance.availability) && instance.availability.status !== "unknown") {
        matches("availability", null);
        if ((instance.availability.status === "available" || instance.availability.status === "limited") && !instance.availability.next_slot) {
          failures.push(`availability.status "${instance.availability.status}" without next_slot — a bookable claim needs a slot (DECISIONS D6: never fabricate one)`);
        }
        if (instance.availability.as_of == null) failures.push("availability has no as_of — AGENT §5 sets its TTL to 0, so the stamp is mandatory");
      }

      if (isObj(instance.open) && instance.open.is_open !== null && instance.open.is_open !== undefined) {
        if (!instance.open.as_of) failures.push("renders an open/closed verdict without as_of (AGENT §5: a cached answer must not read as live)");
        const cited = instance.open.source_fact_id;
        if (!cited) failures.push("renders an open/closed verdict without source_fact_id (AGENT §4 renderer contract)");
        else if (!ids.has(cited)) failures.push(`open.source_fact_id ${cited} is not among the card's facts`);
      }
      return failures;
    },
  };

  const cardExplanations = {
    id: "entity_card_explanation_traceable",
    schemas: ["entity_card"],
    rationale:
      "@contract API_CONTRACT §2 `MatchExplanation` — 「every bullet must trace to a fact id」; AGENT_CONTRACT §1 "
      + "forbids the `recommendation` agent from emitting a bullet without one, §4 forbids rendering it.",
    check(instance) {
      const failures = [];
      const { ids } = factIndex(instance);
      const reasons = isObj(instance.ai_match) && Array.isArray(instance.ai_match.reasons) ? instance.ai_match.reasons : [];
      reasons.forEach((reason, index) => {
        if (!isObj(reason)) return;
        if (typeof reason.fact_id !== "string" || reason.fact_id === "") {
          failures.push(`ai_match.reasons[${index}] ("${reason.label}") has no fact_id`);
        } else if (!ids.has(reason.fact_id)) {
          failures.push(`ai_match.reasons[${index}] cites fact ${reason.fact_id} which is not on this card`);
        }
      });
      return failures;
    },
  };

  const cardFactsScoped = {
    id: "entity_card_facts_scoped",
    schemas: ["entity_card"],
    rationale:
      "@derived API_CONTRACT §2 attaches `facts` to the entity being rendered; a fact about an unrelated row would "
      + "make the citation meaningless, so each fact's subject must be one of the card's own ids (AGENT §4 audit trail).",
    check(instance) {
      const failures = [];
      const scope = new Set(
        [instance.id, instance.merchant_id, instance.location_id].filter((value) => typeof value === "string"),
      );
      const facts = Array.isArray(instance.facts) ? instance.facts : [];
      facts.forEach((fact, index) => {
        if (!isObj(fact)) return;
        if (!scope.has(fact.subject_id) && !scope.has(fact.merchant_id)) {
          failures.push(`facts[${index}] (${fact.attribute}) has subject_id ${fact.subject_id} which is not an entity on this card`);
        }
      });
      return failures;
    },
  };

  const cardSponsoredOrganic = {
    id: "entity_card_sponsored_has_no_organic_rank",
    schemas: ["entity_card"],
    rationale:
      "@contract AGENT_CONTRACT §6: paid placement is inserted **after** organic scoring, so a sponsored card carries "
      + "no organic `ai_match.rank`; exposing one would let the badge masquerade as relevance (spec §66-67).",
    check(instance) {
      const failures = [];
      if (isObj(instance.flags) && instance.flags.sponsored === true) {
        if (isObj(instance.ai_match) && instance.ai_match.rank !== null && instance.ai_match.rank !== undefined) {
          failures.push(`flags.sponsored is true but ai_match.rank = ${instance.ai_match.rank}`);
        }
      }
      return failures;
    },
  };

  /** ---------------- event (AGENT §10, V1 `events`) ------------------------------ */
  const eventActor = {
    id: "event_actor_identity",
    schemas: ["event"],
    rationale:
      "@contract AGENT_CONTRACT §10 types `actor_id` as 「uuid|null」 with null meaning anonymous; a `user` event "
      + "without an actor id is unattributable and V1 `events.actor_id` would be NULL for the wrong reason.",
    check(instance) {
      const failures = [];
      const identified = ["user", "merchant_user", "agent"];
      if (identified.includes(instance.actor_type) && typeof instance.actor_id !== "string") {
        failures.push(`actor_type "${instance.actor_type}" requires actor_id`);
      }
      if (instance.actor_type === "anonymous") {
        if (instance.actor_id !== null) failures.push("actor_type anonymous must carry actor_id: null");
        if (typeof instance.session_id !== "string" || instance.session_id === "") {
          failures.push("actor_type anonymous requires session_id, otherwise the event cannot be deduped or funnelled");
        }
      }
      if (instance.actor_type === "system" && instance.actor_id !== null) {
        failures.push("actor_type system must carry actor_id: null (V1 `events.actor_id` is only for real subjects)");
      }
      return failures;
    },
  };

  const eventSubjectPairing = {
    id: "event_subject_pairing",
    schemas: ["event"],
    rationale:
      "@contract AGENT_CONTRACT §10 keeps `subject_type`/`subject_id` as a pair (request-level events such as "
      + "`search` have neither). Half a subject cannot be joined to a row.",
    check(instance) {
      const failures = [];
      const hasType = instance.subject_type !== null && instance.subject_type !== undefined;
      const hasId = instance.subject_id !== null && instance.subject_id !== undefined;
      if (hasType !== hasId) {
        failures.push(`subject_type=${JSON.stringify(instance.subject_type)} / subject_id=${JSON.stringify(instance.subject_id)} must both be set or both null`);
      }
      return failures;
    },
  };

  const eventSearchProperties = {
    id: "event_search_properties",
    schemas: ["event"],
    rationale:
      "@contract spec §58 lists `search` as 「查询词 + 结果数」 and AGENT §10 puts those in `properties`; the search→conversion "
      + "funnel (spec §162) cannot be computed without them.",
    check(instance) {
      if (instance.name !== "search") return [];
      const failures = [];
      const properties = isObj(instance.properties) ? instance.properties : {};
      if (typeof properties.query !== "string" || properties.query === "") failures.push("a search event must record properties.query");
      if (typeof properties.result_count !== "number") failures.push("a search event must record properties.result_count (number, 0 allowed)");
      return failures;
    },
  };

  const eventConversionDegraded = {
    id: "event_conversion_carries_degraded",
    schemas: ["event"],
    rationale:
      "@contract AGENT_CONTRACT §10's north-star derivation counts a conversion only 「with degraded=false」, so a conversion "
      + "event must state the flag rather than leave the aggregator to guess (spec §162).",
    check(instance) {
      const conversions = ts.NEXUS_ENUMS.NorthStarConversionEvent ?? ["reserve", "purchase", "favorite", "share"];
      if (!conversions.includes(instance.name)) return [];
      if (typeof instance.degraded !== "boolean") {
        return [`conversion event "${instance.name}" must carry a boolean degraded flag for v_north_star`];
      }
      return [];
    },
  };

  /** ---------------- tool_spec (AGENT §2/§3/§5/§8) ------------------------------- */
  const toolClosedInput = {
    id: "tool_spec_closed_input",
    schemas: ["tool_spec"],
    rationale:
      "@contract AGENT_CONTRACT §3 `input_schema={...}  # JSON Schema, additionalProperties=false`; the dispatcher "
      + "rejects unlisted arguments (spec §52: no prompt-to-DB path).",
    check(instance) {
      const failures = [];
      const input = instance.input_schema;
      if (!isObj(input)) return ["input_schema must be a JSON Schema object"];
      if (input.type !== "object") failures.push(`input_schema.type must be "object", got ${JSON.stringify(input.type)}`);
      if (input.additionalProperties !== false) {
        failures.push(`input_schema.additionalProperties must be false, got ${JSON.stringify(input.additionalProperties)}`);
      }
      return failures;
    },
  };

  const toolBudget = {
    id: "tool_spec_within_budget",
    schemas: ["tool_spec"],
    rationale:
      "@contract AGENT_CONTRACT §2 rule 5 sets 4s per tool and 12s per request; §3 gives `search_web` a 10s ceiling "
      + "because it leaves the network. `retries` > 2 cannot fit the request budget.",
    check(instance) {
      const failures = [];
      const ceiling = instance.network_egress === true ? ts.WEB_TOOL_TIMEOUT_MS : ts.TOOL_TIMEOUT_MS;
      if (typeof instance.timeout_ms === "number" && instance.timeout_ms > ceiling) {
        failures.push(`timeout_ms ${instance.timeout_ms} exceeds the ${ceiling}ms AGENT §2/§3 ceiling for ${instance.network_egress ? "network" : "local"} tools`);
      }
      if (typeof instance.retries === "number" && instance.timeout_ms * (instance.retries + 1) > ts.REQUEST_TIMEOUT_MS) {
        failures.push(
          `timeout_ms ${instance.timeout_ms} x (retries ${instance.retries} + 1) = ${instance.timeout_ms * (instance.retries + 1)}ms overruns the ${ts.REQUEST_TIMEOUT_MS}ms request budget`,
        );
      }
      return failures;
    },
  };

  const toolAvailabilityUncached = {
    id: "tool_spec_availability_uncached",
    schemas: ["tool_spec"],
    rationale:
      "@contract AGENT_CONTRACT §3 marks availability `cache_ttl_s=0  # availability: never cached` and §5 keeps live "
      + "availability under 60s (spec §20). Inventory may cache for at most 15 minutes.",
    check(instance) {
      const failures = [];
      const uncached = ["get_availability"];
      const ttlCeiling = { get_inventory: FRESHNESS_TTL_SECONDS.inventory, get_price: FRESHNESS_TTL_SECONDS.price, get_business_hours: FRESHNESS_TTL_SECONDS.opening_hours };
      if (uncached.includes(instance.name) && instance.cache_ttl_s !== 0) {
        failures.push(`${instance.name} must set cache_ttl_s=0 (AGENT §3/§5, spec §20)`);
      }
      const ceiling = ttlCeiling[instance.name];
      if (typeof ceiling === "number" && typeof instance.cache_ttl_s === "number" && instance.cache_ttl_s > ceiling) {
        failures.push(`${instance.name} caches for ${instance.cache_ttl_s}s; AGENT §5 allows at most ${ceiling}s`);
      }
      return failures;
    },
  };

  const toolMutationIdempotent = {
    id: "tool_spec_mutation_idempotent",
    schemas: ["tool_spec"],
    rationale:
      "@contract AGENT_CONTRACT §3/§8 and API_CONTRACT §1: side-effecting tools require an explicit user action plus an "
      + "`Idempotency-Key`, otherwise a retry double-books a table.",
    check(instance) {
      if (instance.side_effect !== true) return [];
      if (instance.requires_idempotency_key !== true) {
        return [`side_effect tool "${instance.name}" must set requires_idempotency_key: true (API §1)`];
      }
      return [];
    },
  };

  const toolAvailabilityPermission = {
    id: "tool_spec_permission_matches_scope",
    schemas: ["tool_spec"],
    rationale:
      "@derived AGENT §8 checks `permission` against the subject's grants for the declared `scopes`; a tool that "
      + "declares the `merchant` scope but asks for a platform-admin permission (or vice versa) would either fail at "
      + "runtime or over-grant. The table below is the minimal coupling the contracts imply.",
    check(instance) {
      const failures = [];
      const adminPermissions = new Set(ts.NEXUS_ENUMS.PermissionName.filter((p) => p.startsWith("admin_") || p === "moderate_content" || p === "export_data"));
      const scopes = Array.isArray(instance.scopes) ? instance.scopes : [];
      if (adminPermissions.has(instance.permission) && !scopes.includes("tenant")) {
        failures.push(`permission "${instance.permission}" needs the "tenant" scope (AGENT §8)`);
      }
      if (scopes.includes("merchant") && !String(instance.permission).includes("read") && !String(instance.permission).includes("write") && !["create_cart", "create_reservation", "checkout", "publish_listing"].includes(instance.permission)) {
        failures.push(`merchant-scoped tool "${instance.name}" carries the unrecognised permission "${instance.permission}"`);
      }
      return failures;
    },
  };

  /** ---------------- error_envelope (API §1) ------------------------------------ */
  const errorStatusMatchesCode = {
    id: "error_http_status_matches_code",
    schemas: ["error_envelope"],
    rationale:
      "@contract API_CONTRACT §1's table binds each code to one HTTP status (`ERROR_CODE_STATUS` in `src/enums.ts`); "
      + "a body that disagrees with its own status line breaks the client's failure ladder.",
    check(instance) {
      const details = isObj(instance.error) && isObj(instance.error.details) ? instance.error.details : null;
      if (!details || details.http_status === undefined) return [];
      const expected = ERROR_HTTP_STATUS[instance.error.code];
      if (expected !== details.http_status) {
        return [`details.http_status ${details.http_status} does not match code "${instance.error.code}" -> HTTP ${expected}`];
      }
      return [];
    },
  };

  const errorLadderFallback = {
    id: "error_ai_unavailable_names_ladder",
    schemas: ["error_envelope"],
    rationale:
      "@contract API_CONTRACT §1 / spec §105: when the AI path fails the response must name the rung the caller should "
      + "use (model_fallback -> deterministic_search -> human), from `FALLBACK_KIND` in `src/enums.ts`.",
    check(instance) {
      if (!isObj(instance.error) || instance.error.code !== "ai_unavailable") return [];
      const details = isObj(instance.error.details) ? instance.error.details : {};
      if (!fallbackKinds.includes(details.fallback)) {
        return [`ai_unavailable must name details.fallback from [${fallbackKinds.join(", ")}], got ${JSON.stringify(details.fallback)}`];
      }
      if (details.retryable !== true && details.retryable !== false) {
        return ["ai_unavailable details must carry a boolean retryable flag"];
      }
      return [];
    },
  };

  return [
    intentUnknowns,
    intentLowConfidence,
    intentConfidenceKeys,
    factTtl,
    factMoneyShape,
    factInferredCapped,
    cardValuesBacked,
    cardExplanations,
    cardFactsScoped,
    cardSponsoredOrganic,
    eventActor,
    eventSubjectPairing,
    eventSearchProperties,
    eventConversionDegraded,
    toolClosedInput,
    toolBudget,
    toolAvailabilityUncached,
    toolMutationIdempotent,
    toolAvailabilityPermission,
    errorStatusMatchesCode,
    errorLadderFallback,
  ];
}

/** Keys that legitimately are not snake_case because they are *paths*, not field names. */
export const SNAKE_CASE_EXEMPT_PARENTS = new Set(["field_errors"]);

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Walk an instance and report every object key that violates API_CONTRACT §1's snake_case rule.
 * @param {unknown} instance @param {string} [pointer]
 * @returns {Array<{pointer: string, key: string}>}
 */
export function findNonSnakeKeys(instance, pointer = "", parentKey = "", out = []) {
  if (Array.isArray(instance)) {
    instance.forEach((item, index) => findNonSnakeKeys(item, `${pointer}/${index}`, parentKey, out));
    return out;
  }
  if (isObj(instance)) {
    for (const [key, value] of Object.entries(instance)) {
      if (key.startsWith("$")) continue;
      if (!SNAKE_CASE_EXEMPT_PARENTS.has(parentKey) && !SNAKE_CASE.test(key)) out.push({ pointer: `${pointer}/${key}`, key });
      findNonSnakeKeys(value, `${pointer}/${key}`, key, out);
    }
  }
  return out;
}
