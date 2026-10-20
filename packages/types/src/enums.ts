/**
 * NEXUS canonical enumerations.
 *
 * Single source of truth for every status / kind / name string that crosses a process
 * boundary. Values mirror `infra/db/V1__init.sql` column comments **and** the contract
 * documents; where the two disagree, the contract document wins (see the `CONTRACT NOTES`
 * block at the bottom of this file) and the divergence is recorded in the doc comment.
 *
 * Every enum is emitted as an `as const` array plus a derived union type so that:
 *  - JSON Schemas under `src/schemas/` can be checked against these arrays at CI time
 *    (`scripts/validate_conformance.mjs`, bindings table at the bottom: `SCHEMA_ENUM_BINDINGS`).
 *  - consumers can iterate values at runtime (badges, filter UIs, RBAC pickers).
 *
 * Key-naming rule: wire keys are snake_case everywhere (API_CONTRACT §1), and so are the
 * string values below.
 */

/* --------------------------------------------------------------------------------------------
 * Tenancy / identity / RBAC
 * ------------------------------------------------------------------------------------------ */

/**
 * Tenant lifecycle. Source: V1__init.sql `tenants.status` (line 22).
 * Tenancy model: API_CONTRACT §1 (`X-Tenant`), DECISIONS D5; spec §47 Multi-Tenant Architecture.
 */
export const TENANT_STATUS = ["active", "suspended"] as const;
/** Tenant lifecycle state — V1 `tenants.status`; spec §47. */
export type TenantStatus = (typeof TENANT_STATUS)[number];

/**
 * Platform-side roles. Source: V1__init.sql `users.role` (line 38).
 * API_CONTRACT §9 requires `role IN (platform_admin, platform_ops)` for every admin route;
 * `creator` is the guide/CMS role (spec §63 Creator System).
 */
export const USER_ROLE = ["consumer", "platform_admin", "platform_ops", "creator"] as const;
/** Consumer/staff role on `users` — V1 `users.role`; API_CONTRACT §9, spec §63/§68. */
export type UserRole = (typeof USER_ROLE)[number];

/**
 * Account state. Source: V1__init.sql `users.status` (line 39).
 * `deleted` is soft-delete, paired with `users.deleted_at` and `deletion_requests` (spec §106 Privacy).
 */
export const USER_STATUS = ["active", "disabled", "deleted"] as const;
/** Account state — V1 `users.status`; spec §31/§106. */
export type UserStatus = (typeof USER_STATUS)[number];

/**
 * OAuth / credential providers. Source: V1__init.sql `user_identities.provider` (line 52)
 * and API_CONTRACT §3 (`/auth/oauth/{provider}` → google|apple).
 * `github` exists in the schema comment but is not offered by API §3 — kept because the
 * storage layer accepts it.
 */
export const IDENTITY_PROVIDER = ["password", "google", "apple", "github"] as const;
/** Login provider — V1 `user_identities.provider`; API_CONTRACT §3. */
export type IdentityProvider = (typeof IDENTITY_PROVIDER)[number];

/**
 * Merchant-workspace RBAC roles. Source: V1__init.sql `merchant_users.role` (line 120),
 * mirrored from spec §48 RBAC ("Owner Admin Manager Staff Marketing Analyst AI Agent").
 * `ai_agent` is a first-class member: spec §49 + AGENT_CONTRACT §8 (grants are per subject).
 */
export const MERCHANT_USER_ROLE = [
  "owner",
  "admin",
  "manager",
  "staff",
  "marketing",
  "analyst",
  "ai_agent",
] as const;
/** Merchant membership role — V1 `merchant_users.role`; spec §48/§49. */
export type MerchantUserRole = (typeof MERCHANT_USER_ROLE)[number];

/**
 * Subjects that can hold a `permission_grants` row.
 * Source: V1__init.sql `permission_grants.subject_type` (line 130) = API_CONTRACT §0 token
 * subjects = AGENT_CONTRACT §8 "per subject, not per model".
 */
export const SUBJECT_KIND = ["user", "merchant_user", "agent", "api_key"] as const;
/** Grant-holder kind — V1 `permission_grants.subject_type`; AGENT_CONTRACT §8. */
export type SubjectKind = (typeof SUBJECT_KIND)[number];

/**
 * Closed set of permission names checked by `registry.dispatch()` (AGENT_CONTRACT §3, §8) and
 * by the platform RBAC layer.
 *
 * Provenance of each value:
 *  - API_CONTRACT §5 table ("Required permission" column): `read_profile` is implied by the
 *    read-only counterpart of `write_profile`; the rest are verbatim: `write_profile`,
 *    `publish_listing`, `write_products`, `read_products`, `read_analytics`, `configure_ai`,
 *    `send_message`, `create_draft_campaign`, `publish_campaign`, `admin_members`.
 *  - V1__init.sql line 133 comment + spec §49: `read_orders`, `write_orders`, `create_reservation`,
 *    `refund_payment`.
 *  - AGENT_CONTRACT §3 `ToolSpec(permission=...)`: `read_availability`.
 *  - Derived by the same rule the contract names (`<verb>_<resource>`, needed because AGENT §3
 *    mandates a permission on *every* tool but the docs only spell out the ones above):
 *    `write_availability`, `read_reviews`, `write_reviews`, `read_preferences`,
 *    `write_preferences`, `read_merchant_documents`, `read_web`, `create_cart`, `checkout`,
 *    `moderate_content`, `export_data`.
 * A model may never raise its own scope (AGENT_CONTRACT §8), so this list is deliberately closed.
 */
export const PERMISSION_NAME = [
  "read_profile",
  "write_profile",
  "publish_listing",
  "read_products",
  "write_products",
  "read_availability",
  "write_availability",
  "read_reviews",
  "write_reviews",
  "read_orders",
  "write_orders",
  "create_cart",
  "create_reservation",
  "checkout",
  "refund_payment",
  "send_message",
  "read_preferences",
  "write_preferences",
  "read_analytics",
  "configure_ai",
  "create_draft_campaign",
  "publish_campaign",
  "read_merchant_documents",
  "read_web",
  "admin_members",
  "moderate_content",
  "export_data",
] as const;
/** Declarative permission name — API_CONTRACT §5, AGENT_CONTRACT §3/§8, spec §49. */
export type PermissionName = (typeof PERMISSION_NAME)[number];

/**
 * Context scopes a tool may require (AGENT_CONTRACT §3 `scopes=["tenant"]`, §7 tenant+merchant
 * filtering, §8 grant expiry).
 */
export const TOOL_SCOPE = ["tenant", "merchant", "user", "public", "external_agent"] as const;
/** Required context a tool declares — AGENT_CONTRACT §3/§7. */
export type ToolScope = (typeof TOOL_SCOPE)[number];

/* --------------------------------------------------------------------------------------------
 * Commerce core — merchants
 * ------------------------------------------------------------------------------------------ */

/**
 * Merchant lifecycle. Source: V1__init.sql `merchants.status` (line 88).
 * AGENT_CONTRACT §1 forbids the `search` agent from returning anything not `published`.
 */
export const MERCHANT_STATUS = ["draft", "pending_review", "published", "suspended"] as const;
/** Merchant listing state — V1 `merchants.status`; API_CONTRACT §4, AGENT_CONTRACT §1. */
export type MerchantStatus = (typeof MERCHANT_STATUS)[number];

/**
 * Provenance marker for honesty rules. Source: V1__init.sql `merchants.data_origin` (line 90).
 * DECISIONS D6 + API_CONTRACT §2 (`flags.demo`) + spec §109/§155: seeded data must say so.
 */
export const DATA_ORIGIN = ["demo", "merchant", "imported", "partnership"] as const;
/** Row provenance badge — V1 `merchants.data_origin`; DECISIONS D6, spec §109. */
export type DataOrigin = (typeof DATA_ORIGIN)[number];

/** Subscription tier. Source: V1__init.sql `merchants.plan` (line 103) / `subscriptions.plan` (720); monetization spec §65. */
export const MEMBERSHIP_PLAN = ["free", "pro", "enterprise"] as const;
/** Merchant plan tier — V1 `merchants.plan`; spec §65. Sponsored slots must not leak into organic rank (spec §67). */
export type MembershipPlan = (typeof MEMBERSHIP_PLAN)[number];

/**
 * Catalog kind. Source: V1__init.sql `categories.kind` (line 198).
 * `collection` is added by API_CONTRACT §2 `card_type` (a card exists per kind); spec §115
 * lists the unified result types Merchant|Product|Service|Experience|Collection|Guide.
 */
export const CATEGORY_KIND = ["merchant", "product", "service", "experience"] as const;
/** Catalog node kind — V1 `categories.kind`; spec §115. */
export type CategoryKind = (typeof CATEGORY_KIND)[number];

