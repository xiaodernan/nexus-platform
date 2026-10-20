/**
 * Console data helpers (§23 merchant workspace, §27 publish gate, §47 data ownership).
 *
 * This module is **pure**: no `process.env`, no `fetch`, no cookies, no `'use client'`. The
 * consoles' server modules (`console-merchant.ts`, `console-review.ts`) compose these shapes on
 * top of `nexusGet`, and the unit tests (`console-shared.test.ts`) exercise everything the UI
 * asserts — freshness buckets, derived rates, form validation, queue counting — without a network.
 *
 * Two honesty rules the types enforce:
 *  - every `ConsoleRead` names its `source` (a documented endpoint or `fixture:` label) and its
 *    `asOf` instant, because §23/§19 say a figure without provenance is not a figure;
 *  - a failed read is `status:'failed'` with the §1 error code — the page renders the failure
 *    visibly, and nothing here silently backfills a live read with fixtures (D6).
 */

import type { Money } from './types';

/* ------------------------------------------------------------ read provenance */

export type Freshness = 'fresh' | 'recent' | 'stale' | 'unknown';
export type ReadOrigin = 'live' | 'mock' | 'none';

export interface ConsoleRead<T> {
  status: 'ok' | 'failed';
  /** 'live' = platform HTTP read; 'mock' = fixture catalogue (always demo-badged); 'none' = failed. */
  origin: ReadOrigin;
  data: T | null;
  /** Documented endpoint (`GET /api/v1/...`) or fixture label (`fixture:console-*`). */
  source: string;
  /** Instant the payload says it was computed/observed (ISO-8601), or null when it does not say. */
  asOf: string | null;
  freshness: Freshness;
  /** True ⇒ §109/§155: synthetic demo data, the page must carry the demo badge. */
  demo: boolean;
  errorCode: string | null;
  requestId: string | null;
}

export const FRESH_UNTIL_MS = 15 * 60_000;
export const RECENT_UNTIL_MS = 24 * 3_600_000;

/** Fresh ≤15 min, recent ≤24 h, older is stale; an unreadable or missing stamp is `unknown`, never fresh. */
export function freshnessOf(asOf: string | null | undefined, now: Date = new Date()): Freshness {
  if (!asOf) return 'unknown';
  const then = Date.parse(asOf);
  if (!Number.isFinite(then)) return 'unknown';
  const age = now.getTime() - then;
  if (age < 0) return 'unknown'; // a timestamp from the future is a bug, not freshness
  if (age <= FRESH_UNTIL_MS) return 'fresh';
  if (age <= RECENT_UNTIL_MS) return 'recent';
  return 'stale';
}

export function okRead<T>(input: {
  data: T;
  origin: Extract<ReadOrigin, 'live' | 'mock'>;
  source: string;
  asOf: string | null;
  demo: boolean;
  requestId?: string | null;
  now?: Date;
}): ConsoleRead<T> {
  return {
    status: 'ok',
    origin: input.origin,
    data: input.data,
    source: input.source,
    asOf: input.asOf,
    freshness: freshnessOf(input.asOf, input.now ?? new Date()),
    demo: input.demo,
    errorCode: null,
    requestId: input.requestId ?? null,
  };
}

export function failedRead<T>(input: {
  source: string;
  errorCode: string;
  requestId?: string | null;
  asOf?: string | null;
}): ConsoleRead<T> {
  return {
    status: 'failed',
    origin: 'none',
    data: null,
    source: input.source,
    asOf: input.asOf ?? null,
    freshness: 'unknown',
    demo: false,
    errorCode: input.errorCode,
    requestId: input.requestId ?? null,
  };
}

/* ------------------------------------------------------------- merchant (§23) */

/** Mirror of `GET /api/v1/merchant/businesses/{id}/overview` (platform `MerchantOverviewController`, D15). */
export interface MerchantFunnel {
  views: number;
  clicks: number;
  actions: number;
  reservations: number;
  orders: number;
  revenue: Money;
}

export interface MerchantOverviewPayload {
  merchant_id: string;
  slug: string;
  display_name: string;
  status: string;
  plan: string;
  category_primary: string | null;
  location_count: number;
  /** Decimal string on the wire (§1 `money`); null until the merchant has a sourced rating. */
  rating: string | null;
  review_count: number;
  funnel: MerchantFunnel;
  funnel_source: string;
  revenue_definition: string;
  computed_at: string;
  data_origin: string;
}

