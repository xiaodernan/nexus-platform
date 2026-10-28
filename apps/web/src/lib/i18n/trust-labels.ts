/**
 * `TrustLabels` — the copy that makes the trust layer legible (§19, §35).
 *
 * `@nexus/ui` refuses to render a number it cannot resolve to a fact, but it also refuses to
 * invent the words: AGENT_CONTRACT §12 puts all localisation in apps/web, so every renderer takes
 * this object as a required prop. Build it from a locale string, never pass it across the
 * server/client boundary (it contains functions).
 */

import type { TrustLabels } from '@nexus/ui';
import { formatDistance, formatRelativeDay, formatTravelMinutes } from '../format';
import { normalizeLocale, type Locale } from './dict';

/**
 * `CompareTable` needs three more strings than a card does, plus the row names the compare
 * contract emits as raw attribute keys; the union keeps both call sites honest.
 */
export type UiLabels = TrustLabels & {
  compareTitle: string;
  best: string;
  viewMerchant: string;
  rowLabels: Record<string, string>;
};

export function trustLabels(locale: string | null | undefined): UiLabels {
  const lang = normalizeLocale(locale);
  return lang === 'en' ? enLabels : zhLabels;
}

const zhLabels: UiLabels = {
  compareTitle: '逐項對比',
  best: '本行最優',
  viewMerchant: '查看主頁',
  rowLabels: {
    price: '價格',
    rating: '評分',
    category: '類別',
    district: '地區',
    open_state: '營業狀態',
    distance: '距離',
  },
  unverified: '未驗證',
  staleValue: '可能已過期',
  uncertain: '置信度低',
  demo: '示例數據',
  demoTooltip: '合成演示數據，不代表真實商戶或真實營業狀況。',
  sponsored: '廣告',
  sponsoredTooltip: '付費展示位；與自然搜索結果分開排序，不代表更高相關度。',
  open: '營業中',
  closed: '休息中',
  priceModels: {
    per_person: '每人',
    per_item: '每件',
    per_hour: '每小時',
    per_party: '每單',
    from: '起',
    free: '免費',
  },
  reviewsCount: (count) => `${count} 條評價`,
  distanceText: (meters) => formatDistance(meters, 'zh-HK'),
  travelMinutes: (minutes) => formatTravelMinutes(minutes, 'zh-HK'),
  sourceLabel: {
    merchant: '商戶自報',
    imported: '商戶導入',
    observed: '平台觀察',
    third_party: '第三方',
    inferred: 'AI 推斷',
    demo: '示範數據',
  },
  confidenceLabel: (confidence) => (confidence >= 0.8 ? '高置信' : confidence >= 0.6 ? '中置信' : '低置信'),
  observedLabel: (iso) => {
    const day = formatRelativeDay(iso, 'zh-HK');
    return day ? `更新於 ${day}` : '更新時間未知';
  },
  availability: { available: '有位', limited: '位況緊張', full: '已滿', unknown: '未提供位況', closed: '休息中' },
  matchScore: (score) => `匹配度 ${Math.round(score * 100)}%`,
  provenance: '數據來源',
};

const enLabels: UiLabels = {
  compareTitle: 'Attribute by attribute',
  best: 'Best in row',
  viewMerchant: 'View profile',
  rowLabels: {
    price: 'Price',
    rating: 'Rating',
    category: 'Category',
    district: 'District',
    open_state: 'Opening state',
    distance: 'Distance',
  },
  unverified: 'Unverified',
  staleValue: 'Possibly outdated',
  uncertain: 'Low confidence',
  demo: 'Demo data',
  demoTooltip: 'Synthetic demonstration data — not a real merchant or a real trading state.',
  sponsored: 'Ad',
  sponsoredTooltip: 'Paid placement; ranked separately from organic results, not as a better match.',
  open: 'Open now',
  closed: 'Closed',
  priceModels: {
    per_person: 'per person',
    per_item: 'each',
    per_hour: 'per hour',
    per_party: 'per booking',
    from: 'from',
    free: 'free',
  },
  reviewsCount: (count) => `${count} review${count === 1 ? '' : 's'}`,
  distanceText: (meters) => formatDistance(meters, 'en'),
  travelMinutes: (minutes) => formatTravelMinutes(minutes, 'en'),
  sourceLabel: {
    merchant: 'Merchant-reported',
    imported: 'Imported by merchant',
    observed: 'Observed by platform',
    third_party: 'Third party',
    inferred: 'Model inference',
    demo: 'Demo data',
  },
  confidenceLabel: (confidence) => (confidence >= 0.8 ? 'high confidence' : confidence >= 0.6 ? 'medium confidence' : 'low confidence'),
  observedLabel: (iso) => {
    const day = formatRelativeDay(iso, 'en');
    return day ? `updated ${day}` : 'update time unknown';
  },
  availability: { available: 'Available', limited: 'Limited', full: 'Full', unknown: 'No availability data', closed: 'Closed' },
  matchScore: (score) => `${Math.round(score * 100)}% match`,
  provenance: 'Data sources',
};

/** Locale is re-exported so components import types from one place. */
export type { Locale };
