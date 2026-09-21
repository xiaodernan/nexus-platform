/**
 * Commerce core: reservations, carts, orders, payments, refunds.
 *
 * Contract: API_CONTRACT §6 (Commerce table), §1 (`Idempotency-Key` required on checkout,
 * payment, reservation create, review create, campaign publish), §0 (AI service mutates these
 * only through platform HTTP with a scoped token).
 * Tables: V1 `reservations` (294-315), `carts` (318-330), `cart_items` (332-346),
 * `orders` (348-368), `order_items` (370-379), `payments` (381-395), `refunds` (397-407).
 * Spec: §40 Reservation Architecture, §41 Cart, §42 Checkout ("no card data"), §20 freshness, §103 caching.
 */

import type {
  CartItemKind,
  CartStatus,
  OrderFulfillment,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  PriceSource,
  RefundStatus,
  ReservationSource,
  ReservationStatus,
} from "./enums.js";
import type { ContactInfo, IsoDateTime, Money, Nullable, Timestamps, Uuid } from "./common.js";
import type { PriceQuote } from "./merchant.js";

/* enum unions used below are declared in enums.ts */

/**
 * A reservation. **Source: API_CONTRACT §6** (`POST /api/v1/reservations` → `201` with a code),
 * V1 `reservations`. Status transitions are guarded server-side (API §6 `PATCH`).
 */
export interface Reservation extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Human-readable code shown to the customer, e.g. `NX-RES-4F2K` — V1 `code` (UNIQUE). */
  code: string;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Customer; null for a walk-in created by the merchant — V1 `user_id`. */
  user_id: Uuid | null;
  /** Offering booked (a tasting menu, a class) — V1 `offering_id`. */
  offering_id: Uuid | null;
  /** Slot reserved — V1 `slot_id`; required by API §6 create body. */
  slot_id: Uuid | null;
  /** Party size — V1 `party_size smallint DEFAULT 2`. The *column* defaults; the wire type keeps null
   * meaning "user never said" (spec §8) and the create request marks it required. */
  party_size: number;
  /** Contact block — V1 `contact jsonb`. */
  contact: ContactInfo;
  /** Start instant — V1 `starts_at` (NOT NULL). */
  starts_at: IsoDateTime;
  /** End instant; null when the merchant does not publish durations — V1 `ends_at`. */
  ends_at: IsoDateTime | null;
  /** `pending|confirmed|cancelled|completed|no_show` — V1 `status`. */
  status: ReservationStatus;
  /** Quoted total; null until priced. Never fabricated (DECISIONS D6) — V1 `total_amount`. */
  total: Nullable<Money>;
  /** Notes from the customer — V1 `notes`. */
  notes: string | null;
  /** Channel it arrived on (`consumer|ai_agent|mcp|ucp|merchant`) — V1 `source`; API §10. */
  source: ReservationSource;
  /** Denormalised merchant name for list rows. */
  merchant_name?: string | null;
  /** Fact id behind the quoted total (AGENT §4). */
  price_fact_id?: Uuid | null;
}

/** `POST /api/v1/reservations` body. **Source: API_CONTRACT §6**
 * (`{merchant_id,offering_id?,slot_id,party_size,contact,notes}`) — `Idempotency-Key` required (API §1). */
export interface ReservationCreateRequest {
  /** Merchant — API §6. */
  merchant_id: Uuid;
  /** Optional offering — API §6. */
  offering_id?: Uuid | null;
  /** Chosen slot; must be live-unverified by the server (API §4 availability is no-cache) — API §6 `slot_id`. */
  slot_id: Uuid;
  /** Party size; required here — the AI may not guess it (spec §8, AGENT §1 `user_intent`). */
  party_size: number;
  /** Contact block — API §6. */
  contact: ContactInfo;
  /** Free-text notes — API §6. */
  notes?: string | null;
  /** Origin channel; defaults to `consumer` on the platform path — V1 `source`. */
  source?: ReservationSource;
}

