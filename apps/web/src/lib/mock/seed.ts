import type { Fact, GeoPoint } from '@nexus/ui/trust/types';
import type {
  AppNotification,
  AvailabilitySlot,
  Favorite,
  Guide,
  Collection,
  MeProfile,
  MerchantDetail,
  OfferingSummary,
  Order,
  Reservation,
  Review,
  ReviewSummary,
  SavedSearch,
  UserPreference,
} from '../types';

/**
 * SYNTHETIC SEED DATA — mirror of the HTTP contract shapes, used when
 * `NEXT_PUBLIC_DATA_MODE=mock` (default) so the UI is runnable and reviewable today.
 *
 * Honesty rules applied here, not only in the UI (§109, §155, DECISIONS D6):
 *  - every record sets `flags.demo = true` / `data_origin: 'demo'`;
 *  - names, phones and domains are invented (`example.hk`), addresses are real districts;
 *  - images are locally generated SVGs and credited `synthetic`;
 *  - **deliberate gaps**: some records have no price fact, one price fact is stale,
 *    one rating fact is below the 0.4 render floor, one merchant has no hours fact.
 *    Those are the cases the UI must render as 未验证, so they are part of the data set.
 */

export const DEMO_ORIGIN = 'demo' as const;

export interface District {
  name: string;
  zh: string;
  geo: GeoPoint;
  mtr: string;
  walk: number;
}

export type DistrictKey =
  | 'central'
  | 'wan_chai'
  | 'causeway_bay'
  | 'mong_kok'
  | 'tsim_sha_tsui'
  | 'kowloon_bay'
  | 'sha_tin'
  | 'ap_lei_chau'
  | 'tsuen_wan'
  | 'tseung_kwan_o'
  | 'jordan'
  | 'sheung_shui';

export const DISTRICTS: Record<DistrictKey, District> = {
  central: { name: 'Central', zh: '中環', geo: { lat: 22.2817, lng: 114.1585 }, mtr: 'Central', walk: 4 },
  wan_chai: { name: 'Wan Chai', zh: '灣仔', geo: { lat: 22.277, lng: 114.172 }, mtr: 'Wan Chai', walk: 6 },
  causeway_bay: { name: 'Causeway Bay', zh: '銅鑼灣', geo: { lat: 22.2806, lng: 114.185 }, mtr: 'Causeway Bay', walk: 5 },
  mong_kok: { name: 'Mong Kok', zh: '旺角', geo: { lat: 22.3194, lng: 114.1703 }, mtr: 'Mong Kok', walk: 3 },
  tsim_sha_tsui: { name: 'Tsim Sha Tsui', zh: '尖沙咀', geo: { lat: 22.2988, lng: 114.1725 }, mtr: 'Tsim Sha Tsui', walk: 7 },
  kowloon_bay: { name: 'Kowloon Bay', zh: '九龍灣', geo: { lat: 22.322, lng: 114.207 }, mtr: 'Kowloon Bay', walk: 8 },
  sha_tin: { name: 'Sha Tin', zh: '沙田', geo: { lat: 22.386, lng: 114.19 }, mtr: 'Sha Tin', walk: 6 },
  ap_lei_chau: { name: 'Ap Lei Chau', zh: '鴨脷洲', geo: { lat: 22.241, lng: 114.155 }, mtr: 'South Horizon', walk: 9 },
  tsuen_wan: { name: 'Tsuen Wan', zh: '荃灣', geo: { lat: 22.368, lng: 114.115 }, mtr: 'Tsuen Wan', walk: 5 },
  tseung_kwan_o: { name: 'Tseung Kwan O', zh: '將軍澳', geo: { lat: 22.315, lng: 114.263 }, mtr: 'Tseung Kwan O', walk: 7 },
  jordan: { name: 'Jordan', zh: '佐敦', geo: { lat: 22.303, lng: 114.17 }, mtr: 'Jordan', walk: 4 },
  sheung_shui: { name: 'Sheung Shui', zh: '上水', geo: { lat: 22.502, lng: 114.128 }, mtr: 'Sheung Shui', walk: 5 },
};

export interface SeedMerchant {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  subcategories: string[];
  tags: string[];
  district: keyof typeof DISTRICTS;
  offset: [number, number];
  priceAmount: string | null;
  priceModel: 'per_person' | 'per_item' | 'per_hour' | 'per_party';
  ratingValue: number | null;
  ratingCount: number;
  currency: string;
  hours: Array<{ weekday: number; ranges: Array<{ open: string; close: string }> }> | null;
  seats: boolean;
  /** Which trust facts exist / how sure they are. Encodes the deliberate data gaps. */
  factGaps?: { price?: boolean; rating?: boolean; hours?: boolean; distance?: boolean; stalePrice?: boolean; lowConfidenceRating?: boolean };
  phone: string;
  domain: string;
  imageHue: number;
  offerings: Array<{ slug: string; title: string; kind: OfferingSummary['kind']; price: string; description: string }>;
  reviewSeed: Array<{ name: string; rating: number; text: string; days: number; helpful: number }>;
}

const H = (weekday: number, open: string, close: string) => ({ weekday, ranges: [{ open, close }] });
const EVERYDAY = (open: string, close: string) => [0, 1, 2, 3, 4, 5, 6].map((d) => H(d, open, close));
const WITH_CLOSED_SUN = (open: string, close: string) => [1, 2, 3, 4, 5, 6].map((d) => H(d, open, close));

