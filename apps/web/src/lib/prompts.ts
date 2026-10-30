/**
 * The starter prompts shown on the home page and on an empty search (§6).
 *
 * They live outside `lib/mock` on purpose: `lib/mock` is the server-side data plane, and importing
 * it into a client component would ship the whole fixture catalogue to browsers running in live
 * mode. These are copy, keyed by locale like everything else in apps/web (AGENT_CONTRACT §12).
 *
 * The `zh-HK` half is in the Traditional script, like every other thing a Hong Kong reader is
 * answered in (D606). These five strings are also what a reviewer types first, so they are the exact
 * queries the mock plane's script-closure census (§638) drives its matcher vocabulary with.
 */

import type { Locale } from './i18n/dict';

export interface ExamplePrompt {
  key: string;
  query: string;
}

const BY_LOCALE: Record<Locale, ExamplePrompt[]> = {
  'zh-HK': [
    { key: 'friends_dinner', query: '幫我找附近適合朋友聚會的餐廳' },
    { key: 'japanese_budget', query: '預算 300 港幣，想吃日料' },
    { key: 'date_weekend', query: '週末找一個適合情侶約會的地方' },
    { key: 'rainy_shoes', query: '我想買一雙適合香港下雨天穿的鞋' },
    { key: 'late_gym', query: '幫我找一個晚上 10 點後還營業的健身房' },
  ],
  en: [
    { key: 'friends_dinner', query: 'restaurants near me for a group dinner' },
    { key: 'japanese_budget', query: 'japanese food under HK$300' },
    { key: 'date_weekend', query: 'somewhere quiet for a date this weekend' },
    { key: 'rainy_shoes', query: 'shoes that survive a Hong Kong rainstorm' },
    { key: 'late_gym', query: 'gyms still open after 10pm' },
  ],
};

export function examplePrompts(locale: Locale): ExamplePrompt[] {
  return BY_LOCALE[locale] ?? BY_LOCALE['zh-HK'];
}