/** `PATCH /api/v1/reservations/{id}` body (API_CONTRACT §6, guarded transitions). */
export interface ReservationPatch {
  /** Target state; illegal transitions come back as `conflict` 409 (API §1). */
  status?: ReservationStatus;
  /** New slot when rescheduling. */
  slot_id?: Uuid | null;
  /** New party size. */
  party_size?: number;
  /** Updated contact. */
  contact?: ContactInfo;
  /** Additional notes. */
  notes?: string | null;
  /** Reason, required for cancellations — logged to `audit_logs` (API §9). */
  reason?: string | null;
}

/**
 * A line in the universal cart. **Source: V1 `cart_items` (332-346)**; the CHECK at line 345
 * means exactly one of {@link offering_id} / {@link reservation_id} is set — a cart can hold
 * products, services, experiences *and* a reservation (API §6 `POST /carts/items`, spec §41).
 */
export interface CartItem {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Parent cart — V1 `cart_id`. */
  cart_id: Uuid;
  /** Product/service/experience line — V1 `offering_id`. */
  offering_id: Uuid | null;
  /** Reservation line — V1 `reservation_id`. */
  reservation_id: Uuid | null;
  /** `product|service|experience|reservation` — V1 `kind`. */
  kind: CartItemKind;
  /** Quantity — V1 `quantity` (default 1). */
  quantity: number;
  /** Server-priced unit price; the client value is never trusted (API §6 "server re-prices + TTL check"). */
  unit_price: Money;
  /** `unit_price × quantity`. */
  line_total: Money;
  /** Selected variants/add-ons — V1 `options jsonb`. */
  options: Record<string, unknown>;
  /** Provenance of the unit price — V1 `price_source`. */
  price_source: PriceSource;
  /** When the price was validated — V1 `priced_at`; compared against the AGENT §5 TTL before checkout. */
  priced_at: IsoDateTime;
  /** Staleness flag from `POST /carts/price-check`; must be surfaced, never silently charged (AGENT §5). */
  stale: boolean;
  /** Merchant grouping — V1 `carts.merchant_id` comment ("multi-merchant allowed"). */
  merchant_id?: Uuid | null;
  /** Display snapshot for the line (title/image) so the cart renders without extra fetches. */
  title?: string | null;
  /** @see title */
  image_url?: string | null;
  /** Backing fact for {@link unit_price} (AGENT §4). */
  fact_id?: Uuid | null;
}

/** A cart. **Source: API_CONTRACT §6** (`POST /carts` → cart, anonymous allowed with `session_id`;
 * `GET /carts/current`), V1 `carts` (318-330). */
export interface Cart extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid;
  /** Owner; null for an anonymous cart — V1 `user_id`. */
  user_id: Uuid | null;
  /** Anonymous session key — V1 `session_id`; API §6 "anonymous allowed". */
  session_id: string | null;
  /** Soft merchant grouping — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** `open|converted|abandoned` — V1 `status`. */
  status: CartStatus;
  /** Cart expiry — V1 `expires_at`. */
  expires_at: IsoDateTime | null;
  /** Lines — API §6. */
  items: CartItem[];
  /** Server-computed subtotal. */
  subtotal: Money;
  /** Applied discount total — mirrors V1 `orders.discount_total`. */
  discount_total: Money;
  /** Fees — mirrors V1 `orders.fee_total`. */
  fee_total: Money;
  /** Tax — mirrors V1 `orders.tax_total`. (HK has no GST/VAT; 0 is the honest default, spec §112.) */
  tax_total: Money;
  /** Grand total — mirrors V1 `orders.total`. */
  total: Money;
  /** Currency of every amount above — V1 `currency` default `HKD`. */
  currency: string;
  /** Applied coupon codes — V1 `coupons.code`. */
  coupons?: string[];
  /** Whether any line is stale; blocks silent checkout (AGENT §5). */
  has_stale_items?: boolean;
}

/** `POST /api/v1/carts/items` body (API_CONTRACT §6). */
export interface CartItemInput {
  /** Product/service/experience line — API §6 `offering_id`. */
  offering_id?: Uuid | null;
  /** Reservation line — API §6 `reservation_id`. */
  reservation_id?: Uuid | null;
  /** Quantity, ≥1 — API §6. */
  quantity?: number;
  /** Selected options — API §6. */
  options?: Record<string, unknown>;
}

