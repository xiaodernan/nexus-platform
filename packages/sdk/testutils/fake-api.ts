/**
 * A tiny in-process `http.createServer` fake API implementing just enough of
 * docs/API_CONTRACT.md for the SDK's unit tests: auth, cursor list, 429-then-
 * success, the error envelope, checkout/reservation idempotency, an SSE stream
 * that can error or drop mid-way, and event ingestion with server-side dedup.
 *
 * Not under `test/` so Node's test runner never treats it as a test file.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type StreamScenario = "ok" | "error" | "drop" | "server";

export interface FakeState {
  requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }>;
  meHeaders: Record<string, string | string[] | undefined>;
  rateLimitedCalls: number;
  loginCalls: number;
  checkoutRequests: number;
  checkoutCreations: number;
  reserveRequests: number;
  aiSearchCalls: number;
  aiStreamCalls: number;
  eventIngestCalls: number;
  importPolls: number;
  approvePublishCalls: number;
  seenEventIds: string[];
  seenIdempotencyKeys: string[];
  scenario: StreamScenario;
}

export interface FakeApi {
  baseUrl: string;
  state: FakeState;
  close(): Promise<void>;
}

function freshState(): FakeState {
  return {
    requests: [],
    meHeaders: {},
    rateLimitedCalls: 0,
    loginCalls: 0,
    checkoutRequests: 0,
    checkoutCreations: 0,
    reserveRequests: 0,
    aiSearchCalls: 0,
    aiStreamCalls: 0,
    eventIngestCalls: 0,
    importPolls: 0,
    approvePublishCalls: 0,
    seenEventIds: [],
    seenIdempotencyKeys: [],
    scenario: "ok",
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function errorEnvelope(res: ServerResponse, status: number, code: string, message: string, requestId: string, details: Record<string, unknown> = {}): void {
  json(res, status, { error: { code, message, details, request_id: requestId } });
}

export async function startFakeApi(): Promise<FakeApi> {
  const state = freshState();
  const seenIdempotency = new Map<string, unknown>();
  const seenEventIds = new Set<string>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const rid = (req.headers["x-request-id"] as string | undefined) ?? "srv-unknown";
    const body = await readBody(req);
    state.requests.push({ method: req.method ?? "GET", path, headers: req.headers, body });
    const idem = req.headers["idempotency-key"] as string | undefined;
    if (idem) state.seenIdempotencyKeys.push(idem);

    // --- auth ---
    if (req.method === "POST" && path === "/api/v1/auth/login") {
      state.loginCalls++;
      return json(res, 200, { user: { id: "usr_1", email: "a@b.example" }, access_token: "tok_demo_access", refresh_token: "tok_demo_refresh" }, { "x-request-id": rid });
    }

    // --- me (requires bearer) ---
    if (path === "/api/v1/me" && (req.method === "GET" || req.method === "PATCH")) {
      state.meHeaders = req.headers;
      const auth = req.headers["authorization"];
      if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
        return errorEnvelope(res, 401, "unauthorized", "missing bearer", rid);
      }
      return json(res, req.method === "PATCH" ? 200 : 200, { user: { id: "usr_1", display_name: (body as { display_name?: string })?.display_name ?? "Ada" }, memberships: [] }, { "x-request-id": rid });
    }

    // --- cursor list ---
    if (req.method === "GET" && path === "/api/v1/merchants") {
      const cursor = url.searchParams.get("cursor");
      const tenant = req.headers["x-tenant"];
      if (cursor === "c1") {
        return json(res, 200, { items: [{ id: "m3", name: "Cafe C", flags: { demo: true } }], next_cursor: null, total_estimate: 3 }, { "x-request-id": rid, "x-tenant-echo": String(tenant ?? "") });
      }
      if (cursor) {
        return json(res, 200, { items: [], next_cursor: null, total_estimate: 3 }, { "x-request-id": rid });
      }
      return json(res, 200, { items: [{ id: "m1", name: "Merchant A", flags: { demo: true } }, { id: "m2", name: "Merchant B", flags: { demo: true } }], next_cursor: "c1", total_estimate: 3 }, { "x-request-id": rid });
    }

    // --- 429 then success ---
    if (req.method === "GET" && path === "/api/v1/rate-limited") {
      state.rateLimitedCalls++;
      if (state.rateLimitedCalls === 1) {
        return errorEnvelope(res, 429, "rate_limited", "slow down", rid);
      }
      return json(res, 200, { ok: true }, { "x-request-id": rid });
    }
    // Always 429 (to prove non-safe POST is NOT retried).
    if (req.method === "POST" && path === "/api/v1/always-429") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0", "x-ratelimit-remaining": "0", "x-request-id": rid });
      return res.end(JSON.stringify({ error: { code: "rate_limited", message: "nope", details: {}, request_id: rid } }));
    }

    // --- error envelope ---
    if (req.method === "GET" && path === "/api/v1/boom") {
      return errorEnvelope(res, 404, "merchant_not_found", "no such merchant", rid, { merchant_id: "nope" });
    }

    // --- timeout helper ---
    if (req.method === "GET" && path === "/api/v1/slow") {
      const delay = Number(url.searchParams.get("delay") ?? "250");
      setTimeout(() => json(res, 200, { ok: true }, { "x-request-id": rid }), delay);
      return;
    }

    // --- checkout (idempotency required, server dedup by key) ---
    if (req.method === "POST" && path === "/api/v1/carts/checkout") {
      state.checkoutRequests++;
      if (!idem) return errorEnvelope(res, 400, "validation_error", "Idempotency-Key required", rid);
      if (seenIdempotency.has(idem)) {
        return json(res, 200, seenIdempotency.get(idem), { "x-request-id": rid });
      }
      state.checkoutCreations++;
      const result = { order: { id: `ord_${state.checkoutCreations}`, status: "pending_payment" }, payment_intent: { id: "pi_1", client_secret: "s" } };
      seenIdempotency.set(idem, result);
      return json(res, 201, result, { "x-request-id": rid });
    }

    // --- reservation create ---
    if (req.method === "POST" && path === "/api/v1/reservations") {
      state.reserveRequests++;
      if (!idem) return errorEnvelope(res, 400, "validation_error", "Idempotency-Key required", rid);
      return json(res, 201, { reservation_id: "res_1", status: "confirmed", code: "RK7Q2" }, { "x-request-id": rid });
    }

    // --- event ingest with server dedup ---
    if (req.method === "POST" && path === "/api/v1/events") {
      state.eventIngestCalls++;
      const events = (body as { events?: Array<{ event_id: string }> })?.events ?? [];
      let accepted = 0;
      for (const ev of events) {
        if (ev && typeof ev.event_id === "string" && !seenEventIds.has(ev.event_id)) {
          seenEventIds.add(ev.event_id);
          state.seenEventIds.push(ev.event_id);
          accepted++;
        }
      }
      return json(res, 202, { accepted, received: events.length }, { "x-request-id": rid });
    }

    // --- merchant AI import: create → queued, poll → done with proposals (§5.1) ---
    if (req.method === "POST" && path === "/api/v1/merchant/imports") {
      return json(res, 202, { job_id: "job_1", status: "queued" }, { "x-request-id": rid });
    }
    if (req.method === "GET" && path.startsWith("/api/v1/merchant/imports/")) {
      state.importPolls++;
      if (state.importPolls < 2) {
        return json(res, 200, { job_id: "job_1", status: "running" }, { "x-request-id": rid });
      }
      return json(res, 200, { job_id: "job_1", status: "done", proposals: [{ offering_draft: { name: "Drinks Tea", price: { amount: "42.00", currency: "HKD" } }, evidence_fact_ids: ["f1"], confidence: 0.9 }] }, { "x-request-id": rid });
    }
    if (req.method === "GET" && path === "/api/v1/merchant/analytics") {
      return json(res, 200, { metrics: [{ metric: "views", value: 42 }] }, { "x-request-id": rid });
    }

    // --- campaign publish: explicit human action + Idempotency-Key (§27) ---
    if (req.method === "POST" && path.endsWith("/approve-publish")) {
      state.approvePublishCalls++;
      if (!idem) return errorEnvelope(res, 400, "validation_error", "Idempotency-Key required", rid);
      return json(res, 200, { id: "camp_1", status: "published" }, { "x-request-id": rid });
    }

    // --- tool registry manifest (§11) ---
    if (req.method === "GET" && path === "/ai/v1/tools") {
      return json(res, 200, { tools: [{ name: "search_merchants", permission: "read_merchants", side_effect: false, version: "1" }, { name: "create_reservation", permission: "create_reservation", side_effect: true, version: "1" }] }, { "x-request-id": rid });
    }

    // --- deterministic AI search (fallback bottom rung) ---
    if (req.method === "POST" && path === "/ai/v1/search") {
      state.aiSearchCalls++;
      return json(res, 200, { items: [{ card_type: "merchant", id: "m_det", title: "Deterministic A", flags: { demo: true } }], facets: {}, took_ms: 7, strategy: "hybrid_v1", degraded: false }, { "x-request-id": rid });
    }

    // --- AI search SSE stream ---
    if (req.method === "POST" && path === "/ai/v1/search/stream") {
      state.aiStreamCalls++;
      const scenario = ((body as { scenario?: StreamScenario })?.scenario) ?? state.scenario;
      const headers: Record<string, string> = { "content-type": "text/event-stream", "cache-control": "no-store", "x-request-id": rid };
      if (scenario === "server") headers["x-nexus-degraded"] = "true";
      res.writeHead(200, headers);
      const frame = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      frame("status", { stage: "understanding", text: "理解需求…" });
      frame("intent", { raw_query: "test", intent: "discover_merchant" });
      frame("status", { stage: "searching", text: "搜索附近商户…" });
      frame("results", { set_id: "set_1", items: [{ card_type: "merchant", id: "m_ai", title: "AI A", flags: { demo: true } }] });
      frame("summary", { text: "找到 1 个符合条件的选择", citations: ["fact_1"] });

      if (scenario === "error") {
        frame("error", { code: "ai_unavailable", message: "llm down", request_id: rid });
        res.end();
        return;
      }
      if (scenario === "drop") {
        // Kill the socket mid-stream to simulate a transport failure.
        res.write(": partial\n\n");
        setImmediate(() => res.destroy());
        return;
      }
      frame("done", { agent_run_id: "run_1", latency_ms: 812, cost_usd: 0.0042, degraded: scenario === "server" });
      res.end();
      return;
    }

    return errorEnvelope(res, 404, "not_found", `no route ${req.method} ${path}`, rid);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    state,
    close(): Promise<void> {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