/** `ratio` of two funnel counts; null when the denominator is zero — 0 traffic is not 0% quality. */
export function conversionRate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  if (numerator < 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export interface FunnelRates {
  clickThrough: number | null;
  actionPerClick: number | null;
}

/** Derived rates are labelled as derivations of the funnel row; they are never extra "data". */
export function funnelRates(funnel: MerchantFunnel): FunnelRates {
  return {
    clickThrough: conversionRate(funnel.clicks, funnel.views),
    actionPerClick: conversionRate(funnel.actions, funnel.clicks),
  };
}

/** Mirror of a thread row from `GET /api/v1/merchant/conversations` (platform `ConversationService.summary`). */
export interface MerchantThreadHandoff {
  id: string;
  reason: string | null;
  status: string | null;
  created_at: string | null;
  resolved_at: string | null;
}

export interface MerchantConversationThread {
  id: string;
  consumer_name: string | null;
  merchant_name: string | null;
  merchant_slug: string | null;
  channel: string | null;
  /** 'ai' | 'hybrid' | 'human' on the wire; unknown values render raw rather than disappearing. */
  mode: string;
  subject: string | null;
  /** 'open' | 'handoff' | 'closed' | 'archived' (§ platform THREAD_STATUSES). */
  status: string;
  last_message_at: string | null;
  created_at: string | null;
  handoffs: MerchantThreadHandoff[];
  demo: boolean;
}

/** One persisted turn of a merchant thread (`GET /api/v1/conversations/{id}`, §7). */
export interface MerchantThreadMessage {
  id: string;
  /** 'consumer' | 'assistant' | 'agent' | 'merchant' on the wire; unknown roles render raw. */
  role: string;
  content: string;
  created_at: string | null;
  /** §52: present when the AI service produced the turn — the audit link back to its `agent_runs` row. */
  agent_run_id: string | null;
  fact_ids: string[];
  degraded: boolean;
}

export interface MerchantThreadDetail {
  id: string;
  status: string;
  mode: string;
  consumer_name: string | null;
  messages: MerchantThreadMessage[];
  handoffs: MerchantThreadHandoff[];
  demo: boolean;
}

/**
 * §108: an agent-authored turn is labelled wherever it appears. The `agent_run_id` is the stronger
 * signal (it names the run), so either one is enough — and a `role` the platform added later is not
 * silently treated as human.
 */
export function messageIsAiAuthored(message: MerchantThreadMessage): boolean {
  return message.agent_run_id !== null || message.role === 'assistant' || message.role === 'agent';
}

export function threadHasOpenHandoff(thread: Pick<MerchantConversationThread, 'handoffs'>): boolean {
  return thread.handoffs.some((handoff) => handoff.status === 'open');
}

/* -------------------------------------------------- offerings rows (§5, §47) */

/**
 * One row of the merchant's own catalogue. The list read is the documented public menu projection
 * (§4 `GET /api/v1/merchants/{id}/menu`), because §5 documents offering *writes* only; `status` and
 * `updated_at` are optional because that projection does not always state them, and an absent value
 * stays absent.
 */
export interface MerchantOfferingRow {
  id: string;
  slug: string | null;
  title: string;
  kind: string;
  price: Money | null;
  status: string | null;
  updated_at: string | null;
  demo: boolean;
}

/** A create/edit draft for one offering — the §5 `POST`/`PATCH /merchant/offerings[/{id}]` fields. */
export type OfferingDraftField = 'title' | 'kind' | 'description' | 'price_amount' | 'currency';
export type OfferingDraft = Record<OfferingDraftField, string>;

export type OfferingDraftErrors = Partial<Record<OfferingDraftField, 'required' | 'too_long' | 'invalid'>>;

export const OFFERING_KINDS = ['product', 'service', 'experience'] as const;

export const OFFERING_LIMITS: Record<'title' | 'description' | 'price_amount', number> = {
  title: 120,
  description: 2000,
  price_amount: 12,
};

export function emptyOfferingDraft(currency = 'HKD'): OfferingDraft {
  return { title: '', kind: 'product', description: '', price_amount: '', currency };
}

export function offeringDraftFrom(row: MerchantOfferingRow): OfferingDraft {
  return {
    title: row.title,
    kind: (OFFERING_KINDS as readonly string[]).includes(row.kind) ? row.kind : 'product',
    description: '',
    price_amount: row.price?.amount ?? '',
    currency: row.price?.currency ?? 'HKD',
  };
}

/**
 * An offering must state a title and, if it states a price at all, a well-formed one. A blank price
 * is "no stated price" and is dropped from the body rather than sent as 0 — 0 is a claim (§19).
 */
export function validateOfferingDraft(draft: OfferingDraft): OfferingDraftErrors {
  const errors: OfferingDraftErrors = {};
  if (!draft.title.trim()) errors.title = 'required';
  if (draft.title.length > OFFERING_LIMITS.title) errors.title = 'too_long';
  if (draft.description.length > OFFERING_LIMITS.description) errors.description = 'too_long';
  const price = draft.price_amount.trim();
  if (price && !/^\d+(\.\d{1,2})?$/.test(price)) errors.price_amount = 'invalid';
  if (price.length > OFFERING_LIMITS.price_amount) errors.price_amount = 'too_long';
  if (!draft.currency.trim()) errors.currency = 'required';
  return errors;
}

export function offeringDraftBody(draft: OfferingDraft): Record<string, unknown> {
  const price = draft.price_amount.trim();
  return {
    title: draft.title.trim(),
    kind: draft.kind,
    description: draft.description.trim(),
    ...(price ? { price: { amount: price, currency: draft.currency.trim() || 'HKD' } } : {}),
  };
}

/* --------------------------------------------------- listing edit form (§47) */
export type ListingDraftField = 'name' | 'tagline' | 'description' | 'phone' | 'price_amount';
export type ListingDraft = Record<ListingDraftField, string>;

/** Error *codes* — the copy lives in the dictionary so this stays a pure, locale-free helper. */
export type ListingDraftErrors = Partial<Record<ListingDraftField, 'required' | 'too_long' | 'invalid'>>;

export const LISTING_LIMITS: Record<ListingDraftField, number> = {
  name: 80,
  tagline: 60,
  description: 2000,
  phone: 24,
  price_amount: 12,
};

/**
 * Client-side validation (§47 the merchant owns their data, but not their own typos):
 * required name, bounded lengths mirroring the platform column widths, an HKD decimal string
 * matching the §1 `money` shape, and a phone that can plausibly dial.
 */
export function validateListingDraft(draft: ListingDraft): ListingDraftErrors {
  const errors: ListingDraftErrors = {};
  if (!draft.name.trim()) errors.name = 'required';
  if (draft.name.length > LISTING_LIMITS.name) errors.name = 'too_long';
  if (draft.tagline.length > LISTING_LIMITS.tagline) errors.tagline = 'too_long';
  if (draft.description.length > LISTING_LIMITS.description) errors.description = 'too_long';
  const price = draft.price_amount.trim();
  if (price && !/^\d+(\.\d{1,2})?$/.test(price)) errors.price_amount = 'invalid';
  const phone = draft.phone.trim();
  if (phone && !/^\+?[\d][\d\s-]{5,23}$/.test(phone)) errors.phone = 'invalid';
  return errors;
}

export function listingDraftIsDirty(before: ListingDraft, after: ListingDraft): boolean {
  return (Object.keys(before) as ListingDraftField[]).some((field) => before[field] !== after[field]);
}

/**
 * The §1 `money` shape a `PATCH /api/v1/merchant/businesses/{id}` body carries for the price.
 * An empty price field means "no stated average price" — it is removed from the body rather than
 * sent as 0, because 0 is a claim and blank is not.
 */
export function listingPatchBody(draft: ListingDraft): Record<string, unknown> {
  const price = draft.price_amount.trim();
  return {
    display_name: draft.name.trim(),
    tagline: draft.tagline.trim(),
    description: draft.description.trim(),
    phone: draft.phone.trim(),
    ...(price ? { avg_price: { amount: price, currency: 'HKD' } } : {}),
  };
}

/* ------------------------------------------------- admin review queue (§27) */

export type ReviewQueueKind = 'guide' | 'coupon' | 'listing_change';
export type ReviewQueueStatus = 'pending' | 'approved' | 'rejected';

/**
 * One item waiting behind the §27 publish gate. `generated_by_ai` + `reviewed_by_human` are the
 * AI-content disclosure state (§23/§28); the queue never merges them into one "AI ok" flag.
 */
export interface ReviewQueueItem {
  id: string;
  kind: ReviewQueueKind;
  title: string;
  summary: string;
  /** Who/what proposed the change ('ai:marketing', 'merchant', 'editor'). */
  actor: string;
  merchant_name: string | null;
  generated_by_ai: boolean;
  reviewed_by_human: boolean;
  submitted_at: string | null;
  status: ReviewQueueStatus;
  /** Documented endpoint or fixture label the item was read from; travels with the item. */
  source: string;
  demo: boolean;
}

export interface QueueSummary {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  byKind: Record<ReviewQueueKind, number>;
  /** §27: AI content nobody has checked yet — the count the reviewer owes attention to. */
  unreviewedAi: number;
}

export function summarizeQueue(items: ReviewQueueItem[]): QueueSummary {
  const summary: QueueSummary = {
    total: items.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    byKind: { guide: 0, coupon: 0, listing_change: 0 },
    unreviewedAi: 0,
  };
  for (const item of items) {
    if (item.status === 'pending') summary.pending += 1;
    if (item.status === 'approved') summary.approved += 1;
    if (item.status === 'rejected') summary.rejected += 1;
    if (item.kind in summary.byKind) summary.byKind[item.kind] += 1;
    if (item.generated_by_ai && !item.reviewed_by_human) summary.unreviewedAi += 1;
  }
  return summary;
}

/* ------------------------------------------- AI content provenance (§27, §108) */

/**
 * §27/§108: an AI-generated artifact is never "just content". Two independent booleans travel with
 * it — was it generated by a model, has a human checked it — and the console must render both.
 * `generated_by_ai && !reviewed_by_human` is the one state that may not be published, so it is a
 * distinct value here rather than a derived `!` in a view.
 */
export interface AiProvenance {
  generated_by_ai: boolean;
  reviewed_by_human: boolean;
  /** Who/what produced it ('ai:marketing', 'ai:import', 'merchant', 'editor'), or null when unstated. */
  actor: string | null;
  generated_at: string | null;
}

export type AiDraftState = 'human' | 'ai_approved' | 'ai_unapproved';

export function aiDraftState(provenance: AiProvenance): AiDraftState {
  if (!provenance.generated_by_ai) return 'human';
  return provenance.reviewed_by_human ? 'ai_approved' : 'ai_unapproved';
}

/**
 * The §27 publish gate as a predicate. Unapproved AI content is not publishable by any button in
 * the merchant console; the server enforces it too, this only stops the UI offering a lie.
 */
export function publishGateOpen(provenance: AiProvenance): boolean {
  return aiDraftState(provenance) !== 'ai_unapproved';
}

/** Counting helper so a page can state "N AI drafts, none checked by a human" without re-deriving it. */
export function countByAiState(items: AiProvenance[]): Record<AiDraftState, number> {
  const counts: Record<AiDraftState, number> = { human: 0, ai_approved: 0, ai_unapproved: 0 };
  for (const item of items) counts[aiDraftState(item)] += 1;
  return counts;
}

/* ------------------------------------------------------ campaigns (§27, §23) */

export interface MerchantCampaign {
  id: string;
  name: string;
  /** marketing channel the draft targets (in_app|email|whatsapp|social|landing|…); rendered raw if unknown. */
  channel: string;
  /** Raw wire status; an unknown value renders itself rather than being mapped onto a guess. */
  status: string;
  body: string | null;
  audience: string | null;
  provenance: AiProvenance;
  /** The human the platform recorded (§27 `campaigns.approved_by`); null until someone approves. */
  approved_by: string | null;
  published_at: string | null;
  created_at: string | null;
  evidence_fact_ids: string[];
  demo: boolean;
}

export const CAMPAIGN_TERMINAL_STATUSES = ['published', 'rejected', 'archived'] as const;

export function campaignIsTerminal(status: string): boolean {
  return (CAMPAIGN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A draft is publishable when it is not already decided **and** it passes the §27 AI gate. A
 * published campaign is not "publishable" — offering the button again would be a second publish.
 */
export function campaignPublishable(campaign: MerchantCampaign): boolean {
  return !campaignIsTerminal(campaign.status) && publishGateOpen(campaign.provenance);
}

export function campaignCounts(items: MerchantCampaign[]): {
  total: number;
  drafts: number;
  published: number;
  awaitingHuman: number;
} {
  return {
    total: items.length,
    drafts: items.filter((item) => item.status === 'draft').length,
    published: items.filter((item) => item.status === 'published').length,
    awaitingHuman: items.filter((item) => !publishGateOpen(item.provenance) && !campaignIsTerminal(item.status)).length,
  };
}

/* ------------------------------------------------------- AI import (§22, §23) */

/**
 * Proposals below the confidence floor are the ones a reviewer must actually look at; the floor is
 * a UI affordance, not a data claim — `confidence` itself comes from the extractor (§22/§51).
 */
export const IMPORT_CONFIDENCE_FLOOR = 0.6;

export interface ImportProposal {
  id: string;
  kind: string;
  name: string;
  price: Money | null;
  category: string | null;
  confidence: number | null;
  /** §22/§55: the facts the extraction cites. An empty list is stated, never glossed over. */
  evidence_fact_ids: string[];
  /** The span of the source document the proposal was read from (§51 untrusted input). */
  source_span: string | null;
}

export interface ImportJob {
  job_id: string;
  /** Raw wire status (queued|running|done|failed|…); unknown values render themselves. */
  status: string;
  source_type: string | null;
  source_ref: string | null;
  created_at: string | null;
  updated_at: string | null;
  documents: number | null;
  chunks: number | null;
  proposals: ImportProposal[];
  error: string | null;
  degraded: boolean;
  demo: boolean;
}

export const IMPORT_TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'succeeded'] as const;

export function importJobIsTerminal(status: string): boolean {
  return (IMPORT_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type ImportStageState = 'pending' | 'active' | 'done' | 'failed';

export interface ImportStage {
  key: string;
  state: ImportStageState;
}

/**
 * The §22 pipeline as ordered stages. The mapping is by stage *position*, because the wire status
 * vocabulary is the platform's: an unrecognised status leaves every stage pending (the job exists,
 * we cannot say where it is) rather than inventing progress.
 */
const IMPORT_STAGE_ORDER = ['queued', 'fetching', 'parsing', 'embedding', 'proposing'] as const;

export function importJobStages(status: string): ImportStage[] {
  const failed = status === 'failed' || status === 'error';
  const done = status === 'done' || status === 'succeeded' || status === 'completed';
  const index = IMPORT_STAGE_ORDER.indexOf(status as (typeof IMPORT_STAGE_ORDER)[number]);
  return IMPORT_STAGE_ORDER.map((key, position) => {
    if (done) return { key, state: 'done' as const };
    if (failed) {
      // Everything before the failure is assumed complete only if the wire said which stage it
      // reached; without that we mark the last stage failed and leave the rest pending.
      return { key, state: position === IMPORT_STAGE_ORDER.length - 1 ? ('failed' as const) : ('pending' as const) };
    }
    if (index < 0) return { key, state: 'pending' as const };
    if (position < index) return { key, state: 'done' as const };
    if (position === index) return { key, state: 'active' as const };
    return { key, state: 'pending' as const };
  });
}

export function proposalIsLowConfidence(proposal: ImportProposal): boolean {
  return proposal.confidence !== null && proposal.confidence < IMPORT_CONFIDENCE_FLOOR;
}

export function importProposalCounts(proposals: ImportProposal[]): {
  total: number;
  lowConfidence: number;
  withoutEvidence: number;
} {
  return {
    total: proposals.length,
    lowConfidence: proposals.filter(proposalIsLowConfidence).length,
    withoutEvidence: proposals.filter((proposal) => proposal.evidence_fact_ids.length === 0).length,
  };
}

/* ----------------------------------------------------- reservations (§6, §40) */

/**
 * The guarded status machine of `PATCH /api/v1/reservations/{id}` (§6). Terminal states have no
 * outgoing edge: a cancelled booking is not re-openable, it is a new booking. An unknown status
 * offers no transitions rather than a guess.
 */
export const RESERVATION_TRANSITIONS: Record<string, readonly string[]> = {
  requested: ['confirmed', 'cancelled'],
  pending: ['confirmed', 'cancelled'],
  confirmed: ['seated', 'no_show', 'cancelled'],
  seated: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function nextReservationStates(status: string): string[] {
  return [...(RESERVATION_TRANSITIONS[status] ?? [])];
}

/**
 * The guest's own contact block from `GET /api/v1/merchant/reservations` (§5/§23). The route carries
 * `contact` because calling the guest is the job of the screen, and it deliberately omits the
 * platform's `user_id` — that identifies a person to us, not to the merchant. Each field is nullable
 * because the wire only states what the guest supplied.
 */
export interface ReservationContact {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface MerchantReservation {
  id: string;
  code: string | null;
  consumer_name: string | null;
  offering_title: string | null;
  party_size: number | null;
  slot_start: string | null;
  status: string;
  notes: string | null;
  created_at: string | null;
  /** The guest's contact block (§5); null when the payload states none. */
  contact: ReservationContact | null;
  /** The booked value as the wire reports it (`total_amount`), or null when it states none. */
  price: Money | null;
  /** Where the booking came from (in_app|phone|…); unknown values render themselves. */
  source: string | null;
  updated_at: string | null;
  demo: boolean;
}

/** The label a merchant reads first: the guest's name, else the phone, else "—". Never invented. */
export function reservationGuestLabel(reservation: Pick<MerchantReservation, 'consumer_name' | 'contact'>): string | null {
  return reservation.consumer_name ?? reservation.contact?.name ?? reservation.contact?.phone ?? null;
}

/** `YYYY-MM-DD` in Hong Kong time — the merchant's day, not the server's UTC day (§112). */
export function reservationDayKey(iso: string | null | undefined, now: Date = new Date()): string {
  const instant = iso ? new Date(iso) : now;
  if (Number.isNaN(instant.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts;
}

export function reservationsOnDay(
  items: MerchantReservation[],
  day: string,
  now: Date = new Date(),
): MerchantReservation[] {
  return items.filter((item) => reservationDayKey(item.slot_start, now) === day);
}

export function reservationCounts(items: MerchantReservation[]): {
  total: number;
  awaitingDecision: number;
  seated: number;
  cancelled: number;
  covers: number;
} {
  return {
    total: items.length,
    awaitingDecision: items.filter((item) => item.status === 'requested' || item.status === 'pending').length,
    seated: items.filter((item) => item.status === 'seated').length,
    cancelled: items.filter((item) => item.status === 'cancelled' || item.status === 'no_show').length,
    // Covers counts the people the merchant must seat — only for bookings still standing.
    covers: items
      .filter((item) => item.status !== 'cancelled' && item.status !== 'no_show')
      .reduce((sum, item) => sum + (item.party_size ?? 0), 0),
  };
}

/* -------------------------------------------- review intelligence (§54, §55) */

export interface ReviewIntelTheme {
  label: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  mentions: number;
  /** §55: the reviews the theme was read out of. Empty means the model asserted it without evidence. */
  review_ids: string[];
}

export interface ReviewIntelligence {
  summary: string | null;
  themes: ReviewIntelTheme[];
  evidence_review_ids: string[];
  generated_at: string | null;
  model: string | null;
  /** How many reviews are published for the merchant; null when the read did not state it. */
  published_reviews: number | null;
  average_rating: number | null;
  distribution: Record<string, number>;
  provenance: AiProvenance;
  demo: boolean;
}

export interface EvidenceCoverage {
  themes: number;
  themesWithEvidence: number;
  evidenceCount: number;
  /** Theme labels that cite nothing — the ones a reviewer must not trust (§55). */
  uncoveredThemes: string[];
  hasEvidence: boolean;
}

/** §55 as a predicate: a summary either shows its review_ids or says it has none. */
export function reviewEvidenceCoverage(intel: ReviewIntelligence): EvidenceCoverage {
  const uncoveredThemes = intel.themes.filter((theme) => theme.review_ids.length === 0).map((theme) => theme.label);
  return {
    themes: intel.themes.length,
    themesWithEvidence: intel.themes.length - uncoveredThemes.length,
    evidenceCount: intel.evidence_review_ids.length,
    uncoveredThemes,
    hasEvidence: intel.evidence_review_ids.length > 0,
  };
}

/** Shares sum to at most 1; a bucket with no total renders nothing rather than 0%. */
export function distributionShares(distribution: Record<string, number>): Array<{ rating: number; count: number; share: number | null }> {
  const total = Object.values(distribution).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return [5, 4, 3, 2, 1].map((rating) => {
    const count = distribution[String(rating)] ?? 0;
    return { rating, count, share: total > 0 ? Math.round((count / total) * 1000) / 1000 : null };
  });
}

/* ------------------------------------------------------- analytics (§56, §23) */

/**
 * §56 metric set. Every field is a count from the merchant's own event stream; `revenue` is the
 * only money and it keeps the §1 `money` shape so it can carry its currency.
 */
export interface MerchantAnalyticsTotals {
  views: number;
  ai_impressions: number;
  search_appearances: number;
  clicks: number;
  leads: number;
  reservations: number;
  orders: number;
  repeat_customers: number;
  revenue: Money;
}

export interface MerchantAnalyticsPoint extends MerchantAnalyticsTotals {
  date: string;
}

export interface MerchantAnalytics {
  from: string;
  to: string;
  metric: string;
  points: MerchantAnalyticsPoint[];
  totals: MerchantAnalyticsTotals;
  /** The platform's own definition strings, rendered verbatim so a figure cannot outlive its meaning. */
  definitions: Record<string, string>;
  computed_at: string | null;
  data_origin: string;
  degraded: boolean;
  /**
   * Which total fields the payload actually carried. The live `GET /api/v1/merchant/analytics`
   * returns `views|clicks|actions|reservations|orders|revenue` and nothing else, so the page must
   * render "—" for a field the platform did not measure rather than a fabricated 0 (§19/§109).
   */
  provided: string[];
  /** The platform's own per-day event series (`series`), or [] when it states none. */
  event_series: Array<{ date: string; events: number }>;
  /** The window the platform reports (`window`), or null when the payload states none. */
  window: { from: string; to: string; days: number; metric: string } | null;
  /** The platform's own source string for the measurement, rendered verbatim. */
  source: string | null;
  /** The platform's own note about what the numbers mean, rendered verbatim. */
  note: string | null;
}

/** The six total fields the live analytics read is defined over (§5 `GET /merchant/analytics`). */
export const ANALYTICS_LIVE_FIELDS = ['views', 'clicks', 'actions', 'reservations', 'orders', 'revenue'] as const;

/**
 * The analytics field a payload actually carries. A field is "provided" only when the payload states
 * a finite number for it (money counts when it carries an amount) — the reader must never promote a
 * missing metric into a 0 on the page (§19: a number without a source is not a number).
 */
export function analyticsProvidedFields(metrics: Record<string, unknown> | null | undefined): string[] {
  if (!metrics) return [];
  const provided: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) provided.push(key);
    else if (value && typeof value === 'object' && typeof (value as { amount?: unknown }).amount === 'string') {
      provided.push(key);
    }
  }
  return provided;
}

/** True when the payload measured this total — the gate a view uses before printing a figure. */
export function analyticsFieldProvided(analytics: Pick<MerchantAnalytics, 'provided'>, field: string): boolean {
  return analytics.provided.includes(field);
}

/** The platform's own per-day series rows (`{day, events}`), normalised and sorted by day. */
export function analyticsEventSeries(rows: Array<Record<string, unknown>>): Array<{ date: string; events: number }> {
  return rows
    .map((row) => {
      const date = typeof row.day === 'string' ? row.day : typeof row.date === 'string' ? row.date : '';
      const events = typeof row.events === 'number' && Number.isFinite(row.events) ? row.events : null;
      return date && events !== null ? { date, events } : null;
    })
    .filter((point): point is { date: string; events: number } => point !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export interface AnalyticsRates {
  viewToClick: number | null;
  clickToLead: number | null;
  leadToReservation: number | null;
  leadToOrder: number | null;
  repeatShare: number | null;
}

/** Derived rates; a zero denominator is `null`, never 0% — no traffic is not 0% quality. */
export function analyticsRates(totals: MerchantAnalyticsTotals): AnalyticsRates {
  return {
    viewToClick: conversionRate(totals.clicks, totals.views),
    clickToLead: conversionRate(totals.leads, totals.clicks),
    leadToReservation: conversionRate(totals.reservations, totals.leads),
    leadToOrder: conversionRate(totals.orders, totals.leads),
    repeatShare: conversionRate(totals.repeat_customers, totals.orders),
  };
}

export function analyticsIsEmpty(totals: MerchantAnalyticsTotals): boolean {
  return (
    totals.views === 0 &&
    totals.ai_impressions === 0 &&
    totals.search_appearances === 0 &&
    totals.clicks === 0 &&
    totals.leads === 0 &&
    totals.reservations === 0 &&
    totals.orders === 0
  );
}

export function analyticsSeries(
  points: MerchantAnalyticsPoint[],
  metric: keyof MerchantAnalyticsTotals,
): Array<{ date: string; value: number }> {
  return points.map((point) => {
    const raw = point[metric];
    return { date: point.date, value: typeof raw === 'number' && Number.isFinite(raw) ? raw : 0 };
  });
}

/* ------------------------------------------------- settings (§5, §47, §48, §49) */

export interface MerchantMember {
  id: string;
  name: string | null;
  email: string | null;
  /** Raw wire role; an unknown value renders itself (§48 roles are the platform's vocabulary). */
  role: string;
  permissions: string[];
  status: string | null;
  created_at: string | null;
  demo: boolean;
}

/** §48/§49 role vocabulary, for the invite form. The platform is the authority on what a role may do. */
export const MEMBER_ROLES = ['owner', 'admin', 'manager', 'staff', 'marketing', 'analyst', 'ai_agent'] as const;

export function isMemberRole(value: string): boolean {
  return (MEMBER_ROLES as readonly string[]).includes(value);
}

export interface MerchantApiKey {
  id: string;
  label: string;
  /** Only ever the display prefix — a full key is returned once, at creation, and never stored here. */
  prefix: string | null;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  demo: boolean;
}

/** §46/§49 permission names a scoped merchant key may carry. */
export const API_KEY_SCOPES = [
  'read_products',
  'write_products',
  'read_analytics',
  'send_message',
  'admin_members',
] as const;

export interface AiAgentConfig {
  enabled: boolean;
  greeting: string;
  tone: string;
  /** Below this confidence the agent hands off to a human (§26); null when the platform did not state it. */
  handoff_threshold: number | null;
  languages: string[];
  outside_hours_message: string;
  updated_at: string | null;
  updated_by: string | null;
  demo: boolean;
}

export interface AiAgentConfigDraft {
  enabled: boolean;
  greeting: string;
  tone: string;
  handoff_threshold: string;
  languages: string;
  outside_hours_message: string;
}

export const AGENT_CONFIG_LIMITS: Record<'greeting' | 'outside_hours_message' | 'languages', number> = {
  greeting: 200,
  outside_hours_message: 300,
  languages: 120,
};

export type AiAgentConfigErrors = Partial<Record<keyof AiAgentConfigDraft, 'required' | 'too_long' | 'invalid'>>;

export function agentConfigDraftFrom(config: AiAgentConfig): AiAgentConfigDraft {
  return {
    enabled: config.enabled,
    greeting: config.greeting,
    tone: config.tone,
    handoff_threshold: config.handoff_threshold === null ? '' : String(config.handoff_threshold),
    languages: config.languages.join(', '),
    outside_hours_message: config.outside_hours_message,
  };
}

/**
 * The blank draft used when the current config could not be read (§5 documents the write only, so
 * there is no read of the current switch). It starts from "off" and empty strings rather than from
 * plausible-looking defaults, because a pre-filled greeting the merchant never wrote is a lie about
 * what the agent will say.
 */
export function emptyAgentConfigDraft(): AiAgentConfigDraft {
  return {
    enabled: false,
    greeting: '',
    tone: '',
    handoff_threshold: '',
    languages: '',
    outside_hours_message: '',
  };
}

/**
 * A greeting is required because the agent speaks it to customers; the threshold, when present,
 * must be a probability — a 0.85 floor and a "85" floor are different promises, so "85" is invalid
 * rather than silently divided by 100.
 */
export function validateAgentConfigDraft(draft: AiAgentConfigDraft): AiAgentConfigErrors {
  const errors: AiAgentConfigErrors = {};
  if (!draft.greeting.trim()) errors.greeting = 'required';
  if (draft.greeting.length > AGENT_CONFIG_LIMITS.greeting) errors.greeting = 'too_long';
  if (draft.outside_hours_message.length > AGENT_CONFIG_LIMITS.outside_hours_message) {
    errors.outside_hours_message = 'too_long';
  }
  if (draft.languages.length > AGENT_CONFIG_LIMITS.languages) errors.languages = 'too_long';
  if (!draft.tone.trim()) errors.tone = 'required';
  const threshold = draft.handoff_threshold.trim();
  if (threshold) {
    const parsed = Number.parseFloat(threshold);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) errors.handoff_threshold = 'invalid';
  }
  return errors;
}

/** The §5 `POST /merchant/ai-agent/config` body; an empty threshold is omitted, not sent as 0. */
export function agentConfigBody(draft: AiAgentConfigDraft): Record<string, unknown> {
  const threshold = draft.handoff_threshold.trim();
  return {
    enabled: draft.enabled,
    greeting: draft.greeting.trim(),
    tone: draft.tone.trim(),
    languages: draft.languages
      .split(',')
      .map((language) => language.trim())
      .filter((language) => language.length > 0),
    outside_hours_message: draft.outside_hours_message.trim(),
    ...(threshold ? { handoff_threshold: Number.parseFloat(threshold) } : {}),
  };
}

/* ------------------------------------------- admin moderation cases (§9, §27) */

/**
 * The moderation queue the platform actually serves is a list of *cases*
 * (`GET /api/v1/admin/moderation`), and a case's own status is `open|resolved` — not the review's
 * `published|rejected|flagged`. The two vocabularies are kept apart here because collapsing them is
 * how a console starts printing a decision nobody made (the case is closed; what the review became is
 * in `resolution.decision`).
 */
export type ModerationCaseStatus = 'open' | 'resolved';
/** The review's own states, which is what `POST /moderation/{id}/resolve {decision}` accepts (§9). */
export type ModerationDecision = 'published' | 'rejected' | 'flagged';

export const MODERATION_DECISIONS: readonly ModerationDecision[] = ['published', 'rejected', 'flagged'] as const;

export function isModerationDecision(value: unknown): value is ModerationDecision {
  return typeof value === 'string' && (MODERATION_DECISIONS as readonly string[]).includes(value);
}

export function moderationCaseStatusOf(value: unknown): ModerationCaseStatus {
  return value === 'resolved' ? 'resolved' : 'open';
}

/** The decision recorded on a resolved case (`resolution.decision`), or null when none is stated. */
export function moderationDecisionOf(resolution: unknown): ModerationDecision | null {
  const decision = (resolution as { decision?: unknown } | null)?.decision;
  return isModerationDecision(decision) ? decision : null;
}

/**
 * The queue item's display status, derived from the case status and — only when the case is resolved
 * — the decision the platform recorded. An `open` case is always pending; a resolved case with no
 * stated decision stays `pending` in the display sense rather than being guessed into "approved".
 */
export function moderationDisplayStatus(
  caseStatus: ModerationCaseStatus,
  decision: ModerationDecision | null,
): 'pending' | 'approved' | 'rejected' {
  if (caseStatus === 'open') return 'pending';
  if (decision === 'rejected') return 'rejected';
  if (decision === 'published' || decision === 'flagged') return 'approved';
  return 'pending';
}

/** Only an open `review` case can be resolved on the served route (§9); anything else is not actionable. */
export function moderationCaseResolvable(item: { case_status: ModerationCaseStatus; subject_type: string | null }): boolean {
  return item.case_status === 'open' && item.subject_type === 'review';
}

/* ------------------------------------------------ admin AI observability (§9, §70) */

/**
 * §9 `GET /api/v1/admin/ai/costs` reports `{key, runs, cost_usd, prompt_tokens, completion_tokens,
 * avg_latency_ms}` per group. Tokens are the sum of the two halves when the payload states them and
 * `null` when it states neither — a missing token count is not a zero.
 */
export function costRowTokens(promptTokens: number | null, completionTokens: number | null): number | null {
  if (promptTokens === null && completionTokens === null) return null;
  return (promptTokens ?? 0) + (completionTokens ?? 0);
}

/** Sum of the values that exist; `null` when none do (a total of nothing is not 0). */
export function sumDefined(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

/* ------------------------------------- admin Analytics Agent answer (§9, §126) */

/**
 * One aggregate the §126 answer used, e.g. `{label: 'merchants.total', value: '3'}`. The agent's
 * tools are read-only, so the evidence is a set of counted aggregates rather than a free-text claim.
 */
export interface AdminAskEvidence {
  label: string;
  value: string | null;
}

export interface AdminAskAnswer {
  answer: string;
  /** Where the answer came from: `sql` in this build — the platform ships no LLM client (§126). */
  answer_source: string | null;
  evidence: AdminAskEvidence[];
  model: string | null;
  provider: string | null;
  degraded: boolean;
  /** Why it is degraded (`no_llm_key_configured`, `no_llm_client_in_platform_service`, …). */
  degraded_reason: string | null;
  read_only: true;
  latency_ms: number | null;
  generated_at: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Parse the `POST /api/v1/admin/ai/ask` answer (§9/§126). Lives here, in the pure module, so the
 * browser component can import it without pulling the server fetch layer across the boundary.
 *
 * The served shape is `{answer, answer_source, read_only, degraded, degraded_reason, model_used,
 * evidence: [{metric, value}], …}`. An answer with no text is not an answer — the parser returns
 * `null` rather than rendering an empty box that looks like a successful call.
 */
export function parseAdminAskAnswer(payload: unknown): AdminAskAnswer | null {
  const record = asRecord(payload);
  if (!record) return null;
  const answer = firstString(record, ['answer', 'text', 'summary', 'response']);
  if (!answer) return null;
  const evidence: AdminAskEvidence[] = [];
  const rawEvidence = record.evidence ?? record.sql ?? record.grounding ?? record.citations;
  for (const entry of Array.isArray(rawEvidence) ? rawEvidence : []) {
    const asText = asString(entry);
    if (asText) {
      evidence.push({ label: asText, value: null });
      continue;
    }
    const row = asRecord(entry);
    if (!row) continue;
    const label = firstString(row, ['metric', 'label', 'name', 'key']);
    if (!label) continue;
    evidence.push({ label, value: asString(row.value ?? row.amount) });
  }
  const latency = record.latency_ms;
  return {
    answer,
    answer_source: firstString(record, ['answer_source', 'source']),
    evidence,
    model: firstString(record, ['model', 'model_used']),
    provider: firstString(record, ['provider']),
    degraded: record.degraded === true,
    degraded_reason: firstString(record, ['degraded_reason', 'reason']),
    read_only: true,
    latency_ms: typeof latency === 'number' && Number.isFinite(latency) ? Math.trunc(latency) : null,
    generated_at: firstString(record, ['generated_at', 'created_at', 'as_of']),
  };
}

/* ------------------------------------------------ admin search analytics (§9) */

export interface AdminSearchDay {
  day: string;
  sessions: number | null;
  searches: number | null;
  fulfilled_intents: number | null;
}

/** The §9 search read's own daily rows, normalised and sorted; unknown numbers stay null. */
export function searchDailySeries(rows: Array<Record<string, unknown>>): AdminSearchDay[] {
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return rows
    .map((row) => {
      const day = typeof row.day === 'string' ? row.day : '';
      if (!day) return null;
      return {
        day,
        sessions: numberOrNull(row.sessions),
        searches: numberOrNull(row.searches),
        fulfilled_intents: numberOrNull(row.fulfilled_intents),
      };
    })
    .filter((row): row is AdminSearchDay => row !== null)
    .sort((left, right) => left.day.localeCompare(right.day));
}

/**
 * The search read is descriptive only: it reports searches, sessions, fulfilled intents and active
 * days, and carries **no** zero-result rate (no such metric exists in the schema, §109). This helper
 * returns the fulfilment share that *is* derivable — fulfilled / searches — and `null` when the
 * denominator is zero, so a page can label it as derived rather than claiming a platform number.
 */
export function searchFulfilmentShare(searches: number | null, fulfilled: number | null): number | null {
  return conversionRate(fulfilled ?? 0, searches ?? 0);
}

/* ------------------------------------------------ merchant verification (§48) */

export type VerificationState = 'verified' | 'pending' | 'unverified' | 'unknown';

/**
 * §48/§5 `POST /businesses/{id}/verification` is self-attested in this build, and a merchant's own
 * `verification_status` column is the only authority. An unrecognised value is `unknown` — the console
 * never upgrades a status it does not recognise into "verified".
 */
export function verificationStateOf(raw: unknown): VerificationState {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (['verified', 'approved', 'active'].includes(value)) return 'verified';
  if (['pending', 'in_review', 'submitted'].includes(value)) return 'pending';
  if (['unverified', 'rejected', 'none', 'not_submitted'].includes(value)) return 'unverified';
  return 'unknown';
}

/** §5 offering statuses the console may offer on the create/edit form (writes only). */
export const OFFERING_STATUSES = ['draft', 'active', 'archived', 'out_of_stock'] as const;

/* ------------------------------------------------ imports (§22, §5.1) */

/**
 * §5.1/§22: an import proposal is a *proposal*. The platform's own state vocabulary for the job is
 * `queued|running|succeeded|failed` (with `document_status` carrying the raw column), so the console
 * renders those two spellings rather than the SDK's older union — and a proposal is only ever
 * publishable after a human confirms it, which is a per-proposal action (§27).
 */
export const IMPORT_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

export function importJobTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed';
}

/* ------------------------------------------------ conversations (§7, §26) */

/** The two actions `POST /conversations/{id}/handoff-resolve` accepts (§7); `resolved` is the default. */
export const HANDOFF_ACTIONS = ['accepted', 'resolved'] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export function isHandoffAction(value: unknown): value is HandoffAction {
  return typeof value === 'string' && (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

/** True when the thread has a handoff that is still waiting on a person. */
export function threadNeedsHuman(thread: Pick<MerchantConversationThread, 'status' | 'handoffs'>): boolean {
  return thread.status === 'handoff' || threadHasOpenHandoff(thread);
}

/* ------------------------------------------------ knowledge base (§24–26, §52) */

/**
 * One document row from `GET /api/v1/merchant/knowledge-base` (§24–26). The read is deliberately
 * narrow — it reports the document and its chunk count, never chunk text — so a merchant console
 * cannot become a second way to read content. `status` is the platform's own column
 * (`pending|processing|indexed|failed|…`); an unknown value renders itself.
 */
export interface KnowledgeDocument {
  id: string;
  kind: string | null;
  title: string | null;
  source_uri: string | null;
  mime_type: string | null;
  lang: string | null;
  status: string;
  error: string | null;
  /** How many chunks this document is embedded as; null when the read did not state it. */
  chunk_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  demo: boolean;
}

/**
 * §52/§24: only the AI service embeds. A document that is `pending` is *queued* for reindexing, not
 * indexed — the console must not read a queue write as completed work, so this predicate names the
 * states in which the merchant can rely on the agent answering from the document.
 */
export const KNOWLEDGE_INDEXED_STATUSES = ['indexed', 'ready', 'embedded', 'active'] as const;

export function knowledgeDocumentIndexed(document: Pick<KnowledgeDocument, 'status'>): boolean {
  return (KNOWLEDGE_INDEXED_STATUSES as readonly string[]).includes(document.status);
}

export function knowledgeSummary(documents: KnowledgeDocument[]): {
  documents: number;
  chunks: number | null;
  indexed: number;
  awaitingIndex: number;
  failed: number;
} {
  const knownChunks = documents.filter((document) => document.chunk_count !== null);
  return {
    documents: documents.length,
    // A total of nothing stated is not 0 chunks; it is unknown.
    chunks: knownChunks.length === 0 ? null : knownChunks.reduce((sum, document) => sum + (document.chunk_count ?? 0), 0),
    indexed: documents.filter(knowledgeDocumentIndexed).length,
    awaitingIndex: documents.filter((document) => document.status === 'pending' || document.status === 'processing').length,
    failed: documents.filter((document) => document.status === 'failed' || document.error !== null).length,
  };
}