export const SEED_MERCHANTS: SeedMerchant[] = [
  {
    id: 'm-lung-yuen', slug: 'lung-yuen-kitchen', name: '龍苑 Kitchen', tagline: '粤式小炒 · 沙田',
    description: '合成示例商戶：街坊式粵式小炒，晚市有分享碟，安靜角落位有限。',
    category: 'restaurant', subcategories: ['cantonese', 'dimsum'], tags: ['date-night', 'family', 'quiet', 'cantonese'],
    district: 'sha_tin', offset: [0.004, -0.006], priceAmount: '188.00', priceModel: 'per_person',
    ratingValue: 4.6, ratingCount: 213, currency: 'HKD',
    hours: EVERYDAY('11:30', '22:00'), seats: true, phone: '+852 2600 0001', domain: 'lungyuen.example.hk', imageHue: 212,
    offerings: [
      { slug: 'lung-yuen-set-dinner-two', title: '雙人晚市套餐', kind: 'experience', price: '398.00', description: '兩餸一湯 + 甜品，需預約。' },
      { slug: 'lung-yuen-salt-baked-crayfish', title: '鹽焗大蝦（份）', kind: 'product', price: '168.00', description: '即點即做，約 20 分鐘。' },
    ],
    reviewSeed: [
      { name: 'K. Chan', rating: 5, text: '安静的角落位适合两个人吃饭，盐焗虾很稳定。', days: 6, helpful: 24 },
      { name: 'Mora L.', rating: 4, text: 'Service was quick, portions generous for sharing. Ask for the corner table.', days: 13, helpful: 11 },
      { name: '阿強', rating: 5, text: '订位很快，晚市人潮多但不会吵。', days: 21, helpful: 8 },
    ],
  },
  {
    id: 'm-haeto-bistro', slug: 'haeto-bistro', name: '海塘 Bistro', tagline: '海景西餐 · 鴨脷洲',
    description: '合成示例商戶：避風塘景位的西餐小館，晚上有窗边位。',
    category: 'restaurant', subcategories: ['western', 'seafood'], tags: ['date-night', 'sea-view', 'quiet'],
    district: 'ap_lei_chau', offset: [-0.005, 0.004], priceAmount: '420.00', priceModel: 'per_person',
    ratingValue: 4.4, ratingCount: 128, currency: 'HKD',
    hours: WITH_CLOSED_SUN('12:00', '22:30'), seats: true, phone: '+852 2600 0002', domain: 'haeto.example.hk', imageHue: 188,
    offerings: [
      { slug: 'haeto-window-two-course', title: '窗边双人两道式', kind: 'experience', price: '688.00', description: '需指定窗边位，视当天供应。' },
      { slug: 'haeto-black-pepper-scallop', title: '黑椒带子（件）', kind: 'product', price: '128.00', description: '限量，售完即止。' },
    ],
    reviewSeed: [
      { name: 'V. Ho', rating: 5, text: '海景位值得，提前一天订比较稳。', days: 4, helpful: 31 },
      { name: 'Dan R.', rating: 4, text: 'Good value for the view; acoustics get loud after 8pm.', days: 17, helpful: 9 },
    ],
  },
  {
    id: 'm-ramen-koji', slug: 'ramen-koji', name: '拉麵小路 Koji', tagline: '日式拉麵 · 旺角',
    description: '合成示例商戶：吧台位为主，翻台快，辣度可选。',
    category: 'restaurant', subcategories: ['japanese', 'ramen'], tags: ['solo', 'cheap', 'japanese', 'spicy'],
    district: 'mong_kok', offset: [0.003, 0.002], priceAmount: '92.00', priceModel: 'per_person',
    ratingValue: 4.3, ratingCount: 402, currency: 'HKD',
    hours: EVERYDAY('11:00', '23:00'), seats: false, phone: '+852 2600 0003', domain: 'koji.example.hk', imageHue: 24,
    offerings: [
      { slug: 'koji-tonkotsu-large', title: '大碗豚骨拉麵', kind: 'product', price: '102.00', description: '面体软硬可指定。' },
      { slug: 'koji-spicy-miso', title: '辛味噌拉麵', kind: 'product', price: '98.00', description: '辣度 1–5。' },
    ],
    reviewSeed: [
      { name: 'Siu Ming', rating: 4, text: '排队二十分钟，但翻台很快。辣度三级已经很辣。', days: 2, helpful: 14 },
      { name: 'Priya S.', rating: 5, text: 'Cheap, consistent, and the counter seats are great solo.', days: 9, helpful: 22 },
      { name: 'T. Leung', rating: 3, text: '太拥挤，不适合聊天。', days: 28, helpful: 6 },
    ],
  },
  {
    id: 'm-sichuan-lane', slug: 'sichuan-lane', name: '川巷 Sichuan Lane', tagline: '川菜 · 銅鑼灣',
    description: '合成示例商戶：重辣小馆，有清汤选项，朋友聚会为主。',
    category: 'restaurant', subcategories: ['sichuan', 'spicy'], tags: ['friends', 'spicy', 'group'],
    district: 'causeway_bay', offset: [-0.004, -0.003], priceAmount: '240.00', priceModel: 'per_person',
    ratingValue: 4.5, ratingCount: 176, currency: 'HKD',
    hours: EVERYDAY('12:00', '23:30'), seats: true, phone: '+852 2600 0004', domain: 'sichuanlane.example.hk', imageHue: 6,
    offerings: [
      { slug: 'sichuan-four-person-feast', title: '四人辣宴套餐', kind: 'experience', price: '880.00', description: '含两清汤选择。' },
    ],
    reviewSeed: [
      { name: 'R. Yip', rating: 5, text: '四个人吃得很好，可以叫不辣的汤给小孩。', days: 5, helpful: 19 },
      { name: 'Alina', rating: 4, text: 'Very good spice levels, service slows when full.', days: 15, helpful: 7 },
    ],
  },
  {
    id: 'm-bauhinia-cafe', slug: 'bauhinia-cafe', name: '洋紫荊咖啡', tagline: '咖啡 · 中環',
    description: '合成示例商戶：早开门、有插座、可外带。',
    category: 'cafe', subcategories: ['coffee', 'brunch'], tags: ['quiet', 'work', 'cheap', 'early'],
    district: 'central', offset: [0.002, 0.003], priceAmount: '78.00', priceModel: 'per_person',
    ratingValue: 4.7, ratingCount: 331, currency: 'HKD',
    hours: EVERYDAY('07:00', '19:00'), seats: true, phone: '+852 2600 0005', domain: 'bauhinia.example.hk', imageHue: 36,
    offerings: [
      { slug: 'bauhinia-filter-two', title: '手冲咖啡（两杯）', kind: 'product', price: '128.00', description: '豆单每周更换。' },
      { slug: 'bauhinia-laptop-corner', title: '角落工作位 2 小时', kind: 'service', price: '0.00', description: '免费，但需消费。' },
    ],
    reviewSeed: [
      { name: 'J. Wong', rating: 5, text: '早上七点就开，有位有插座。', days: 3, helpful: 27 },
      { name: 'Marco B.', rating: 4, text: 'Solid beans, quick wifi, gets full before ten.', days: 11, helpful: 12 },
    ],
  },
  {
    id: 'm-granite-gym', slug: 'granite-gym', name: 'Granite Strength Club', tagline: '健身 · 九龍灣',
    description: '合成示例商戶：24 小时入口，晚上十点后仍营业，硬拉台有限。',
    category: 'fitness', subcategories: ['gym', 'strength'], tags: ['late-night', 'solo', 'equipment'],
    district: 'kowloon_bay', offset: [0.005, -0.004], priceAmount: '120.00', priceModel: 'per_item',
    ratingValue: 4.2, ratingCount: 96, currency: 'HKD',
    hours: EVERYDAY('00:00', '23:59'), seats: false, phone: '+852 2600 0006', domain: 'granite.example.hk', imageHue: 210,
    offerings: [
      { slug: 'granite-day-pass', title: '日票', kind: 'service', price: '120.00', description: '含更衣室与储物柜。' },
      { slug: 'granite-coaching-60', title: '私人指导 60 分钟', kind: 'service', price: '680.00', description: '需预约教练档期。' },
    ],
    reviewSeed: [
      { name: 'Kit T.', rating: 4, text: '十点后还有位置，周日晚最多人。', days: 7, helpful: 15 },
      { name: 'Nadia', rating: 5, text: 'Deadlift platforms actually available, that is rare.', days: 19, helpful: 10 },
    ],
  },
  {
    id: 'm-petal-tea', slug: 'petal-tea-house', name: '花瓣茶室', tagline: '茶室 · 上水',
    description: '合成示例商戶：安静茶室，无酒精，适合长辈同行。',
    category: 'cafe', subcategories: ['tea', 'dessert'], tags: ['quiet', 'family', 'no-alcohol'],
    district: 'sheung_shui', offset: [-0.003, 0.005], priceAmount: '110.00', priceModel: 'per_person',
    ratingValue: 4.8, ratingCount: 64, currency: 'HKD',
    hours: WITH_CLOSED_SUN('13:00', '20:00'), seats: true, phone: '+852 2600 0007', domain: 'petal.example.hk', imageHue: 132,
    offerings: [{ slug: 'petal-tea-flight', title: '四款茶试饮组', kind: 'product', price: '148.00', description: '约 25 分钟。' }],
    reviewSeed: [{ name: 'C. Lam', rating: 5, text: '真的很静，适合跟父母聊天。', days: 8, helpful: 21 }],
    // deliberate gap: no price fact → the card must render 未验证
    factGaps: { price: true },
  },
  {
    id: 'm-harbour-bar', slug: 'harbour-quiet-bar', name: 'Harbour Side Bar', tagline: '酒吧 · 尖沙咀',
    description: '合成示例商戶：深夜营业，现场不供应正餐，可外带小食。',
    category: 'entertainment', subcategories: ['bar', 'cocktails'], tags: ['late-night', 'date-night', 'group'],
    district: 'tsim_sha_tsui', offset: [0.004, 0.006], priceAmount: '135.00', priceModel: 'per_item',
    ratingValue: 4.1, ratingCount: 149, currency: 'HKD',
    hours: EVERYDAY('18:00', '02:00'), seats: true, phone: '+852 2600 0008', domain: 'harbourside.example.hk', imageHue: 268,
    offerings: [{ slug: 'harbour-signature-two', title: '指定鸡尾酒两款', kind: 'product', price: '210.00', description: '含软性替代选项。' }],
    reviewSeed: [{ name: 'O. Beck', rating: 4, text: 'Loud after 10pm but easy to find seats.', days: 12, helpful: 9 }],
    // deliberate gap: stale price fact (observed long ago) → "价格可能已更新"
    factGaps: { stalePrice: true },
  },
  {
    id: 'm-green-curve', slug: 'green-curve-vegetarian', name: '青弯素膳', tagline: '素食 · 灣仔',
    description: '合成示例商戶：无辣选项多，孩子餐椅有。',
    category: 'restaurant', subcategories: ['vegetarian', 'cantonese'], tags: ['family', 'no-spicy', 'cheap', 'quiet'],
    district: 'wan_chai', offset: [-0.002, -0.005], priceAmount: '128.00', priceModel: 'per_person',
    ratingValue: 4.0, ratingCount: 88, currency: 'HKD',
    hours: EVERYDAY('11:00', '21:00'), seats: true, phone: '+852 2600 0009', domain: 'greencurve.example.hk', imageHue: 108,
    offerings: [{ slug: 'green-curve-set-lunch', title: '午市素套餐', kind: 'product', price: '78.00', description: '11:00–15:00。' }],
    reviewSeed: [{ name: 'Wai Yee', rating: 4, text: '清汤选项多，带小孩方便。', days: 10, helpful: 13 }],
  },
  {
    id: 'm-north-point-hotel', slug: 'north-point-inn', name: 'North Point Inn', tagline: '精品住宿 · 將軍澳',
    description: '合成示例商戶：海景双人房，可加床，含早餐。',
    category: 'hotel', subcategories: ['boutique-hotel'], tags: ['date-night', 'sea-view', 'stay'],
    district: 'tseung_kwan_o', offset: [0.006, 0.004], priceAmount: '980.00', priceModel: 'per_party',
    ratingValue: 4.3, ratingCount: 57, currency: 'HKD',
    hours: EVERYDAY('00:00', '23:59'), seats: false, phone: '+852 2600 0010', domain: 'northpoint.example.hk', imageHue: 200,
    offerings: [{ slug: 'northpoint-sea-double', title: '海景双人房一晚', kind: 'service', price: '980.00', description: '含双人早餐。' }],
    reviewSeed: [{ name: 'E. Fung', rating: 4, text: '房间安静，海景位要早订。', days: 25, helpful: 6 }],
  },
  {
    id: 'm-tsuen-wan-dimsum', slug: 'tsuen-wan-dimsum-house', name: '荃灣點心屋', tagline: '点心 · 荃灣',
    description: '合成示例商戶：即蒸点心，周末排队，价格低。',
    category: 'restaurant', subcategories: ['dimsum', 'cantonese'], tags: ['cheap', 'family', 'cantonese'],
    district: 'tsuen_wan', offset: [0.003, -0.005], priceAmount: '86.00', priceModel: 'per_person',
    ratingValue: 4.2, ratingCount: 265, currency: 'HKD',
    hours: EVERYDAY('07:30', '18:00'), seats: true, phone: '+852 2600 0011', domain: 'tswendimsum.example.hk', imageHue: 44,
    offerings: [{ slug: 'tsuen-dimsum-basket-five', title: '五笼点心组', kind: 'product', price: '158.00', description: '即蒸约 15 分钟。' }],
    reviewSeed: [{ name: 'K. Poon', rating: 4, text: '平而稳定，周日上午最挤。', days: 5, helpful: 17 }],
  },
  {
    id: 'm-jordan-korean', slug: 'jordan-seoul-grill', name: '首尔炭火 · Jordan', tagline: '韩式烧烤 · 佐敦',
    description: '合成示例商戶：聚会型烧烤，可选不辣腌料。',
    category: 'restaurant', subcategories: ['korean', 'bbq'], tags: ['friends', 'group', 'korean'],
    district: 'jordan', offset: [-0.006, 0.002], priceAmount: '268.00', priceModel: 'per_person',
    ratingValue: 4.5, ratingCount: 191, currency: 'HKD',
    hours: EVERYDAY('12:00', '23:00'), seats: true, phone: '+852 2600 0012', domain: 'seoulgrill.example.hk', imageHue: 16,
    offerings: [{ slug: 'jordan-grill-four-person', title: '四人炭火套餐', kind: 'experience', price: '1080.00', description: '含不辣腌料选项。' }],
    reviewSeed: [{ name: 'Hana K.', rating: 5, text: '四人餐够食，服务快。', days: 6, helpful: 18 }],
    // deliberate gap: rating fact below the 0.4 confidence floor → omitted as 未验证
    factGaps: { lowConfidenceRating: true },
  },
  {
    id: 'm-central-running', slug: 'central-runs-club', name: 'Central Runs Club', tagline: '活动 · 中環',
    description: '合成示例商戶：清晨缓跑团，含教练，天气取消。',
    category: 'activities', subcategories: ['running', 'outdoor'], tags: ['early', 'solo', 'outdoor'],
    district: 'central', offset: [-0.005, -0.002], priceAmount: '150.00', priceModel: 'per_item',
    ratingValue: null, ratingCount: 0, currency: 'HKD',
    hours: [H(6, '06:00', '08:00'), H(0, '06:00', '08:00')], seats: false, phone: '+852 2600 0013', domain: 'centralruns.example.hk', imageHue: 156,
    offerings: [{ slug: 'central-runs-sat-session', title: '周六缓跑 session', kind: 'experience', price: '150.00', description: '集合点中环码头。' }],
    reviewSeed: [{ name: 'G. Ortiz', rating: 5, text: 'Pacing groups are honest, no pressure.', days: 14, helpful: 5 }],
    factGaps: { rating: true },
  },
  {
    id: 'm-sha-tin-hotpot', slug: 'sha-tin-hotpot', name: '沙田火锅 · 围炉', tagline: '火锅 · 沙田',
    description: '合成示例商戶：鸳鸯锅，周末晚上有位率低。',
    category: 'restaurant', subcategories: ['hotpot', 'sichuan'], tags: ['friends', 'spicy', 'group', 'date-night'],
    district: 'sha_tin', offset: [-0.004, 0.006], priceAmount: '320.00', priceModel: 'per_person',
    ratingValue: 4.4, ratingCount: 158, currency: 'HKD',
    hours: EVERYDAY('11:30', '23:00'), seats: true, phone: '+852 2600 0014', domain: 'weilu.example.hk', imageHue: 350,
    offerings: [{ slug: 'shatin-hotpot-two', title: '双人鸳鸯锅', kind: 'experience', price: '588.00', description: '周六 19:00 需等位。' }],
    reviewSeed: [{ name: 'L. Cheung', rating: 4, text: '汤底稳，周末七点要等。', days: 9, helpful: 16 }],
  },
  {
    id: 'm-wan-chai-noise', slug: 'wan-chai-listening-bar', name: 'Wan Chai Listening Bar', tagline: '酒吧 · 灣仔',
    description: '合成示例商戶：黑胶聆听酒吧，不供应正餐。',
    category: 'entertainment', subcategories: ['bar', 'music'], tags: ['quiet', 'date-night', 'late-night'],
    district: 'wan_chai', offset: [0.005, 0.003], priceAmount: '180.00', priceModel: 'per_person',
    ratingValue: 4.6, ratingCount: 74, currency: 'HKD',
    hours: WITH_CLOSED_SUN('19:00', '23:30'), seats: true, phone: '+852 2600 0015', domain: 'listeningbar.example.hk', imageHue: 282,
    offerings: [{ slug: 'listening-two-cocktails', title: '两款指定鸡尾酒', kind: 'product', price: '230.00', description: '无酒精替代有。' }],
    reviewSeed: [{ name: 'I. Sato', rating: 5, text: '安静得可以聊天，音量控制得好。', days: 20, helpful: 8 }],
  },
  {
    id: 'm-kowloon-bay-bakery', slug: 'kowloon-bay-bakery', name: '九龍灣面包房', tagline: '面包 · 九龍灣',
    description: '合成示例商戶：下午出炉，雨天有外带。',
    category: 'cafe', subcategories: ['bakery', 'coffee'], tags: ['cheap', 'takeaway', 'early'],
    district: 'kowloon_bay', offset: [-0.003, -0.006], priceAmount: '42.00', priceModel: 'per_item',
    ratingValue: 4.5, ratingCount: 210, currency: 'HKD',
    hours: WITH_CLOSED_SUN('07:30', '19:30'), seats: false, phone: '+852 2600 0016', domain: 'kbbakery.example.hk', imageHue: 52,
    offerings: [{ slug: 'kb-sourdough-loaf', title: '天然酸种面包（条）', kind: 'product', price: '58.00', description: '下午 3 点出炉。' }],
    reviewSeed: [{ name: 'P. Ng', rating: 5, text: '三点出炉，去晚就没了。', days: 4, helpful: 26 }],
  },
  {
    id: 'm-mong-kok-sneaker', slug: 'mong-kok-rain-ready', name: 'Rain Ready 鞋履', tagline: '购物 · 旺角',
    description: '合成示例商戶：雨天防滑鞋与护理服务。',
    category: 'shopping', subcategories: ['footwear'], tags: ['rainy-day', 'takeaway'],
    district: 'mong_kok', offset: [0.002, -0.004], priceAmount: '680.00', priceModel: 'per_item',
    ratingValue: 4.1, ratingCount: 43, currency: 'HKD',
    hours: EVERYDAY('12:00', '20:30'), seats: false, phone: '+852 2600 0017', domain: 'rainready.example.hk', imageHue: 226,
    offerings: [
      { slug: 'rr-grip-derby', title: '防滑德比鞋', kind: 'product', price: '680.00', description: '尺码 36–45。' },
      { slug: 'rr-waterproof-treat', title: '防水护理（双）', kind: 'service', price: '120.00', description: '当日可取。' },
    ],
    reviewSeed: [{ name: 'F. Tsang', rating: 4, text: '雨天真的不滑，尺码偏大半号。', days: 16, helpful: 7 }],
  },
  {
    id: 'm-tst-massage', slug: 'tst-recovery-studio', name: 'TST Recovery Studio', tagline: '理疗 · 尖沙咀',
    description: '合成示例商戶：运动恢复与按摩，晚间时段紧。',
    category: 'beauty', subcategories: ['massage', 'recovery'], tags: ['solo', 'late-night', 'quiet'],
    district: 'tsim_sha_tsui', offset: [-0.005, -0.003], priceAmount: '520.00', priceModel: 'per_hour',
    ratingValue: 4.7, ratingCount: 112, currency: 'HKD',
    hours: EVERYDAY('10:00', '21:00'), seats: true, phone: '+852 2600 0018', domain: 'trecovery.example.hk', imageHue: 168,
    offerings: [{ slug: 'tst-deep-tissue-60', title: '深层组织 60 分钟', kind: 'service', price: '520.00', description: '需提前 24 小时改期。' }],
    reviewSeed: [{ name: 'S. Malik', rating: 5, text: 'Booked same day at 8pm, actually available.', days: 3, helpful: 14 }],
    // deliberate gap: no business-hours fact → 未验证 for open/closed
    factGaps: { hours: true },
  },
];

