/**
 * `reservations` — create and transition reservations (contract §6). Create is
 * idempotency-required (auto key unless supplied), and status transitions are
 * guarded server-side — the SDK never fakes a held slot (DECISIONS D6).
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

export interface Reservation {
  reservation_id?: string;
  id?: string;
  status?: string;
  code?: string;
  [key: string]: unknown;
}

export class ReservationsResource extends Resource {
  /** `POST /api/v1/reservations` → `201` with a confirmation code. Idempotency-Key required. */
  create(body: CreateReservationInput, idempotencyKey?: string): Promise<Reservation> {
    return this.post<Reservation>("/api/v1/reservations", body, { requireIdempotency: true, idempotencyKey });
  }

  /** `GET /api/v1/reservations/{id}`. */
  get(id: string): Promise<Reservation> {
    return super.reqGet<Reservation>(`/api/v1/reservations/${encodeURIComponent(id)}`);
  }

  /** `PATCH /api/v1/reservations/{id}` — `status` transitions are guarded server-side. */
  update(id: string, body: Record<string, unknown>): Promise<Reservation> {
    return this.patch<Reservation>(`/api/v1/reservations/${encodeURIComponent(id)}`, body);
  }
}