/**
 * Entity-card discriminator. Source: API_CONTRACT §2 `EntityCard.card_type`
 * ("merchant|product|service|experience|collection"), rendered on consumer + AI + MCP
 * surfaces (spec §35 Recommendation Cards, §36 AI Result Interface, §115).
 */
export const CARD_TYPE = ["merchant", "product", "service", "experience", "collection"] as const;
/** EntityCard discriminant — API_CONTRACT §2; spec §35/§115. */
export type CardType = (typeof CARD_TYPE)[number];

/**
 * CTA kinds on `EntityCard.actions[].type`. Source: API_CONTRACT §2 example
 * (`{ "type": "reserve", "label": "预订", "endpoint": "/api/v1/reservations" }`); the rest are
 * the §4-§6 endpoints a card can point at. Action buttons are the "explicit user action" that
 * AGENT_CONTRACT §8 requires before any mutation tool runs.
 */
export const CARD_ACTION_TYPE = [
  "reserve",
  "buy",
  "add_to_cart",
  "view_menu",
  "view_reviews",
  "compare",
  "message",
  "direction",
  "share",
  "external_link",
  "follow",
] as const;
/** Card CTA kind — API_CONTRACT §2/§4-§6. */
export type CardActionType = (typeof CARD_ACTION_TYPE)[number];

/* --------------------------------------------------------------------------------------------
 * Commerce core — offerings / prices / freshness
 * ------------------------------------------------------------------------------------------ */

/**
 * Offering kind. Source: V1__init.sql `offerings.kind` (line 215) — one table holds products,
 * services and experiences so the universal cart works (API_CONTRACT §6, spec §41).
 */
export const OFFERING_KIND = ["product", "service", "experience"] as const;
/** Offering kind — V1 `offerings.kind`; spec §41. */
export type OfferingKind = (typeof OFFERING_KIND)[number];

/**
 * Offering state. Source: V1__init.sql `offerings.status` (line 239).
 * `out_of_stock` is a *display* status; the authoritative number is `stock_quantity`.
 */
export const OFFERING_STATUS = ["draft", "active", "archived", "out_of_stock"] as const;
/** Offering state — V1 `offerings.status`. */
export type OfferingStatus = (typeof OFFERING_STATUS)[number];

/**
 * How a price should be read. Source: V1__init.sql `offerings.price_model` (line 224);
 * API_CONTRACT §2 renders `price.model` on the card.
 */
export const PRICE_MODEL = ["fixed", "from_price", "per_person", "hourly", "range"] as const;
/** Price semantics — V1 `offerings.price_model`; API_CONTRACT §2. */
export type PriceModel = (typeof PRICE_MODEL)[number];

/**
 * Price provenance. Source: V1__init.sql `offerings.price_source` (line 227) =
 * `merchant|imported|observed|estimated`.
 * NOTE: this differs from {@link FACT_SOURCE}, which uses `inferred` where the price column
 * uses `estimated`. Both are `text` columns with no CHECK constraint, so the two vocabularies
 * are kept separate rather than force-merged; conflict resolution order is defined once in
 * AGENT_CONTRACT §4.
 */
export const PRICE_SOURCE = ["merchant", "imported", "observed", "estimated"] as const;
/** Price provenance — V1 `offerings.price_source`; AGENT_CONTRACT §4/§5. */
export type PriceSource = (typeof PRICE_SOURCE)[number];

/**
 * Reservation-side resource kind. Source: V1__init.sql `resource_pools.kind` (line 269).
 * Generic resource model so restaurant/hotel/beauty/fitness share one service (spec §40).
 */
export const RESOURCE_POOL_KIND = ["table", "room", "seat", "treatment_room", "class_slot", "ticket"] as const;
/** Reservable resource kind — V1 `resource_pools.kind`; spec §40. */
export type ResourcePoolKind = (typeof RESOURCE_POOL_KIND)[number];

/* --------------------------------------------------------------------------------------------
 * Trust layer (AGENT_CONTRACT §4, spec §19) — freshness (AGENT §5, spec §20)
 * ------------------------------------------------------------------------------------------ */

/**
 * Fact provenance, ordered by conflict-resolution priority
 * (`merchant` fresh > `observed` > `imported` > `third_party` > `inferred` > `demo`).
 * Source: API_CONTRACT §2 `Fact.source` = V1__init.sql `facts.source` (line 546).
 * `demo` is the seeded/synthetic origin (spec §109, §155): it states where the claim came from
 * instead of clamping it to a real-world source, and it ranks last so it can never out-claim
 * merchant- or observation-backed data in a conflict.
 */
export const FACT_SOURCE = ["merchant", "imported", "observed", "third_party", "inferred", "demo"] as const;
/** Fact provenance — API_CONTRACT §2, V1 `facts.source`; AGENT_CONTRACT §4, spec §19. */
export type FactSource = (typeof FACT_SOURCE)[number];

/** Conflict-resolution order, highest trust first. AGENT_CONTRACT §4; spec §19. */
export const FACT_SOURCE_PRIORITY: readonly FactSource[] = [
  "merchant",
  "observed",
  "imported",
  "third_party",
  "inferred",
  "demo",
];

/**
 * Fact subject types. Source: V1__init.sql `facts.subject_type` (line 539).
 * API_CONTRACT §2 example uses `offering`.
 */
export const FACT_SUBJECT_TYPE = ["merchant", "offering", "location", "review", "policy"] as const;
/** Fact subject — V1 `facts.subject_type`; API_CONTRACT §2. */
export type FactSubjectType = (typeof FACT_SUBJECT_TYPE)[number];

/** Canonical `facts.attribute` values that drive the freshness policy. V1 line 542, AGENT_CONTRACT §5, spec §20. */
export const FACT_ATTRIBUTE = [
  "price",
  "opening_hours",
  "availability",
  "address",
  "cuisine",
  "capacity",
  "rating",
  "distance",
  "description",
  "inventory",
  "review_summary",
  "popularity",
] as const;
/** Fact attribute — V1 `facts.attribute`; AGENT_CONTRACT §4/§5. (`rating`/`distance`/`description`/`inventory` are required by the §2 card contract, which renders them as facts.) */
export type FactAttribute = (typeof FACT_ATTRIBUTE)[number];

/**
 * Availability status shown on a card. Source: API_CONTRACT §2 `availability.status`
 * (`"available"` in the example). Never fabricated: DECISIONS D6, spec §20.
 */
export const AVAILABILITY_STATUS = ["available", "limited", "unavailable", "unknown"] as const;
/** Real-time availability state — API_CONTRACT §2/§4; AGENT_CONTRACT §5 (TTL 0). */
export type AvailabilityStatus = (typeof AVAILABILITY_STATUS)[number];

/**
 * Trust-signal kinds. Source: V1__init.sql `trust_signals.kind` (line 561).
 * Written only by the `fraud_trust` guard agent (AGENT_CONTRACT §1, spec §53).
 */
export const TRUST_SIGNAL_KIND = ["verified_business", "review_anomaly", "price_anomaly", "duplicate_listing", "fraud_flag", "prompt_injection"] as const;
/** Trust/fraud signal kind — V1 `trust_signals.kind`; AGENT_CONTRACT §1/§7, spec §51/§53. (`prompt_injection` comes from AGENT §7's signal logging.) */
export type TrustSignalKind = (typeof TRUST_SIGNAL_KIND)[number];

/** Severity ladder. Source: V1__init.sql `trust_signals.severity` (line 562). */
export const SEVERITY = ["info", "warn", "high", "critical"] as const;
/** Signal/case severity — V1 `trust_signals.severity`; API_CONTRACT §9 moderation queue. */
export type Severity = (typeof SEVERITY)[number];

/** Trust-signal workflow. Source: V1__init.sql `trust_signals.status` (line 566). */
export const TRUST_SIGNAL_STATUS = ["open", "reviewing", "dismissed", "confirmed"] as const;
/** Trust-signal state — V1 `trust_signals.status`; spec §53. */
export type TrustSignalStatus = (typeof TRUST_SIGNAL_STATUS)[number];

/** Moderation subjects. Source: V1__init.sql `moderation_cases.subject_type` (line 574). */
export const MODERATION_SUBJECT_TYPE = ["review", "merchant", "document", "message", "listing", "seo_page"] as const;
/** Moderation case subject — V1 `moderation_cases.subject_type`; API_CONTRACT §9, spec §127. (`seo_page` added for spec §28 quality bar.) */
export type ModerationSubjectType = (typeof MODERATION_SUBJECT_TYPE)[number];

/** Automated actions a guard may take; `none|hide|flag|reject`. Source: V1__init.sql `moderation_cases.auto_action` (line 578). */
export const MODERATION_AUTO_ACTION = ["none", "hide", "flag", "reject"] as const;
/** Auto-action taken — V1 `moderation_cases.auto_action`; spec §127. */
export type ModerationAutoAction = (typeof MODERATION_AUTO_ACTION)[number];

