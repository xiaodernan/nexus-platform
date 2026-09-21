/**
 * `createClient` — the single entry point. Wires the transport to every namespaced
 * resource and applies the automatic behaviors (auth injection, tenant/locale,
 * request id, idempotency, retry/timeout, cursor paging, SSE, event batching).
 */
import { HttpClient, type HttpInit } from "./http.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import { AuthResource } from "./resources/auth.js";
import { MeResource } from "./resources/me.js";
import { MerchantsResource } from "./resources/merchants.js";
import { DiscoveryResource } from "./resources/discovery.js";
import { MerchantWorkspaceResource } from "./resources/merchant.js";
import { CartsResource } from "./resources/carts.js";
import { OrdersResource } from "./resources/orders.js";
import { ReservationsResource } from "./resources/reservations.js";
import { PaymentsResource } from "./resources/payments.js";
import { ReviewsResource } from "./resources/reviews.js";
import { ConversationsResource } from "./resources/conversations.js";
import { EventsResource } from "./resources/events.js";
import { CollectionsResource } from "./resources/collections.js";
import { AdminResource } from "./resources/admin.js";
import { AiResource } from "./resources/ai.js";

export interface CreateClientOptions {
  /** Origin of the NEXUS gateway, e.g. `https://api.example.hk`. No trailing slash needed. */
  baseUrl: string;
  /** Bearer JWT (or a merchant API token). Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Merchant API key. Sent as `X-API-Key`. */
  apiKey?: string;
  /** Tenant, e.g. `hong-kong`. Sent as `X-Tenant` (contract §1). */
  tenant?: string;
  /** Locale, e.g. `zh-HK`. Sent as `Accept-Language`. */
  locale?: string;
  /** Per-request timeout (ms). Default 10000. `0` disables. */
  timeoutMs?: number;
  /** Max retries for safe/idempotent requests. Default 2. */
  retries?: number;
  /** Base for exponential backoff (ms). Default 250. */
  backoffBaseMs?: number;
  /** Upper bound for a single backoff step (ms). Default 8000. */
  backoffCapMs?: number;
  /** Inject a `fetch` (tests / polyfills). Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Replay cache for caller-supplied Idempotency-Keys. Defaults to an in-memory store. */
  idempotencyStore?: IdempotencyStore;
  /** Cookie policy for session auth. Default `include`. */
  credentials?: RequestCredentials;
  /** Headers merged into every request (a `X-Request-Id` here pins the id). */
  headers?: Record<string, string>;
}

export class NexusClient {
  readonly http: HttpClient;
  readonly auth: AuthResource;
  readonly me: MeResource;
  readonly merchants: MerchantsResource;
  readonly discovery: DiscoveryResource;
  readonly merchant: MerchantWorkspaceResource;
  readonly carts: CartsResource;
  readonly orders: OrdersResource;
  readonly reservations: ReservationsResource;
  readonly payments: PaymentsResource;
  readonly reviews: ReviewsResource;
  readonly conversations: ConversationsResource;
  readonly events: EventsResource;
  readonly collections: CollectionsResource;
  readonly admin: AdminResource;
  readonly ai: AiResource;

  constructor(options: CreateClientOptions) {
    const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    const fetchImpl = options.fetch ?? globalFetch;
    if (!fetchImpl) {
      throw new Error("@nexus/sdk needs a global `fetch` (Node >= 18 / modern browser) or an explicit `fetch` option.");
    }

    const init: HttpInit = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      token: options.token,
      apiKey: options.apiKey,
      tenant: options.tenant,
      locale: options.locale,
      timeoutMs: options.timeoutMs ?? 10_000,
      retries: options.retries ?? 2,
      backoffBaseMs: options.backoffBaseMs ?? 250,
      backoffCapMs: options.backoffCapMs ?? 8_000,
      fetch: fetchImpl,
      idempotencyStore: options.idempotencyStore ?? new InMemoryIdempotencyStore(),
      credentials: options.credentials ?? "include",
      defaultHeaders: { ...options.headers },
    };

    this.http = new HttpClient(init);
    this.auth = new AuthResource(this.http);
    this.me = new MeResource(this.http);
    this.merchants = new MerchantsResource(this.http);
    this.discovery = new DiscoveryResource(this.http);
    this.merchant = new MerchantWorkspaceResource(this.http);
    this.carts = new CartsResource(this.http);
    this.orders = new OrdersResource(this.http);
    this.reservations = new ReservationsResource(this.http);
    this.payments = new PaymentsResource(this.http);
    this.reviews = new ReviewsResource(this.http);
    this.conversations = new ConversationsResource(this.http);
    this.events = new EventsResource(this.http);
    this.collections = new CollectionsResource(this.http);
    this.admin = new AdminResource(this.http);
    this.ai = new AiResource(this.http);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** Adopt/replace the bearer token after you obtained one out of band. */
  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }
}

/** Create a configured {@link NexusClient}. */
export function createClient(options: CreateClientOptions): NexusClient {
  return new NexusClient(options);
}