/* --------------------------------------------------------------- fact factory */

/** Deterministic pseudo-uuid from a string, so fixtures stay stable across builds. */
export function factUuid(seed: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  let h2 = h1 ^ 0x5bf03635;
  const hex = (n: number, len = 8) => {
    let out = '';
    const x = n >>> 0;
    for (let i = 0; i < len; i += 1) {
      out += '0123456789abcdef'[(x >>> (i * 4)) & 15];
    }
    return out;
  };
  h2 = (Math.imul(h2, 2654435761) >>> 0) ^ 0x9e3779b9;
  return `${hex(h1)}-${hex(h2).slice(0, 4)}-4${hex(h1 ^ h2).slice(0, 3)}-a${hex(h2 ^ h1).slice(0, 3)}-${hex(h1 + h2)}${hex(h2, 4).slice(0, 4)}`;
}

/**
 * Stable non-fact identifier for demo artefacts (result sets, agent runs, sessions).
 * Same generator as `factUuid` so nothing depends on `crypto` during a build.
 */
export const demoUuid = (label: string): string => factUuid(`demo:${label}`);

/** Hours in ISO weekday order, always present for merchants that publish them. */export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Facts are generated relative to `now` so `expires_at`/`stale` behave like the real
 * freshness policy (§5: price 6h, hours 24h, availability never cached) — a fixture that
 * is stale by construction is what makes the 未验证 path testable.
 */
