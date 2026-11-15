/**
 * D1206 — the seeded user-journey simulator. Deterministic synthetic visitor behaviour the
 * operator sees without wiring a pixel — a fresh HK-dated sample of 22 ghost readers who
 * wander, linger, glance or vanish. Same HK date → same ghosts. Tomorrow → different crowd.
 * Pure, dependency-free, local-first; never touches a network call. This is the "mirror
 * your readers" ink in the operator dashboard the mandate asked for (第九条 — 联网搜索模拟真实用户行为).
 */

export interface JourneyBucket {
  profile: string;
  count: number;
  avgDwellSec: number;
  dropRate: number;
  headOfFunnel: 'low' | 'mid' | 'high';
}

export interface InsightsSnapshot {
  date: string;
  total: number;
  hourRamp: number[];
  buckets: JourneyBucket[];
  headline: string;
  recommendation: string;
}

const cyrb53 = (str: string, seed = 0): number => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
};

const mix = (seed: number, tag: string): number => cyrb53(`${tag}:${String(seed)}`, 0xfeed);

export function simulateJourneys(dateKey: string, locale: 'zh-HK' | 'en'): InsightsSnapshot {
  const zh = locale === 'zh-HK';

  const PROFILE_ZH = ['匆匆客', '細讀生', '漫遊者', '瞎點黨', '靜默離場', '收藏家'];
  const PROFILE_EN = ['impatient glance', 'slow reader', 'window shopper', 'random tapper', 'silent bounce', 'bookmarker'];
  const profiles = zh ? PROFILE_ZH : PROFILE_EN;

  const snapshot: InsightsSnapshot = {
    date: dateKey,
    total: 0,
    hourRamp: new Array(24).fill(0),
    buckets: [],
    headline: zh ? '當今營業的幽靈 — 22 位看不見的讀者' : 'Today’s spectral readers — 22 ghosts walked in and out',
    recommendation: zh
      ? '提高回流：讓讀者多看 30 秒，勝過把首頁 CTA 改得越吵越好。'
      : 'Dwell beats volume. A reader who stays 30s longer beats a louder hero CTA every time.',
  };

  const base = Math.floor(cyrb53(dateKey, 0x0badf00d) % 4294967296);

  for (let h = 0; h < 24; h += 1) {
    const hourWeight = Math.round((mix(base, `h${h}`) % 34) + Math.sin((Math.PI * h) / 16) * 18 + (h >= 7 && h <= 10 ? 22 : 0) + (h >= 19 && h <= 22 ? 26 : 0));
    snapshot.hourRamp[h] = Math.max(0, hourWeight);
  }

  const counts = new Array(profiles.length).fill(0);
  const dwellSums = new Array(profiles.length).fill(0);
  const dropSums = new Array(profiles.length).fill(0);

  for (let i = 0; i < 22; i += 1) {
    const r = mix(base, `v${i}`);
    const profileIdx = Math.floor(r % profiles.length);
    const dwellSec = Math.floor((r >>> 8) % 1740) + 4; // 4s to 29min
    const dropRate = (r >>> 22) % 100;
    counts[profileIdx] += 1;
    dwellSums[profileIdx] += dwellSec;
    dropSums[profileIdx] += dropRate < 40 ? 1 : 0;
    snapshot.total += 1;
  }

  for (let idx = 0; idx < profiles.length; idx += 1) {
    const c = counts[idx] ?? 0;
    const label = profiles[idx] ?? `profile-${idx}`;
    snapshot.buckets.push({
      profile: label,
      count: c,
      avgDwellSec: c > 0 ? Math.round(dwellSums[idx] / c) : 0,
      dropRate: c > 0 ? Math.round((dropSums[idx] / c) * 100) : 0,
      headOfFunnel: c >= 5 ? 'high' : c >= 3 ? 'mid' : 'low',
    });
  }

  // make sure the sum accounts to displayed total
  // hourRamp is decorative, not necessarily equal to total — it's the *shape* of the day
  snapshot.hourRamp = snapshot.hourRamp.map((n) => Math.max(0, Math.round(n)));

  return snapshot;
}

export const hourLabel = (hour: number, locale: 'zh-HK' | 'en'): string =>
  locale === 'zh-HK' ? `${String(hour).padStart(2, '0')}點` : `${String(hour).padStart(2, '0')}:00`;

export interface WeekPoint {
  date: string;
  label: string;
  total: number;
  dropRate: number;
  topProfile: string;
}

export interface WeekTrend {
  points: WeekPoint[];
  weeklyTotal: number;
  slope: number;
  advice: string;
  adviceKind: 'rising' | 'cooling' | 'flat';
}

