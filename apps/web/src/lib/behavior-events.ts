/**
 * D1513 — deterministic, clearly-labelled synthetic §58 events derived from the SAME ghost
 * readers the /insights page shows (`simulateJourneys`). This connects the mandate's two
 * §九 halves: the "impatient close / random clicking" simulation now feeds the admin
 * analytics read instead of living on a separate island.
 *
 * Pure, dependency-free, offline. Same HK date → same crowd → same events. Every row is
 * DEMO (the payload carries `demo: true`): it never claims to be a real database row.
 */

import { simulateJourneys, type InsightsSnapshot } from './user-journeys';

export interface BehaviorEvent {
  session_id: string;
  name: string;
  hour: number;
  day: string;
  actor: string;
}

export interface DemoBehavior {
  window_hours: number;
  total_events: number;
  daily: Array<[string, number]>;
  projection_next_7_days: Array<{ day_index: number; projected: number }>;
  hourly: Array<{ hour: number; n: number }>;
  top_events: Array<{ name: string; n: number }>;
  sessions: Array<{ session_id: string; n: number; first_at: string; last_at: string }>;
  recommendations: string[];
  /**
   * D1569 — the drop-off funnel: the share of ghost sessions that reached each step of the
   * engagement pipeline, in order. Curated step order; a session "reached" a step when its
   * event set contains it, regardless of sequence.
   */
  funnel: Array<{ step: string; sessions: number; share: number }>;
  /** D1569 — per-actor-profile depth: how many sessions each profile ran, and how deep each went. */
  profiles: Array<{ actor: string; sessions: number; avg_depth: number }>;
  degraded: boolean;
  demo: boolean;
}

/** The engagement pipeline the funnel measures, in order. */
const FUNNEL_STEPS = ['view', 'click', 'search', 'read', 'save'] as const;

/** Profile index → event sequence. Mirrors the stable order of simulateJourneys' profiles. */
const PROFILE_EVENTS: string[][] = [
  ['view'],                       // impatient glance — opens and bails
  ['view', 'read', 'dwell'],      // slow reader
  ['view', 'click'],              // window shopper
  ['view', 'click', 'search', 'click'],  // random tapper
  ['view'],                       // silent bounce
  ['view', 'save'],               // bookmarker
];

/** Deterministic 32-bit hash (cyrb53-lite) — no Math.random anywhere in this module. */
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const dayKey = (base: string, offset: number): string => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** One day's ghost readers → raw event rows, all labelled with the day and an hour. */
export function eventsForDay(day: string, locale: 'zh-HK' | 'zh-CN' | 'en'): BehaviorEvent[] {
  const snap: InsightsSnapshot = simulateJourneys(day, locale);
  const rows: BehaviorEvent[] = [];
  snap.buckets.forEach((bucket, bucketIndex) => {
    const seq = PROFILE_EVENTS[bucketIndex] ?? ['view'];
    for (let i = 0; i < bucket.count; i += 1) {
      const seed = hash(`${day}:${bucket.profile}:${i}`);
      const sessionId = `demo-${day}-${bucketIndex}-${i}`;
      // place the reader in an hour the ramp actually carries
      const hour = (snap.hourRamp[seed % 24] ?? 0) > 0 ? seed % 24 : (seed + 8) % 24;
      for (const name of seq) {
        rows.push({ session_id: sessionId, name, hour, day, actor: bucket.profile });
      }
    }
  });
  return rows;
}

/** Least-squares projection over observed daily counts (same math as routes_behavior._project). */
function project(daily: Array<[string, number]>, days: number): Array<{ day_index: number; projected: number }> {
  if (daily.length < 2) return [];
  const ys = daily.map(([, n]) => n);
  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  const denom = ys.reduce((a, _y, i) => a + (i - meanX) ** 2, 0);
  if (!denom) return [];
  const slope = ys.reduce((a, y, i) => a + (i - meanX) * (y - meanY), 0) / denom;
  const intercept = meanY - slope * meanX;
  return Array.from({ length: days }, (_unused, i) => ({
    day_index: n + i,
    projected: Math.max(0, Math.round(intercept + slope * (n + i))),
  }));
}