export function buildMerchantFacts(seed: SeedMerchant, now: Date): Fact[] {
  const facts: Fact[] = [];
  const gaps = seed.factGaps ?? {};
  const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
  const HOUR = 3_600_000;

  if (seed.priceAmount && !gaps.price) {
    const stale = gaps.stalePrice === true;
    facts.push({
      fact_id: factUuid(`${seed.id}:price`),
      subject_type: 'merchant',
      subject_id: seed.id,
      attribute: 'price',
      value: { amount: seed.priceAmount, currency: seed.currency },
      source: stale ? 'imported' : 'merchant',
      confidence: stale ? 0.72 : 0.98,
      observed_at: stale ? iso(-9 * 24 * HOUR) : iso(-2 * HOUR),
      expires_at: stale ? iso(-24 * HOUR) : iso(6 * HOUR),
      stale,
    });
  }

  if (seed.ratingValue !== null && !gaps.rating) {
    const low = gaps.lowConfidenceRating === true;
    facts.push({
      fact_id: factUuid(`${seed.id}:rating`),
      subject_type: 'merchant',
      subject_id: seed.id,
      attribute: 'rating',
      value: { value: seed.ratingValue, count: seed.ratingCount },
      source: 'observed',
      confidence: low ? 0.31 : 0.9,
      observed_at: iso(-36 * HOUR),
      expires_at: iso(12 * HOUR),
      stale: false,
    });
  }

  if (seed.hours && !gaps.hours) {
    facts.push({
      fact_id: factUuid(`${seed.id}:hours`),
      subject_type: 'merchant',
      subject_id: seed.id,
      attribute: 'business_hours',
      value: seed.hours,
      source: 'merchant',
      confidence: 0.97,
      observed_at: iso(-18 * HOUR),
      expires_at: iso(24 * HOUR),
      stale: false,
    });
  }

  facts.push({
    fact_id: factUuid(`${seed.id}:distance`),
    subject_type: 'location',
    subject_id: `${seed.id}:loc`,
    attribute: 'distance',
    value: { meters: distanceMeters(seed), travel_minutes: travelMinutes(seed), text: null },
    source: 'observed',
    confidence: 0.99,
    observed_at: iso(-1 * HOUR),
    expires_at: iso(23 * HOUR),
    stale: false,
  });

  return facts;
}