/** `PATCH /api/v1/carts/items/{id}` body (API_CONTRACT §6). */
export interface CartItemPatch {
  /** New quantity. */
  quantity?: number;
  /** Replaced option selection. */
  options?: Record<string, unknown>;
}

/** `POST /api/v1/carts/price-check` response. **Source: API_CONTRACT §6** — "returns per-item
 * `stale` flags before checkout — never silently charge stale price (§20,§103)". */
export interface CartPriceCheckResult {
  /** Cart checked. */
  cart_id: Uuid;
  /** Per-line re-pricing. */
  items: Array<{ item_id: Uuid; quote: PriceQuote; new_unit_price: Money; changed: boolean }>;
  /** Recomputed totals. */
  subtotal: Money;
  /** @see subtotal */
  total: Money;
  /** True when the checkout must be re-confirmed by the user. */
  requires_confirmation: boolean;
  /** Instant the check ran. */
  checked_at: IsoDateTime;
}

/** A sold line, snapshotted at purchase time. **Source: V1 `order_items` (370-379).** */
export interface OrderItem {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Parent order — V1 `order_id`. */
  order_id: Uuid;
  /** Offering sold; null when the line was deleted afterwards — V1 `offering_id`. */
  offering_id: Uuid | null;
  /** Name captured at purchase — V1 `name_snapshot` (NOT NULL: history never rewrites itself). */
  name_snapshot: string;
  /** Quantity — V1 `quantity`. */
  quantity: number;
  /** Unit price at purchase — V1 `unit_price numeric(12,2)`. */
  unit_price: Money;
  /** Line total — V1 `total_price`. */
  total_price: Money;
  /** Option snapshot — V1 `options jsonb`. */
  options: Record<string, unknown>;
}

/**
 * An order. **Source: API_CONTRACT §6** (`GET /api/v1/orders/{id}` "status machine",
 * `POST /orders/{id}/cancel`), V1 `orders` (348-368).
 */
export interface Order extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Human code, e.g. `NX-ORD-8K3D` — V1 `code` (UNIQUE). */
  code: string;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Buyer; null for anonymous/guest — V1 `user_id`. */
  user_id: Uuid | null;
  /** `created|paid|preparing|completed|cancelled|refunded` — V1 `status`. */
  status: OrderStatus;
  /** `pickup|delivery|dine_in|reservation|virtual` — V1 `fulfillment`. */
  fulfillment: OrderFulfillment;
  /** Sum of line totals — V1 `subtotal`. */
  subtotal: Money;
  /** Discount applied — V1 `discount_total`. */
  discount_total: Money;
  /** Service/platform fees — V1 `fee_total`. */
  fee_total: Money;
  /** Tax — V1 `tax_total`. */
  tax_total: Money;
  /** Amount charged — V1 `total`; excluded from revenue when `cancelled|refunded` (V1 `v_merchant_funnel`). */
  total: Money;
  /** Contact block — V1 `contact jsonb`. */
  contact: ContactInfo;
  /** Free-form metadata (`source`, `utm`, `device`) — V1 `metadata jsonb`. */
  metadata: Record<string, unknown>;
  /** Purchased lines — V1 `order_items`. */
  items: OrderItem[];
  /** Payments attached — V1 `payments`. */
  payments?: Payment[];
  /** Reservation created alongside the order, if any — V1 `reservations.id`. */
  reservation_id?: Uuid | null;
  /** Idempotency key that produced the order — API §1/§6. */
  idempotency_key?: string | null;
}

/**
 * A payment attempt. **Source: V1 `payments` (381-395)**, API_CONTRACT §6
 * (`POST /payments/{order_id}/confirm`, `POST /webhooks/payments/{provider}`).
 * No card data is ever present in this shape — DECISIONS D5 / spec §42.
 */
