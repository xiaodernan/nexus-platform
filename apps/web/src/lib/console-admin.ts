/**
 * Server-side data plane for the admin console (§68, §126–127, §70, §9).
 *
 * Four rules this module exists to enforce, all of them observable on the page:
 *
 *  1. **Identity is checked before any read.** `adminGate()` answers "may this caller see the
 *     console?" from the session cookie the page already reads plus the documented `GET /api/v1/me`
 *     read (§3) — it never invents a role, and it **fails closed**: a role it cannot read is
 *     `unverified`, which renders the permission state, never the data (§68 requires
 *     `role IN (platform_admin, platform_ops)`). The mechanism is deliberately the one the existing
 *     consoles use (cookie presence) extended by the one documented role read, not a new cookie.
 *  2. **A failed read is a failed read.** Every reader returns a `ConsoleRead` naming the documented
 *     endpoint it called; the page renders `ReadFailure` with the §1 error code. Nothing here
 *     backfills a live read with a fixture (D6).
 *  3. **Derived numbers name their formula.** `degradedRate`, `zeroResultRate`, `topIntents` and
 *     `costShare` are pure, take only rows the platform returned, and return `null` when the
 *     denominator is missing — a rate with no denominator is not 0%.
 *  4. **Unspecified shapes degrade visibly.** §9 lists the admin *paths* but not their payloads, so
 *     every row reader is written against the field names of the nearest documented projection
 *     (§4 for merchants, §3 for users) and yields `null` for anything the wire does not say. A
 *     differently-shaped payload renders `—`; it never becomes an invented value.
 *
 * Mock mode (`NEXT_PUBLIC_DATA_MODE=mock`, the default) is the demo data plane: fixtures here are
 * deterministic projections of the same seed catalogue the consumer pages already serve, every one
 * of them is `demo: true` and carries a `fixture:` source label, and the pages carry the demo
 * banner (§109, §155). No fixture is ever returned for a *live* read.
 */

import { nexusGet } from './api/base';
import { IS_MOCK } from './env';
import {
  conversionRate,
  costRowTokens,
  failedRead,
  moderationCaseResolvable,
  moderationCaseStatusOf,
  moderationDecisionOf,
  okRead,
  searchDailySeries,
  type AdminSearchDay,
  type ConsoleRead,
  type ModerationCaseStatus,
  type ModerationDecision,
} from './console-shared';
import { fixtureReviewQueue } from './console-fixtures';
import { SEED_MERCHANTS } from './mock/seed';

/* ------------------------------------------------------------------ sources (§9) */

/** Every endpoint this module reads, spelled exactly as `docs/API_CONTRACT.md` §9 spells it. */
export const ADMIN_SOURCES = {
  me: 'GET /api/v1/me',
  merchants: 'GET /api/v1/admin/merchants',
  users: 'GET /api/v1/admin/users',
  orders: 'GET /api/v1/admin/orders',
  reservations: 'GET /api/v1/admin/reservations',
  moderation: 'GET /api/v1/admin/moderation',
  moderationResolve: 'POST /api/v1/admin/moderation/{case_id}/resolve',
  merchantSuspend: 'POST /api/v1/admin/merchants/{id}/suspend',
  aiRuns: 'GET /api/v1/admin/ai/runs',
  aiCosts: 'GET /api/v1/admin/ai/costs',
  aiAsk: 'POST /api/v1/admin/ai/ask',
  searchAnalytics: 'GET /api/v1/admin/search/analytics',
  systemHealth: 'GET /api/v1/admin/system/health',
} as const;

/** BFF paths the browser components post to — the proxy forwards these to the platform (§0.1). */
export const ADMIN_BFF = {
  moderationResolve: '/api/nexus/platform/admin/moderation',
  merchantSuspend: '/api/nexus/platform/admin/merchants',
  aiAsk: '/api/nexus/platform/admin/ai/ask',
} as const;

const DEMO_SOURCE = (endpoint: string) => `fixture:console-admin (mirrors ${endpoint})`;

