/**
 * The starter prompts shown on the home page and on an empty search (§6).
 *
 * They live outside `lib/mock` on purpose: `lib/mock` is the server-side data plane, and importing
 * it into a client component would ship the whole fixture catalogue to browsers running in live
 * mode. These are copy, keyed by locale like everything else in apps/web (AGENT_CONTRACT §12).
 */

import type { Locale } from './i18n/dict';

export interface ExamplePrompt {
  key: string;
  query: string;
}

const BY_LOCALE: Record<Locale, ExamplePrompt[]> = {
  'zh-HK': [
    { key: 'friends_dinner', query: '帮我找附近适合朋友聚会的餐厅' },
    { key: 'japanese_budget', query: '预算 300 港币，想吃日料' },
    { key: 'date_weekend', query: '周末找一个适合情侣约会的地方' },
    { key: 'rainy_shoes', query: '我想买一双适合香港下雨天穿的鞋' },
    { key: 'late_gym', query: '帮我找一个晚上 10 点后还营业的健身房' },
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
