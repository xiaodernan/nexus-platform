/**
 * `reservations` — create and release reservations (contract §6). Create is idempotency-required (auto key
 * unless supplied), and the transition this client may ask for is exactly one: release the hold. The SDK
 * never fakes a held slot (DECISIONS D6) and never pretends to confirm one (D26).
 */
import { Resource } from "./_base.js";

export interface CreateReservationInput {
  merchant_id: string;
  offering_id?: string;
  slot_id: string;
  party_size: number;
  contact: Record<string, unknown>;
  notes?: string;
  [key: string]: unknown;
}

/**
 * The only transition §6 exposes to a caller: `pending`/`confirmed` → `cancelled`. Advancing a hold is
 * the merchant's decision and has no route (D26), so a client cannot ask for it. `reason` is kept in the
 * audit trail, not on the booking row, and does not reach the merchant.
 */
export interface ReservationPatch {
  status: "cancelled";
  reason?: string;
  [key: string]: unknown;
}

export interface Reservation {
  reservation_id?: string;
  id?: string;
  status?: string;
  code?: string;
  starts_at?: string;
  ends_at?: string;
  party_size?: number;
  merchant?: { id?: string; name?: string; slug?: string };
  /** Plain-language statement of what the server did and did not promise (e.g. "the merchant is not notified"). */
  status_note?: string;
  [key: string]: unknown;
}

export class ReservationsResource extends Resource {
  /**
   * `POST /api/v1/reservations` → `201` with a confirmation code (`200` when the same hold already
   * exists). `409 slot_full` when the seats went, `409 reservation_exists` when this caller already
   * holds the slot at a different party size.
   */
  create(body: CreateReservationInput, idempotencyKey?: string): Promise<Reservation> {
    return this.post<Reservation>("/api/v1/reservations", body, { requireIdempotency: true, idempotencyKey });
  }

  /** `GET /api/v1/reservations/{id}` — the holder, or a workspace with `read_orders` on that merchant. */
  get(id: string): Promise<Reservation> {
    return super.reqGet<Reservation>(`/api/v1/reservations/${encodeURIComponent(id)}`);
  }

  /** `PATCH /api/v1/reservations/{id}` — `status` transitions are guarded server-side. */
  update(id: string, body: ReservationPatch): Promise<Reservation> {
    return this.patch<Reservation>(`/api/v1/reservations/${encodeURIComponent(id)}`, body);
  }

  /** Release a hold and return its seats. Idempotent: cancelling twice changes nothing the second time. */
  cancel(id: string, reason?: string): Promise<Reservation> {
    return this.update(id, reason === undefined ? { status: "cancelled" } : { status: "cancelled", reason });
  }
}
