/**
 * @nexus/sdk — a zero-dependency, fetch-based TypeScript client for the NEXUS
 * platform (`/api/v1/**`) and AI (`/ai/v1/**`) surfaces. Node + browser, ESM.
 *
 * See README.md for examples. All wire types are snake_case per docs/API_CONTRACT.md.
 */

// Wire + domain types (contract §1-§7, §10).
export * from "./types.js";

// Errors.
export { NexusApiError, statusToCode } from "./errors.js";

// Client factory.
export { createClient, NexusClient } from "./client.js";
export type { CreateClientOptions } from "./client.js";

// Transport (re-exported for advanced usage / typing helper functions).
export type { HttpClient, RequestSpec, HttpInit, PagedQuery } from "./http.js";

// Idempotency store.
export { InMemoryIdempotencyStore, resolveIdempotencyKey } from "./idempotency.js";
export type { IdempotencyStore, IdempotencyRecord } from "./idempotency.js";

// Cursor pagination.
export { PagedRequest, normalizePage } from "./cursor.js";

// Event batching emitter.
export { EventTracker, batchIdempotencyKey } from "./events.js";
export type { EventTrackerOptions, EventSender } from "./events.js";

// SSE.
export { parseSseStream } from "./sse.js";
export type { SseFrame } from "./sse.js";

// Resource classes + their public input/result types (for annotation + narrowing).
export { AuthResource } from "./resources/auth.js";
export type { RegisterInput, LoginInput, OAuthInput, DemoRole } from "./resources/auth.js";
export { MeResource } from "./resources/me.js";
export type { MeProfile } from "./resources/me.js";
export { MerchantsResource } from "./resources/merchants.js";
export type { MerchantListQuery, MerchantSummary, MerchantDetail, AvailabilityQuery, AvailabilitySlot } from "./resources/merchants.js";
export { DiscoveryResource } from "./resources/discovery.js";
export type { GeoQuery, MapCluster } from "./resources/discovery.js";
export { MerchantWorkspaceResource } from "./resources/merchant.js";
export type { CreateImportInput, ImportJob, ImportProposal, ImportSource } from "./resources/merchant.js";
export { CartsResource } from "./resources/carts.js";
export type { CartItemInput, CheckoutResult, PriceCheckResult } from "./resources/carts.js";
export { OrdersResource } from "./resources/orders.js";
export { ReservationsResource } from "./resources/reservations.js";
export type { CreateReservationInput, Reservation } from "./resources/reservations.js";
export { PaymentsResource } from "./resources/payments.js";
export { ReviewsResource } from "./resources/reviews.js";
export { ConversationsResource } from "./resources/conversations.js";
export type { CreateConversationInput } from "./resources/conversations.js";
export { EventsResource } from "./resources/events.js";
export { CollectionsResource } from "./resources/collections.js";
export { AdminResource } from "./resources/admin.js";
export { AiResource, frameToEvent } from "./resources/ai.js";
export type { AiSearchInput, AiRequestContext, StreamOptions } from "./resources/ai.js";

import { NexusApiError as _NexusApiError } from "./errors.js";
import type { NexusApiError } from "./errors.js";

/** Type-guard for catching SDK errors without importing the class. */
export function isNexusApiError(err: unknown): err is NexusApiError {
  return err instanceof _NexusApiError;
}

/** SDK version, kept in sync with package.json by hand (no build-time codegen dep). */
export const SDK_VERSION = "0.1.0";