/** Moderation/case/queue state. V1__init.sql `moderation_cases.status` (line 579). */
export const MODERATION_STATUS = ["open", "reviewing", "resolved", "rejected", "expired"] as const;
/** Moderation case state — V1 `moderation_cases.status`; API_CONTRACT §9. */
export type ModerationStatus = (typeof MODERATION_STATUS)[number];

/* --------------------------------------------------------------------------------------------
 * Commerce core — reservations / carts / orders / payments
 * ------------------------------------------------------------------------------------------ */

/**
 * Reservation state machine. Source: V1__init.sql `reservations.status` (line 306).
 * Transitions are server-guarded (API_CONTRACT §6 `PATCH /reservations/{id}`).
 */
export const RESERVATION_STATUS = ["pending", "confirmed", "cancelled", "completed", "no_show"] as const;
/** Reservation state — V1 `reservations.status`; API_CONTRACT §6, spec §40. */
export type ReservationStatus = (typeof RESERVATION_STATUS)[number];

/**
 * Where a reservation originated. Source: V1__init.sql `reservations.source` (line 310).
 * `mcp` / `ucp` are the external-agent surfaces (API_CONTRACT §10, spec §43-45).
 */
export const RESERVATION_SOURCE = ["consumer", "ai_agent", "mcp", "ucp", "merchant"] as const;
/** Reservation origin channel — V1 `reservations.source`; API_CONTRACT §10. */
export type ReservationSource = (typeof RESERVATION_SOURCE)[number];

/** Cart state. Source: V1__init.sql `carts.status` (line 324). */
export const CART_STATUS = ["open", "converted", "abandoned"] as const;
/** Cart state — V1 `carts.status`; API_CONTRACT §6, spec §41. */
export type CartStatus = (typeof CART_STATUS)[number];

/**
 * Cart line kind — superset of {@link OFFERING_KIND} plus `reservation`, because the
 * universal cart holds products, services, experiences *and* booked tables.
 * Source: V1__init.sql `cart_items.kind` (line 337); spec §41.
 */
export const CART_ITEM_KIND = ["product", "service", "experience", "reservation"] as const;
/** Cart line kind — V1 `cart_items.kind`; API_CONTRACT §6. */
export type CartItemKind = (typeof CART_ITEM_KIND)[number];

/**
 * Order state machine. Source: V1__init.sql `orders.status` (line 354).
 * `v_merchant_funnel` treats `cancelled|refunded` as non-revenue (V1 line 1017).
 */
export const ORDER_STATUS = ["created", "paid", "preparing", "completed", "cancelled", "refunded"] as const;
/** Order state — V1 `orders.status`; API_CONTRACT §6, spec §42. */
export type OrderStatus = (typeof ORDER_STATUS)[number];

/** Fulfilment mode. Source: V1__init.sql `orders.fulfillment` (line 355). */
export const ORDER_FULFILLMENT = ["pickup", "delivery", "dine_in", "reservation", "virtual"] as const;
/** Fulfilment mode — V1 `orders.fulfillment`; spec §42. */
export type OrderFulfillment = (typeof ORDER_FULFILLMENT)[number];

/** Payment providers. Source: V1__init.sql `payments.provider` (line 384); no card data is ever stored (DECISIONS D5, spec §42). */
export const PAYMENT_PROVIDER = ["demo", "stripe", "alipayhk", "payme", "hsbc"] as const;
/** Payment provider id — V1 `payments.provider`; spec §42. */
export type PaymentProvider = (typeof PAYMENT_PROVIDER)[number];

/** Payment state machine. Source: V1__init.sql `payments.status` (line 389). */
export const PAYMENT_STATUS = ["pending", "authorized", "captured", "failed", "refunded", "partially_refunded"] as const;
/** Payment state — V1 `payments.status`; API_CONTRACT §6. */
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

/** Refund state. Source: V1__init.sql `refunds.status` (line 403). `refund_payment` is never in a default AI grant (AGENT_CONTRACT §8). */
export const REFUND_STATUS = ["pending", "succeeded", "failed"] as const;
/** Refund state — V1 `refunds.status`; AGENT_CONTRACT §8. */
export type RefundStatus = (typeof REFUND_STATUS)[number];

/* --------------------------------------------------------------------------------------------
 * Reviews (spec §54-55)
 * ------------------------------------------------------------------------------------------ */

/** Review moderation state. Source: V1__init.sql `reviews.status` (line 425). */
export const REVIEW_STATUS = ["pending", "published", "rejected", "flagged"] as const;
/** Review state — V1 `reviews.status`; API_CONTRACT §4, spec §54. */
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

/**
 * Review provenance. Source: V1__init.sql `reviews.data_origin` (line 424): `demo|user|imported`.
 * Distinct from {@link DATA_ORIGIN} (merchant rows) — reviews are authored by users, not merchants.
 */
export const REVIEW_DATA_ORIGIN = ["demo", "user", "imported"] as const;
/** Review provenance badge — V1 `reviews.data_origin`; spec §109. */
export type ReviewDataOrigin = (typeof REVIEW_DATA_ORIGIN)[number];

/** Review sort orders. Source: API_CONTRACT §4 `/reviews?sort=recent|helpful`. */
export const REVIEW_SORT = ["recent", "helpful"] as const;
/** Review list ordering — API_CONTRACT §4. */
export type ReviewSort = (typeof REVIEW_SORT)[number];

/* --------------------------------------------------------------------------------------------
 * Conversations (API_CONTRACT §7, spec §25-26/§34)
 * ------------------------------------------------------------------------------------------ */

/** Conversation channel. Source: V1__init.sql `conversations.channel` (line 453). */
export const CONVERSATION_CHANNEL = ["web", "mcp", "ucp", "whatsapp", "email"] as const;
/** Conversation channel — V1 `conversations.channel`; API_CONTRACT §7, spec §34. */
export type ConversationChannel = (typeof CONVERSATION_CHANNEL)[number];

/** Handoff/automation mode. Source: V1__init.sql `conversations.mode` (line 454). */
export const CONVERSATION_MODE = ["ai", "human", "hybrid"] as const;
/** Conversation mode — V1 `conversations.mode`; spec §25/§26. */
export type ConversationMode = (typeof CONVERSATION_MODE)[number];

/** Conversation lifecycle. Source: V1__init.sql `conversations.status` (line 457). */
export const CONVERSATION_STATUS = ["open", "handoff", "closed", "archived"] as const;
/** Conversation state — V1 `conversations.status`; spec §26. */
export type ConversationStatus = (typeof CONVERSATION_STATUS)[number];

/** Who physically sent a message. Source: V1__init.sql `messages.sender_type` (line 468). */
export const SENDER_TYPE = ["user", "ai_agent", "merchant_user", "system"] as const;
/** Message sender kind — V1 `messages.sender_type`. */
export type SenderType = (typeof SENDER_TYPE)[number];

/** ChatML-style role. Source: V1__init.sql `messages.role` (line 470). */
export const MESSAGE_ROLE = ["user", "assistant", "tool", "system"] as const;
/** Model role — V1 `messages.role`. */
export type MessageRole = (typeof MESSAGE_ROLE)[number];

/** Structured payload renderer. Source: V1__init.sql `messages.content_type` (line 472). */
export const MESSAGE_CONTENT_TYPE = ["text", "cards", "comparison", "form"] as const;
/** Message renderer — V1 `messages.content_type`; spec §35/§36/§37. */
export type MessageContentType = (typeof MESSAGE_CONTENT_TYPE)[number];

/**
 * Why a conversation left the AI. Source: V1__init.sql `handoffs.reason` (line 485).
 * `low_confidence` implements the AGENT_CONTRACT §4 floor (§4: confidence < 0.4 ⇒ omit and
 * offer handoff) and AGENT §1's `customer_service` rule.
 */
export const HANDOFF_REASON = ["low_confidence", "user_request", "policy", "refund"] as const;
/** Handoff reason — V1 `handoffs.reason`; AGENT_CONTRACT §1/§4, spec §26. */
export type HandoffReason = (typeof HANDOFF_REASON)[number];

/** Handoff workflow. Source: V1__init.sql `handoffs.status` (line 486). */
export const HANDOFF_STATUS = ["open", "accepted", "resolved", "expired"] as const;
/** Handoff state — V1 `handoffs.status`; spec §26. */
export type HandoffStatus = (typeof HANDOFF_STATUS)[number];

/* --------------------------------------------------------------------------------------------
 * Query understanding / search / ranking
 * ------------------------------------------------------------------------------------------ */