/** Build the full demo behavior payload from seven days of the same deterministic crowd. */
export function demoBehavior(baseDay: string, locale: 'zh-HK' | 'zh-CN' | 'en', hours = 720): DemoBehavior {
  const events: BehaviorEvent[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    events.push(...eventsForDay(dayKey(baseDay, -back), locale));
  }
  const dailyMap = new Map<string, number>();
  const hourly = new Array(24).fill(0) as number[];
  const names = new Map<string, number>();
  const sessions = new Map<string, { n: number; first: number; last: number }>();
  for (const e of events) {
    dailyMap.set(e.day, (dailyMap.get(e.day) ?? 0) + 1);
    hourly[e.hour] = (hourly[e.hour] ?? 0) + 1;
    names.set(e.name, (names.get(e.name) ?? 0) + 1);
    const s = sessions.get(e.session_id) ?? { n: 0, first: e.hour, last: e.hour };
    s.n += 1;
    s.first = Math.min(s.first, e.hour);
    s.last = Math.max(s.last, e.hour);
    sessions.set(e.session_id, s);
  }
  const daily = [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const total = events.length;
  const projection = project(daily, 7);
  const top = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  const sessionRows = [...sessions.entries()].slice(0, 25).map(([session_id, s]) => ({
    session_id,
    n: s.n,
    first_at: String(s.first).padStart(2, '0') + ':00',
    last_at: String(s.last).padStart(2, '0') + ':00',
  }));

  // D1569 — the funnel: sessions are counted by their event NAME SET, so 'search' twice still
  // counts once. Shares are over the total session count, not the previous step's.
  const sessionNames = new Map<string, Set<string>>();
  const sessionActor = new Map<string, string>();
  for (const e of events) {
    if (!sessionNames.has(e.session_id)) sessionNames.set(e.session_id, new Set());
    sessionNames.get(e.session_id)!.add(e.name);
    sessionActor.set(e.session_id, e.actor);
  }
  const totalSessions = sessionNames.size || 1;
  const funnel = FUNNEL_STEPS.map((step) => {
    const reached = [...sessionNames.values()].filter((set) => set.has(step)).length;
    return { step, sessions: reached, share: Math.round((reached / totalSessions) * 1000) / 1000 };
  });
  // The weakest transition: the largest share drop between consecutive steps — the step where
  // the crowd falls off hardest, and therefore the first thing an operator should work on.
  const profilesMap = new Map<string, { sessions: number; depthSum: number }>();
  for (const [session_id, set] of sessionNames) {
    const actor = sessionActor.get(session_id) ?? 'unknown';
    const p = profilesMap.get(actor) ?? { sessions: 0, depthSum: 0 };
    p.sessions += 1;
    p.depthSum += set.size;
    profilesMap.set(actor, p);
  }
  const profiles = [...profilesMap.entries()]
    .map(([actor, p]) => ({
      actor,
      sessions: p.sessions,
      avg_depth: Math.round((p.depthSum / p.sessions) * 100) / 100,
    }))
    .sort((a, b) => b.sessions - a.sessions);
  const recommendations: string[] = [];
  if (projection.length >= 2) {
    const a = projection[0]!.projected;
    const b = projection[projection.length - 1]!.projected;
    recommendations.push(`demo 7-day projection ${a}→${b} events/day (delta ${b - a})`);
  }
  const peak = hourly.indexOf(Math.max(...hourly));
  recommendations.push(`demo peak hour ${String(peak).padStart(2, '0')}:00 carries ${hourly[peak]} events`);
  recommendations.push(`demo funnel: ${top.find((t) => t.name === 'search')?.n ?? 0} search / ${top.find((t) => t.name === 'save')?.n ?? 0} save events across ${sessions.size} ghost sessions`);
  let weakest = -1;
  let weakestDrop = 0;
  for (let i = 1; i < funnel.length; i += 1) {
    const drop = funnel[i - 1]!.share - funnel[i]!.share;
    if (drop > weakestDrop) {
      weakestDrop = drop;
      weakest = i;
    }
  }
  if (weakest > 0) {
    const kept = Math.round(funnel[weakest]!.share * 100);
    recommendations.push(
      `demo funnel weakest transition: ${funnel[weakest - 1]!.step}→${funnel[weakest]!.step} keeps ${kept}% of sessions — the first thing an operator should work on`,
    );
  }

  return {
    window_hours: hours,
    total_events: total,
    daily,
    projection_next_7_days: projection,
    hourly: hourly.map((n, hour) => ({ hour, n })),
    top_events: top,
    sessions: sessionRows,
    recommendations,
    funnel,
    profiles,
    degraded: false,
    demo: true,
  };
}
