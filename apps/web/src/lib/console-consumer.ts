/**
 * Server-side data plane for the consumer account hub (`/me`). Mirrors `console-merchant.ts`:
 * pages never fetch, this module decides between the mock catalogue (`mockMe`, always demo-badged)
 * and live platform reads taken with the caller's session cookie (`nexusAuthedGet`). A read that
 * fails renders visibly as `failedRead` — nothing here silently backfills a live read with fixtures
 * (data.ts header, §155, D6).
 *
 * Identity: in mock mode the demo identity always exists. Live mode trusts the session cookie that
 * `/signin` set; a missing cookie is the page's decision (`meSession`), this module only answers
 * the reads once that decision is made.
 */

import { IS_MOCK, SESSION_COOKIE } from './env';
import { nexusAuthedGet } from './api/base';
import { getMerchantCard } from './merchant-card-cache';
import { failedRead, okRead, type ConsoleRead } from './console-shared';
import { mockMe } from './mock';
import type { EntityCard } from '@nexus/ui/trust/types';
import { currentLocale } from './i18n/server';

if (typeof window !== 'undefined') {
  throw new Error('console-consumer is server-only: the browser must call /api/nexus/**, never a service origin');
}

export const PROFILE_SOURCE = 'GET /api/v1/me';
export const FAVORITES_SOURCE = 'GET /api/v1/me/favorites';
export const RESERVATIONS_SOURCE = 'GET /api/v1/me/reservations';
export const ORDERS_SOURCE = 'GET /api/v1/me/orders';
export const SAVED_SEARCHES_SOURCE = 'GET /api/v1/me/saved-searches';
export const NOTIFICATIONS_SOURCE = 'GET /api/v1/notifications';
export const PREFERENCES_SOURCE = 'GET /api/v1/me/preferences';

function reasonOf(cause: unknown): string {
  const code = (cause as { code?: string } | null)?.code;
  return typeof code === 'string' ? code : 'upstream_unreachable';
}

/* ------------------------------------------------------------------ identity */

export interface MeSession {
  locale: string;
  signedIn: boolean;
  /** True ⇒ this render must not issue live reads. */
  blocked: boolean;
}

/** Identity for `app/me/**`. Mock mode always has the demo identity; live mode trusts `/signin`'s cookie. */
export async function meSession(): Promise<MeSession> {
  const locale = await currentLocale();
  if (IS_MOCK) return { locale, signedIn: true, blocked: false };
  // Imported lazily so the unit tests never load next/headers (merchant-shell pattern).
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  const signedIn = Boolean(jar.get(SESSION_COOKIE)?.value);
  return { locale, signedIn, blocked: !signedIn };
}

/* ----------------------------------------------------------------- profile */

export interface MeMembership {
  role: string;
  merchantName: string | null;
  merchantSlug: string | null;
}

export interface MeProfileView {
  id: string;
  displayName: string;
  email: string;
  locale: string;
  avatarUrl: string | null;
  tenant: string | null;
  createdAt: string | null;
  memberships: MeMembership[];
  preferencesUsed: number;
  demo: boolean;
}

interface WireMembership {
  role?: string | null;
  status?: string | null;
  merchant?: { slug?: string | null; display_name?: string | null } | null;
}

interface WireMeProfile {
  id?: string | null;
  display_name?: string | null;
  email?: string | null;
  locale?: string | null;
  avatar_url?: string | null;
  tenant?: string | null;
  created_at?: string | null;
  memberships?: WireMembership[] | null;
  preferences_summary?: { count?: number | null } | null;
  flags?: { demo?: boolean | null } | null;
}