/**
 * Canonical `Intent.intent` values. Source: API_CONTRACT §7.1 (verbatim comment) —
 * `discover_merchant|discover_offering|reserve|purchase|ask_merchant|compare|plan_experience|unknown`.
 * Spec §8 Query Understanding: `unknown` is a legitimate answer; guessing is forbidden.
 */
export const INTENT_KIND = [
  "discover_merchant",
  "discover_offering",
  "reserve",
  "purchase",
  "ask_merchant",
  "compare",
  "plan_experience",
  "unknown",
] as const;
/** Query intent class — API_CONTRACT §7.1; spec §8. */
export type IntentKind = (typeof INTENT_KIND)[number];

/**
 * `Intent.location.type`. API_CONTRACT §7.1 shows `district`; the other members cover spec §112
 * (HK addresses use district/area + MTR proximity) and coordinate/POI resolution.
 */
export const LOCATION_REF_TYPE = ["district", "area", "mtr_station", "address", "point", "landmark", "current_location"] as const;
/** Location reference kind — API_CONTRACT §7.1; spec §112/§38. */
export type LocationRefType = (typeof LOCATION_REF_TYPE)[number];

/**
 * `Intent.time.type`. API_CONTRACT §7.1 shows `explicit`; `relative` covers "周六晚上",
 * `open_now` covers AGENT_CONTRACT §2's "what's open now" example that must not trigger a
 * retrieval+rerank plan.
 */
export const TIME_REF_TYPE = ["explicit", "relative", "range", "open_now", "unspecified"] as const;
/** Time reference kind — API_CONTRACT §7.1; AGENT_CONTRACT §2. */
export type TimeRefType = (typeof TIME_REF_TYPE)[number];

/** What a budget applies to. API_CONTRACT §7.1 `budget.per`. */
export const BUDGET_UNIT = ["party", "person", "item", "total"] as const;
/** Budget denominator — API_CONTRACT §7.1. */
export type BudgetUnit = (typeof BUDGET_UNIT)[number];

/**
 * Result ordering preference. Source: API_CONTRACT §7.1 (verbatim)
 * `relevance|distance|price_low|rating|trending`; ranking inputs per AGENT_CONTRACT §6.
 */
export const SORT_PREFERENCE = ["relevance", "distance", "price_low", "rating", "trending"] as const;
/** Sort preference — API_CONTRACT §7.1; AGENT_CONTRACT §6. */
export type SortPreference = (typeof SORT_PREFERENCE)[number];

/**
 * `Intent.urgency`. The contract shows the value `"normal"` but does not enumerate the set
 * (API_CONTRACT §7.1); `low|normal|high` is the closed vocabulary chosen here — see CONTRACT
 * NOTES #4. Never defaulted from silence: absence is `null`.
 */
export const URGENCY_LEVEL = ["low", "normal", "high"] as const;
/** Time pressure — API_CONTRACT §7.1 (values not enumerated in the contract). */
export type UrgencyLevel = (typeof URGENCY_LEVEL)[number];

/** Preference polarity: `1` like, `-1` avoid. API_CONTRACT §7.1 `preferences[].polarity`. */
export const POLARITY = [1, -1] as const;
/** Preference polarity (+1 / -1) — API_CONTRACT §7.1. */
export type Polarity = (typeof POLARITY)[number];

/**
 * Intent fields an extractor may declare unknown. Source: API_CONTRACT §7.1 `unknowns`
 * (`§8 — never guess; ask in one follow-up only`). Only fields that can legitimately be absent
 * are listable: `raw_query`, `confidence` and `unknowns` itself are never unknown.
 */
export const INTENT_UNKNOWN_FIELD = [
  "category",
  "location",
  "time",
  "budget",
  "party_size",
  "preferences",
  "constraints",
  "sort_preference",
  "urgency",
] as const;
/** Field name that may appear in `Intent.unknowns` — API_CONTRACT §7.1, spec §8. */
export type IntentUnknownField = (typeof INTENT_UNKNOWN_FIELD)[number];

/** Supported locales. Source: DECISIONS D1/AGENT_CONTRACT §12 (default `zh-HK`), V1 `tenants.locales` (line 21). */
export const SUPPORTED_LOCALE = ["en", "zh-HK", "zh-CN"] as const;
/** UI/AI locale — AGENT_CONTRACT §12, spec §111. */
export type SupportedLocale = (typeof SUPPORTED_LOCALE)[number];

/** Routed strategy name, versioned into `recommendation_sets.strategy`. Source: V1__init.sql line 594, AGENT_CONTRACT §6. */
export const SEARCH_STRATEGY = ["hybrid_v1", "keyword_v1", "vector_v1", "geo_v1", "deterministic_v1"] as const;
/** Ranking/retrieval strategy id — AGENT_CONTRACT §6, V1 `recommendation_sets.strategy`. */
export type SearchStrategy = (typeof SEARCH_STRATEGY)[number];

/** Ranking score components weighted in AGENT_CONTRACT §6 §"score =". */
export const RANKING_FACTOR = [
  "relevance",
  "quality",
  "distance",
  "price_fit",
  "availability",
  "personalization",
  "popularity",
  "freshness",
] as const;
/** Organic score contributing factor — AGENT_CONTRACT §6, spec §17/§113. */
export type RankingFactor = (typeof RANKING_FACTOR)[number];

/** Explanation labels the renderer can show. API_CONTRACT §2 `MatchExplanation.label` (`within_budget` in the example). */
export const EXPLANATION_LABEL = [
  "within_budget",
  "price_low",
  "distance_close",
  "open_now",
  "slot_available",
  "rating_high",
  "matches_preference",
  "matches_category",
  "trending",
  "transit_nearby",
] as const;
/** Explanation bullet label — API_CONTRACT §2; AGENT_CONTRACT §6, spec §18. */
export type ExplanationLabel = (typeof EXPLANATION_LABEL)[number];

/** Facet kinds for `SearchResponse.facets`. API_CONTRACT §7 `/ai/v1/search` → `{items, facets, took_ms, strategy, degraded}`. */
export const FACET_KIND = ["range", "terms", "boolean", "geo"] as const;
/** Facet aggregation kind — API_CONTRACT §7. */
export type FacetKind = (typeof FACET_KIND)[number];

/** Feedback signals. Source: V1__init.sql `feedback_events.signal` (line 607); AGENT_CONTRACT §6 (EMA over explicit + implicit + outcome), spec §99-100. */
export const FEEDBACK_SIGNAL = [
  "like",
  "dislike",
  "not_relevant",
  "too_expensive",
  "too_far",
  "wrong_category",
  "click",
  "reserve",
  "purchase",
  "dwell",
] as const;
/** Recommendation feedback signal — V1 `feedback_events.signal`; spec §99. */
export type FeedbackSignal = (typeof FEEDBACK_SIGNAL)[number];

/** Feedback subjects. Source: V1__init.sql `feedback_events.subject_type` (line 605). */
export const FEEDBACK_SUBJECT_TYPE = ["recommendation_set", "message", "merchant", "offering", "search_result"] as const;
/** Feedback subject — V1 `feedback_events.subject_type`; API_CONTRACT §7 `/ai/v1/feedback`. */
export type FeedbackSubjectType = (typeof FEEDBACK_SUBJECT_TYPE)[number];

/* --------------------------------------------------------------------------------------------
 * RAG / documents (AGENT_CONTRACT §7, spec §12)
 * ------------------------------------------------------------------------------------------ */

/** Document kinds. Source: V1__init.sql `documents.kind` (line 498). */
export const DOCUMENT_KIND = ["menu", "policy", "faq", "description", "review", "image_meta", "url", "pdf", "xlsx"] as const;
/** Indexed document kind — V1 `documents.kind`; AGENT_CONTRACT §7. */
export type DocumentKind = (typeof DOCUMENT_KIND)[number];

/** Indexing pipeline state. Source: V1__init.sql `documents.status` (line 505). */
export const DOCUMENT_STATUS = ["pending", "processing", "indexed", "failed"] as const;
/** Document index state — V1 `documents.status`. */
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];

/** Import job state. API_CONTRACT §5.1: `202 {job_id, status:"queued"}` then polled. */
export const IMPORT_JOB_STATUS = ["queued", "crawling", "parsing", "classifying", "completed", "failed", "cancelled"] as const;
/** AI import pipeline state — API_CONTRACT §5.1; spec §22. */
export type ImportJobStatus = (typeof IMPORT_JOB_STATUS)[number];

/** Import source kinds. API_CONTRACT §5.1 `source.type` (`url`) plus uploaded files. Spec §22. */
export const IMPORT_SOURCE_TYPE = ["url", "file", "menu_pdf", "spreadsheet", "pos_export"] as const;
/** Import source kind — API_CONTRACT §5.1; spec §22. */
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPE)[number];

/** Embedding dimension fixed across the stack: DECISIONS D3 (`chunks.embedding vector(1024)`). */
export const EMBEDDING_DIM = 1024;

