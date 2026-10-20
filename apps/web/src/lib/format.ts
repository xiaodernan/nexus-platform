import type { BusinessHoursDay, MerchantDetail } from './types';
import type { Fact, OpeningState } from '@nexus/ui/trust/types';
import { findFact } from '@nexus/ui/trust/fact';

/**
 * Formatting + fact-resolution helpers. Pure functions, unit-tested in ./facts.test.ts
 * and ./format.test.ts (§156: code → build → test).
 */

export const HK_TIME_ZONE = 'Asia/Hong_Kong';

/** `Money` is a string decimal on the wire (§1) — parse once, format with Intl. */
export function formatMoney(
  money: { amount: string; currency: string } | null | undefined,
  locale = 'zh-HK',
  opts: { compact?: boolean } = {},
): string | null {
  if (!money) return null;
  const value = Number.parseFloat(money.amount);
  if (!Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency || 'HKD',
      maximumFractionDigits: opts.compact || Number.isInteger(value) ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${money.currency} ${money.amount}`;
  }
}

export function formatNumber(value: number, locale = 'zh-HK'): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** HK addresses are district-first (§112); distance keeps the API text when provided. */
export function formatDistance(meters: number, locale = 'zh-HK'): string {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1000) {
    return locale.startsWith('zh') ? `${Math.round(meters)} 米` : `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return locale.startsWith('zh') ? `${km.toFixed(1)} 公里` : `${km.toFixed(1)} km`;
}

export function formatTravelMinutes(minutes: number, locale = 'zh-HK'): string {
  return locale.startsWith('zh') ? `行 ${Math.round(minutes)} 分鐘` : `${Math.round(minutes)} min walk`;
}

export function formatClock(iso: string | null | undefined, locale = 'zh-HK'): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: HK_TIME_ZONE,
  }).format(date);
}

export function formatDateTime(iso: string | null | undefined, locale = 'zh-HK'): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: HK_TIME_ZONE,
  }).format(date);
}

export function formatDate(iso: string | null | undefined, locale = 'zh-HK'): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: HK_TIME_ZONE,
  }).format(date);
}

/** "3 日前" style relative time without a date library. */
export function formatRelativeDay(iso: string, locale = 'zh-HK', now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffDays = Math.max(0, Math.round((now.getTime() - then) / 86_400_000));
  if (locale.startsWith('zh')) {
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 30) return `${diffDays} 日前`;
    return formatDate(iso, locale) ?? '';
  }
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  return formatDate(iso, locale) ?? '';
}

export const WEEKDAY_LABELS: Record<string, string[]> = {
  'zh-HK': ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
  'zh-CN': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

export function weekdayLabel(weekday: number, locale = 'zh-HK'): string {
  const labels = WEEKDAY_LABELS[locale] ?? WEEKDAY_LABELS['en'] ?? [];
  return labels[((weekday % 7) + 7) % 7] ?? '';
}

/* ------------------------------------------------------------------ open/closed */

/** Current HK wall-clock as { weekday, minutes } — computed from an explicit instant so it is testable. */
export function hkNowParts(instant: Date = new Date()): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HK_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hour = Number.parseInt(get('hour'), 10);
  const minute = Number.parseInt(get('minute'), 10);
  return {
    weekday: weekdayIndex >= 0 ? weekdayIndex : 0,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/**
 * Compute open/closed from `business_hours` — never guessed, and the result always names
 * the fact it came from so the renderer can prove provenance (spec §20, AGENT_CONTRACT §4).
 * Returns `null` when there is no hours data at all: the caller must then show 未验证.
 */
export function computeOpening(
  hours: BusinessHoursDay[] | null | undefined,
  sourceFactId: string | null,
  instant: Date = new Date(),
): OpeningState | null {
  if (!hours?.length || !sourceFactId) return null;
  const { weekday, minutes } = hkNowParts(instant);
  const today = hours.find((day) => day.weekday === weekday);
  const yesterday = hours.find((day) => day.weekday === (weekday + 6) % 7);
  const asOf = instant.toISOString();

  if (today && !today.closed && today.ranges?.length) {
    for (const range of today.ranges) {
      const open = toMinutes(range.open);
      const close = toMinutes(range.close);
      if (open === null || close === null) continue;
      const end = range.crosses_midnight || close <= open ? close + 1440 : close;
      if (minutes >= open && minutes < end) {
        return {
          is_open: true,
          opens_at: null,
          closes_at: isoAtMinutes(weekday, end > 1440 ? end - 1440 : end, instant),
          as_of: asOf,
          source_fact_id: sourceFactId,
        };
      }
    }
  }

  // Still inside a window that started yesterday (e.g. 18:00–02:00 bar at 00:30).
  if (yesterday && !yesterday.closed) {
    for (const range of yesterday.ranges ?? []) {
      const open = toMinutes(range.open);
      const close = toMinutes(range.close);
      if (open === null || close === null) continue;
      if (close <= open || range.crosses_midnight) {
        if (minutes < close) {
          return {
            is_open: true,
            opens_at: null,
            closes_at: isoAtMinutes(weekday, close, instant),
            as_of: asOf,
            source_fact_id: sourceFactId,
          };
        }
      }
    }
  }

  // Closed: find the next opening moment in the coming week.
  for (let offset = 0; offset < 8; offset += 1) {
    const dayIndex = (weekday + offset) % 7;
    const day = hours.find((entry) => entry.weekday === dayIndex);
    if (!day || day.closed) continue;
    for (const range of day.ranges ?? []) {
      const open = toMinutes(range.open);
      if (open === null) continue;
      if (offset === 0 && open <= minutes) continue;
      return {
        is_open: false,
        opens_at: isoAtMinutes(dayIndex, open, instant, offset),
        closes_at: null,
        as_of: asOf,
        source_fact_id: sourceFactId,
      };
    }
  }
  return null;
}

/** ISO timestamp for "weekday W at HH:MM" within the current/next week (HK timezone). */
function isoAtMinutes(weekday: number, minutes: number, instant: Date, dayOffsetHint?: number): string {
  const { weekday: nowWeekday, minutes: nowMinutes } = hkNowParts(instant);
  let offset = (weekday - nowWeekday + 7) % 7;
  if (dayOffsetHint !== undefined) offset = dayOffsetHint;
  if (minutes < nowMinutes && offset === 0) offset = 7;
  const base = new Date(instant);
  // Move to HK midnight of the target day, then add minutes.
  const hkOffsetMinutes = 8 * 60;
  const shifted = new Date(base.getTime() + hkOffsetMinutes * 60_000);
  const target = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offset, 0, 0, 0),
  );
  return new Date(target.getTime() + minutes * 60_000 - hkOffsetMinutes * 60_000).toISOString();
}