export function merchantLocation(seed: SeedMerchant): GeoPoint {
  const district = DISTRICTS[seed.district] ?? DISTRICTS.central;
  return { lat: district.geo.lat + seed.offset[0], lng: district.geo.lng + seed.offset[1] };
}

export function distanceMeters(seed: SeedMerchant): number {
  const point = merchantLocation(seed);
  const central = DISTRICTS.central.geo;
  const dLat = (point.lat - central.lat) * 111_000;
  const dLng = (point.lng - central.lng) * 103_000;
  return Math.max(120, Math.round(Math.sqrt(dLat * dLat + dLng * dLng) / 10) * 10);
}

export function travelMinutes(seed: SeedMerchant): number {
  return Math.max(2, Math.round(distanceMeters(seed) / 80));
}

export function offeringFacts(seed: SeedMerchant, offering: SeedMerchant['offerings'][number], now: Date): Fact[] {
  const HOUR = 3_600_000;
  const priceId = factUuid(`${seed.id}:${offering.slug}:price`);
  return [
    {
      fact_id: priceId,
      subject_type: 'offering',
      subject_id: `${seed.id}:${offering.slug}`,
      attribute: 'price',
      value: { amount: offering.price, currency: seed.currency },
      source: 'merchant',
      confidence: 0.97,
      observed_at: new Date(now.getTime() - HOUR).toISOString(),
      expires_at: new Date(now.getTime() + 6 * HOUR).toISOString(),
      stale: false,
    },
    {
      fact_id: factUuid(`${seed.id}:${offering.slug}:availability`),
      subject_type: 'offering',
      subject_id: `${seed.id}:${offering.slug}`,
      attribute: 'availability',
      value: { status: 'available' },
      source: 'observed',
      confidence: 0.85,
      observed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      stale: false,
    },
  ];
}

