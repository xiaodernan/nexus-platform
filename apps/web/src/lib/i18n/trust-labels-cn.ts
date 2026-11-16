/** GENERATED Simplified-Chinese trust labels — fold of zhLabels via opencc-python-reimplemented (hk2s+t2s). DO NOT EDIT BY HAND. */
import type { UiLabels } from './trust-labels';
import { formatDistance, formatRelativeDay, formatTravelMinutes } from '../format';

export const zhCNLabels: UiLabels = {
  compareTitle: '逐项对比',
  best: '本行最优',
  viewMerchant: '查看主页',
  rowLabels: {
    price: '价格',
    rating: '评分',
    category: '类别',
    district: '地区',
    open_state: '营业状态',
    duration: '时长',
    distance: '距离',
  },
  unverified: '未验证',
  staleValue: '可能已过期',
  uncertain: '置信度低',
  demo: '示例数据',
  demoTooltip: '合成演示数据，不代表真实商户或真实营业状况。',
  sponsored: '广告',
  sponsoredTooltip: '付费展示位；与自然搜索结果分开排序，不代表更高相关度。',
  open: '营业中',
  closed: '休息中',
  priceModels: {
    per_person: '每人',
    per_item: '每件',
    per_hour: '每小时',
    per_party: '每单',
    from: '起',
    free: '免费',
  },
  reviewsCount: (count) => `${count} 条评价`,
  distanceText: (meters) => formatDistance(meters, 'zh-CN'),
  travelMinutes: (minutes) => formatTravelMinutes(minutes, 'zh-CN'),
  sourceLabel: {
    merchant: '商户自报',
    imported: '商户导入',
    observed: '平台观察',
    third_party: '第三方',
    inferred: 'AI 推断',
    demo: '示范数据',
  },
  confidenceLabel: (confidence) => (confidence >= 0.8 ? '高置信' : confidence >= 0.6 ? '中置信' : '低置信'),
  observedLabel: (iso) => {
    const day = formatRelativeDay(iso, 'zh-CN');
    return day ? `更新于 ${day}` : '更新时间未知';
  },
  availability: { available: '有位', limited: '位况紧张', full: '已满', unknown: '未提供位况', closed: '休息中' },
  matchScore: (score) => `匹配度 ${Math.round(score * 100)}%`,
  provenance: '数据来源',
  railPrev: '向左滚动',
  railNext: '向右滚动',
};
