/**
 * `ai` — the AI-service surface (contract §7): deterministic search, query
 * understanding, recommendation, comparison, RAG retrieval, feedback, the tool
 * registry, and the streaming AI-search consumer.
 *
 * Streaming follows the failure ladder (§105): if the SSE stream never opens,
 * errors mid-flight, or emits an `event: error`, the SDK falls back to the
 * deterministic `POST /ai/v1/search` and emits an explicit `degraded` event.
 * It NEVER fabricates a successful AI result — a failed fallback throws rather
 * than pretending (DECISIONS D6).
 */
import { Resource } from "./_base.js";
import { NexusApiError } from "../errors.js";
import { parseSseStream, type SseFrame } from "../sse.js";
import type { AiSearchResult, AiStreamEvent, EntityCard, Intent, Json } from "../types.js";
import { errorMessage } from "../util.js";

export interface AiRequestContext {
  geo?: unknown;
  now?: string;
  locale?: string;
  party_size?: number;
  [key: string]: unknown;
}

/** Superset request body accepted by both the streaming and deterministic endpoints. */
export interface AiSearchInput {
  query?: string;
  intent?: Intent;
  context?: AiRequestContext;
  geo?: unknown;
  filters?: Record<string, unknown>;
  limit?: number;
  [key: string]: unknown;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Total wall-clock cap for the stream (ms). `0` disables the per-request timeout. */
  timeoutMs?: number;
  /** Body forwarded to the deterministic fallback; defaults to the stream body. */
  fallbackBody?: unknown;
}

function toObject(data: string): Record<string, unknown> {
  if (!data) return {};
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed as Json };
  } catch {
    return { message: data };
  }
}

/** Map an SSE frame onto the typed AI-search event union (contract §7). */
export function frameToEvent(frame: SseFrame): AiStreamEvent {
  const d = toObject(frame.data);
  switch (frame.event) {
    case "status":
      return { type: "status", stage: String(d.stage ?? ""), text: String(d.text ?? "") };
    case "intent":
      return { type: "intent", data: d as unknown as Intent };
    case "results":
      return { type: "results", set_id: typeof d.set_id === "string" ? d.set_id : undefined, items: Array.isArray(d.items) ? (d.items as EntityCard[]) : [] };
    case "summary":
      return { type: "summary", text: String(d.text ?? ""), citations: Array.isArray(d.citations) ? (d.citations as string[]) : undefined };
    case "done":
      return {
        type: "done",
        agent_run_id: typeof d.agent_run_id === "string" ? d.agent_run_id : undefined,
        latency_ms: typeof d.latency_ms === "number" ? d.latency_ms : undefined,
        cost_usd: typeof d.cost_usd === "number" ? d.cost_usd : undefined,
        degraded: d.degraded === true,
      };
    case "error":
      return {
        type: "error",
        code: typeof d.code === "string" ? d.code : undefined,
        message: typeof d.message === "string" ? d.message : undefined,
        request_id: typeof d.request_id === "string" ? d.request_id : undefined,
        data: d,
      };
    default:
      // Unknown event name → surface as a user-legible status, never dropped silently.
      return { type: "status", stage: frame.event, text: String(d.text ?? "") };
  }
}

function causeOf(err: unknown): { code?: string; status?: number; message?: string; request_id?: string } {
  if (err instanceof NexusApiError) return { code: err.code, status: err.status, message: err.message, request_id: err.requestId };
  return { message: errorMessage(err) };
}

export class AiResource extends Resource {
  /** `POST /ai/v1/query/understand` → canonical {@link Intent}. */
  queryUnderstand(body: { query: string; context?: AiRequestContext }): Promise<Intent> {
    return this.post<Intent>("/ai/v1/query/understand", body, { safe: true });
  }

  /**
   * `POST /ai/v1/search` — deterministic hybrid search (the §105 bottom rung).
   * Marked `safe` (a pure read) so it retries on transient failures.
   */
  search(body: AiSearchInput): Promise<AiSearchResult> {
    return this.http.request<AiSearchResult>({ method: "POST", path: "/ai/v1/search", body, safe: true });
  }

  /** `POST /ai/v1/recommend`. */
  recommend(body: Record<string, unknown>): Promise<{ set_id?: string; items: EntityCard[]; [key: string]: unknown }> {
    return this.post("/ai/v1/recommend", body, { safe: true });
  }

  /** `POST /ai/v1/compare` (contract §37). */
  compare(body: { subject_ids: string[]; [key: string]: unknown }): Promise<Record<string, unknown>> {
    return this.post("/ai/v1/compare", body, { safe: true });
  }