/* --------------------------------------------------------------------------------------------
 * Agents / tools / runs (AGENT_CONTRACT §1-§3, API_CONTRACT §7)
 * ------------------------------------------------------------------------------------------ */

/**
 * Agent roster. Source: AGENT_CONTRACT §1 table (all 19 names, verbatim).
 * Divergence: V1__init.sql line 808 comments `agent_runs.agent` as
 * `...|fraud|fact_verification` — it uses `fraud` (not `fraud_trust`) and omits
 * `location|availability|checkout|merchant_sales|admin_agent`. The roster in AGENT_CONTRACT §1
 * is the authoritative list (it is the file that "fixes the invariants every agent must honour"),
 * and `agent_runs.agent` is a plain `text` column with no CHECK, so no migration is needed.
 */
export const AGENT_NAME = [
  "user_intent",
  "search",
  "retrieval",
  "location",
  "availability",
  "ranking",
  "recommendation",
  "review",
  "fact_verification",
  "reservation",
  "cart",
  "checkout",
  "customer_service",
  "merchant_sales",
  "marketing",
  "seo",
  "analytics",
  "fraud_trust",
  "admin_agent",
] as const;
/** Orchestrator agent name — AGENT_CONTRACT §1; V1 `agent_runs.agent`; spec §9. */
export type AgentName = (typeof AGENT_NAME)[number];

/** Agent role in the loop. AGENT_CONTRACT §1 "Kind" column. */
export const AGENT_KIND = ["planner", "executor", "synthesiser", "analyst", "guard", "action", "conversational", "generator"] as const;
/** Agent kind — AGENT_CONTRACT §1. */
export type AgentKind = (typeof AGENT_KIND)[number];

/**
 * Canonical tool names. Source: AGENT_CONTRACT §3 "Canonical tool names (implement exactly
 * these)" — all 24 names, verbatim. Unknown tool names are hard errors.
 */
export const TOOL_NAME = [
  "search_merchants",
  "search_products",
  "search_services",
  "search_reviews",
  "search_location",
  "get_business_hours",
  "get_price",
  "get_inventory",
  "get_availability",
  "create_reservation",
  "create_cart",
  "update_cart",
  "checkout",
  "get_order_status",
  "search_web",
  "retrieve_merchant_documents",
  "analyze_reviews",
  "get_user_preferences",
  "set_user_preference",
  "summarize_reviews",
  "compare_entities",
  "draft_campaign",
  "draft_seo_page",
  "record_event",
] as const;
/** Registry tool name — AGENT_CONTRACT §3, spec §11. */
export type ToolName = (typeof TOOL_NAME)[number];

/**
 * MCP-exposed tool names. Source: API_CONTRACT §10 — a narrower, externally published subset
 * of {@link TOOL_NAME} plus `search_nexus` (the composite entry point) and `check_availability`.
 */
export const MCP_TOOL_NAME = [
  "search_nexus",
  "get_merchant",
  "search_products",
  "check_availability",
  "create_cart",
  "create_reservation",
  "get_order_status",
] as const;
/** Public MCP tool name — API_CONTRACT §10; spec §44. */
export type McpToolName = (typeof MCP_TOOL_NAME)[number];

/** Tool cost classes. Source: AGENT_CONTRACT §3 `cost_class`. Cost accounting: spec §102/§160. */
export const COST_CLASS = ["db", "vector", "llm_cheap", "llm_reason", "external"] as const;
/** Tool cost class — AGENT_CONTRACT §3. */
export type CostClass = (typeof COST_CLASS)[number];

/** Fallback kinds. Source: V1__init.sql `agent_runs.fallback_used` (line 824) = AGENT_CONTRACT §2 failure ladder, spec §105. */
export const FALLBACK_KIND = ["model_fallback", "deterministic_search", "human"] as const;
/** Degradation path taken — V1 `agent_runs.fallback_used`; API_CONTRACT §1, spec §105. */
export type FallbackKind = (typeof FALLBACK_KIND)[number];

/** Run state. Source: V1__init.sql `agent_runs.status` (line 812). */
export const AGENT_RUN_STATUS = ["running", "succeeded", "failed", "fallback", "cancelled"] as const;
/** Agent run state — V1 `agent_runs.status`. */
export type AgentRunStatus = (typeof AGENT_RUN_STATUS)[number];

/** Plan step execution mode: AGENT_CONTRACT §2 rules 1 & 3 (dynamic plan, independent steps run concurrently). */
export const PLAN_STEP_MODE = ["parallel", "sequential", "conditional"] as const;
/** Plan step scheduling mode — AGENT_CONTRACT §2. */
export type PlanStepMode = (typeof PLAN_STEP_MODE)[number];

/**
 * Model-router task classes. Source: AGENT_CONTRACT §9 table.
 * Divergence: the table's row labels `classify/route` and `reason/plan` contain a slash, which
 * is unusable as a JSON string value in enums/paths, so they are canonicalised to
 * `classify_route` and `reason_plan` (documented in CONTRACT NOTES #3).
 */
export const TASK_CLASS = [
  "intent_extract",
  "classify_route",
  "embed",
  "rerank",
  "summary",
  "reason_plan",
  "generate_ui_copy",
] as const;
/** Router task class — AGENT_CONTRACT §9. */
export type TaskClass = (typeof TASK_CLASS)[number];

/** LLM provider adapters. Source: DECISIONS D4 (`mock|anthropic|openai`), AGENT_CONTRACT §9. */
export const LLM_PROVIDER = ["mock", "anthropic", "openai"] as const;
/** Provider id — DECISIONS D4 (`NEXUS_LLM_PROVIDER`). */
export type LlmProvider = (typeof LLM_PROVIDER)[number];

/** LLM call purposes. Source: V1__init.sql `llm_calls.purpose` (line 836). */
export const LLM_PURPOSE = ["intent", "rerank", "summary", "generate", "classify", "plan", "extract"] as const;
/** `llm_calls.purpose` — V1 `llm_calls.purpose`. (`plan`/`extract` come from AGENT §2 planning and §5 extraction.) */
export type LlmPurpose = (typeof LLM_PURPOSE)[number];

/** LLM call outcome. Source: V1__init.sql `llm_calls.status` (line 841) — `ok` default; `error`/`timeout` added for AGENT §2 timeouts. */
export const LLM_CALL_STATUS = ["ok", "error", "timeout", "cancelled"] as const;
/** `llm_calls.status` — V1 `llm_calls.status`; AGENT_CONTRACT §2 rule 5. */
export type LlmCallStatus = (typeof LLM_CALL_STATUS)[number];

/** Evaluation suites. Source: AGENT_CONTRACT §11 `suites` list (verbatim). */
export const EVAL_SUITE = [
  "intent_v1",
  "search_relevance_v1",
  "rag_faithfulness_v1",
  "tool_selection_v1",
  "safety_injection_v1",
  "personalization_v1",
] as const;
/** Named eval suite — AGENT_CONTRACT §11; spec §71. */
export type EvalSuiteName = (typeof EVAL_SUITE)[number];

/* --------------------------------------------------------------------------------------------
 * Events (AGENT_CONTRACT §10) / notifications (spec §123-125) / growth (spec §59-63)
 * ------------------------------------------------------------------------------------------ */

/**
 * Event name union — **all** names in AGENT_CONTRACT §10 ("Required names"), verbatim.
 * Divergence: V1__init.sql line 768 (`events.name`) comments only 13 of the 17 names; it omits
 * `ai_answer`, `handoff`, `campaign_publish`, `agent_run`. AGENT §10 is authoritative and
 * `events.name` is `text` with no CHECK, so the union here is the 17-name superset
 * (see CONTRACT NOTES #1).
 */
export const EVENT_NAME = [
  "search",
  "view",
  "click",
  "favorite",
  "compare",
  "reserve",
  "cart_add",
  "checkout",
  "purchase",
  "cancel",
  "review",
  "share",
  "feedback",
  "ai_answer",
  "handoff",
  "campaign_publish",
  "agent_run",
] as const;
/** Analytics/agent event name — AGENT_CONTRACT §10; V1 `events.name`; spec §58. */
export type EventName = (typeof EVENT_NAME)[number];

/** Conversion events used by the north-star derivation. AGENT_CONTRACT §10 §"North-star derivation" (a `search` followed within 30 min by one of these, `degraded=false`). */
export const NORTH_STAR_CONVERSION_EVENT = ["reserve", "purchase", "favorite", "share"] as const;
/** Events that fulfil an intent for `v_north_star` — AGENT_CONTRACT §10; spec §162. */
export type NorthStarConversionEvent = (typeof NORTH_STAR_CONVERSION_EVENT)[number];

/** North-star window in minutes: AGENT_CONTRACT §10 ("within 30 min"). */
export const NORTH_STAR_WINDOW_MINUTES = 30;