/* ----------------------------------------------------------------- derived data */

export function buildMerchantDetail(seed: SeedMerchant, now: Date): MerchantDetail {
  const district = DISTRICTS[seed.district] ?? DISTRICTS.central;
  const geo = merchantLocation(seed);
  const facts = buildMerchantFacts(seed, now);
  const hoursFact = facts.find((fact) => fact.attribute === 'business_hours') ?? null;
  const ratingFact = facts.find((fact) => fact.attribute === 'rating') ?? null;
  const priceFact = facts.find((fact) => fact.attribute === 'price') ?? null;

  return {
    id: seed.id,
    slug: seed.slug,
    name: seed.name,
    tagline: seed.tagline,
    description: seed.description,
    category: seed.category,
    cuisine: seed.subcategories,
    price_band: seed.priceModel,
    avg_price: priceFact ? { amount: seed.priceAmount as string, currency: seed.currency } : null,
    rating: ratingFact && seed.ratingValue !== null ? { value: seed.ratingValue, count: seed.ratingCount } : null,
    images: [
      { url: `/media/${seed.slug}-a.svg`, alt: `合成示例图片：${seed.name}`, credit: 'synthetic' },
      { url: `/media/${seed.slug}-b.svg`, alt: `合成示例图片：${seed.name} 室内`, credit: 'synthetic' },
      { url: `/media/${seed.slug}-c.svg`, alt: `合成示例图片：${seed.name} 供应`, credit: 'synthetic' },
    ],
    locations: [
      {
        id: `${seed.id}:loc`,
        name: district.name,
        address: `${district.zh}${seed.slug === 'lung-yuen-kitchen' ? '正街 8 号地下的 1 樓' : '示例道 1 号'}（合成地址）`,
        district: district.name,
        city: 'Hong Kong',
        geo,
        mtr: { station: district.mtr, walk_minutes: district.walk },
        phone: seed.phone,
      },
    ],
    business_hours: seed.hours
      ? WEEKDAYS.map((weekday) => {
          const entry = seed.hours?.find((row) => row.weekday === weekday);
          return { weekday, closed: !entry, ranges: entry?.ranges ?? null };
        })
      : [],
    top_offerings: seed.offerings.map((offering) => buildOfferingSummary(seed, offering, now)),
    review_summary: buildReviewSummary(seed, now),
    facts,
    flags: { demo: true },
    links: [{ type: 'website', url: `https://${seed.domain}`, label: seed.domain }],
    attributes: {
      seating: [seed.seats ? '有座位预约' : '不提供座位预约'],
      hours_fact: [hoursFact ? '商户自报营业时间' : '营业时间未验证'],
    },
  };
}