/* ------------------------------------------------------------------ wire helpers */

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function intOf(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function boolOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** First key present with a non-empty string value; order is the caller's preference order. */
function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = str(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = intOf(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function errorCodeOf(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'upstream_unreachable';
}

function requestIdOf(cause: unknown): string | null {
  const id = (cause as { requestId?: unknown } | null)?.requestId;
  return typeof id === 'string' ? id : null;
}

/** The payload's own clock, under any of the names the contract uses for one (§4 `as_of`). */
function asOfOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  return pickString(payload, ['as_of', 'computed_at', 'generated_at', 'checked_at', 'updated_at']);
}

/* ------------------------------------------------------- pure: identity (§68, §48) */

export const ADMIN_ROLES = ['platform_admin', 'platform_ops'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

/**
 * Breadth-first walk for a role claim. A `role` may arrive as a bare field, inside `user`, or as a
 * `memberships[]` row, so the reader accepts those carriers and nothing else — it never infers an
 * admin role from an unrelated field, and an unreadable payload returns `null` (fail closed).
 */
function walkForRole(payload: unknown): { admin: AdminRole | null; stated: string | null } {
  const seen = new Set<unknown>();
  const queue: unknown[] = [payload];
  let stated: string | null = null;

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;

    for (const key of ['role', 'platform_role', 'roles']) {
      const value = record[key];
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (isAdminRole(candidate)) return { admin: candidate, stated: stated ?? candidate };
        if (typeof candidate === 'string' && stated === null && candidate.trim() !== '') stated = candidate;
      }
    }
    for (const key of ['user', 'me', 'profile', 'memberships', 'permission_grants']) {
      const child = record[key];
      if (Array.isArray(child)) queue.push(...child);
      else if (child && typeof child === 'object') queue.push(child);
    }
  }
  return { admin: null, stated };
}

/** The admin role the payload grants, or `null`. Never guesses (§68). */
export function parseAdminRole(payload: unknown): AdminRole | null {
  return walkForRole(payload).admin;
}

/** The role the payload states, admin or not — used only to word the permission-denied state. */
export function parseStatedRole(payload: unknown): string | null {
  return walkForRole(payload).stated;
}

export type AdminAccess =
  | {
      granted: true;
      role: AdminRole;
      /** True ⇒ the identity is a demo fixture, not an authenticated platform role (§155). */
      demo: boolean;
      source: string;
      asOf: string | null;
    }
  | { granted: false; reason: 'sign_in_required' }
  | { granted: false; reason: 'forbidden'; statedRole: string | null }
  | { granted: false; reason: 'unverified'; errorCode: string; requestId: string | null };

/**
 * May the acting user see the admin console? Checked once per page, before any data read, so a
 * denied caller never causes an admin request to be issued at all.
 */
export async function adminGate(session: {
  signedIn: boolean;
  cookieHeader?: string | null;
}): Promise<AdminAccess> {
  if (IS_MOCK) {
    // The demo data plane has no session by construction; the demo identity is stated on the page.
    return {
      granted: true,
      role: 'platform_admin',
      demo: true,
      source: DEMO_SOURCE(ADMIN_SOURCES.me),
      asOf: null,
    };
  }
  if (!session.signedIn) return { granted: false, reason: 'sign_in_required' };

  try {
    const payload = await nexusGet<unknown>('platform', '/api/v1/me', {
      cache: 'no-store',
      cookieHeader: session.cookieHeader ?? null,
    });
    const role = parseAdminRole(payload);
    if (role) return { granted: true, role, demo: false, source: ADMIN_SOURCES.me, asOf: asOfOf(recordOf(payload)) };
    return { granted: false, reason: 'forbidden', statedRole: parseStatedRole(payload) };
  } catch (cause) {
    // Not "denied": we do not know. Fail closed and say which read failed (§105).
    return { granted: false, reason: 'unverified', errorCode: errorCodeOf(cause), requestId: requestIdOf(cause) };
  }
}

/* ------------------------------------------------ pure: derived metrics (§70, §160) */

/** One `agent_runs` row, as the admin AI views need it (§70, §7). */
export interface AdminAgentRun {
  id: string;
  agent: string;
  model: string | null;
  provider: string | null;
  status: string | null;
  /** True when the answer was served down the §105 ladder rather than by the primary path. */
  degraded: boolean;
  latency_ms: number | null;
  tokens: number | null;
  cost_usd: number | null;
  started_at: string | null;
  conversation_id: string | null;
}

/**
 * §70/OBSERVABILITY §2: a run is degraded when it says `status='fallback'`/`degraded` **or** carries
 * `fallback_used`. Both spellings are accepted because the contract uses both, and the page prints
 * this definition next to the rate so the number cannot be read as something else.
 */
export function isDegradedRun(run: Pick<AdminAgentRun, 'status' | 'degraded'>): boolean {
  return run.degraded || run.status === 'fallback' || run.status === 'degraded';
}

/** Degraded share of the runs given; `null` when there are no runs (no denominator, no rate). */
export function degradedRate(runs: Array<Pick<AdminAgentRun, 'status' | 'degraded'>>): number | null {
  if (runs.length === 0) return null;
  return runs.filter(isDegradedRun).length / runs.length;
}

export interface AdminSearchQuery {
  query: string;
  intent: string | null;
  results: number | null;
  at: string | null;
}

/** Share of *known* result counts that were zero; a query whose count the wire omits is not counted. */
export function zeroResultRate(queries: AdminSearchQuery[]): number | null {
  const known = queries.filter((entry) => entry.results !== null);
  if (known.length === 0) return null;
  return known.filter((entry) => entry.results === 0).length / known.length;
}

export interface IntentShare {
  intent: string;
  count: number;
  share: number | null;
}

/** Intent histogram over the queries that state one, biggest first (ties by name, so it is stable). */
export function topIntents(queries: AdminSearchQuery[], limit = 8): IntentShare[] {
  const counts = new Map<string, number>();
  for (const entry of queries) {
    if (!entry.intent) continue;
    counts.set(entry.intent, (counts.get(entry.intent) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .map(([intent, count]) => ({ intent, count, share: conversionRate(count, total) }))
    .sort((left, right) => right.count - left.count || left.intent.localeCompare(right.intent))
    .slice(0, Math.max(0, limit));
}

export type DependencyState = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * Map a dependency's own word for its state onto the four the console renders. `GET
 * /admin/system/health` reports the key/value backend as `redis`/`in_memory` (which store is
 * serving — a fact, and an up one) and the AI service as `configured`/`not_configured`, which is a
 * *configuration* answer, not a health probe: those stay `unknown` on purpose, and the raw word is
 * rendered verbatim so the console cannot soften a state it did not classify.
 */
export function dependencyStateOf(raw: unknown): DependencyState {
  const value = typeof raw === 'string' ? raw.toLowerCase() : null;
  if (!value) return 'unknown';
  if (['ok', 'up', 'healthy', 'ready', 'pass', 'green', 'redis', 'in_memory'].includes(value)) return 'ok';
  if (['degraded', 'warn', 'warning', 'partial', 'slow'].includes(value)) return 'degraded';
  if (['down', 'fail', 'failed', 'error', 'unhealthy', 'unreachable', 'not_ready'].includes(value)) return 'down';
  return 'unknown';
}

/** Worst state wins; an empty list is `unknown`, never `ok` (§155: absence is not a pass). */
export function healthRollup(states: DependencyState[]): DependencyState {
  if (states.length === 0) return 'unknown';
  if (states.includes('down')) return 'down';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('unknown')) return 'unknown';
  return 'ok';
}

/** A part-of-total share; `null` when the total is zero — 0 spend is not a 0% share (§19). */
export function costShare(part: number | null, total: number | null): number | null {
  if (part === null || total === null) return null;
  return conversionRate(part, total);
}

/** Sum of the values that exist; `null` when none do (a total of nothing is not 0). */
export function sumOf(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

/* ------------------------------------------------------------------ read plumbing */

interface PageResult<T> {
  items: T[];
  totalEstimate: number | null;
  asOf: string | null;
  demo: boolean;
}

type ReadOutcome<T> = { ok: true; page: PageResult<T> } | { ok: false; errorCode: string; requestId: string | null };

/**
 * One §1 `Paging` read. `mapRow` returns `null` for a row the console cannot describe, and such a
 * row is dropped rather than rendered as a blank line — the count that remains is then reported
 * against the rows actually kept, not against `total_estimate`.
 */
async function readPage<T>(
  path: string,
  options: {
    searchParams?: Record<string, string | number | undefined | null>;
    mapRow: (row: Record<string, unknown>) => T | null;
  },
): Promise<ReadOutcome<T>> {
  try {
    const payload = await nexusGet<unknown>('platform', path, {
      searchParams: options.searchParams,
      cache: 'no-store',
    });
    const record = recordOf(payload);
    const rawItems = listOf(record?.items ?? payload);
    const items: T[] = [];
    for (const raw of rawItems) {
      const row = recordOf(raw);
      if (!row) continue;
      const mapped = options.mapRow(row);
      if (mapped !== null) items.push(mapped);
    }
    return {
      ok: true,
      page: {
        items,
        totalEstimate: intOf(record?.total_estimate),
        asOf: asOfOf(record),
        demo: false,
      },
    };
  } catch (cause) {
    return { ok: false, errorCode: errorCodeOf(cause), requestId: requestIdOf(cause) };
  }
}

function failedFrom<T>(path: string, outcome: Extract<ReadOutcome<T>, { ok: false }>): ConsoleRead<T> {
  return failedRead<T>({ source: path, errorCode: outcome.errorCode, requestId: outcome.requestId });
}

/* ------------------------------------------------------------ merchants (§68) */

export interface AdminMerchantRow {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
  category: string | null;
  locations: number | null;
  rating: string | null;
  reviews: number | null;
  plan: string | null;
  created_at: string | null;
  demo: boolean;
}

function mapMerchantRow(row: Record<string, unknown>): AdminMerchantRow | null {
  const id = pickString(row, ['id', 'merchant_id']);
  if (!id) return null;
  const ratingValue = num(row.rating);
  return {
    id,
    name: pickString(row, ['display_name', 'name', 'title']) ?? id,
    slug: pickString(row, ['slug']),
    status: pickString(row, ['status']),
    category: pickString(row, ['category_primary', 'category']),
    locations: pickNumber(row, ['location_count', 'locations']),
    rating: pickString(row, ['rating']) ?? (ratingValue === null ? null : ratingValue.toFixed(2)),
    reviews: pickNumber(row, ['review_count', 'reviews']),
    plan: pickString(row, ['plan']),
    created_at: pickString(row, ['created_at', 'published_at']),
    demo: row.data_origin === 'demo',
  };
}

export async function adminMerchantsRead(options: { limit?: number } = {}): Promise<ConsoleRead<AdminMerchantRow[]>> {
  const path = ADMIN_SOURCES.merchants;
  if (IS_MOCK) {
    const data = demoMerchantRows();
    return okRead({ data, origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  }
  const outcome = await readPage(path, {
    searchParams: { limit: options.limit ?? 50 },
    mapRow: mapMerchantRow,
  });
  if (!outcome.ok) return failedFrom(path, outcome);
  return okRead({
    data: outcome.page.items,
    origin: 'live',
    source: path,
    asOf: outcome.page.asOf,
    demo: outcome.page.demo,
  });
}

/* ----------------------------------------------------------------- users (§68) */

export interface AdminUserRow {
  id: string;
  display_name: string;
  email: string | null;
  locale: string | null;
  roles: string[];
  created_at: string | null;
  demo: boolean;
}

function mapUserRow(row: Record<string, unknown>): AdminUserRow | null {
  const id = pickString(row, ['id', 'user_id']);
  if (!id) return null;
  const memberships = listOf(row.memberships)
    .map((entry) => str(recordOf(entry)?.role))
    .filter((role): role is string => role !== null);
  const bareRole = pickString(row, ['role']);
  return {
    id,
    display_name: pickString(row, ['display_name', 'name']) ?? id,
    email: pickString(row, ['email']),
    locale: pickString(row, ['locale']),
    roles: bareRole ? [bareRole, ...memberships] : memberships,
    created_at: pickString(row, ['created_at']),
    demo: row.data_origin === 'demo',
  };
}

export async function adminUsersRead(): Promise<ConsoleRead<AdminUserRow[]>> {
  const path = ADMIN_SOURCES.users;
  if (IS_MOCK) return okRead({ data: demoUserRows(), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  const outcome = await readPage(path, { searchParams: { limit: 50 }, mapRow: mapUserRow });
  if (!outcome.ok) return failedFrom(path, outcome);
  return okRead({
    data: outcome.page.items,
    origin: 'live',
    source: path,
    asOf: outcome.page.asOf,
    demo: outcome.page.demo,
  });
}

/* -------------------------------------------------- orders & reservations (§68) */

export interface AdminOrderRow {
  id: string;
  status: string | null;
  total: { amount: string; currency: string } | null;
  item_count: number | null;
  merchant_name: string | null;
  created_at: string | null;
  demo: boolean;
}

function mapMoney(value: unknown): { amount: string; currency: string } | null {
  const record = recordOf(value);
  const amount = record ? str(record.amount) : null;
  const currency = record ? str(record.currency) : null;
  if (amount && currency) return { amount, currency };
  return null;
}

function mapOrderRow(row: Record<string, unknown>): AdminOrderRow | null {
  const id = pickString(row, ['id', 'order_id', 'code']);
  if (!id) return null;
  return {
    id,
    status: pickString(row, ['status']),
    total: mapMoney(row.total ?? row.total_amount ?? row.amount),
    item_count: pickNumber(row, ['item_count', 'items_count', 'line_count']),
    merchant_name: pickString(row, ['merchant_name', 'merchant']),
    created_at: pickString(row, ['created_at', 'placed_at']),
    demo: row.data_origin === 'demo',
  };
}

export async function adminOrdersRead(): Promise<ConsoleRead<AdminOrderRow[]>> {
  const path = ADMIN_SOURCES.orders;
  if (IS_MOCK) return okRead({ data: demoOrderRows(), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  const outcome = await readPage(path, { searchParams: { limit: 50 }, mapRow: mapOrderRow });
  if (!outcome.ok) return failedFrom(path, outcome);
  return okRead({
    data: outcome.page.items,
    origin: 'live',
    source: path,
    asOf: outcome.page.asOf,
    demo: outcome.page.demo,
  });
}

export interface AdminReservationRow {
  id: string;
  status: string | null;
  party_size: number | null;
  starts_at: string | null;
  merchant_name: string | null;
  created_at: string | null;
  demo: boolean;
}

function mapReservationRow(row: Record<string, unknown>): AdminReservationRow | null {
  const id = pickString(row, ['id', 'reservation_id', 'code']);
  if (!id) return null;
  return {
    id,
    status: pickString(row, ['status']),
    party_size: pickNumber(row, ['party_size', 'party']),
    starts_at: pickString(row, ['starts_at', 'start_at']),
    merchant_name: pickString(row, ['merchant_name', 'merchant']),
    created_at: pickString(row, ['created_at', 'booked_at']),
    demo: row.data_origin === 'demo',
  };
}

export async function adminReservationsRead(): Promise<ConsoleRead<AdminReservationRow[]>> {
  const path = ADMIN_SOURCES.reservations;
  if (IS_MOCK) {
    return okRead({ data: demoReservationRows(), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  }
  const outcome = await readPage(path, { searchParams: { limit: 50 }, mapRow: mapReservationRow });
  if (!outcome.ok) return failedFrom(path, outcome);
  return okRead({
    data: outcome.page.items,
    origin: 'live',
    source: path,
    asOf: outcome.page.asOf,
    demo: outcome.page.demo,
  });
}

/* ------------------------------------------------------- moderation queue (§27) */
/*
 * The queue reader lives under "moderation cases" below: the platform serves moderation as *cases*
 * (`GET /api/v1/admin/moderation` → `{case_id, subject_type, status: open|resolved, resolution}`),
 * not as review rows, so a reader written against a `title`/`kind`/`actor` row shape would invent a
 * subject type the payload never carried. The earlier speculative shape was removed rather than
 * patched, because "kind: listing_change" for a review case is a fabricated classification (§109).
 */

/* ------------------------------------------- moderation cases (§9, §27, §127) */

/** The merchant behind a review case — enough for a reviewer to see whether the page is reachable. */
export interface AdminModerationMerchant {
  id: string | null;
  slug: string | null;
  name: string | null;
  /** `published` | `pending_review` | `suspended` | … — publishing for a suspended shop is moot. */
  status: string | null;
}

export interface AdminModerationSubject {
  review_id: string | null;
  rating: string | null;
  excerpt: string | null;
  language: string | null;
  status: string | null;
  merchant: AdminModerationMerchant | null;
}

/**
 * The case the platform actually serves (`GET /api/v1/admin/moderation`), not the review's own
 * status vocabulary. `case_status` is `open|resolved`; what the review *became* lives in
 * `resolution.decision` (§9 `POST /moderation/{id}/resolve`). Keeping the two apart is what stops
 * the console printing a decision nobody made — an `open` case is never "approved".
 */
export interface AdminModerationCase {
  case_id: string;
  subject_type: string | null;
  subject_id: string | null;
  reason: string | null;
  policy: string | null;
  auto_action: string | null;
  case_status: ModerationCaseStatus;
  /** The decision recorded on a resolved case, or null when the case states none. */
  resolution: ModerationDecision | null;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string | null;
  /** False ⇒ the subject row is gone; the case is still listed, it just has nothing to show. */
  subject_known: boolean;
  subject: AdminModerationSubject | null;
  demo: boolean;
}

function mapMerchant(value: unknown): AdminModerationMerchant | null {
  const record = recordOf(value);
  if (!record) return null;
  const id = pickString(record, ['id']);
  const slug = pickString(record, ['slug']);
  const name = pickString(record, ['name', 'display_name']);
  const status = pickString(record, ['status']);
  if (!id && !slug && !name && !status) return null;
  return { id, slug, name, status };
}

function mapModerationCase(row: Record<string, unknown>): AdminModerationCase | null {
  const caseId = pickString(row, ['case_id', 'id']);
  if (!caseId) return null;
  const resolutionRecord = recordOf(row.resolution);
  const subjectRecord = recordOf(row.subject);
  const subject: AdminModerationSubject | null = subjectRecord
    ? {
        review_id: pickString(subjectRecord, ['review_id']),
        rating: pickString(subjectRecord, ['rating']) ?? (num(subjectRecord.rating) === null ? null : String(num(subjectRecord.rating))),
        excerpt: pickString(subjectRecord, ['excerpt', 'body', 'body_excerpt']),
        language: pickString(subjectRecord, ['language', 'lang']),
        status: pickString(subjectRecord, ['status']),
        merchant: mapMerchant(subjectRecord.merchant),
      }
    : null;
  return {
    case_id: caseId,
    subject_type: pickString(row, ['subject_type']),
    subject_id: pickString(row, ['subject_id']),
    reason: pickString(row, ['reason']),
    policy: pickString(row, ['policy']),
    auto_action: pickString(row, ['auto_action']),
    case_status: moderationCaseStatusOf(row.status),
    resolution: moderationDecisionOf(row.resolution),
    resolution_note: resolutionRecord ? pickString(resolutionRecord, ['note']) : null,
    resolved_at: pickString(row, ['resolved_at']),
    created_at: pickString(row, ['created_at']),
    subject_known: row.subject_known === true,
    subject,
    demo: row.data_origin === 'demo',
  };
}

/**
 * §9/§127 the moderation queue as cases. `status` is the **case** filter (`open`/`resolved`), not
 * the review's status; the served route rejects anything else with a 422. Only `open` `review`
 * cases can be resolved today — the route says so itself — which `moderationCaseResolvable` mirrors
 * so the page does not offer a button the platform will refuse.
 */
export async function adminModerationCasesRead(
  options: { status?: ModerationCaseStatus | 'all' } = {},
): Promise<ConsoleRead<AdminModerationCase[]>> {
  const path = ADMIN_SOURCES.moderation;
  if (IS_MOCK) {
    const data: AdminModerationCase[] = fixtureReviewQueue().map((item, index) => ({
      case_id: `demo-case-${index + 1}`,
      subject_type: 'review',
      subject_id: item.id,
      reason: item.actor === 'merchant' ? null : 'policy_review',
      policy: '§27 publish gate',
      auto_action: null,
      case_status: item.status === 'pending' ? 'open' : 'resolved',
      resolution: item.status === 'approved' ? 'published' : item.status === 'rejected' ? 'rejected' : null,
      resolution_note: item.status === 'pending' ? null : 'fixture: demo decision',
      resolved_at: item.status === 'pending' ? null : item.submitted_at,
      created_at: item.submitted_at,
      subject_known: true,
      subject: {
        review_id: item.id,
        rating: item.kind === 'guide' ? null : '4',
        excerpt: item.summary,
        language: 'zh-HK',
        status: item.status === 'approved' ? 'published' : 'pending',
        merchant: item.merchant_name ? { id: null, slug: null, name: item.merchant_name, status: 'published' } : null,
      },
      demo: true,
    }));
    const filtered = options.status && options.status !== 'all' ? data.filter((item) => item.case_status === options.status) : data;
    const asOf = filtered[0]?.created_at ?? null;
    return okRead({ data: filtered, origin: 'mock', source: DEMO_SOURCE(path), asOf, demo: true });
  }
  const outcome = await readPage(path, {
    searchParams: { status: options.status === 'all' ? undefined : (options.status ?? 'open'), limit: 50 },
    mapRow: mapModerationCase,
  });
  if (!outcome.ok) return failedFrom(path, outcome);
  return okRead({
    data: outcome.page.items,
    origin: 'live',
    source: path,
    asOf: outcome.page.asOf,
    demo: outcome.page.demo,
  });
}

/** Which cases a reviewer can actually act on here, so the page can say why the rest have no button. */
export function resolvableCases(cases: AdminModerationCase[]): AdminModerationCase[] {
  return cases.filter((item) => moderationCaseResolvable({ case_status: item.case_status, subject_type: item.subject_type }));
}

/* ----------------------------------------------------------- overview (§68, §9) */

export interface AdminCounterFailure {
  source: string;
  errorCode: string;
}

/** Case-shaped counts (§9/§127) — the queue is cases, and the overview must not restate them as kinds. */
export interface AdminModerationCounts {
  total: number;
  open: number;
  resolved: number;
  /** Cases a reviewer can act on here: `open` **and** `subject_type='review'` (§9). */
  resolvable: number;
}

export function moderationCounts(cases: AdminModerationCase[]): AdminModerationCounts {
  return {
    total: cases.length,
    open: cases.filter((item) => item.case_status === 'open').length,
    resolved: cases.filter((item) => item.case_status === 'resolved').length,
    resolvable: resolvableCases(cases).length,
  };
}

export interface AdminCounters {
  users: number | null;
  merchants: number | null;
  orders: number | null;
  reservations: number | null;
  /** Counted from the merchant rows this read received, so it can be `null` while `merchants` is not. */
  suspendedMerchants: number | null;
  moderation: AdminModerationCounts | null;
  /** Endpoints this composite read actually called, so the page can name them all. */
  sources: string[];
  /** Reads that failed; a non-empty list means the section renders a degraded notice (§105). */
  failures: AdminCounterFailure[];
}

/**
 * The overview counters are **totals the platform reported** (`total_estimate`, §1) — never
 * `items.length`, which is one page and would understate every number on a full list. When the
 * platform omits the estimate the counter stays `null` and the cell renders `—`.
 */
export async function adminCountersRead(): Promise<ConsoleRead<AdminCounters>> {
  const path = ADMIN_SOURCES.merchants;
  if (IS_MOCK) {
    const merchants = demoMerchantRows();
    const users = demoUserRows();
    const orders = demoOrderRows();
    const reservations = demoReservationRows();
    const moderation = await adminModerationCasesRead({ status: 'all' });
    return okRead({
      data: {
        users: users.length,
        merchants: merchants.length,
        orders: orders.length,
        reservations: reservations.length,
        suspendedMerchants: merchants.filter((row) => row.status === 'suspended').length,
        moderation: moderationCounts(moderation.data ?? []),
        sources: [DEMO_SOURCE(ADMIN_SOURCES.users), DEMO_SOURCE(path)],
        failures: [],
      },
      origin: 'mock',
      source: DEMO_SOURCE(path),
      asOf: null,
      demo: true,
    });
  }

  const [users, merchants, orders, reservations, moderation] = await Promise.all([
    readPage(ADMIN_SOURCES.users, { searchParams: { limit: 1 }, mapRow: mapUserRow }),
    readPage(path, { searchParams: { limit: 50 }, mapRow: mapMerchantRow }),
    readPage(ADMIN_SOURCES.orders, { searchParams: { limit: 1 }, mapRow: mapOrderRow }),
    readPage(ADMIN_SOURCES.reservations, { searchParams: { limit: 1 }, mapRow: mapReservationRow }),
    adminModerationCasesRead({ status: 'all' }),
  ]);

  const failures: AdminCounterFailure[] = [];
  for (const [source, outcome] of [
    [ADMIN_SOURCES.users, users],
    [path, merchants],
    [ADMIN_SOURCES.orders, orders],
    [ADMIN_SOURCES.reservations, reservations],
  ] as const) {
    if (!outcome.ok) failures.push({ source, errorCode: outcome.errorCode });
  }
  if (moderation.status === 'failed') {
    failures.push({ source: ADMIN_SOURCES.moderation, errorCode: moderation.errorCode ?? 'upstream_unreachable' });
  }

  const sources = [
    ADMIN_SOURCES.users,
    path,
    ADMIN_SOURCES.orders,
    ADMIN_SOURCES.reservations,
    ADMIN_SOURCES.moderation,
  ];

  if (failures.length === sources.length) {
    return failedRead<AdminCounters>({ source: path, errorCode: failures[0]?.errorCode ?? 'upstream_unreachable' });
  }

  const merchantRows = merchants.ok ? merchants.page.items : [];
  const asOf = [users, merchants, orders, reservations]
    .map((outcome) => (outcome.ok ? outcome.page.asOf : null))
    .concat(moderation.asOf)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

  return okRead({
    data: {
      users: users.ok ? users.page.totalEstimate : null,
      merchants: merchants.ok ? merchants.page.totalEstimate : null,
      orders: orders.ok ? orders.page.totalEstimate : null,
      reservations: reservations.ok ? reservations.page.totalEstimate : null,
      suspendedMerchants: merchants.ok
        ? merchantRows.filter((row) => row.status === 'suspended').length
        : null,
      moderation: moderation.status === 'ok' ? moderationCounts(moderation.data ?? []) : null,
      sources,
      failures,
    },
    origin: 'live',
    source: path,
    asOf,
    demo: false,
  });
}

/* ---------------------------------------------------------------- AI views (§70) */

export interface AdminCostRow {
  key: string;
  /** Runs in this group (`groups[].runs`); null when the payload does not state one. */
  runs: number | null;
  /** prompt_tokens + completion_tokens; null when the payload states neither (§9). */
  tokens: number | null;
  cost_usd: number | null;
  avg_latency_ms: number | null;
  /** Derived here from the rows returned and labelled as derived on the page; never recomputed twice. */
  share: number | null;
}

export type CostGroupBy = 'agent' | 'model' | 'day';

/**
 * A run is degraded when it says `status='fallback'`/`degraded`, when `degraded` is true, or when
 * `fallback_used` states anything other than "no" — the platform serves `fallback_used` as a text
 * column (§9), so a non-empty value that is not `false`/`none` is a fallback having fired.
 */
function fallbackStated(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const lowered = value.trim().toLowerCase();
  return lowered !== '' && lowered !== 'false' && lowered !== 'none' && lowered !== 'no' && lowered !== 'null';
}

function mapRunRow(row: Record<string, unknown>): AdminAgentRun | null {
  const id = pickString(row, ['agent_run_id', 'run_id', 'id']);
  if (!id) return null;
  const promptTokens = intOf(row.prompt_tokens);
  const completionTokens = intOf(row.completion_tokens);
  const explicitTokens = intOf(row.tokens);
  const status = pickString(row, ['status']);
  return {
    id,
    agent: pickString(row, ['agent', 'agent_name']) ?? 'unknown',
    model: pickString(row, ['model']),
    provider: pickString(row, ['provider']),
    status,
    degraded: boolOf(row.degraded) === true || fallbackStated(row.fallback_used),
    latency_ms: intOf(row.latency_ms),
    tokens:
      explicitTokens ?? (promptTokens === null && completionTokens === null ? null : (promptTokens ?? 0) + (completionTokens ?? 0)),
    cost_usd: num(row.cost_usd),
    started_at: pickString(row, ['started_at', 'created_at']),
    conversation_id: pickString(row, ['conversation_id']),
  };
}

export async function adminAiRunsRead(options: { limit?: number } = {}): Promise<ConsoleRead<AdminAgentRun[]>> {
  const path = ADMIN_SOURCES.aiRuns;
  if (IS_MOCK) return okRead({ data: demoAgentRuns(), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  const outcome = await readPage(path, { searchParams: { limit: options.limit ?? 50 }, mapRow: mapRunRow });
  if (!outcome.ok) return failedFrom(path, outcome);
  return okRead({
    data: outcome.page.items,
    origin: 'live',
    source: path,
    asOf: outcome.page.asOf,
    demo: outcome.page.demo,
  });
}

function mapCostRow(row: Record<string, unknown>): AdminCostRow | null {
  const key = pickString(row, ['key', 'group_key', 'group', 'agent', 'model', 'day', 'date', 'name']);
  if (!key) return null;
  const promptTokens = intOf(row.prompt_tokens);
  const completionTokens = intOf(row.completion_tokens);
  return {
    key,
    runs: pickNumber(row, ['runs', 'calls', 'call_count', 'count']),
    tokens: costRowTokens(promptTokens, completionTokens),
    cost_usd: num(row.cost_usd ?? row.cost),
    avg_latency_ms: pickNumber(row, ['avg_latency_ms', 'latency_ms']),
    share: num(row.share),
  };
}

/**
 * `GET /api/v1/admin/ai/costs?group_by=agent|model|day` (§9). The served payload is **not** a §1
 * page: it is `{group_by, groups:[…], totals, allowed_group_by, as_of, source}`, so this reader takes
 * `groups` and nothing else — reading `items` here (as a generic page reader would) would silently
 * return an empty table for a payload that is full of rows.
 *
 * The share column is derived here from the rows the platform returned and is labelled as derived on
 * the page; when the platform already sends a share it is kept as-is rather than recomputed.
 */
export async function adminAiCostsRead(groupBy: CostGroupBy): Promise<ConsoleRead<AdminCostRow[]>> {
  const path = `${ADMIN_SOURCES.aiCosts}?group_by=${groupBy}`;
  if (IS_MOCK) {
    return okRead({ data: demoCostRows(groupBy), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  }
  try {
    const payload = await nexusGet<unknown>('platform', '/api/v1/admin/ai/costs', {
      searchParams: { group_by: groupBy, limit: 100 },
      cache: 'no-store',
    });
    const record = recordOf(payload);
    if (!record) return failedRead({ source: path, errorCode: 'invalid_payload' });
    const rows: AdminCostRow[] = [];
    for (const raw of listOf(record.groups ?? record.items)) {
      const row = recordOf(raw);
      if (!row) continue;
      const mapped = mapCostRow(row);
      if (mapped) rows.push(mapped);
    }
    const total = sumOf(rows.map((row) => row.cost_usd));
    const data = rows.map((row) => (row.share === null ? { ...row, share: costShare(row.cost_usd, total) } : row));
    return okRead({ data, origin: 'live', source: path, asOf: asOfOf(record), demo: false });
  } catch (cause) {
    return failedRead({ source: path, errorCode: errorCodeOf(cause), requestId: requestIdOf(cause) });
  }
}

/* ----------------------------------------------------- search analytics (§9) */

/** One row of the platform's own `by_event` breakdown (`{name, events, sessions}`). */
export interface AdminSearchEventRow {
  name: string;
  events: number | null;
  sessions: number | null;
}

/**
 * `GET /api/v1/admin/search/analytics` (§9) is deliberately **descriptive**: it reports searches,
 * sessions, fulfilled intents and active days over a bounded window, plus the raw event-name
 * breakdown. There is no search-quality or zero-result metric in the schema, and this type has no
 * field for one — inventing it from a count is exactly what §109 forbids. The fulfilment *share* the
 * page may show is derived from these totals and labelled as derived.
 */
export interface AdminSearchAnalytics {
  window_days: number | null;
  totals: {
    searches: number | null;
    sessions: number | null;
    fulfilled_intents: number | null;
    active_days: number | null;
  };
  daily: AdminSearchDay[];
  by_event: AdminSearchEventRow[];
  /** The platform's own definition of what it counted, rendered verbatim. */
  source: string | null;
  /** The platform's own note, rendered verbatim. */
  note: string | null;
}

export async function adminSearchAnalyticsRead(): Promise<ConsoleRead<AdminSearchAnalytics>> {
  const path = ADMIN_SOURCES.searchAnalytics;
  if (IS_MOCK) {
    return okRead({ data: demoSearchAnalytics(), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  }
  try {
    const payload = await nexusGet<unknown>('platform', '/api/v1/admin/search/analytics', { cache: 'no-store' });
    const record = recordOf(payload);
    if (!record) return failedRead({ source: path, errorCode: 'invalid_payload' });
    const totalsRecord = recordOf(record.totals);
    const byEvent: AdminSearchEventRow[] = [];
    for (const raw of listOf(record.by_event ?? record.byEvent)) {
      const row = recordOf(raw);
      if (!row) continue;
      const name = pickString(row, ['name', 'event', 'key']);
      if (!name) continue;
      byEvent.push({
        name,
        events: pickNumber(row, ['events', 'count']),
        sessions: pickNumber(row, ['sessions']),
      });
    }
    return okRead({
      data: {
        window_days: pickNumber(record, ['window_days', 'days']),
        totals: {
          searches: pickNumber(totalsRecord ?? record, ['searches', 'query_count']),
          sessions: pickNumber(totalsRecord ?? record, ['sessions']),
          fulfilled_intents: pickNumber(totalsRecord ?? record, ['fulfilled_intents']),
          active_days: pickNumber(totalsRecord ?? record, ['active_days']),
        },
        daily: searchDailySeries(listOf(record.daily).map((entry) => recordOf(entry) ?? {})),
        by_event: byEvent,
        source: pickString(record, ['source']),
        note: pickString(record, ['note']),
      },
      origin: 'live',
      source: path,
      asOf: asOfOf(record),
      demo: false,
    });
  } catch (cause) {
    return failedRead({ source: path, errorCode: errorCodeOf(cause), requestId: requestIdOf(cause) });
  }
}

/* --------------------------------------------------- system health (§69, §70) */

export interface AdminDependency {
  name: string;
  state: DependencyState;
  /** The dependency's own word for its state, kept verbatim so the console cannot soften it. */
  raw_status: string | null;
  latency_ms: number | null;
  detail: string | null;
}

export interface AdminSystemHealth {
  overall: DependencyState;
  raw_status: string | null;
  version: string | null;
  /** The Flyway schema version the database reported, or null when it did not state one (§9). */
  schema_version: string | null;
  /** The platform's active Spring profiles, rendered verbatim. */
  profiles: string[];
  dependencies: AdminDependency[];
}

function mapDependency(name: string, value: unknown): AdminDependency {
  if (typeof value === 'string') {
    return { name, state: dependencyStateOf(value), raw_status: value, latency_ms: null, detail: null };
  }
  const record = recordOf(value);
  const rawStatus = record ? pickString(record, ['status', 'state', 'health']) : null;
  return {
    name: pickString(record ?? {}, ['name']) ?? name,
    state: dependencyStateOf(rawStatus ?? (boolOf(record?.ok ?? record?.available) === true ? 'ok' : null)),
    raw_status: rawStatus,
    latency_ms: record ? intOf(record.latency_ms ?? record.latency) : null,
    detail: record ? pickString(record, ['detail', 'message', 'error']) : null,
  };
}

export function parseSystemHealth(payload: unknown): AdminSystemHealth | null {
  const record = recordOf(payload);
  if (!record) return null;
  const container = record.dependencies ?? record.services ?? record.checks ?? record.components;
  const dependencies: AdminDependency[] = [];
  if (Array.isArray(container)) {
    for (const raw of container) {
      const row = recordOf(raw);
      const name = row ? pickString(row, ['name', 'key', 'dependency']) : null;
      if (!name) continue;
      dependencies.push(mapDependency(name, row));
    }
  } else {
    const map = recordOf(container);
    if (map) {
      for (const [name, value] of Object.entries(map)) dependencies.push(mapDependency(name, value));
    }
  }
  const rawStatus = pickString(record, ['status', 'state', 'health']);
  const rollup = healthRollup(dependencies.map((entry) => entry.state));
  const profiles = listOf(record.profiles)
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== null);
  return {
    // A payload that names an overall state and lists no dependency rows is still usable: the
    // rollup is `unknown` there, so the stated word wins. A listed `down` dependency always wins.
    overall: rollup === 'unknown' && rawStatus ? dependencyStateOf(rawStatus) : rollup,
    raw_status: rawStatus,
    version: pickString(record, ['version', 'service_version']),
    schema_version: pickString(record, ['schema_version']),
    profiles,
    dependencies,
  };
}

export async function adminSystemHealthRead(): Promise<ConsoleRead<AdminSystemHealth>> {
  const path = ADMIN_SOURCES.systemHealth;
  if (IS_MOCK) {
    return okRead({ data: demoSystemHealth(), origin: 'mock', source: DEMO_SOURCE(path), asOf: null, demo: true });
  }
  try {
    const payload = await nexusGet<unknown>('platform', '/api/v1/admin/system/health', { cache: 'no-store' });
    const parsed = parseSystemHealth(payload);
    if (!parsed) return failedRead({ source: path, errorCode: 'invalid_payload' });
    return okRead({
      data: parsed,
      origin: 'live',
      source: path,
      asOf: asOfOf(recordOf(payload)),
      demo: false,
    });
  } catch (cause) {
    return failedRead({ source: path, errorCode: errorCodeOf(cause), requestId: requestIdOf(cause) });
  }
}

/* ------------------------------------------------------------ demo catalogue */

/**
 * The demo data plane. Every row below is a deterministic projection of the seed catalogue the
 * consumer pages already serve as demo data (`mock/seed.ts`) — the same merchants, the same ratings
 * — so the console cannot show an operator a merchant the rest of the demo does not have. Sources
 * are labelled `fixture:…`, every row is `demo: true`, and the pages carry the demo banner (§109).
 */
function demoMerchantRows(): AdminMerchantRow[] {
  return SEED_MERCHANTS.map((seed, index) => ({
    id: seed.id,
    name: seed.name,
    slug: seed.slug,
    // The last demo merchant is suspended so the suspend state (and its confirm flow) is reviewable.
    status: index === SEED_MERCHANTS.length - 1 ? 'suspended' : 'published',
    category: seed.category,
    locations: 1,
    rating: seed.ratingValue === null ? null : seed.ratingValue.toFixed(2),
    reviews: seed.ratingCount,
    plan: 'pro',
    created_at: null,
    demo: true,
  }));
}

function demoUserRows(): AdminUserRow[] {
  const names = SEED_MERCHANTS.flatMap((seed) => seed.reviewSeed.map((review) => review.name));
  const unique = [...new Set(names)].slice(0, 8);
  return unique.map((name, index) => ({
    id: `demo-user-${index + 1}`,
    display_name: name,
    // `.invalid` is reserved by RFC 2606 and can never route, which is the point for demo contact data.
    email: `demo.consumer.${index + 1}@example.invalid`,
    locale: index % 3 === 0 ? 'en' : 'zh-HK',
    roles: ['consumer'],
    created_at: null,
    demo: true,
  }));
}

function demoOrderRows(): AdminOrderRow[] {
  return SEED_MERCHANTS.slice(0, 6).map((seed, index) => {
    const price = seed.priceAmount ?? '0';
    const quantity = (index % 3) + 1;
    const amount = (Number.parseFloat(price) * quantity).toFixed(2);
    return {
      id: `NX-ORD-DEMO${String(index + 1).padStart(3, '0')}`,
      status: index % 4 === 3 ? 'refunded' : index % 2 === 0 ? 'paid' : 'pending',
      total: { amount, currency: seed.currency },
      item_count: quantity,
      merchant_name: seed.name,
      created_at: null,
      demo: true,
    };
  });
}

function demoReservationRows(): AdminReservationRow[] {
  return SEED_MERCHANTS.filter((seed) => seed.seats)
    .slice(0, 6)
    .map((seed, index) => ({
      id: `NX-RES-DEMO${String(index + 1).padStart(3, '0')}`,
      status: index % 3 === 2 ? 'cancelled' : 'pending',
      party_size: (index % 4) + 2,
      starts_at: null,
      merchant_name: seed.name,
      created_at: null,
      demo: true,
    }));
}

/** Real agent names from AGENT_CONTRACT §1 — a demo run for an agent that does not exist would be a lie. */
const DEMO_AGENTS = [
  'user_intent',
  'search',
  'ranking',
  'recommendation',
  'customer_service',
  'review',
  'fact_verification',
  'seo',
  'analytics',
] as const;

function demoAgentRuns(): AdminAgentRun[] {
  return DEMO_AGENTS.map((agent, index) => {
    // Every third run is degraded: the console must be able to show a non-zero degraded rate.
    const degraded = index % 3 === 2;
    return {
      id: `demo-run-${String(index + 1).padStart(3, '0')}`,
      agent,
      model: 'mock',
      provider: 'mock',
      status: degraded ? 'fallback' : 'succeeded',
      degraded,
      latency_ms: 180 + index * 37,
      tokens: 420 + index * 55,
      // D4: with `provider=mock` there is no real spend, and the page says so rather than printing $0 as a fact.
      cost_usd: null,
      started_at: null,
      conversation_id: null,
    };
  });
}

function demoCostRows(groupBy: CostGroupBy): AdminCostRow[] {
  const runs = demoAgentRuns();
  const groups = new Map<string, AdminAgentRun[]>();
  for (const run of runs) {
    const key = groupBy === 'agent' ? run.agent : groupBy === 'model' ? (run.model ?? 'unknown') : 'demo-day';
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const total = sumOf([...groups.values()].map((rows) => sumOf(rows.map((row) => row.cost_usd))));
  return [...groups.entries()].map(([key, rows]) => {
    const cost = sumOf(rows.map((row) => row.cost_usd));
    return {
      key,
      runs: rows.length,
      tokens: sumOf(rows.map((row) => row.tokens)),
      cost_usd: cost,
      avg_latency_ms: sumOf(rows.map((row) => row.latency_ms)),
      share: costShare(cost, total),
    };
  });
}

function demoSearchAnalytics(): AdminSearchAnalytics {
  const seed = SEED_MERCHANTS;
  const totalSearches = 34 + seed.length;
  const days = 7;
  const daily: AdminSearchDay[] = Array.from({ length: days }, (_, index) => {
    const share = (index + 1) / ((days * (days + 1)) / 2);
    return {
      day: new Date(Date.now() - (days - index - 1) * 86_400_000).toISOString().slice(0, 10),
      sessions: Math.round(totalSearches * share * 0.8),
      searches: Math.round(totalSearches * share),
      fulfilled_intents: Math.round(totalSearches * share * 0.45),
    };
  });
  const totals = {
    searches: daily.reduce((sum, day) => sum + (day.searches ?? 0), 0),
    sessions: daily.reduce((sum, day) => sum + (day.sessions ?? 0), 0),
    fulfilled_intents: daily.reduce((sum, day) => sum + (day.fulfilled_intents ?? 0), 0),
    active_days: days,
  };
  return {
    window_days: days,
    totals,
    daily,
    by_event: [
      { name: 'search', events: totals.searches, sessions: totals.sessions },
      { name: 'view_merchant', events: Math.round(totals.searches * 1.4), sessions: totals.sessions },
      { name: 'reserve', events: Math.round(totals.fulfilled_intents * 0.6), sessions: Math.round(totals.sessions * 0.3) },
      { name: 'favorite', events: Math.round(totals.fulfilled_intents * 0.4), sessions: Math.round(totals.sessions * 0.2) },
    ],
    source: 'fixture:console-admin (a deterministic projection of the demo catalogue, not a measurement)',
    note: 'Demo counts. The platform read reports descriptive totals only; there is no search-quality score (§109).',
  };
}

function demoSystemHealth(): AdminSystemHealth {
  const dependencies: AdminDependency[] = [
    { name: 'platform', state: 'ok', raw_status: 'ok', latency_ms: 12, detail: 'fixture: demo plane' },
    { name: 'ai', state: 'degraded', raw_status: 'degraded', latency_ms: 240, detail: 'fixture: NEXUS_LLM_PROVIDER=mock (D4)' },
    { name: 'postgres', state: 'ok', raw_status: 'ok', latency_ms: 4, detail: 'fixture: 127.0.0.1:5433' },
    { name: 'redis', state: 'unknown', raw_status: null, latency_ms: null, detail: null },
  ];
  return {
    overall: healthRollup(dependencies.map((entry) => entry.state)),
    raw_status: null,
    version: null,
    schema_version: null,
    profiles: [],
    dependencies,
  };
}