/** Hours text for the week ("12:00–22:00" / "全日休息"), used by the merchant availability strip. */
export function hoursText(day: BusinessHoursDay | undefined, locale = 'zh-HK'): string {
  const closedText = locale.startsWith('zh') ? '休息' : 'closed';
  const unverifiedText = locale.startsWith('zh') ? '未驗證' : 'unverified';
  if (!day) return unverifiedText;
  // A day with no ranges is only 休息 when the data says it is closed; silence about a weekday is not
  // a closure claim (§19), and the live projection emits rows only for the days the service describes.
  if (day.closed === true) return closedText;
  if (!day.ranges?.length) return unverifiedText;
  return day.ranges.map((range) => `${range.open}–${range.close}`).join(', ');
}

/**
 * `opening_hours` fact values are `{ zones: [{ weekday, opens, closes }] }` (docs/DATABASE.md), where
 * `weekday` is the column's own 0=Mon…6=Sun numbering. Decoding it here keeps the provenance panel
 * readable without restating the claim: the text is only ever the ranges the fact already carries.
 */
export function hoursFactText(value: unknown, locale = 'zh-HK'): string | null {
  const zones = (value as { zones?: unknown } | null)?.zones;
  if (!Array.isArray(zones)) return null;
  const seen = new Set<string>();
  const lines: Array<{ weekday: number; range: string }> = [];
  for (const zone of zones) {
    const entry = zone as { weekday?: unknown; opens?: unknown; closes?: unknown };
    if (typeof entry?.weekday !== 'number' || typeof entry.opens !== 'string' || typeof entry.closes !== 'string') {
      continue;
    }
    const key = `${entry.weekday}:${entry.opens}-${entry.closes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ weekday: entry.weekday, range: `${entry.opens}–${entry.closes}` });
  }
  if (!lines.length) return null;
  return lines
    .sort((a, b) => a.weekday - b.weekday || a.range.localeCompare(b.range))
    .map((line) => `${weekdayLabel((line.weekday + 1) % 7, locale)} ${line.range}`)
    .join(locale.startsWith('zh') ? '、' : ', ');
}

/* ------------------------------------------------------------------ distance/maps */

/** Haversine distance in metres (used by the map panel to draw real relative spacing). */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const earthR = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * earthR * Math.asin(Math.sqrt(h)));
}

/** Google Maps deep link — the only "map" we can honestly offer without an API key (§38). */
export function directionsUrl(dest: { lat: number; lng: number }, from?: { lat: number; lng: number } | null): string {
  const destination = `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`;
  const origin = from ? `&origin=${from.lat.toFixed(6)},${from.lng.toFixed(6)}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${origin}&travelmode=walking`;
}

export function factOf(card: { facts?: Fact[] | null }, attribute: string): Fact | null {
  return findFact(card, attribute);
}

export type { MerchantDetail };