/** Event actor kinds. Source: AGENT_CONTRACT §10 `actor_type` (verbatim; equals V1 line 766). */
export const ACTOR_TYPE = ["user", "merchant_user", "agent", "system", "anonymous"] as const;
/** Event actor type — AGENT_CONTRACT §10; V1 `events.actor_type`. */
export type ActorType = (typeof ACTOR_TYPE)[number];

/**
 * Event subjects. Source: AGENT_CONTRACT §10 `subject_type`
 * ("merchant|offering|search_result|conversation|null"); `recommendation_set`, `guide`,
 * `campaign`, `order`, `reservation` are needed because §10's name list includes
 * `campaign_publish`, `reserve`, `checkout`/`purchase` whose subject is not in the four
 * documented members.
 */
export const EVENT_SUBJECT_TYPE = [
  "merchant",
  "offering",
  "search_result",
  "conversation",
  "recommendation_set",
  "guide",
  "collection",
  "campaign",
  "coupon",
  "order",
  "reservation",
  "review",
  "agent_run",
] as const;
/** Event subject kind — AGENT_CONTRACT §10 (superset, see CONTRACT NOTES #2). */
export type EventSubjectType = (typeof EVENT_SUBJECT_TYPE)[number];

/** Geo precision carried in `Event.context.geo_precision`. Source: AGENT_CONTRACT §10 example + §1 (`location` agent must not use precise geo without consent). */
export const GEO_PRECISION = ["precise", "district", "area", "none"] as const;
/** Coarse-grained geo label — AGENT_CONTRACT §10, spec §50. */
export type GeoPrecision = (typeof GEO_PRECISION)[number];

/** Device class in `Event.context.device`. AGENT_CONTRACT §10 example (`"mobile"`). */
export const DEVICE_CLASS = ["mobile", "desktop", "tablet", "watch", "unknown"] as const;
/** Device class — AGENT_CONTRACT §10. */
export type DeviceClass = (typeof DEVICE_CLASS)[number];

/** Notification audience. Source: V1__init.sql `notifications.audience` (line 786). */
export const NOTIFICATION_AUDIENCE = ["consumer", "merchant", "platform"] as const;
/** Notification audience — V1 `notifications.audience`; spec §123-125. */
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCE)[number];

/** Delivery channels. Source: V1__init.sql `notifications.channel` (line 789); spec §123 ("WhatsApp where legally/technically available"). */
export const NOTIFICATION_CHANNEL = ["in_app", "email", "push", "whatsapp"] as const;
/** Notification channel — V1 `notifications.channel`; spec §123. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL)[number];

/** Delivery state. Source: V1__init.sql `notifications.status` (line 792). */
export const NOTIFICATION_STATUS = ["pending", "sent", "failed", "suppressed"] as const;
/** Notification delivery state — V1 `notifications.status`. */
export type NotificationStatus = (typeof NOTIFICATION_STATUS)[number];

/** Campaign channels. Source: V1__init.sql `campaigns.channel` (line 685). */
export const CAMPAIGN_CHANNEL = ["push", "email", "whatsapp", "landing", "social"] as const;
/** Campaign channel — V1 `campaigns.channel`; spec §27/§59. */
export type CampaignChannel = (typeof CAMPAIGN_CHANNEL)[number];

/**
 * Campaign workflow. Source: V1__init.sql `campaigns.status` (line 689).
 * The `marketing` agent may only write `draft`; publishing is an explicit human action
 * (AGENT_CONTRACT §1/§8, API_CONTRACT §5 `approve-publish`, spec §27).
 */
export const CAMPAIGN_STATUS = ["draft", "awaiting_approval", "scheduled", "live", "paused", "ended"] as const;
/** Campaign state — V1 `campaigns.status`; spec §27. */
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];

/** Campaign generator identity. Source: V1__init.sql `campaigns.generated_by` (line 690). */
export const CAMPAIGN_GENERATOR = ["ai_marketing_agent", "merchant", "platform_ops"] as const;
/** Who authored a campaign — V1 `campaigns.generated_by`; spec §27. */
export type CampaignGenerator = (typeof CAMPAIGN_GENERATOR)[number];

/** Coupon mechanics. Source: V1__init.sql `coupons.kind` (line 663). */
export const COUPON_KIND = ["percent", "fixed", "free_item"] as const;
/** Discount kind — V1 `coupons.kind`; spec §61/§62. */
export type CouponKind = (typeof COUPON_KIND)[number];

/** Coupon lifecycle. Source: V1__init.sql `coupons.status` (line 671). */
export const COUPON_STATUS = ["draft", "scheduled", "active", "exhausted", "retired"] as const;
/** Coupon state — V1 `coupons.status`. */
export type CouponStatus = (typeof COUPON_STATUS)[number];

/** Collection kinds. Source: V1__init.sql `collections.kind` (line 640). */
export const COLLECTION_KIND = ["collection", "guide", "itinerary"] as const;
/** Collection/guide kind — V1 `collections.kind`; API_CONTRACT §8, spec §63/§64. */
export type CollectionKind = (typeof COLLECTION_KIND)[number];

/** Visibility of a collection/guide. Source: V1__init.sql `collections.visibility` (line 647). */
export const VISIBILITY = ["private", "unlisted", "public"] as const;
/** Content visibility — V1 `collections.visibility`. */
export type Visibility = (typeof VISIBILITY)[number];

/** Referral programme kinds. Source: V1__init.sql `referrals.kind` (line 704); spec §61-62. */
export const REFERRAL_KIND = ["consumer", "merchant", "creator"] as const;
/** Referral programme — V1 `referrals.kind`; spec §60-62. */
export type ReferralKind = (typeof REFERRAL_KIND)[number];

/** Referrer identity kind. Source: V1__init.sql `referrals.referrer_type` (line 705). */
export const REFERRER_TYPE = ["user", "merchant"] as const;
/** Referrer kind — V1 `referrals.referrer_type`. */
export type ReferrerType = (typeof REFERRER_TYPE)[number];

/**
 * Referral funnel state. Source: V1__init.sql `referrals.status` (line 710).
 * Rewards are recorded only on genuine conversion (API_CONTRACT §8, spec §110 forbids fake growth).
 */
export const REFERRAL_STATUS = ["invited", "signed_up", "first_value", "rewarded", "expired"] as const;
/** Referral state — V1 `referrals.status`; spec §110. */
export type ReferralStatus = (typeof REFERRAL_STATUS)[number];

/** SEO page kinds. Source: V1__init.sql `seo_pages.kind` (line 739). */
export const SEO_PAGE_KIND = ["city", "category", "category_district", "theme", "merchant", "offering", "guide"] as const;
/** Programmatic SEO page kind — V1 `seo_pages.kind`; spec §29/§30. */
export type SeoPageKind = (typeof SEO_PAGE_KIND)[number];

/** SEO page lifecycle. Source: V1__init.sql `seo_pages.status` (line 750). */
export const SEO_PAGE_STATUS = ["draft", "published", "noindex", "retired"] as const;
/** SEO page state — V1 `seo_pages.status`; spec §28. */
export type SeoPageStatus = (typeof SEO_PAGE_STATUS)[number];

/** Preference memory kinds. Source: V1__init.sql `user_preferences.kind` (line 64); spec §32/§117-118. */
export const PREFERENCE_KIND = ["food", "budget", "location", "brand", "style", "activity", "language", "accessibility"] as const;
/** Preference memory kind — V1 `user_preferences.kind`; spec §32. */
export type PreferenceKind = (typeof PREFERENCE_KIND)[number];

/** How a preference was learned. Source: V1__init.sql `user_preferences.source` (line 68). */
export const PREFERENCE_SOURCE = ["declared", "inferred", "transaction"] as const;
/** Preference provenance — V1 `user_preferences.source`; spec §33/§117. */
export type PreferenceSource = (typeof PREFERENCE_SOURCE)[number];

/** Memory scope. Source: V1__init.sql `user_preferences.scope` (line 69); memory tiers per spec §117. */
export const PREFERENCE_SCOPE = ["session", "long_term"] as const;
/** Preference memory scope — V1 `user_preferences.scope`; spec §117. */
export type PreferenceScope = (typeof PREFERENCE_SCOPE)[number];

/** Favorite subjects. Source: V1__init.sql `favorites.subject_type` (line 619). */
export const FAVORITE_SUBJECT_TYPE = ["merchant", "offering", "guide", "collection"] as const;
/** Favorite target kind — V1 `favorites.subject_type`. */
export type FavoriteSubjectType = (typeof FAVORITE_SUBJECT_TYPE)[number];