/** One read for the hub's identity panel: profile, memberships, live preference-use count. */
export async function meProfileRead(): Promise<ConsoleRead<MeProfileView>> {
  if (IS_MOCK) {
    const me = mockMe();
    const view: MeProfileView = {
      id: me.user.id,
      displayName: me.user.display_name,
      email: me.user.email,
      locale: me.user.locale,
      avatarUrl: me.user.avatar_url ?? null,
      tenant: null,
      createdAt: me.user.created_at,
      memberships: [],
      preferencesUsed: me.preferences.length,
      demo: true,
    };
    return okRead({ data: view, origin: 'mock', source: 'fixture:mockMe', asOf: me.user.created_at, demo: true });
  }
  try {
    const wire = await nexusAuthedGet<WireMeProfile>('platform', '/api/v1/me');
    const view: MeProfileView = {
      id: wire.id ?? '',
      displayName: wire.display_name ?? wire.email ?? '—',
      email: wire.email ?? '',
      locale: wire.locale ?? 'zh-HK',
      avatarUrl: wire.avatar_url ?? null,
      tenant: wire.tenant ?? null,
      createdAt: wire.created_at ?? null,
      memberships: (wire.memberships ?? []).map((membership): MeMembership => ({
        role: membership.role ?? 'member',
        merchantName: membership.merchant?.display_name ?? null,
        merchantSlug: membership.merchant?.slug ?? null,
      })),
      preferencesUsed: wire.preferences_summary?.count ?? 0,
      demo: Boolean(wire.flags?.demo),
    };
    return okRead({ data: view, origin: 'live', source: PROFILE_SOURCE, asOf: wire.created_at ?? null, demo: view.demo });
  } catch (cause) {
    return failedRead({ source: PROFILE_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* --------------------------------------------------------------- favorites */

export interface HydratedFavorite {
  id: string;
  subjectType: string;
  subjectId: string;
  createdAt: string;
  /** The card rendered for merchant subjects; null for types the platform cannot project yet. */
  card: EntityCard | null;
}

interface WireFavoriteRow {
  id: string;
  subject_type: string;
  subject_id: string;
  note?: string | null;
  created_at: string;
}

/**
 * Favorites with cards where the platform can project them. The documented read serves bare rows
 * (`GET /api/v1/me/favorites`, session-required); merchant subjects hydrate through the same wire
 * projection `/m/[slug]` uses. Offering/collection/guide saves are returned with `card: null` —
 * the page states that limit rather than guessing a card the platform never served.
 */
export async function meFavoritesRead(limit = 6): Promise<ConsoleRead<HydratedFavorite[]>> {
  if (IS_MOCK) {
    const me = mockMe();
    const favorites: HydratedFavorite[] = me.favorites.slice(0, limit).map((favorite) => ({
      id: favorite.id,
      subjectType: favorite.subject_type,
      subjectId: favorite.subject_id,
      createdAt: favorite.created_at,
      card: favorite.card,
    }));
    const asOf = favorites.reduce<string | null>(
      (latest, favorite) => (!latest || favorite.createdAt > latest ? favorite.createdAt : latest),
      null,
    );
    return okRead({ data: favorites, origin: 'mock', source: 'fixture:mockMe', asOf, demo: true });
  }
  try {
    const rows = await nexusAuthedGet<WireFavoriteRow[]>('platform', '/api/v1/me/favorites', {
      searchParams: { limit },
    });
    const list = Array.isArray(rows) ? rows : [];
    const hydrated = await Promise.allSettled(
      list.filter((row) => row.subject_type === 'merchant').map(async (row): Promise<HydratedFavorite> => {
        // Public read with a 10-minute cross-request Data Cache (merchant-card-cache.ts) — the
        // session cookie is deliberately absent; the card has no caller variance.
        const card = await getMerchantCard(row.subject_id);
        return {
          id: row.id,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          createdAt: row.created_at,
          card,
        };
      }),
    );
    const byId = new Map<string, EntityCard>();
    for (const result of hydrated) {
      if (result.status === 'fulfilled' && result.value.card) byId.set(result.value.id, result.value.card);
    }
    const favorites = list.map((row): HydratedFavorite => ({
      id: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      createdAt: row.created_at,
      card: byId.get(row.id) ?? null,
    }));
    const asOf = favorites.reduce<string | null>(
      (latest, favorite) => (!latest || favorite.createdAt > latest ? favorite.createdAt : latest),
      null,
    );
    return okRead({ data: favorites, origin: 'live', source: FAVORITES_SOURCE, asOf, demo: false });
  } catch (cause) {
    return failedRead({ source: FAVORITES_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------------------ reservations */

export interface MeReservationRow {
  id: string;
  code: string | null;
  status: string;
  startsAt: string | null;
  partySize: number | null;
  price: { amount: string; currency: string } | null;
  merchantName: string | null;
}

interface WireReservationRow {
  id: string;
  code?: string | null;
  status?: string | null;
  starts_at?: string | null;
  party_size?: number | null;
  price?: { amount?: string | null; currency?: string | null } | null;
  merchant?: { name?: string | null } | null;
  created_at?: string | null;
}

export async function meReservationsRead(limit = 3): Promise<ConsoleRead<MeReservationRow[]>> {
  if (IS_MOCK) {
    const me = mockMe();
    const rows = me.reservations.slice(0, limit).map((reservation): MeReservationRow => ({
      id: reservation.id,
      code: reservation.code,
      status: reservation.status,
      startsAt: reservation.slot_start,
      partySize: reservation.party_size,
      price: null,
      merchantName: reservation.merchant_name,
    }));
    const asOf = rows.reduce<string | null>(
      (latest, row) => (!row.startsAt || (latest && row.startsAt <= latest) ? latest : row.startsAt),
      null,
    );
    return okRead({ data: rows, origin: 'mock', source: 'fixture:mockMe', asOf, demo: true });
  }
  try {
    const rows = await nexusAuthedGet<WireReservationRow[]>('platform', '/api/v1/me/reservations', {
      searchParams: { limit },
    });
    const list = (Array.isArray(rows) ? rows : []).slice(0, limit).map((row): MeReservationRow => ({
      id: row.id,
      code: row.code ?? null,
      status: row.status ?? 'requested',
      startsAt: row.starts_at ?? null,
      partySize: typeof row.party_size === 'number' ? row.party_size : null,
      price: row.price?.amount != null
        ? { amount: String(row.price.amount), currency: row.price.currency ?? 'HKD' }
        : null,
      merchantName: row.merchant?.name ?? null,
    }));
    const asOf = list.reduce<string | null>(
      (latest, row) => (!row.startsAt || (latest && row.startsAt <= latest) ? latest : row.startsAt),
      null,
    );
    return okRead({ data: list, origin: 'live', source: RESERVATIONS_SOURCE, asOf, demo: false });
  } catch (cause) {
    return failedRead({ source: RESERVATIONS_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* -------------------------------------------------------------------- orders */

export interface MeOrderRow {
  id: string;
  code: string | null;
  status: string;
  total: { amount: string; currency: string } | null;
  merchantName: string | null;
  createdAt: string | null;
}

interface WireOrderRow {
  id: string;
  code?: string | null;
  status?: string | null;
  total?: { amount?: string | null; currency?: string | null } | null;
  merchant?: { name?: string | null } | null;
  created_at?: string | null;
}

export async function meOrdersRead(limit = 3): Promise<ConsoleRead<MeOrderRow[]>> {
  if (IS_MOCK) {
    const me = mockMe();
    const rows = me.orders.slice(0, limit).map((order): MeOrderRow => ({
      id: order.id,
      code: order.code,
      status: order.status,
      total: order.total,
      merchantName: order.merchant_name,
      createdAt: order.created_at,
    }));
    const asOf = rows.reduce<string | null>(
      (latest, row) => (!row.createdAt || (latest && row.createdAt <= latest) ? latest : row.createdAt),
      null,
    );
    return okRead({ data: rows, origin: 'mock', source: 'fixture:mockMe', asOf, demo: true });
  }
  try {
    const rows = await nexusAuthedGet<WireOrderRow[]>('platform', '/api/v1/me/orders', {
      searchParams: { limit },
    });
    const list = (Array.isArray(rows) ? rows : []).slice(0, limit).map((row): MeOrderRow => ({
      id: row.id,
      code: row.code ?? null,
      status: row.status ?? 'pending_payment',
      total: row.total?.amount != null
        ? { amount: String(row.total.amount), currency: row.total.currency ?? 'HKD' }
        : null,
      merchantName: row.merchant?.name ?? null,
      createdAt: row.created_at ?? null,
    }));
    const asOf = list.reduce<string | null>(
      (latest, row) => (!row.createdAt || (latest && row.createdAt <= latest) ? latest : row.createdAt),
      null,
    );
    return okRead({ data: list, origin: 'live', source: ORDERS_SOURCE, asOf, demo: false });
  } catch (cause) {
    return failedRead({ source: ORDERS_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ----------------------------------------------------------- saved searches */

export interface MeSavedSearchRow {
  id: string;
  name: string | null;
  query: string;
  notify: boolean;
  createdAt: string | null;
}

interface WireSavedSearchRow {
  id: string;
  name?: string | null;
  query?: string | null;
  notify?: boolean | null;
  created_at?: string | null;
}

export async function meSavedSearchesRead(limit = 6): Promise<ConsoleRead<MeSavedSearchRow[]>> {
  if (IS_MOCK) {
    const me = mockMe();
    const rows = me.saved_searches.slice(0, limit).map((search): MeSavedSearchRow => ({
      id: search.id,
      name: null,
      query: search.query,
      notify: search.notify,
      createdAt: search.created_at,
    }));
    return okRead({ data: rows, origin: 'mock', source: 'fixture:mockMe', asOf: null, demo: true });
  }
  try {
    const rows = await nexusAuthedGet<WireSavedSearchRow[]>('platform', '/api/v1/me/saved-searches', {
      searchParams: { limit },
    });
    const list = (Array.isArray(rows) ? rows : []).slice(0, limit).map((row): MeSavedSearchRow => ({
      id: row.id,
      name: row.name ?? null,
      query: row.query ?? '',
      notify: Boolean(row.notify),
      createdAt: row.created_at ?? null,
    }));
    return okRead({ data: list, origin: 'live', source: SAVED_SEARCHES_SOURCE, asOf: null, demo: false });
  } catch (cause) {
    return failedRead({ source: SAVED_SEARCHES_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* -------------------------------------------------------------- preferences */

export type MePreferenceSource = 'declared' | 'inferred' | 'explicit_feedback' | 'transaction';

export interface MePreferenceRow {
  id: string;
  /** kind (user-facing taxonomy on the platform); '' when the service sent no kind at all. */
  kind: string;
  key: string;
  /** value rendered as JSON text; never a float, never an invention — the wire's own JSON. */
  value: string;
  scope: 'session' | 'long_term';
  source: MePreferenceSource;
  confidence: number | null;
  updatedAt: string | null;
}

interface WirePreferenceRow {
  id?: string | null;
  kind?: string | null;
  key?: string | null;
  value?: unknown;
  source?: string | null;
  scope?: string | null;
  weight?: number | null;
  updated_at?: string | null;
}

function preferenceSource(raw: string | null | undefined): MePreferenceSource {
  if (raw === 'declared' || raw === 'inferred' || raw === 'explicit_feedback' || raw === 'transaction') return raw;
  return 'declared';
}

/**
 * The caller's own preference memory (§32/§33), capped at 8 rows. Read-only by design: the hub
 * shows what the ranker may read — it does not edit, because §33 says the person owns every row
 * and this page is a mirror, not an eraser.
 */
export async function mePreferencesRead(limit = 8): Promise<ConsoleRead<MePreferenceRow[]>> {
  if (IS_MOCK) {
    const me = mockMe();
    const rows = me.preferences.slice(0, limit).map((pref): MePreferenceRow => ({
      id: pref.id,
      kind: '',
      key: pref.key,
      value: typeof pref.value === 'object' ? JSON.stringify(pref.value) : String(pref.value),
      scope: pref.scope === 'session' ? 'session' : 'long_term',
      source: preferenceSource(pref.source),
      confidence: typeof pref.confidence === 'number' ? pref.confidence : null,
      updatedAt: pref.updated_at,
    }));
    return okRead({ data: rows, origin: 'mock', source: 'fixture:mockMe', asOf: null, demo: true });
  }
  try {
    const rows = await nexusAuthedGet<WirePreferenceRow[]>('platform', '/api/v1/me/preferences', {
      searchParams: { limit },
    });
    const list = (Array.isArray(rows) ? rows : []).slice(0, limit).map((row): MePreferenceRow => ({
      id: row.id ?? '',
      kind: row.kind ?? '',
      key: row.key ?? '',
      value: typeof row.value === 'object' && row.value !== null ? JSON.stringify(row.value) : String(row.value ?? ''),
      scope: row.scope === 'session' ? 'session' : 'long_term',
      source: preferenceSource(row.source),
      confidence: typeof row.weight === 'number' ? row.weight : null,
      updatedAt: row.updated_at ?? null,
    }));
    return okRead({ data: list, origin: 'live', source: PREFERENCES_SOURCE, asOf: null, demo: false });
  } catch (cause) {
    return failedRead({ source: PREFERENCES_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------------------- inbox (text) */

export type MeNotificationKind = 'reservation' | 'order' | 'review' | 'guide' | 'price' | 'system';

export interface MeNotificationRow {
  id: string;
  kind: MeNotificationKind;
  template: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string | null;
  unread: boolean;
}

interface WirePage<T> {
  items?: T[];
  next_cursor?: string | null;
  total_estimate?: number | null;
}

interface WireNotificationRow {
  id: string;
  audience?: string | null;
  channel?: string | null;
  template?: string | null;
  payload?: { title?: string | null; body?: string | null; href?: string | null; name?: string | null } | null;
  read_at?: string | null;
  created_at?: string | null;
  merchant_id?: string | null;
}

function notificationKind(template: string): MeNotificationKind {
  if (template.startsWith('reservation_')) return 'reservation';
  if (template.startsWith('order_')) return 'order';
  if (template === 'price_drop') return 'price';
  if (template === 'new_review_reply' || template.startsWith('review_')) return 'review';
  if (template === 'guide_published') return 'guide';
  return 'system';
}

function templateLabel(template: string): string {
  return template.replace(/_/g, ' ');
}

/**
 * The caller's inbox (§123): consumer and merchant audience rows alike — the hub belongs to the
 * person, and hiding merchant rows would be a lie about what is in there. `unread_count` is folded
 * into the returned metadata so the section header can state it.
 */
export async function meNotificationsRead(limit = 6): Promise<ConsoleRead<{ rows: MeNotificationRow[]; unread: number }>> {
  if (IS_MOCK) {
    const me = mockMe();
    const rows = me.notifications.slice(0, limit).map((notification): MeNotificationRow => ({
      id: notification.id,
      kind: notificationKind(notification.type),
      template: notification.type,
      title: notification.title,
      body: notification.body,
      href: notification.href ?? null,
      createdAt: notification.created_at,
      unread: notification.read_at === null,
    }));
    const unread = rows.filter((row) => row.unread).length;
    return okRead({ data: { rows, unread }, origin: 'mock', source: 'fixture:mockMe', asOf: null, demo: true });
  }
  try {
    const page = await nexusAuthedGet<WirePage<WireNotificationRow> & { unread_count?: number }>(
      'platform',
      '/api/v1/notifications',
      { searchParams: { limit } },
    );
    const items = (page.items ?? []).slice(0, limit).map((row): MeNotificationRow => {
      const template = row.template ?? 'system';
      const payload = row.payload ?? null;
      return {
        id: row.id,
        kind: notificationKind(template),
        template,
        title: payload?.title ?? templateLabel(template),
        body: payload?.body ?? payload?.name ?? null,
        href: payload?.href ?? null,
        createdAt: row.created_at ?? null,
        unread: !row.read_at,
      };
    });
    const unread = typeof page.unread_count === 'number' ? page.unread_count : items.filter((row) => row.unread).length;
    return okRead({ data: { rows: items, unread }, origin: 'live', source: NOTIFICATIONS_SOURCE, asOf: null, demo: false });
  } catch (cause) {
    return failedRead({ source: NOTIFICATIONS_SOURCE, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}
