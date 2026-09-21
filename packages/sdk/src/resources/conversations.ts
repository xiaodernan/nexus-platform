/** `conversations` — create a conversation and read its messages/state (contract §7). */
import { Resource } from "./_base.js";

export interface CreateConversationInput {
  merchant_id?: string;
  channel: string;
  mode?: string;
  [key: string]: unknown;
}

export class ConversationsResource extends Resource {
  /** `POST /api/v1/conversations`. */
  create(body: CreateConversationInput): Promise<Record<string, unknown>> {
    return this.post("/api/v1/conversations", body);
  }

  /** `GET /api/v1/conversations/{id}` — messages + state. */
  get(id: string): Promise<Record<string, unknown>> {
    return super.reqGet<Record<string, unknown>>(`/api/v1/conversations/${encodeURIComponent(id)}`);
  }
}