export interface Payment {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Order being paid — V1 `order_id`. */
  order_id: Uuid;
  /** `demo|stripe|alipayhk|payme|hsbc` — V1 `provider`; `demo` must be badged (DECISIONS D6). */
  provider: PaymentProvider;
  /** Provider-side reference — V1 `provider_ref`. */
  provider_ref: string | null;
  /** Client-supplied dedupe key — V1 `idempotency_key` (UNIQUE), API §1. */
  idempotency_key: string;
  /** Amount captured/requested — V1 `amount`. */
  amount: Money;
  /** `pending|authorized|captured|failed|refunded|partially_refunded` — V1 `status`. */
  status: PaymentStatus;
  /** Reference to the client secret held in the secret store — V1 `client_secret_ref`; never the secret itself (spec §131). */
  client_secret_ref: string | null;
  /** Failure detail — V1 `failure_reason`. */
  failure_reason: string | null;
  /** Capture instant — V1 `captured_at`. */
  captured_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Last change — V1 `updated_at`. */
  updated_at: IsoDateTime;
  /** Refund rows — V1 `refunds`. */
  refunds?: Refund[];
}

/** A refund. **Source: V1 `refunds` (397-407)**; `refund_payment` is never in a default AI grant (AGENT §8). */
export interface Refund {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Payment refunded — V1 `payment_id`. */
  payment_id: Uuid;
  /** Amount — V1 `amount`. */
  amount: Money;
  /** Reason — V1 `reason`. */
  reason: string | null;
  /** `pending|succeeded|failed` — V1 `status`. */
  status: RefundStatus;
  /** Human approver; a model may not self-authorise — V1 `approved_by`, AGENT §8. */
  approved_by: Uuid | null;
  /** Provider reference — V1 `provider_ref`. */
  provider_ref: string | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** `POST /api/v1/carts/checkout` response. **Source: API_CONTRACT §6** — `→ {order, payment_intent}`. */
export interface CheckoutResult {
  /** Created order. */
  order: Order;
  /** Provider payment-intent payload for the client SDK; `provider:"demo"` means no real charge. */
  payment_intent: PaymentIntent;
  /** Reservation created in the same transaction, when the cart held one (spec §41). */
  reservation?: Reservation | null;
  /** Idempotency key echoed back so a retry is safe — API §1. */
  idempotency_key: string;
}

/** Payment intent handed to the client. Source: API_CONTRACT §6 `{order, payment_intent}`. */
export interface PaymentIntent {
  /** Payment row this intent will settle into — V1 `payments.id`. */
  payment_id: Uuid;
  /** Provider id — V1 `provider`. */
  provider: PaymentProvider;
  /** Amount to authorise — V1 `amount`. */
  amount: Money;
  /** Client-side publishable reference; never a secret (spec §131). */
  client_secret_ref: string | null;
  /** Provider redirect/webhook URL for confirmation. */
  redirect_url: string | null;
  /** True for the `demo` provider — the UI must show the demo badge (DECISIONS D6). */
  demo: boolean;
}

/** `POST /api/v1/payments/{order_id}/confirm` body (API_CONTRACT §6, demo provider). */
export interface PaymentConfirmRequest {
  /** Provider assertion; `demo` accepts instantly. */
  provider: PaymentProvider;
  /** Provider reference produced by the client SDK — V1 `provider_ref`. */
  provider_ref?: string | null;
  /** Must match the checkout key — V1 `payments.idempotency_key`. */
  idempotency_key: string;
  /** Amount the client believes was charged; a mismatch is a `conflict` (API §1). */
  amount: Money;
}

/** Normalised webhook body from a payment provider (API_CONTRACT §6 `/webhooks/payments/{provider}`: signature-verified, idempotent). */
export interface PaymentWebhookEvent {
  /** Provider id — URL path segment. */
  provider: PaymentProvider;
  /** Provider event id, used as the idempotency key — API §6 "idempotent". */
  provider_event_id: string;
  /** Provider payment reference — V1 `payments.provider_ref`. */
  provider_ref: string | null;
  /** Local order id resolved from metadata. */
  order_id: Uuid | null;
  /** Mapped status — V1 `payments.status`. */
  status: PaymentStatus;
  /** Amount as reported by the provider. */
  amount: Nullable<Money>;
  /** Raw event body, retained for audit — V1 `audit_logs.after`. */
  raw: Record<string, unknown>;
  /** Signature verification result; unverified events are rejected before this shape exists. */
  signature_valid: boolean;
}