  /** `POST /ai/v1/rag/retrieve`. */
  ragRetrieve(body: { query: string; merchant_id?: string; filters?: Record<string, unknown>; top_k?: number }): Promise<{ chunks: Array<Record<string, unknown>>; [key: string]: unknown }> {
    return this.post("/ai/v1/rag/retrieve", body, { safe: true });
  }

  /** `POST /ai/v1/feedback` (§99). */
  feedback(body: { subject_type: string; subject_id: string; signal: string; value: Json; session_id?: string }): Promise<Record<string, unknown>> {
    return this.post("/ai/v1/feedback", body);
  }

  /** `GET /ai/v1/tools` — tool registry manifest (name, schema, permission, side_effect). */
  tools(): Promise<{ tools: Array<Record<string, unknown>>; [key: string]: unknown }> {
    return this.reqGet("/ai/v1/tools");
  }

  /**
   * Consume the AI-search SSE stream (`POST /ai/v1/search/stream`) and yield typed
   * events. On any stream failure it degrades to {@link search} and yields a
   * `degraded` event; if that also fails it throws (never a silent fake success).
   */
  async *searchStream(body: AiSearchInput, opts: StreamOptions = {}): AsyncGenerator<AiStreamEvent> {
    let res: Response;
    try {
      res = await this.http.raw({
        method: "POST",
        path: "/ai/v1/search/stream",
        body,
        headers: { accept: "text/event-stream" },
        safe: true,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 0,
      });
    } catch (err) {
      yield* this.degrade(opts, { reason: "stream did not open", cause: causeOf(err) }, body);
      return;
    }

    const serverDegraded = res.headers.get("x-nexus-degraded") === "true";
    let sawError = false;
    let errorEvent: AiStreamEvent | undefined;
    try {
      const iterable = res.body ? parseSseStream(res.body) : [];
      for await (const frame of iterable) {
        const event = frameToEvent(frame);
        if (event.type === "error") {
          sawError = true;
          errorEvent = event;
          yield event;
          break;
        }
        yield event;
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err; // caller cancelled — propagate, do not "degrade"
      yield* this.degrade(opts, { reason: "stream interrupted", cause: causeOf(err) }, body);
      return;
    }

    if (sawError) {
      const e = (errorEvent ?? {}) as { code?: string; message?: string; request_id?: string };
      yield* this.degrade(opts, { reason: "stream reported error", cause: { code: e.code, message: e.message, request_id: e.request_id } }, body);
      return;
    }

    if (serverDegraded) {
      // The server already answered from a degraded path; make that explicit.
      yield { type: "degraded", degraded: true, via: "server", reason: "response flagged X-Nexus-Degraded" };
    }
  }

  /**
   * `POST /ai/v1/search/stream` with a `conversation_id` — the conversational turn of
   * the same stream (D13). It deliberately does not fall back to `/ai/v1/search`:
   * a mid-conversation failure must surface, not silently answer with a search page.
   */
  async *chatStream(body: { query: string; conversation_id?: string; context?: AiRequestContext }, opts: StreamOptions = {}): AsyncGenerator<AiStreamEvent> {
    const res = await this.http.raw({
      method: "POST",
      path: "/ai/v1/search/stream",
      body,
      headers: { accept: "text/event-stream" },
      safe: true,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 0,
    });
    const iterable = res.body ? parseSseStream(res.body) : [];
    for await (const frame of iterable) {
      yield frameToEvent(frame);
    }
  }

  /** Shared degradation path: try deterministic search, emit `degraded`, else throw. */
  private async *degrade(
    opts: StreamOptions,
    info: { reason: string; cause?: { code?: string; status?: number; message?: string; request_id?: string } },
    streamBody: AiSearchInput,
  ): AsyncGenerator<AiStreamEvent> {
    let result: AiSearchResult | undefined;
    let fallbackError: unknown;
    try {
      const fallbackBody = (opts.fallbackBody ?? streamBody) as AiSearchInput;
      result = await this.search(fallbackBody);
    } catch (err) {
      fallbackError = err;
    }
    if (result) {
      yield { type: "degraded", degraded: true, via: "deterministic_search", reason: info.reason, result, cause: info.cause };
      return;
    }
    // The deterministic bottom rung also failed — surface a loud error, never a fake success (§105, D6).
    throw new NexusApiError({
      code: "ai_unavailable",
      status: 503,
      message: `AI search stream failed (${info.reason}: ${info.cause?.message ?? "n/a"}) and deterministic fallback was unavailable (${errorMessage(fallbackError)})`,
      cause: fallbackError,
    });
  }
}