/** External-agent protocols. Source: V1__init.sql `agent_profiles.protocol` (line 922) and `external_principals.protocol` (935). `a2a` is stored but only `ucp`/`mcp` are live in v1 (API_CONTRACT §10, spec §149). */
export const AGENT_PROTOCOL = ["ucp", "mcp", "a2a"] as const;
/** External protocol — V1 `agent_profiles.protocol`; API_CONTRACT §10, spec §43-45/§149. */
export type AgentProtocol = (typeof AGENT_PROTOCOL)[number];

/** Agent-profile publication state. Source: V1__init.sql `agent_profiles.status` (line 927). */
export const PROFILE_STATUS = ["draft", "published", "revoked"] as const;
/** Published profile state — V1 `agent_profiles.status`; API_CONTRACT §10. */
export type ProfileStatus = (typeof PROFILE_STATUS)[number];

/** UCP capability ids served from `/.well-known/ucp`. API_CONTRACT §10 `capabilities[]`; spec §43. Values mirror the MCP tool surface (§10) plus profile discovery. */
export const UCP_CAPABILITY = [
  "discovery",
  "search",
  "merchant_profile",
  "product_catalog",
  "availability",
  "cart",
  "reservation",
  "order_status",
  "checkout",
] as const;
/** Declared UCP capability — API_CONTRACT §10; spec §43. */
export type UcpCapability = (typeof UCP_CAPABILITY)[number];

/** JSON-RPC 2.0 error codes used on `/mcp`. API_CONTRACT §10; standard JSON-RPC constants. */
export const JSON_RPC_ERROR_CODE = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const satisfies Record<string, number>;
/** JSON-RPC error code — API_CONTRACT §10 `/mcp`. */
export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODE)[keyof typeof JSON_RPC_ERROR_CODE];

/** Audit actions. Source: V1__init.sql `audit_logs.action` (line 886). */
export const AUDIT_ACTION = [
  "login",
  "logout",
  "update_product",
  "publish_campaign",
  "refund",
  "delete_data",
  "tool_call",
  "permission_denied",
  "suspend_merchant",
  "moderation_resolve",
] as const;
/** Audit log action — V1 `audit_logs.action`; AGENT_CONTRACT §8 (every denial is logged), API_CONTRACT §9, spec §50/§106. (`suspend_merchant`/`moderation_resolve` cover the §9 admin writes.) */
export type AuditAction = (typeof AUDIT_ACTION)[number];

/* --------------------------------------------------------------------------------------------
 * HTTP envelope (API_CONTRACT §1)
 * ------------------------------------------------------------------------------------------ */

/**
 * Error codes with their HTTP status, exactly as tabulated in API_CONTRACT §1
 * ("Codes: validation_error(422) unauthorized(401) forbidden(403) not_found(404)
 * conflict(409) rate_limited(429) ai_unavailable(503) internal(500)").
 */
export const ERROR_CODE_STATUS = {
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  ai_unavailable: 503,
  internal: 500,
} as const satisfies Record<string, number>;

/** API error code — API_CONTRACT §1 error envelope. */
export type ErrorCode = keyof typeof ERROR_CODE_STATUS;

/** Ordered list of {@link ErrorCode}. */
export const ERROR_CODE = Object.keys(ERROR_CODE_STATUS) as [ErrorCode, ...ErrorCode[]];

/**
 * Ladder codes a caller may specialise by naming the resource that failed — DECISIONS D27.
 *
 * §1's table is the *status ladder*, not a closed vocabulary: `merchant_not_found` is a `not_found`, and a
 * client that has never heard of `slot_not_found` still lands on the same rung. Only these three qualify
 * because only they change what the user is offered next; `validation_error`, `rate_limited` and
 * `ai_unavailable` carry their whole meaning in `details`, so prefixing them would hide which `if/then`
 * branch of `error_envelope.json` applies.
 */
export const RESOURCE_ERROR_SUFFIX = ["not_found", "conflict", "forbidden"] as const;
/** Suffix a resource-qualified `error.code` must end with — DECISIONS D27. */
export type ResourceErrorSuffix = (typeof RESOURCE_ERROR_SUFFIX)[number];

/** SSE stream event names for `POST /ai/v1/chat` / `/api/v1/ai/search`. Source: API_CONTRACT §7 event list (verbatim) + spec §116. */
export const AI_STREAM_EVENT = ["status", "intent", "results", "summary", "done", "error"] as const;
/** SSE `event:` name — API_CONTRACT §7; spec §116. */
export type AiStreamEvent = (typeof AI_STREAM_EVENT)[number];

/** User-legible pipeline stages in `status` SSE events. Source: API_CONTRACT §7 stream (`understanding`, `searching`) extended with the §116 stages ("Comparing…", "Found N options…"). */
export const AI_STAGE = ["understanding", "searching", "retrieving", "verifying", "comparing", "ranking", "composing", "done"] as const;
/** SSE `status.stage` — API_CONTRACT §7; spec §116. */
export type AiStage = (typeof AI_STAGE)[number];

/* --------------------------------------------------------------------------------------------
 * Enum registry + schema bindings (consumed by scripts/validate_conformance.mjs)
 * ------------------------------------------------------------------------------------------ */

/**
 * Every runtime-enumerable value set in the package, keyed by its **TS type name**.
 * `scripts/validate_conformance.mjs` reads this registry to assert
 * `JSON Schema enum === TS union` (bindings in {@link SCHEMA_ENUM_BINDINGS}), so a value added
 * to a schema without its type — or the other way round — fails the build.
 */
export const NEXUS_ENUMS = {
  TenantStatus: TENANT_STATUS,
  UserRole: USER_ROLE,
  UserStatus: USER_STATUS,
  IdentityProvider: IDENTITY_PROVIDER,
  MerchantUserRole: MERCHANT_USER_ROLE,
  SubjectKind: SUBJECT_KIND,
  PermissionName: PERMISSION_NAME,
  ToolScope: TOOL_SCOPE,
  MerchantStatus: MERCHANT_STATUS,
  DataOrigin: DATA_ORIGIN,
  MembershipPlan: MEMBERSHIP_PLAN,
  CategoryKind: CATEGORY_KIND,
  CardType: CARD_TYPE,
  CardActionType: CARD_ACTION_TYPE,
  OfferingKind: OFFERING_KIND,
  OfferingStatus: OFFERING_STATUS,
  PriceModel: PRICE_MODEL,
  PriceSource: PRICE_SOURCE,
  ResourcePoolKind: RESOURCE_POOL_KIND,
  FactSource: FACT_SOURCE,
  FactSubjectType: FACT_SUBJECT_TYPE,
  FactAttribute: FACT_ATTRIBUTE,
  AvailabilityStatus: AVAILABILITY_STATUS,
  TrustSignalKind: TRUST_SIGNAL_KIND,
  Severity: SEVERITY,
  TrustSignalStatus: TRUST_SIGNAL_STATUS,
  ModerationSubjectType: MODERATION_SUBJECT_TYPE,
  ModerationAutoAction: MODERATION_AUTO_ACTION,
  ModerationStatus: MODERATION_STATUS,
  ReservationStatus: RESERVATION_STATUS,
  ReservationSource: RESERVATION_SOURCE,
  CartStatus: CART_STATUS,
  CartItemKind: CART_ITEM_KIND,
  OrderStatus: ORDER_STATUS,
  OrderFulfillment: ORDER_FULFILLMENT,
  PaymentProvider: PAYMENT_PROVIDER,
  PaymentStatus: PAYMENT_STATUS,
  RefundStatus: REFUND_STATUS,
  ReviewStatus: REVIEW_STATUS,
  ReviewDataOrigin: REVIEW_DATA_ORIGIN,
  ReviewSort: REVIEW_SORT,
  ConversationChannel: CONVERSATION_CHANNEL,
  ConversationMode: CONVERSATION_MODE,
  ConversationStatus: CONVERSATION_STATUS,
  SenderType: SENDER_TYPE,
  MessageRole: MESSAGE_ROLE,
  MessageContentType: MESSAGE_CONTENT_TYPE,
  HandoffReason: HANDOFF_REASON,
  HandoffStatus: HANDOFF_STATUS,
  IntentKind: INTENT_KIND,
  LocationRefType: LOCATION_REF_TYPE,
  TimeRefType: TIME_REF_TYPE,
  BudgetUnit: BUDGET_UNIT,
  SortPreference: SORT_PREFERENCE,
  UrgencyLevel: URGENCY_LEVEL,
  IntentUnknownField: INTENT_UNKNOWN_FIELD,
  SupportedLocale: SUPPORTED_LOCALE,
  SearchStrategy: SEARCH_STRATEGY,
  RankingFactor: RANKING_FACTOR,
  ExplanationLabel: EXPLANATION_LABEL,
  FacetKind: FACET_KIND,
  FeedbackSignal: FEEDBACK_SIGNAL,
  FeedbackSubjectType: FEEDBACK_SUBJECT_TYPE,
  DocumentKind: DOCUMENT_KIND,
  DocumentStatus: DOCUMENT_STATUS,
  ImportJobStatus: IMPORT_JOB_STATUS,
  ImportSourceType: IMPORT_SOURCE_TYPE,
  AgentName: AGENT_NAME,
  AgentKind: AGENT_KIND,
  ToolName: TOOL_NAME,
  McpToolName: MCP_TOOL_NAME,
  CostClass: COST_CLASS,
  FallbackKind: FALLBACK_KIND,
  AgentRunStatus: AGENT_RUN_STATUS,
  PlanStepMode: PLAN_STEP_MODE,
  TaskClass: TASK_CLASS,
  LlmProvider: LLM_PROVIDER,
  LlmPurpose: LLM_PURPOSE,
  LlmCallStatus: LLM_CALL_STATUS,
  EvalSuiteName: EVAL_SUITE,
  EventName: EVENT_NAME,
  NorthStarConversionEvent: NORTH_STAR_CONVERSION_EVENT,
  ActorType: ACTOR_TYPE,
  EventSubjectType: EVENT_SUBJECT_TYPE,
  GeoPrecision: GEO_PRECISION,
  DeviceClass: DEVICE_CLASS,
  NotificationAudience: NOTIFICATION_AUDIENCE,
  NotificationChannel: NOTIFICATION_CHANNEL,
  NotificationStatus: NOTIFICATION_STATUS,
  CampaignChannel: CAMPAIGN_CHANNEL,
  CampaignStatus: CAMPAIGN_STATUS,
  CampaignGenerator: CAMPAIGN_GENERATOR,
  CouponKind: COUPON_KIND,
  CouponStatus: COUPON_STATUS,
  CollectionKind: COLLECTION_KIND,
  Visibility: VISIBILITY,
  ReferralKind: REFERRAL_KIND,
  ReferrerType: REFERRER_TYPE,
  ReferralStatus: REFERRAL_STATUS,
  SeoPageKind: SEO_PAGE_KIND,
  SeoPageStatus: SEO_PAGE_STATUS,
  PreferenceKind: PREFERENCE_KIND,
  PreferenceSource: PREFERENCE_SOURCE,
  PreferenceScope: PREFERENCE_SCOPE,
  FavoriteSubjectType: FAVORITE_SUBJECT_TYPE,
  AgentProtocol: AGENT_PROTOCOL,
  ProfileStatus: PROFILE_STATUS,
  UcpCapability: UCP_CAPABILITY,
  AuditAction: AUDIT_ACTION,
  ErrorCode: ERROR_CODE,
  ResourceErrorSuffix: RESOURCE_ERROR_SUFFIX,
  AiStreamEvent: AI_STREAM_EVENT,
  AiStage: AI_STAGE,
} as const satisfies Record<string, readonly string[]>;

