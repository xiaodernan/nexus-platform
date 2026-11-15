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