export function buildOfferingSummary(seed: SeedMerchant, offering: SeedMerchant['offerings'][number], now: Date): OfferingSummary {
  return {
    id: `${seed.id}:${offering.slug}`,
    slug: offering.slug,
    title: offering.title,
    kind: offering.kind,
    description: offering.description,
    price: { amount: offering.price, currency: seed.currency, model: offering.kind === 'product' ? 'per_item' : 'per_person' },
    image: { url: `/media/${seed.slug}-b.svg`, alt: `合成示例图片：${offering.title}`, credit: 'synthetic' },
    merchant: { id: seed.id, slug: seed.slug, name: seed.name },
    facts: offeringFacts(seed, offering, now),
    flags: { demo: true },
  };
}

export function buildReviews(seed: SeedMerchant, now: Date): Review[] {
  return seed.reviewSeed.map((review, index) => ({
    review_id: factUuid(`${seed.id}:review:${index}`),
    author: { display_name: review.name },
    rating: review.rating,
    text: review.text,
    created_at: new Date(now.getTime() - review.days * 86_400_000).toISOString(),
    helpful_count: review.helpful,
    verified_reservation: index % 2 === 0,
    verified_purchase: index % 3 === 0,
    flags: { demo: true },
  }));
}

export function buildReviewSummary(seed: SeedMerchant, now: Date): ReviewSummary | null {
  const reviews = buildReviews(seed, now);
  if (reviews.length === 0) return null;
  return {
    summary: `${seed.name}：${reviews.length} 条合成示例评价中，最常提到的是「${seed.tags[0] ?? '安静'}」与「${seed.tags[1] ?? '性价比'}」。示例数据，用于演示评价摘要的呈现方式。`,
    themes: [
      {
        label: seed.tags[0] ?? 'ambience',
        sentiment: reviews.some((review) => review.rating >= 4) ? 'positive' : 'neutral',
        mentions: reviews.length,
        review_ids: reviews.map((review) => review.review_id),
      },
      {
        label: 'service_speed',
        sentiment: 'neutral',
        mentions: Math.max(1, reviews.length - 1),
        review_ids: reviews.slice(0, 1).map((review) => review.review_id),
      },
    ],
    evidence_review_ids: reviews.map((review) => review.review_id),
    generated_at: new Date(now.getTime() - 20 * 3_600_000).toISOString(),
    model: 'mock',
    facts: [
      {
        fact_id: factUuid(`${seed.id}:review-summary`),
        subject_type: 'merchant',
        subject_id: seed.id,
        attribute: 'review_summary',
        value: { mentions: reviews.length },
        source: 'observed',
        confidence: 0.8,
        observed_at: new Date(now.getTime() - 20 * 3_600_000).toISOString(),
        expires_at: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
        stale: false,
      },
    ],
    flags: { demo: true },
  };
}

export function buildAvailability(seed: SeedMerchant, now: Date): AvailabilitySlot[] {
  if (!seed.seats) return [];
  const slots: AvailabilitySlot[] = [];
  for (let day = 1; day <= 5; day += 1) {
    for (const [hour, minute] of [[18, 30], [19, 0], [19, 30], [20, 30]] as const) {
      const start = new Date(now.getTime() + day * 86_400_000);
      start.setUTCHours(hour, minute, 0, 0);
      const index = slots.length;
      const full = (index + day) % 7 === 0;
      const limited = (index + day) % 5 === 0;
      slots.push({
        slot_id: factUuid(`${seed.id}:slot:${start.toISOString()}`),
        starts_at: start.toISOString(),
        party_size: 2,
        status: full ? 'full' : limited ? 'limited' : 'available',
        remaining: full ? 0 : limited ? 1 : 4,
      });
    }
  }
  return slots;
}

/* ------------------------------------------------------------ account fixtures */