/** TS type name of any registered enum. */
export type NexusEnumName = keyof typeof NEXUS_ENUMS;

/**
 * Which schema property must equal which TS enum. Keyed by schema file basename
 * (`src/schemas/<name>.json`) → `{ property path → NEXUS_ENUMS key }`.
 *
 * A property path is dot-separated, and a `[]` suffix on a segment means "the array items of
 * that property" (e.g. `actions[].type` is `EntityCard.actions[*].type`).
 * `scripts/validate_conformance.mjs` resolves each path through `$ref`, `definitions/$defs`,
 * `oneOf`/`anyOf`/`allOf` and `items`, then compares **every** `enum` it finds at that node with
 * `NEXUS_ENUMS[name]` — so a nullable wrapper (`anyOf: [enum, null]`) is still checked, and a
 * property bound to the wrong vocabulary (e.g. `availability.status` vs `offering.status`) fails.
 */
export const SCHEMA_ENUM_BINDINGS = {
  intent: {
    intent: "IntentKind",
    sort_preference: "SortPreference",
    urgency: "UrgencyLevel",
    "budget.per": "BudgetUnit",
    "location.type": "LocationRefType",
    "time.type": "TimeRefType",
    language: "SupportedLocale",
    "unknowns[]": "IntentUnknownField",
  },
  entity_card: {
    card_type: "CardType",
    "price.model": "PriceModel",
    "availability.status": "AvailabilityStatus",
    "actions[].type": "CardActionType",
  },
  event: {
    name: "EventName",
    actor_type: "ActorType",
    subject_type: "EventSubjectType",
    "context.geo_precision": "GeoPrecision",
    "context.device": "DeviceClass",
    "context.locale": "SupportedLocale",
  },
  tool_spec: {
    name: "ToolName",
    permission: "PermissionName",
    cost_class: "CostClass",
    "scopes[]": "ToolScope",
    fallback: "FallbackKind",
    task_class: "TaskClass",
    "agents[]": "AgentName",
  },
  fact: {
    source: "FactSource",
    subject_type: "FactSubjectType",
  },
  error_envelope: {
    "error.code": "ErrorCode",
  },
} as const satisfies Record<string, Record<string, NexusEnumName>>;


/**
 * CONTRACT NOTES — divergences found while mirroring the three authoritative files, and what
 * this package chose. All of them are `text` columns without CHECK constraints in
 * `infra/db/V1__init.sql`, so no migration is blocked by these choices.
 *
 * 1. `events.name` (V1 line 768) lists 13 names; AGENT_CONTRACT §10 requires 17.
 *    → chose AGENT §10 ({@link EVENT_NAME}); the SQL comment is stale, not a constraint.
 * 2. AGENT_CONTRACT §10 `subject_type` names only `merchant|offering|search_result|conversation`,
 *    yet the same section requires `campaign_publish`, `reserve`, `checkout`, `purchase`,
 *    `agent_run` events whose subject cannot be one of those four.
 *    → chose the superset {@link EVENT_SUBJECT_TYPE}; schema allows it, still snake_case-only.
 * 3. AGENT_CONTRACT §9 task classes `classify/route` and `reason/plan` embed a slash.
 *    → canonicalised to `classify_route` / `reason_plan` in {@link TASK_CLASS}.
 * 4. API_CONTRACT §7.1 shows `"urgency": "normal"` without enumerating the domain.
 *    → closed as `low|normal|high` ({@link URGENCY_LEVEL}); nullable in `Intent`, never defaulted.
 * 5. `agent_runs.agent` (V1 line 808) says `fraud`; AGENT_CONTRACT §1 says `fraud_trust` and
 *    lists five agents missing from the SQL comment. → chose AGENT §1 ({@link AGENT_NAME}).
 * 6. `offerings.price_source` uses `estimated` where `facts.source` uses `inferred`.
 *    → kept as two vocabularies ({@link PRICE_SOURCE} / {@link FACT_SOURCE}).
 * 7. API_CONTRACT §2 names the fact's wire field `fact_id`; V1__init.sql `facts.id` (line 538)
 *    names the column `id`. → the wire shape wins for transports (`Fact.fact_id` in `src/fact.ts`,
 *    `src/schemas/fact.json`); the platform layer maps `id → fact_id` on serialisation.
 * 8. API_CONTRACT §2 defines `OpeningState` with `as_of` + `source_fact_id`, yet the `EntityCard`
 *    example in the same section renders `"open": { "is_open": true, "text": "…" }`.
 *    → `src/schemas/fact.json#/$defs/OpeningState` keeps the strict 5-field object (mirrored by
 *    the `OpeningState` interface in `src/fact.ts`); `entity_card.json#/$defs/CardOpeningState`
 *    is the relaxed projection, and the conformance rule
 *    `entity_card_rendered_value_backed` still refuses to render a verdict without `as_of` and a
 *    cited `source_fact_id` (AGENT_CONTRACT §4/§5).
 * 9. API_CONTRACT §1's error example uses `"code": "merchant_not_found"`, which is not one of the
 *    eight codes §1 enumerates. → **resolved by DECISIONS D27**: the eight are the status ladder, and a
 *    code may specialise `not_found|conflict|forbidden` by prefixing the resource (`RESOURCE_ERROR_SUFFIX`
 *    above, `ladderErrorCode` in `src/errors.ts`). The live 404 the first conformance run captured is the
 *    evidence — 22 such codes ship in the platform and `apps/web` branches on the family.
 * 10. AGENT_CONTRACT §5 gives a TTL for `review_summary` and `popularity`, but V1 line 542's
 *    `facts.attribute` comment lists neither — so the two most-cache-sensitive claims on a card
 *    (「4.6 分，128 条评价」and「本周热门」) had no attribute to be stored under, and `apps/web`
 *    already seeds a `review_summary` fact. → {@link FACT_ATTRIBUTE} is the superset; `src/tests/
 *    enums.test.ts` asserts every `FRESHNESS_TTL_SECONDS` key is in it, which is the invariant that
 *    makes §20's table expressible. The column is free text, so no migration is needed.
 */
