/** `orders` — read an order's status machine and cancel it (contract §6). */
import { Resource } from "./_base.js";

export class OrdersResource extends Resource {
  /** `GET /api/v1/orders/{id}`. */
  get(id: string): Promise<Record<string, unknown>> {
    return super.reqGet<Record<string, unknown>>(`/api/v1/orders/${encodeURIComponent(id)}`);
  }

  /** `POST /api/v1/orders/{id}/cancel`. */
  cancel(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(`/api/v1/orders/${encodeURIComponent(id)}/cancel`, body ?? {});
  }
}