export function buildMe(now: Date): MeProfile {
  // SEED_MERCHANTS is a static non-empty literal; the index access needs no runtime guard.
  const anySeed = SEED_MERCHANTS[0] as SeedMerchant;
  const favorites: Favorite[] = ['m-lung-yuen', 'm-bauhinia-cafe', 'm-granite-gym'].map((id, index) => {
    const seed = SEED_MERCHANTS.find((merchant) => merchant.id === id) ?? anySeed;
    return {
      id: `fav-${index}`,
      subject_type: 'merchant',
      subject_id: seed.id,
      // filled by the mock card builder to avoid a circular import
      card: null as never,
      created_at: new Date(now.getTime() - (index + 1) * 86_400_000).toISOString(),
    };
  });

  const orders: Order[] = [
    {
      id: 'ord-1', code: 'NX-DEMO-4821', status: 'completed',
      lines: [{ offering_id: 'm-kowloon-bay-bakery:kb-sourdough-loaf', title: '天然酸种面包（条）', quantity: 2, unit_price: { amount: '58.00', currency: 'HKD' } }],
      total: { amount: '116.00', currency: 'HKD' }, created_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      merchant_name: '九龍灣面包房', demo: true,
    },
    {
      id: 'ord-2', code: 'NX-DEMO-4915', status: 'confirmed',
      lines: [{ offering_id: 'm-mong-kok-sneaker:rr-waterproof-treat', title: '防水护理（双）', quantity: 1, unit_price: { amount: '120.00', currency: 'HKD' }, stale: true }],
      total: { amount: '120.00', currency: 'HKD' }, created_at: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
      merchant_name: 'Rain Ready 鞋履', demo: true,
    },
  ];

  const reservations: Reservation[] = [
    {
      id: 'res-1', code: 'RV-DEMO-3311', merchant_id: 'm-lung-yuen', merchant_name: '龍苑 Kitchen',
      slot_start: new Date(now.getTime() + 4 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z').slice(0, 11) + '11:00:00Z',
      party_size: 2, status: 'confirmed', notes: '想要安静角落位（示例请求）。',
      created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(), demo: true,
    },
  ];

  const preferences: UserPreference[] = [
    { id: 'p1', key: 'ambience', value: 'quiet', scope: 'long_term', source: 'declared', confidence: 0.95, updated_at: new Date(now.getTime() - 9 * 86_400_000).toISOString(), used_by_ranking: true },
    { id: 'p2', key: 'budget_per_person_max', value: 'HKD 300', scope: 'long_term', source: 'explicit_feedback', confidence: 0.82, updated_at: new Date(now.getTime() - 4 * 86_400_000).toISOString(), used_by_ranking: true },
    { id: 'p3', key: 'cuisine_avoid', value: 'spicy', scope: 'long_term', source: 'inferred', confidence: 0.58, updated_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(), used_by_ranking: false },
    { id: 'p4', key: 'district', value: 'Sha Tin', scope: 'session', source: 'inferred', confidence: 0.44, updated_at: new Date(now.getTime() - 6 * 3_600_000).toISOString(), used_by_ranking: false },
  ];

  const savedSearches: SavedSearch[] = [
    {
      id: 'ss-1', query: '帮我找沙田适合情侣约会的餐厅，预算500，安静一点，周六晚上',
      intent: {
        raw_query: '帮我找沙田适合情侣约会的餐厅，预算500，安静一点，周六晚上',
        intent: 'discover_merchant', category: 'restaurant',
        location: { type: 'district', value: 'Sha Tin', resolved: DISTRICTS.sha_tin.geo, radius_m: 3000 },
        time: { type: 'explicit', starts_at: new Date(now.getTime() + 4 * 86_400_000).toISOString() },
        budget: { min: null, max: 500, currency: 'HKD', per: 'party' }, party_size: null,
        preferences: [{ key: 'ambience', value: 'quiet', polarity: 1 }],
        constraints: [{ key: 'cuisine_avoid', value: 'spicy' }],
        sort_preference: 'relevance', urgency: 'normal', language: 'zh-HK',
        confidence: { category: 0.95, budget: 0.9, time: 0.8 }, unknowns: ['party_size'],
      },
      notify: true, created_at: new Date(now.getTime() - 5 * 86_400_000).toISOString(), result_count_estimate: 6,
    },
  ];

  const notifications: AppNotification[] = [
    { id: 'n1', type: 'reservation_confirmed', title: '示例：订位已确认', body: '龍苑 Kitchen · 2 位（合成数据，用于演示通知中心）。', href: '/account', read_at: null, created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() },
    { id: 'n2', type: 'guide_published', title: '示例：新指南', body: '《香港雨天去哪》已发布（合成内容）。', href: '/guide/rainy-day-hong-kong', read_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(), created_at: new Date(now.getTime() - 4 * 86_400_000).toISOString() },
  ];

  return {
    user: { id: 'demo-consumer', email: 'consumer@example.hk', display_name: '示例用戶 Ada', locale: 'zh-HK', created_at: new Date(now.getTime() - 120 * 86_400_000).toISOString(), demo: true, memberships: [] },
    preferences, favorites, saved_searches: savedSearches, orders, reservations, notifications,
    personalization: { enabled: true, signals_used: 26, last_updated_at: new Date(now.getTime() - 3600_000).toISOString() },
  };
}

export const DEMO_COLLECTIONS: Collection[] = [
  {
    slug: 'quiet-date-night-central', title: '安静的一晚 · 中環與灣仔', city: 'hong-kong', category: 'restaurant',
    description: '合成示例集合：可以聊完一整晚不喊话的地方，按距离排序。全部为演示数据。',
    cover_image: { url: '/media/collection-quiet-date.svg', alt: '合成示例封面', credit: 'synthetic' },
    curated_by: { type: 'editorial', name: 'NEXUS 编辑（合成）' },
    items: [], updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'rainy-day-hong-kong', title: '下雨天去哪 · 香港', city: 'hong-kong', category: 'activities',
    description: '合成示例集合：雨天不用淋到雨的步行距离方案。',
    cover_image: { url: '/media/collection-rainy-day.svg', alt: '合成示例封面', credit: 'synthetic' },
    curated_by: { type: 'creator', name: 'Creator: 阿明（合成）' },
    items: [], updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'late-night-where', title: '十点后还开着', city: 'hong-kong', category: 'fitness',
    description: '合成示例集合：深夜可去的健身、餐饮与理疗。',
    cover_image: { url: '/media/collection-late-night.svg', alt: '合成示例封面', credit: 'synthetic' },
    curated_by: { type: 'ai', name: 'NEXUS AI（合成，人工复核未做）' },
    items: [], updated_at: new Date().toISOString(), flags: { demo: true },
  },
];

export const DEMO_GUIDES: Guide[] = [
  {
    slug: 'rainy-day-hong-kong', title: '下雨天的香港：步行 10 分钟内的六个选择', city: 'hong-kong', category: 'activities',
    description: '合成示例指南：演示 AI 生成 + 结构化数据的本地指南页。内容并非真实建议。',
    body_blocks: [
      { type: 'paragraph', text: '合成示例：本指南由 NEXUS 的 SEO 代理草拟，用于演示指南页的呈现与结构化数据。所列商戶均为演示数据（flags.demo）。' },
      { type: 'heading', text: '一、避开露天路段' },
      { type: 'list', items: ['选择港铁一站内、有盖走廊连接的地点', '优先早关门的地方，雨天翻台快', '外带比堂食稳'] },
      { type: 'cards', title: '雨天可选', items: [] },
      { type: 'heading', text: '二、预算控制在 HK$150 以内' },
      { type: 'paragraph', text: '合成示例：把价格上限写进 Intent（budget.max），结果会优先给出符合预算的商戶；每条解释都必须能追到 fact_id。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'sha-tin-date-plan', title: '沙田约会两小时方案（示例）', city: 'hong-kong', category: 'restaurant',
    description: '合成示例指南：演示「计划型体验」的页结构与 JSON-LD。',
    body_blocks: [
      { type: 'paragraph', text: '合成示例：一个以沙田为中心、步行可达的两小时方案。' },
      { type: 'heading', text: '路线' },
      { type: 'list', items: ['18:30 咖啡（有插座、安静）', '19:30 晚餐（粤式小炒，需订位）', '21:15 河边散步'] },
      { type: 'cards', title: '本方案涉及商戶', items: [] },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
];