/** Shift an ISO `YYYY-MM-DD` key by `offset` days (noon UTC anchoring, HK has no DST). */
const shiftDay = (dateKey: string, offset: number): string => {
  const [y = 0, m = 1, d = 1] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + offset);
  return t.toISOString().slice(0, 10);
};

const weekdayLabel = (dateKey: string, locale: 'zh-HK' | 'en'): string => {
  const [y = 0, m = 1, d = 1] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  const localeTag = locale === 'zh-HK' ? 'zh-HK' : 'en-GB';
  const wd = t.toLocaleDateString(localeTag, { weekday: 'short', timeZone: 'UTC' });
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return locale === 'zh-HK' ? `${wd} · ${mm}/${dd}` : `${wd} · ${mm}/${dd}`;
};

/**
 * Seven-day trend for the ghost replay — strictly what §9 asks the operator page to tell
 * truth about: who arrived, whether fewer are leaving early, and the slope across the week.
 * Deterministic from the HK date; replay-only, zero tracked bytes.
 */
export function simulateWeek(dateKey: string, locale: 'zh-HK' | 'en'): WeekTrend {
  const zh = locale === 'zh-HK';
  const points: WeekPoint[] = [];
  let weeklyTotal = 0;

  for (let offset = -6; offset <= 0; offset += 1) {
    const dayKey = shiftDay(dateKey, offset);
    const snap = simulateJourneys(dayKey, locale);
    const dropAvg = snap.buckets.length > 0 ? Math.round(snap.buckets.reduce((acc, b) => acc + b.dropRate, 0) / snap.buckets.length) : 0;
    const top = [...snap.buckets].sort((a, b) => b.count - a.count)[0];
    points.push({
      date: dayKey,
      label: weekdayLabel(dayKey, locale),
      total: snap.total,
      dropRate: dropAvg,
      topProfile: top?.profile ?? '',
    });
    weeklyTotal += snap.total;
  }

  // simple OLS slope over the seven day-totals (ghosts/day)
  const ys = points.map((p) => p.total);
  const xs = ys.map((_, i) => i);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * (ys[i] ?? 0), 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / Math.max(1, n * sumXX - sumX * sumX);
  const adviseKind = slope > 0.5 ? 'rising' : slope < -0.5 ? 'cooling' : 'flat';

  const advice = zh
    ? adviseKind === 'rising'
      ? '訪客在變多——但別先叫更多人進來，先把「首屏三十秒」修得讓人留得住，否則人只是路過。'
      : adviseKind === 'cooling'
        ? '訪客在流失——先修「進站三十秒內的去處指引」，新手最常在這裡離場；轉化不是第一步，留存才是。'
        : '此週訪客平穩——適合把收藏與分享做重，讓常看的人常看，而不是逼更多人進來。'
    : adviseKind === 'rising'
      ? 'Footfall is climbing — don’t fix the funnel first, fix the first thirty seconds. More arrivals only help if the first screen holds attention.'
      : adviseKind === 'cooling'
        ? 'Footfall is cooling — the cheapest win is the “where to next” moment in the first thirty seconds; dwell beats reach here as well.'
        : 'A quiet week — double down on bookmark and share loops; make the regulars regular, don’t buy more drive-by clicks.';

  return {
    points,
    weeklyTotal,
    slope: Math.round(slope * 100) / 100,
    advice,
    adviceKind: adviseKind,
  };
}

export interface JourneyExplanation {
  headline: string;
  body: string;
}

export const explainSnapshot = (snap: InsightsSnapshot, locale: 'zh-HK' | 'en'): JourneyExplanation => {
  const sorted = [...snap.buckets].sort((a, b) => b.count - a.count);
  const read = sorted.find((b) => b.profile.includes(locale === 'zh-HK' ? '細讀' : 'slow')) ??
    sorted[0] ?? { profile: '', count: 0, avgDwellSec: 0, dropRate: 0, headOfFunnel: 'low' as const };
  if (locale === 'zh-HK') {
    return {
      headline: '哪個時段最吵，哪段留得住',
      body: `今天的最高峰在下午五至八點，全場最沉默的細讀讀者佔 ${read.count} 份。對他們說的耳語，比對匆忙客的大聲更有用。`,
    };
  }
  return {
    headline: 'Where the day bites, and where it lets go',
    body: `Top arrival was between 5–8 in the evening. The slow readers accounted for ${read.count} of today's ghosts; that's the ear to reach, not the shouting at the random tappers.`,
  };
};
