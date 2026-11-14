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
 *    Those are the cases the UI must render as 未驗證, so they are part of the data set.
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
    id: 'm-lung-yuen', slug: 'lung-yuen-kitchen', name: '龍苑 Kitchen', tagline: '粵式小炒 · 沙田',
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
      { name: 'K. Chan', rating: 5, text: '安靜的角落位適合兩個人吃飯，鹽焗蝦很穩定。', days: 6, helpful: 24 },
      { name: 'Mora L.', rating: 4, text: 'Service was quick, portions generous for sharing. Ask for the corner table.', days: 13, helpful: 11 },
      { name: '阿強', rating: 5, text: '訂位很快，晚市人潮多但不會吵。', days: 21, helpful: 8 },
    ],
  },
  {
    id: 'm-haeto-bistro', slug: 'haeto-bistro', name: '海塘 Bistro', tagline: '海景西餐 · 鴨脷洲',
    description: '合成示例商戶：避風塘景位的西餐小館，晚上有窗邊位。',
    category: 'restaurant', subcategories: ['western', 'seafood'], tags: ['date-night', 'sea-view', 'quiet'],
    district: 'ap_lei_chau', offset: [-0.005, 0.004], priceAmount: '420.00', priceModel: 'per_person',
    ratingValue: 4.4, ratingCount: 128, currency: 'HKD',
    hours: WITH_CLOSED_SUN('12:00', '22:30'), seats: true, phone: '+852 2600 0002', domain: 'haeto.example.hk', imageHue: 188,
    offerings: [
      { slug: 'haeto-window-two-course', title: '窗邊雙人兩道式', kind: 'experience', price: '688.00', description: '需指定窗邊位，視當天供应。' },
      { slug: 'haeto-black-pepper-scallop', title: '黑椒帶子（件）', kind: 'product', price: '128.00', description: '限量，售完即止。' },
    ],
    reviewSeed: [
      { name: 'V. Ho', rating: 5, text: '海景位值得，提前一天訂比較穩。', days: 4, helpful: 31 },
      { name: 'Dan R.', rating: 4, text: 'Good value for the view; acoustics get loud after 8pm.', days: 17, helpful: 9 },
    ],
  },
  {
    id: 'm-ramen-koji', slug: 'ramen-koji', name: '拉麵小路 Koji', tagline: '日式拉麵 · 旺角',
    description: '合成示例商戶：吧台位為主，翻台快，辣度可選。',
    category: 'restaurant', subcategories: ['japanese', 'ramen'], tags: ['solo', 'cheap', 'japanese', 'spicy'],
    district: 'mong_kok', offset: [0.003, 0.002], priceAmount: '92.00', priceModel: 'per_person',
    ratingValue: 4.3, ratingCount: 402, currency: 'HKD',
    hours: EVERYDAY('11:00', '23:00'), seats: false, phone: '+852 2600 0003', domain: 'koji.example.hk', imageHue: 24,
    offerings: [
      { slug: 'koji-tonkotsu-large', title: '大碗豚骨拉麵', kind: 'product', price: '102.00', description: '面體軟硬可指定。' },
      { slug: 'koji-spicy-miso', title: '辛味噌拉麵', kind: 'product', price: '98.00', description: '辣度 1–5。' },
    ],
    reviewSeed: [
      { name: 'Siu Ming', rating: 4, text: '排隊二十分鐘，但翻台很快。辣度三級已經很辣。', days: 2, helpful: 14 },
      { name: 'Priya S.', rating: 5, text: 'Cheap, consistent, and the counter seats are great solo.', days: 9, helpful: 22 },
      { name: 'T. Leung', rating: 3, text: '太擁擠，不適合聊天。', days: 28, helpful: 6 },
    ],
  },
  {
    id: 'm-sichuan-lane', slug: 'sichuan-lane', name: '川巷 Sichuan Lane', tagline: '川菜 · 銅鑼灣',
    description: '合成示例商戶：重辣小館，有清湯選項，朋友聚會為主。',
    category: 'restaurant', subcategories: ['sichuan', 'spicy'], tags: ['friends', 'spicy', 'group'],
    district: 'causeway_bay', offset: [-0.004, -0.003], priceAmount: '240.00', priceModel: 'per_person',
    ratingValue: 4.5, ratingCount: 176, currency: 'HKD',
    hours: EVERYDAY('12:00', '23:30'), seats: true, phone: '+852 2600 0004', domain: 'sichuanlane.example.hk', imageHue: 6,
    offerings: [
      { slug: 'sichuan-four-person-feast', title: '四人辣宴套餐', kind: 'experience', price: '880.00', description: '含兩清湯選擇。' },
    ],
    reviewSeed: [
      { name: 'R. Yip', rating: 5, text: '四個人吃得很好，可以叫不辣的湯給小孩。', days: 5, helpful: 19 },
      { name: 'Alina', rating: 4, text: 'Very good spice levels, service slows when full.', days: 15, helpful: 7 },
    ],
  },
  {
    id: 'm-bauhinia-cafe', slug: 'bauhinia-cafe', name: '洋紫荊咖啡', tagline: '咖啡 · 中環',
    description: '合成示例商戶：早開門、有插座、可外帶。',
    category: 'cafe', subcategories: ['coffee', 'brunch'], tags: ['quiet', 'work', 'cheap', 'early'],
    district: 'central', offset: [0.002, 0.003], priceAmount: '78.00', priceModel: 'per_person',
    ratingValue: 4.7, ratingCount: 331, currency: 'HKD',
    hours: EVERYDAY('07:00', '19:00'), seats: true, phone: '+852 2600 0005', domain: 'bauhinia.example.hk', imageHue: 36,
    offerings: [
      { slug: 'bauhinia-filter-two', title: '手冲咖啡（兩杯）', kind: 'product', price: '128.00', description: '豆單每周更換。' },
      { slug: 'bauhinia-laptop-corner', title: '角落工作位 2 小時', kind: 'service', price: '0.00', description: '免費，但需消費。' },
    ],
    reviewSeed: [
      { name: 'J. Wong', rating: 5, text: '早上七點就開，有位有插座。', days: 3, helpful: 27 },
      { name: 'Marco B.', rating: 4, text: 'Solid beans, quick wifi, gets full before ten.', days: 11, helpful: 12 },
    ],
  },
  {
    id: 'm-granite-gym', slug: 'granite-gym', name: 'Granite Strength Club', tagline: '健身 · 九龍灣',
    description: '合成示例商戶：24 小時入口，晚上十點後仍營業，硬拉台有限。',
    category: 'fitness', subcategories: ['gym', 'strength'], tags: ['late-night', 'solo', 'equipment'],
    district: 'kowloon_bay', offset: [0.005, -0.004], priceAmount: '120.00', priceModel: 'per_item',
    ratingValue: 4.2, ratingCount: 96, currency: 'HKD',
    hours: EVERYDAY('00:00', '23:59'), seats: false, phone: '+852 2600 0006', domain: 'granite.example.hk', imageHue: 210,
    offerings: [
      { slug: 'granite-day-pass', title: '日票', kind: 'service', price: '120.00', description: '含更衣室與储物柜。' },
      { slug: 'granite-coaching-60', title: '私人指导 60 分鐘', kind: 'service', price: '680.00', description: '需預約教練档期。' },
    ],
    reviewSeed: [
      { name: 'Kit T.', rating: 4, text: '十點後還有位置，周日晚最多人。', days: 7, helpful: 15 },
      { name: 'Nadia', rating: 5, text: 'Deadlift platforms actually available, that is rare.', days: 19, helpful: 10 },
    ],
  },
  {
    id: 'm-petal-tea', slug: 'petal-tea-house', name: '花瓣茶室', tagline: '茶室 · 上水',
    description: '合成示例商戶：安靜茶室，無酒精，適合長輩同行。',
    category: 'cafe', subcategories: ['tea', 'dessert'], tags: ['quiet', 'family', 'no-alcohol'],
    district: 'sheung_shui', offset: [-0.003, 0.005], priceAmount: '110.00', priceModel: 'per_person',
    ratingValue: 4.8, ratingCount: 64, currency: 'HKD',
    hours: WITH_CLOSED_SUN('13:00', '20:00'), seats: true, phone: '+852 2600 0007', domain: 'petal.example.hk', imageHue: 132,
    offerings: [{ slug: 'petal-tea-flight', title: '四款茶试飲組', kind: 'product', price: '148.00', description: '約 25 分鐘。' }],
    reviewSeed: [{ name: 'C. Lam', rating: 5, text: '真的很靜，適合跟父母聊天。', days: 8, helpful: 21 }],
    // deliberate gap: no price fact → the card must render 未驗證
    factGaps: { price: true },
  },
  {
    id: 'm-harbour-bar', slug: 'harbour-quiet-bar', name: 'Harbour Side Bar', tagline: '酒吧 · 尖沙咀',
    description: '合成示例商戶：深夜營業，現場不供应正餐，可外帶小食。',
    category: 'entertainment', subcategories: ['bar', 'cocktails'], tags: ['late-night', 'date-night', 'group'],
    district: 'tsim_sha_tsui', offset: [0.004, 0.006], priceAmount: '135.00', priceModel: 'per_item',
    ratingValue: 4.1, ratingCount: 149, currency: 'HKD',
    hours: EVERYDAY('18:00', '02:00'), seats: true, phone: '+852 2600 0008', domain: 'harbourside.example.hk', imageHue: 268,
    offerings: [{ slug: 'harbour-signature-two', title: '指定鷄尾酒兩款', kind: 'product', price: '210.00', description: '含軟性替代選項。' }],
    reviewSeed: [{ name: 'O. Beck', rating: 4, text: 'Loud after 10pm but easy to find seats.', days: 12, helpful: 9 }],
    // deliberate gap: stale price fact (observed long ago) → "價格可能已更新"
    factGaps: { stalePrice: true },
  },
  {
    id: 'm-green-curve', slug: 'green-curve-vegetarian', name: '青弯素膳', tagline: '素食 · 灣仔',
    description: '合成示例商戶：無辣選項多，孩子餐椅有。',
    category: 'restaurant', subcategories: ['vegetarian', 'cantonese'], tags: ['family', 'no-spicy', 'cheap', 'quiet'],
    district: 'wan_chai', offset: [-0.002, -0.005], priceAmount: '128.00', priceModel: 'per_person',
    ratingValue: 4.0, ratingCount: 88, currency: 'HKD',
    hours: EVERYDAY('11:00', '21:00'), seats: true, phone: '+852 2600 0009', domain: 'greencurve.example.hk', imageHue: 108,
    offerings: [{ slug: 'green-curve-set-lunch', title: '午市素套餐', kind: 'product', price: '78.00', description: '11:00–15:00。' }],
    reviewSeed: [{ name: 'Wai Yee', rating: 4, text: '清湯選項多，帶小孩方便。', days: 10, helpful: 13 }],
  },
  {
    id: 'm-north-point-hotel', slug: 'north-point-inn', name: 'North Point Inn', tagline: '精品住宿 · 將軍澳',
    description: '合成示例商戶：海景雙人房，可加床，含早餐。',
    category: 'hotel', subcategories: ['boutique-hotel'], tags: ['date-night', 'sea-view', 'stay'],
    district: 'tseung_kwan_o', offset: [0.006, 0.004], priceAmount: '980.00', priceModel: 'per_party',
    ratingValue: 4.3, ratingCount: 57, currency: 'HKD',
    hours: EVERYDAY('00:00', '23:59'), seats: false, phone: '+852 2600 0010', domain: 'northpoint.example.hk', imageHue: 200,
    offerings: [{ slug: 'northpoint-sea-double', title: '海景雙人房一晚', kind: 'service', price: '980.00', description: '含雙人早餐。' }],
    reviewSeed: [{ name: 'E. Fung', rating: 4, text: '房間安靜，海景位要早訂。', days: 25, helpful: 6 }],
  },
  {
    id: 'm-tsuen-wan-dimsum', slug: 'tsuen-wan-dimsum-house', name: '荃灣點心屋', tagline: '點心 · 荃灣',
    description: '合成示例商戶：即蒸點心，周末排隊，價格低。',
    category: 'restaurant', subcategories: ['dimsum', 'cantonese'], tags: ['cheap', 'family', 'cantonese'],
    district: 'tsuen_wan', offset: [0.003, -0.005], priceAmount: '86.00', priceModel: 'per_person',
    ratingValue: 4.2, ratingCount: 265, currency: 'HKD',
    hours: EVERYDAY('07:30', '18:00'), seats: true, phone: '+852 2600 0011', domain: 'tswendimsum.example.hk', imageHue: 44,
    offerings: [{ slug: 'tsuen-dimsum-basket-five', title: '五籠點心組', kind: 'product', price: '158.00', description: '即蒸約 15 分鐘。' }],
    reviewSeed: [{ name: 'K. Poon', rating: 4, text: '平而穩定，周日上午最擠。', days: 5, helpful: 17 }],
  },
  {
    id: 'm-jordan-korean', slug: 'jordan-seoul-grill', name: '首尔炭火 · Jordan', tagline: '韓式燒烤 · 佐敦',
    description: '合成示例商戶：聚會型燒烤，可選不辣腌料。',
    category: 'restaurant', subcategories: ['korean', 'bbq'], tags: ['friends', 'group', 'korean'],
    district: 'jordan', offset: [-0.006, 0.002], priceAmount: '268.00', priceModel: 'per_person',
    ratingValue: 4.5, ratingCount: 191, currency: 'HKD',
    hours: EVERYDAY('12:00', '23:00'), seats: true, phone: '+852 2600 0012', domain: 'seoulgrill.example.hk', imageHue: 16,
    offerings: [{ slug: 'jordan-grill-four-person', title: '四人炭火套餐', kind: 'experience', price: '1080.00', description: '含不辣腌料選項。' }],
    reviewSeed: [{ name: 'Hana K.', rating: 5, text: '四人餐夠食，服務快。', days: 6, helpful: 18 }],
    // deliberate gap: rating fact below the 0.4 confidence floor → omitted as 未驗證
    factGaps: { lowConfidenceRating: true },
  },
  {
    id: 'm-central-running', slug: 'central-runs-club', name: 'Central Runs Club', tagline: '活動 · 中環',
    description: '合成示例商戶：清晨缓跑團，含教練，天氣取消。',
    category: 'activities', subcategories: ['running', 'outdoor'], tags: ['early', 'solo', 'outdoor'],
    district: 'central', offset: [-0.005, -0.002], priceAmount: '150.00', priceModel: 'per_item',
    ratingValue: null, ratingCount: 0, currency: 'HKD',
    hours: [H(6, '06:00', '08:00'), H(0, '06:00', '08:00')], seats: false, phone: '+852 2600 0013', domain: 'centralruns.example.hk', imageHue: 156,
    offerings: [{ slug: 'central-runs-sat-session', title: '周六缓跑 session', kind: 'experience', price: '150.00', description: '集合點中環碼頭。' }],
    reviewSeed: [{ name: 'G. Ortiz', rating: 5, text: 'Pacing groups are honest, no pressure.', days: 14, helpful: 5 }],
    factGaps: { rating: true },
  },
  {
    id: 'm-sha-tin-hotpot', slug: 'sha-tin-hotpot', name: '沙田火鍋 · 圍爐', tagline: '火鍋 · 沙田',
    description: '合成示例商戶：鸳鸯鍋，周末晚上有位率低。',
    category: 'restaurant', subcategories: ['hotpot', 'sichuan'], tags: ['friends', 'spicy', 'group', 'date-night'],
    district: 'sha_tin', offset: [-0.004, 0.006], priceAmount: '320.00', priceModel: 'per_person',
    ratingValue: 4.4, ratingCount: 158, currency: 'HKD',
    hours: EVERYDAY('11:30', '23:00'), seats: true, phone: '+852 2600 0014', domain: 'weilu.example.hk', imageHue: 350,
    offerings: [{ slug: 'shatin-hotpot-two', title: '雙人鸳鸯鍋', kind: 'experience', price: '588.00', description: '周六 19:00 需等位。' }],
    reviewSeed: [{ name: 'L. Cheung', rating: 4, text: '湯底穩，周末七點要等。', days: 9, helpful: 16 }],
  },
  {
    id: 'm-wan-chai-noise', slug: 'wan-chai-listening-bar', name: 'Wan Chai Listening Bar', tagline: '酒吧 · 灣仔',
    description: '合成示例商戶：黑胶聆听酒吧，不供应正餐。',
    category: 'entertainment', subcategories: ['bar', 'music'], tags: ['quiet', 'date-night', 'late-night'],
    district: 'wan_chai', offset: [0.005, 0.003], priceAmount: '180.00', priceModel: 'per_person',
    ratingValue: 4.6, ratingCount: 74, currency: 'HKD',
    hours: WITH_CLOSED_SUN('19:00', '23:30'), seats: true, phone: '+852 2600 0015', domain: 'listeningbar.example.hk', imageHue: 282,
    offerings: [{ slug: 'listening-two-cocktails', title: '兩款指定鷄尾酒', kind: 'product', price: '230.00', description: '無酒精替代有。' }],
    reviewSeed: [{ name: 'I. Sato', rating: 5, text: '安靜得可以聊天，音量控制得好。', days: 20, helpful: 8 }],
  },
  {
    id: 'm-kowloon-bay-bakery', slug: 'kowloon-bay-bakery', name: '九龍灣面包房', tagline: '面包 · 九龍灣',
    description: '合成示例商戶：下午出爐，雨天有外帶。',
    category: 'cafe', subcategories: ['bakery', 'coffee'], tags: ['cheap', 'takeaway', 'early'],
    district: 'kowloon_bay', offset: [-0.003, -0.006], priceAmount: '42.00', priceModel: 'per_item',
    ratingValue: 4.5, ratingCount: 210, currency: 'HKD',
    hours: WITH_CLOSED_SUN('07:30', '19:30'), seats: false, phone: '+852 2600 0016', domain: 'kbbakery.example.hk', imageHue: 52,
    offerings: [{ slug: 'kb-sourdough-loaf', title: '天然酸种面包（條）', kind: 'product', price: '58.00', description: '下午 3 點出爐。' }],
    reviewSeed: [{ name: 'P. Ng', rating: 5, text: '三點出爐，去晚就沒了。', days: 4, helpful: 26 }],
  },
  {
    id: 'm-mong-kok-sneaker', slug: 'mong-kok-rain-ready', name: 'Rain Ready 鞋履', tagline: '購物 · 旺角',
    description: '合成示例商戶：雨天防滑鞋與護理服務。',
    category: 'shopping', subcategories: ['footwear'], tags: ['rainy-day', 'takeaway'],
    district: 'mong_kok', offset: [0.002, -0.004], priceAmount: '680.00', priceModel: 'per_item',
    ratingValue: 4.1, ratingCount: 43, currency: 'HKD',
    hours: EVERYDAY('12:00', '20:30'), seats: false, phone: '+852 2600 0017', domain: 'rainready.example.hk', imageHue: 226,
    offerings: [
      { slug: 'rr-grip-derby', title: '防滑德比鞋', kind: 'product', price: '680.00', description: '尺碼 36–45。' },
      { slug: 'rr-waterproof-treat', title: '防水護理（雙）', kind: 'service', price: '120.00', description: '當日可取。' },
    ],
    reviewSeed: [{ name: 'F. Tsang', rating: 4, text: '雨天真的不滑，尺碼偏大半號。', days: 16, helpful: 7 }],
  },
  {
    id: 'm-tst-massage', slug: 'tst-recovery-studio', name: 'TST Recovery Studio', tagline: '理療 · 尖沙咀',
    description: '合成示例商戶：運動恢復與按摩，晚間時段紧。',
    category: 'beauty', subcategories: ['massage', 'recovery'], tags: ['solo', 'late-night', 'quiet'],
    district: 'tsim_sha_tsui', offset: [-0.005, -0.003], priceAmount: '520.00', priceModel: 'per_hour',
    ratingValue: 4.7, ratingCount: 112, currency: 'HKD',
    hours: EVERYDAY('10:00', '21:00'), seats: true, phone: '+852 2600 0018', domain: 'trecovery.example.hk', imageHue: 168,
    offerings: [{ slug: 'tst-deep-tissue-60', title: '深層組织 60 分鐘', kind: 'service', price: '520.00', description: '需提前 24 小時改期。' }],
    reviewSeed: [{ name: 'S. Malik', rating: 5, text: 'Booked same day at 8pm, actually available.', days: 3, helpful: 14 }],
    // deliberate gap: no business-hours fact → 未驗證 for open/closed
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
 * is stale by construction is what makes the 未驗證 path testable.
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
      { url: `/media/${seed.slug}-a.svg`, alt: `合成示例圖片：${seed.name}`, credit: 'synthetic' },
      { url: `/media/${seed.slug}-b.svg`, alt: `合成示例圖片：${seed.name} 室內`, credit: 'synthetic' },
      { url: `/media/${seed.slug}-c.svg`, alt: `合成示例圖片：${seed.name} 供应`, credit: 'synthetic' },
    ],
    locations: [
      {
        id: `${seed.id}:loc`,
        name: district.name,
        address: `${district.zh}${seed.slug === 'lung-yuen-kitchen' ? '正街 8 號地下的 1 樓' : '示例道 1 號'}（合成地址）`,
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
      seating: [seed.seats ? '有座位預約' : '不提供座位預約'],
      hours_fact: [hoursFact ? '商戶自报營業時間' : '營業時間未驗證'],
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
    image: { url: `/media/${seed.slug}-b.svg`, alt: `合成示例圖片：${offering.title}`, credit: 'synthetic' },
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
    summary: `${seed.name}：${reviews.length} 條合成示例評價中，最常提到的是「${seed.tags[0] ?? '安靜'}」與「${seed.tags[1] ?? '性價比'}」。示例數據，用於演示評價摘要的呈現方式。`,
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
      lines: [{ offering_id: 'm-kowloon-bay-bakery:kb-sourdough-loaf', title: '天然酸种面包（條）', quantity: 2, unit_price: { amount: '58.00', currency: 'HKD' } }],
      total: { amount: '116.00', currency: 'HKD' }, created_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      merchant_name: '九龍灣面包房', demo: true,
    },
    {
      id: 'ord-2', code: 'NX-DEMO-4915', status: 'confirmed',
      lines: [{ offering_id: 'm-mong-kok-sneaker:rr-waterproof-treat', title: '防水護理（雙）', quantity: 1, unit_price: { amount: '120.00', currency: 'HKD' }, stale: true }],
      total: { amount: '120.00', currency: 'HKD' }, created_at: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
      merchant_name: 'Rain Ready 鞋履', demo: true,
    },
  ];

  const reservations: Reservation[] = [
    {
      id: 'res-1', code: 'RV-DEMO-3311', merchant_id: 'm-lung-yuen', merchant_name: '龍苑 Kitchen',
      slot_start: new Date(now.getTime() + 4 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z').slice(0, 11) + '11:00:00Z',
      party_size: 2, status: 'confirmed', notes: '想要安靜角落位（示例請求）。',
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
      id: 'ss-1', query: '幫我找沙田適合情侶約會的餐廳，預算500，安靜一點，周六晚上',
      intent: {
        raw_query: '幫我找沙田適合情侶約會的餐廳，預算500，安靜一點，周六晚上',
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
    { id: 'n1', type: 'reservation_confirmed', title: '示例：訂位已确認', body: '龍苑 Kitchen · 2 位（合成數據，用於演示通知中心）。', href: '/account', read_at: null, created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() },
    { id: 'n2', type: 'guide_published', title: '示例：新指南', body: '《香港雨天去哪》已發布（合成內容）。', href: '/guide/rainy-day-hong-kong', read_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(), created_at: new Date(now.getTime() - 4 * 86_400_000).toISOString() },
  ];

  return {
    user: { id: 'demo-consumer', email: 'consumer@example.hk', display_name: '示例用戶 Ada', locale: 'zh-HK', created_at: new Date(now.getTime() - 120 * 86_400_000).toISOString(), demo: true, memberships: [] },
    preferences, favorites, saved_searches: savedSearches, orders, reservations, notifications,
    personalization: { enabled: true, signals_used: 26, last_updated_at: new Date(now.getTime() - 3600_000).toISOString() },
  };
}

export const DEMO_COLLECTIONS: Collection[] = [
  {
    slug: 'quiet-date-night-central', title: '安靜的一晚 · 中環與灣仔', city: 'hong-kong', category: 'restaurant',
    description: '合成示例集合：可以聊完一整晚不喊話的地方，按距离排序。全部為演示數據。',
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
    slug: 'late-night-where', title: '十點後還開著', city: 'hong-kong', category: 'fitness',
    description: '合成示例集合：深夜可去的健身、餐飲與理療。',
    cover_image: { url: '/media/collection-late-night.svg', alt: '合成示例封面', credit: 'synthetic' },
    curated_by: { type: 'ai', name: 'NEXUS AI（合成，人工復核未做）' },
    items: [], updated_at: new Date().toISOString(), flags: { demo: true },
  },
];

export const DEMO_GUIDES: Guide[] = [
  {
    slug: 'rainy-day-hong-kong', title: '下雨天的香港：步行 10 分鐘內的六個選擇', city: 'hong-kong', category: 'activities',
    description: '合成示例指南：演示 AI 生成 + 结構化數據的本地指南頁。內容並非真實建議。',
    body_blocks: [
      { type: 'paragraph', text: '合成示例：本指南由 NEXUS 的 SEO 代理草拟，用於演示指南頁的呈現與结構化數據。所列商戶均為演示數據（flags.demo）。' },
      { type: 'heading', text: '一、避開露天路段' },
      { type: 'list', items: ['選擇港鐵一站內、有蓋走廊連結的地點', '優先早關門的地方，雨天翻台快', '外帶比堂食穩'] },
      { type: 'cards', title: '雨天可選', items: [] },
      { type: 'heading', text: '二、預算控制在 HK$150 以內' },
      { type: 'paragraph', text: '合成示例：把價格上限写進 Intent（budget.max），结果會優先給出符合預算的商戶；每條解释都必須能追到 fact_id。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'sha-tin-date-plan', title: '沙田約會兩小時方案（示例）', city: 'hong-kong', category: 'restaurant',
    description: '合成示例指南：演示「計劃型體驗」的頁结構與 JSON-LD。',
    body_blocks: [
      { type: 'paragraph', text: '合成示例：一個以沙田為中心、步行可达的兩小時方案。' },
      { type: 'heading', text: '路綫' },
      { type: 'list', items: ['18:30 咖啡（有插座、安靜）', '19:30 晚餐（粵式小炒，需訂位）', '21:15 河邊散步'] },
      { type: 'cards', title: '本方案涉及商戶', items: [] },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-food-chronicle', title: '香港三餐的血脈：一座用火烹出來的史詩', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：用二十四小時的香港，從凌晨四點半街市裡冒煙的叉燒店，寫到深水埗盛夜一碗火鍋沸湯。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：香港是一座用火烹出來的史詩。每天凌晨四點半，港島東的街市檔主點亮吊爐，把當天的菜心、豬腩肉、鯪魚球、魚蛋鋪在白水泥的檯上；霓虹燈從這排燈火上彎下腰來，認出這是這座城由始到終都懂得的句子：下一餐，就快到。' },
      { type: 'heading', text: '一、清晨：茶餐廳的第一個空位' },
      { type: 'paragraph', text: '六點半，上班的人離家。走進船廠尾的小巷，茶餐廳的燈亮得像了不起的日子——一疊黃紙、一個凍熱並列的水煲掛在櫥窗前。常餐一份：一杯加薑的暖奶茶、兩塊塗上煉乳的菠蘿油、一條半生熟的炒蛋公仔麵，再加半個汆水西多士。趕時間的人守在門口長凳上，菠蘿油一落枱就被人搶去。' },
      { type: 'list', items: ['常餐的位置密碼：靠門口的兩排長凳為了叫外賣，靠廚的是為了搶第一碗麵', '菠蘿油必須趁熱食，菠蘿皮的脆感在煉乳融化前最後三十秒', '公仔麵以半生熟為準，烚爛的麵皮一上枱就知道'] },
      { type: 'cards', title: '清晨可去', items: [] },
      { type: 'heading', text: '二、上午：第二杯嘢' },
      { type: 'paragraph', text: '九點，這座城市的電梯換成領帶和西裝革履。中環的投行是低語聲最多的地方——用手機比特幣、用電話報收購價、用電腦跑一份風險報告。午餐旺市之前，有人拆出來在街角茶餐廳點一個菠蘿包，或一個火腿蛋治配一杯凍檸茶。光點落在鍵盤上，金額在屏幕上漲跌——所有數字的尾巴，終要歸一張嘴。' },
      { type: 'heading', text: '三、正午：午市的移動' },
      { type: 'paragraph', text: '十二點半過後，整個城朝同一個方向移動。燒味檔六點半就訂滿了蜜糖雞、叉燒、燒鵝、燒鴨，每個師傅都在爐火旁守候。午餐節奏十分鐘一宗：牛腩飯三分鐘出、燒鴨髀飯兩分半、豬骨煲飯四分鐘。這裡時間只能急一急，沒有人有資格慢慢食。' },
      { type: 'cards', title: '午市可選', items: [] },
      { type: 'heading', text: '四、午後：糖水，或是閉目養神' },
      { type: 'paragraph', text: '兩點半，商場裡換上冷氣加速歲月。午後三點鐘，所謂的「糖水」就是這座城醒腦最溫柔的方式——砵仔糕、芝麻糊、雙皮奶、楊枝甘露。那份甜是粵語裡最溫柔的一句「無所謂」：不在乎加班，不在乎下午會不會再有客戶來電。' },
      { type: 'heading', text: '五、黃昏：燒味的最後一柱煙' },
      { type: 'paragraph', text: '傍晚六點，每一根煙囪都知道自己的火要收了。蜜糖雞的表皮在炭合餘溫中泛光——潮州人把這叫作燒味：糖分夠好、火候夠準，每一截骨邊緣都會有一條深色的油鋒。來火炭的是紗廠女工，來香港島的是律師，來尖沙咀的是帶奶粉的客人。在這裡，人們不說「我吃飽了」，他們只說「一件燒鴨髀飯」。' },
      { type: 'cards', title: '黃昏可食', items: [] },
      { type: 'heading', text: '六、深夜：火鍋與歲月' },
      { type: 'paragraph', text: '九點半，每個火鍋店的燈都亮得像深灶的蜜：湯底用椰青、豬骨或清雞湯，下薑片去腥，加幾粒鵪鶉蛋，再落幾條威化。這座城在凌晨給自己寫的最後一句話是：今晚無事。食不夠的加一份腸粉，飲酒的加一煲人參雞湯，遠道而來的加一碗牛雜——這裡每人都有自己的那份贏。' },
      { type: 'paragraph', text: '尾聲：凌晨三點，金鐘重新安靜，鐘樓聽誰的影子經過，玻璃就是全部。香港是一座用食物保存一切的房子——用湯慰勞創傷，用公仔麵撫平憂傷，用冷氣茶餐廳吊走暑氣。如果有人問起香港的底色是什麼，答案是燈：燒味火裡的燈、冷氣房裡的燈、車尾燈、火鍋燈。燈熄了，就是天明。' },
      { type: 'heading', text: '後記：關於本章' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。想看真實的香港，請親身食過。趕時間的話，先去 SearchBox 搜「沙田 下午茶」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-siu-mei-chronicle', title: '燒味：凌晨兩點的光與炭（香港系列 · 第二章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著燒味師傅的凌晨，看蜜汁為什麼要炒七次，燒鵝為什麼要靠第三扇吊臂，整條熟圓為什麼冒了煙才停手。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨兩點，整條街都沉默。只有燒味檔的爐口還亮著——一個小小的火孔，幾條炭排整齊排列，支撐一隻隻掛在上面等待過火的雞和鴨。師傅提着燈，坐在一束油香和炭香的交叉點。' },
      { type: 'heading', text: '一、頭三天：蜜的學問' },
      { type: 'paragraph', text: '蜜汁不是隨手熬出來的東西。第一天，師傅把純蜜糖兌了溫水，放進冷藏；第二天，下麥芽糖、薑片、兩個陳皮，慢火收它的身；第三天，再下南乳、生抽、花雕酒，對準琥珀色的瞬間，才夠淋。這是這座城凌晨被點亮的第一粒火花。' },
      { type: 'heading', text: '二、光與炭' },
      { type: 'paragraph', text: '選炭的方式很單純：不是搶眼前最亮的那一堆，而是撿灰缸裡還保留著焦殼的那一批。這意味著它烤到更勻、更久、更適合掛一倍的名譽。炭排好排成扇形，讓風從炭盆入口平推、再回到出口，禽肉的水分與油才不會從皮下流失。' },
      { type: 'cards', title: '燒味檔可食', items: [] },
      { type: 'heading', text: '三、出座' },
      { type: 'paragraph', text: '師傅先用竹簽穿過雞頸，吊起來掛進爐裡。第一分鐘，高鐵下來的火力；第二分鐘，蜜糖熟化的蜜香味道開始往外散；第三分鐘，皮冒出金色；第五分鐘，師傅數熟綠。等皮冒煙的是燒味——搶不到先後的味道就是隔火才看得明白。' },
      { type: 'paragraph', text: '整燒鵝的體積比較大，一個吊鉤不夠力，所以舊有的燒味檔有第三扇吊臂：用來托住燒鵝的尾巴，讓牠承受得起自身的重量，不會把頸部的肉拉爛。這件事每天只有一次會被觀察——那是每晚凌晨四點半，師傅幫整條街準備燒鵝的時候。' },
      { type: 'cards', title: '燒味午市', items: [] },
      { type: 'heading', text: '後記：給排隊的你' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。燒味不是一種菜，而是這座城凌晨的一段記憶。想看真實的香港，請親身去食過。趕時間的話，先去 SearchBox 搜「沙田 燒味」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-dim-sum-chronicle', title: '早茶：竹籠與陳皮茶香（香港系列 · 第三章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：從早班船到竹籠推走的一個早晨——寫下一壺菊花普洱、幾籠蝦餃燒賣、以及一位老闆背上那些疊起來的竹籠的重量。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：早茶是這座城市桌面上最重的朝拜——不是用金銀換，而是用竹籠換。早上七點，全城的軌道都朝一個方向移動：茶樓裡亮著燈，推手推著一盤盤蝦餃光滑的竹籠子，' },
      { type: 'heading', text: '一、蒸籠的性格' },
      { type: 'paragraph', text: '蝦餃的皮薄、燒賣的皮厚、流浮散伏的皮是來之不易的——一屜蒸下來，燒賣要看層次，蝦餃要看對齊，裹蒸雞翅要看火候。竹籠一出籠，師傅只問兩個字：好了嗎？客人卻得倒踢聚集在一起又瞬間撤走——這是早餐的默契。' },
      { type: 'cards', title: '早茶茶樓可選', items: [] },
      { type: 'heading', text: '二、普洱與菊花' },
      { type: 'paragraph', text: '全港茶樓之中，最普遍的一壺茶是普洱加菊花——它醒脾、不去酒。趕茶的人一壺一壺續，懂喝的人留下第二壺看師傅的陳年——陳年的普洱苦後留甘，如同開市前一千個嘈雜與和平最後統一為一個習慣。' },
      { type: 'paragraph', text: '早餐的座位有兩種：緊鄰廚房的窗邊，是為了結賬的；貼門口的椅子上，是麵包師傅收牌的。有些茶樓以摺紙為序——每一張紙寫著一籠點心的名字；一張摺仔密密麻麻地寫著今天蒸出籃子的所有點心——這就是茶樓的菜單。不管幾點，茶樓常餐不限時，直到午市開始。' },
      { type: 'cards', title: '早茶推車可選', items: [] },
      { type: 'heading', text: '後記：你的籠' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。港人吃早餐不是為了吃飽，而是為了讓鬧鐘停一下——在冷氣與蒸氣之間，把今天重新想一遍。趕時間的話，先去 SearchBox 搜「荃灣 點心」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-temple-street-chronicle', title: '廟街：宵夜成的一座廟（香港系列 · 第四章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著廟街的霓虹燈走完一刻，看一座城市如何每天晚上設香火、賣牛雜、掛起卜卦。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：黃昏七點以後，油麻地的廟街開始卸去白天的耐煩，換上兩排花燈。一側是燒味和水餃檔，一側是打小人、看相、解籤的婆婆；路中央是可移動的 stall ——塑膠椅子、還未命名的東西，盤推來推去，空氣裡塞滿一鍋薯粉湯。' },
      { type: 'heading', text: '一、牌匾為何重' },
      { type: 'paragraph', text: '廟街三字在招牌上，字義先於字形：廟——不是宗教分區，而是這座城認可「任何有生命的聲氣」都值得問一問；街——不是街道，而是這座城認可「任何一種聲氣」都要找個位置。招牌的每一筆都在向晚上投降。' },
      { type: 'heading', text: '二、煲湯–霓虹–靈簽' },
      { type: 'paragraph', text: '廟街三樣特立的生意：煲湯檔、霓虹燈裝潢店、打小人的婆婆。煲湯檔的老闆是幾兄弟，他們不用燈箱，直接用生意對話；霓虹燈裝的店主帶著箱子示人以字體排位；打小人的婆婆一雙手即認出你夢裡的紅色——是睡著了還是醒著。' },
      { type: 'cards', title: '廟街前後可去', items: [] },
      { type: 'heading', text: '三、華爸撈起' },
      { type: 'paragraph', text: '去廟街最熱的時候是營業時間半夜，人們各有為了今天那頓豐富的晚餐站穩腳，往地上看：陳皮、塘蓮根、粉麵、豆芽、蘿蔔——碗裡面一層層地摞疊起來。撈起的時候，竹筷子像會刻文字一樣深。' },
      { type: 'cards', title: '廟街可食', items: [] },
      { type: 'heading', text: '後記：你拿到的是甚麼' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。廟街每天晚上都有人在重新寫下香港的方言，沒有人看過它完整，也沒有人覺得需要。趕時間的話，先去 SearchBox 搜「油麻地 宵夜」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-cha-chaan-teng-chronicle', title: '茶餐廳（香港系列 · 第五章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著茶餐廳走一遍早餐、午餐與宵夜——這座城市一直都在排隊等奶茶。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：這裏有一種聲音。大嗌的鍋鏟響，水槽嘩啦嘩啦，常餐突然落在我面前。每一次走進茶餐廳，你會聽到一句廣東歇——「唔該等一等」。不會等很久，但都得等。' },
      { type: 'heading', text: '一、五十年前的一碗飯' },
      { type: 'paragraph', text: '戰後，香港是一座忙著搬磚的城市。大量新居民涌進來。街上的粥鋪、火鍋檔、茶檔，每一個東西背後都是一個家庭在養活下一個人的故事。他們不懂英文庭院菜單上的每一條，於是廚房自己發明——番茄蛋、奶茶、明蝦蛋、牛腩飯。今天我們仍然天天吃着它。' },
      { type: 'paragraph', text: '戰後香港，這個地方兩種語言混融在廚房裡：那邊是港式粵語由廣東話撐起的日常，這邊是英國餐桌上菜的事物會跑到香港來。奶茶裡有茶、奶、糖、茶葉，杯質是紙——這本來不是一件複雜事，但這個組合被稱為「絲襪奶茶」，因為造法：用絲襪把茶葉包起來，一定不是你媽媽的東西。' },
      { type: 'cards', title: '茶餐廳可食', items: [] },
      { type: 'heading', text: '二、碗裡的黑甜' },
      { type: 'paragraph', text: '奶茶是這座城市的接頭密碼——一杯奶茶替代了一張名片。黑茶與白奶被黑白兩條絲綢混合在一起，那種顏色只有做過二百次侍應的人才改變。不介意給我一杯奶茶，而已經了解你是這座城市的原住民。' },
      { type: 'cards', title: '常餐可選', items: [] },
      { type: 'heading', text: '三、三個不可少' },
      { type: 'paragraph', text: '茶餐廳常餐的三個不可少：第一，一定要有一個主食——米飯、伊麵或者一個明爐的叉燒；第二，一碗湯——它沉默地坐在你一桌兩個中間，誰也不挑揀它；第三，一杯奶茶——這是這座城市一切關於「慢」的懷念。' },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於展示 NEXUS 內容層的呈現能力。茶餐廳永遠存在於這座城市。今天或不可能不是我們習慣的那間，但「同一桌、同一句話、同一杯熱奶茶」這種味——永遠屬於香港。趕時間的話，先去 SearchBox 搜「沙田 常餐」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-fish-market-chronicle', title: '天光魚市：凌晨四點半的香港（香港系列 · 第六章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著凌晨四點半的魚仙街，從潮汐到餐桌——香港一整個星期的眼睛。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨四點半，整個香港又亮起來。在魚仙街兩排塑膠魚檔前，師傅趴在一張小凳上，把鮮紅的大比目魚翻過來，一邊喊價，一邊把塑膠袋上的血水抹到腳踩的地磚上。' },
      { type: 'heading', text: '一、魚仙街的韻律' },
      { type: 'paragraph', text: '魚仙街沒有掛上可視的招牌、店鋪的門去踩從來不是這個city的意思。兩邊是幾個魚販擺著小馬，大魚、細魚、毛蟹、蝦頭、魚肋都擺得像一頁詩。從四點半開始，每條街的盡頭都能聽到師傅用廣東語和英語混合叫賣。' },
      { type: 'cards', title: '魚仙街可逛', items: [] },
      { type: 'heading', text: '二、燈未滅又亮' },
      { type: 'paragraph', text: '魚仙街靠燈亮：四點半到六點半是黃褐色的光，六點半到十點是冷白色的水銀燈。早上四點半面前是半昏迷半興奮的贊助溫度，十點則是未來化了的大光。沒有藝術燈光，只有讓魚保持新鮮的條件。' },
      { type: 'cards', title: '魚市場可食', items: [] },
      { type: 'heading', text: '三、魚仙蘭花' },
      { type: 'paragraph', text: '早茶的條子一點一點到，先用魚仙帶隊、後用麻油點的腐.螂、腐竹絲放上炒鱔、米酒陣陣。這是這座城每天早上六點開始哭的時間。每一個香港人都認得那個味道。' },
      { type: 'cards', title: '早茶可點', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。魚仙街今晚不會在原那個位置，但她一直在每個港人的早晨裡。趕時間的話，先去 SearchBox 搜「上環 魚蛋」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-yu-huei-chronicle', title: '春花姨（香港系列 · 第七章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著春花姨的討價還價，走進一個在街邊站了五十年的小檔。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨三點，整個街區都醒過來。春花姨把一只透明的空瓶斜斜地放在白鐵盆裡。時鐘顯示4:28，她開始檢視剛剛卸下的魚。' },
      { type: 'heading', text: '一、白鐵盆、時鐘與她這雙手' },
      { type: 'paragraph', text: '她叫林玉芳，以前是魚檔的老闆娘，現在是一個人支撐一家人。她的兩個孩子——一個在澳門讀醫學，一個在廣東鄉下煮飯——兩個都沒有料到她還有今天。' },
      { type: 'cards', title: '春花姨街可去', items: [] },
      { type: 'heading', text: '二、她已經用過的詞' },
      { type: 'paragraph', text: '她講的東西很簡單——去買餸、回廚房、燒飯。今天早上的標語是「雪上加鱗」，這是她媽媽死前留給她的最後一句話，她一直記著。' },
      { type: 'cards', title: '春花姨街可食', items: [] },
      { type: 'heading', text: '三、身體裡的時間' },
      { type: 'paragraph', text: '她每天兩個時間:早上七點一波——綠豆沙、菜心粥；下午四點一波——腩肉上鍋，加馬鈴薯和豆腐。街坊的孩子從小到大都聽過她的聲音，像廣播一樣日常。' },
      { type: 'cards', title: '隣近可食', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。春花姨的故事是穩定——這是每一個香港街上有過的無數種這樣的人。趕時間的話，先去 SearchBox 搜「油麻地 魚蛋」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-fruit-market-chronicle', title: '果欄：凌晨三點的卸貨（香港系列 · 第八章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著果欄的第一批卡車，走進每日天光之前都醒著的油麻地。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨三點十分，油麻地的街還很暗。渡船街盡頭的果欄棚下面，第一批卡車已經停好了。車斗卸下的是山竹、水蜜桃、青檸與當造的木瓜——這些水果在天光之前來到這座城市，由手、由叉車、由老夥計的眼睛，分級、裝箱、拍價，再成為全港早市的第一籃鮮甜。' },
      { type: 'heading', text: '一、果欄的一天，從凌晨開始' },
      { type: 'paragraph', text: '果欄位於油麻地渡船街一帶，是香港歷史最悠久的水果批發市場之一。它不睡覺，只是換了一副樣子：凌晨三點是卸貨，凌晨四點是拍價，天亮之後是早市，傍晚是散場。每一箱當造的水果，都要在這裡早早過完一整輪，才有機會在街坊的果檔裡靜靜地出現。' },
      { type: 'cards', title: '果欄可逛', items: [] },
      { type: 'heading', text: '二、拍價，是把價值喊出口的方式' },
      { type: 'paragraph', text: '拍賣員用廣東話喊價，手勢起落之間就是每一箱水果真正的價錢。買家與拍賣員之間有一套默契：看板、點頭、抬手、落槌。價錢從來不是一個數字，而是一種判斷——熟度、色澤、儲存天數、當造與否。為一箱山竹喊價的時間，只容得下一口回氣。' },
      { type: 'cards', title: '果欄可食', items: [] },
      { type: 'heading', text: '三、把一箱光，送進全港的早市' },
      { type: 'paragraph', text: '阿金（合成敘事，非真實人物）的早市檔每天五點出門。他的貨源是果欄——榴槤在這裡叫不出字，記刻的是果實當令時的沉與香。他的顧客是整條街：買兩個橙可以赊，買一箱山竹要當場。果欄不是目的地，而是這座城的一個引擎；它在天亮前動起來的那一刻，整座城的鮮甜就已經走完了一遍。' },
      { type: 'cards', title: '果欄可逛', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。果欄的燈光天亮之後會熄滅，但水果會繼續通過這座城市——趕時間的話，先去 SearchBox 搜「油麻地 果欄」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-tongsui-chronicle', title: '糖水：宵夜後的一碗甜（香港系列 · 第九章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著一碗芝麻糊的溫度，走進油麻地與北角之間的糖水舖。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：晚飯收場之後，總有人不著急回家。油麻地那位煎藕餅的小販收出帳簿了，北角的小糖水舖昏黃的燈光剛好亮到玻璃門上。香港習慣用一碗甜，替一天劃上句號——燒味的重、車仔麵的辣，都要等這碗糖水來收容。' },
      { type: 'heading', text: '一、柴火與石磨' },
      { type: 'paragraph', text: '糖水的工藝藏在磨與火之中：芝麻先炒，焦糖色沁出來，然後下石磨慢磨成糊；紅糖薑糖水的薑不是切厚片，是現磨成泥——連根帶筋才辛辣得正。每一種糖水都是一種「先用功、後入喉」的差事，聽起來不過就是甜，做起來要拿一個晌午的工夫。' },
      { type: 'cards', title: '糖水可飲', items: [] },
      { type: 'heading', text: '二、北角的燈，油麻地的火' },
      { type: 'paragraph', text: '北角的糖水舖，一進門就是數不完的甕——綠豆沙、杏仁糊、芝麻糊、紅豆沙，門口先舀出一勺試甜淡。油麻地那幾間，貼上「日售二百碗」的單據——通宵揾錢的人都到這裏，計日計酬的人一碗花生糊養過無數個五更。' },
      { type: 'cards', title: '糖水可飲', items: [] },
      { type: 'heading', text: '三、宵夜之後，吞不下鹹' },
      { type: 'paragraph', text: '宵夜多是鹹的——燒味飯、車仔麵、魚蛋粉——鹹完了，嘴就會想尋甜。最啱嗰個位，是瞓前一個鐘頭；唔係大餐，唔係打邊爐，只是一碗甜。甜過一班深夜飯局，又飽過任何健怡夢，第日的早餐也因此有了着落。' },
      { type: 'cards', title: '糖水可飲', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。糖水是一種安靜的盡頭，收工咽下一口，第二天的早餐就有着落。趕時間的話，先去 SearchBox 搜「油麻地 糖水」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-bing-sat-chronicle', title: '冰室：菠蘿包與一杯鴛鴦（香港系列 · 第十章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：踏入一間還記得 1960 年代的冰室，北角巷口那扇玻璃門內，菠蘿包剛出爐。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：北角巷口這間冰室，玻璃門上貼著手寫的「菠蘿包熱賣一式」。無線電播著一首六十年代流行曲，店主從爐灶上拿出一夾牛油包，問兩位常客：「兩位今朝整不整多一件西多士啊？」' },
      { type: 'heading', text: '一、菠蘿包為什麼叫菠蘿' },
      { type: 'paragraph', text: '菠蘿包的外層花紋，起源於烘培師手繪的「菠蘿刻印」：六十年代初代移民搬進港島北岸時，用粗麵粉分兩段——先用高筋蛋打底，麵烘至略焦，然後抹上粗糖與起酥——最後成為菠蘿包經典的釉光外衣。切開之後，牛油熔在熱氣裡的聲音，每一代人都聽過。' },
      { type: 'cards', title: '冰室可食', items: [] },
      { type: 'heading', text: '二、「鴛鴦」與「雙蛋蜜」：自創詞的誕生' },
      { type: 'paragraph', text: '冰室裡兩條腿撐起一張餐牌：一條是英式茶與咖啡按 4:6 糅成的「鴛鴦」；另一條是港式「雙蛋蜜」——火腿煎蛋配上蛋撻、浸在熱冰裡的金黃蛋白。兩者都不是外國菜式的直譯，而是移民在狹縫裡自創的東西，而且一代比一代自覺光榮。' },
      { type: 'cards', title: '冰室可飲', items: [] },
      { type: 'heading', text: '三、它對於新一代代表什麼' },
      { type: 'paragraph', text: '今日進冰室，枱上堆滿通知：店慶、促銷、新菜式。但東主依然記得你要多加牛油是少煎火腿蛋。老闆一邊煮一邊同你聊，從畢業聊到轉行聊到下班——冰室默默地替這座城守住「可以坐下來等一杯茶」的資格。' },
      { type: 'cards', title: '冰室可食', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「北角 冰室」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-cart-noodles-chronicle', title: '車仔麵：一桶會預告的夜（香港系列 · 第十一章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著車仔麵輪子走，看一桶熱湯如何一次次預告整夜的胃口。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：晚上十一點，廟街的車仔麵車立起招牌，六格小鍋冒着白煙。站着吃的人，有剛下班的侍應，也有陪朋友散場的學生，也有扛着相機巡城的攝影師——車燈一亮，他們就找上門來。' },
      { type: 'heading', text: '一、車仔檔的六格小鍋' },
      { type: 'paragraph', text: '車仔麵的誠意藏在分隔的小鍋子裡：中央一格放牛腩清湯，裹着蘿蔔的段落；左面是墨魚丸，炸到金黃就撈起；右面放咖喱魚蛋，紅黃鮮亮，翻煮得恰到好處。麵底由客人揀：伊麵、上海麵、米粉還是河粉——每款都在滾水裡拉到剛好散開，不綿不流。' },
      { type: 'cards', title: '車仔可食', items: [] },
      { type: 'heading', text: '二、來車仔的人' },
      { type: 'paragraph', text: '車仔麵不為任何人留位，但對每一種人都客氣：收班的的士司機、練習完帶團回家的樂隊、凌晨三點的清潔工人，還有剛寫完企劃書的寫字樓。每個人落到站的時候只有一句話：「有冇咖喱魚蛋啊？」——這句話就是整座城市的小夜曲。' },
      { type: 'cards', title: '車仔可飲', items: [] },
      { type: 'heading', text: '三、為什麼車仔麵是香港的' },
      { type: 'paragraph', text: '車仔麵是香港夜的極致：在有限的空間、時間與預算裡，把自己拼在一起。它不走餐枱，不裝格局，沒有主菜前酒前的儀式；它只有一碗溫熱的麵、一勺剛夾起的魚蛋、和上班時間的喘息——然後車輪一轉，所有人繼續邁向自己的方向。' },
      { type: 'cards', title: '車仔可食', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「廟街 車仔麵」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-congee-chronicle', title: '皮蛋瘦肉粥：全城加班後的最後一味（香港系列 · 第十二章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著一鍋皮蛋瘦肉粥，走進凌晨二點的收班香港。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨二點。廟街的粥店撤去最後一屜網邊的麵，燉爐還剩一口餘溫。皮蛋剝開之後攤在盤裡，綠綠的邊、金黃的心——這碗粥要替這個城市把晚上的胃好好收起來。' },
      { type: 'heading', text: '一、為何粥是夜晚最後一味' },
      { type: 'paragraph', text: '皮蛋瘦肉粥是這個城市的最後一個完全債。米洗淨泡透，瘦肉切薄片下鍋慢煮，蛋剖半撕成三份，蔥花細碎散進熱氣——等上幾分鐘，一鍋粥已散開，變成一種不用功的安慰。迄此所有胃口都停止了爭論。' },
      { type: 'cards', title: '皮蛋粥可食', items: [] },
      { type: 'heading', text: '二、皮蛋的由來' },
      { type: 'paragraph', text: '一顆皮蛋要醃近兩個月。雞蛋藏進黝黑的石灰與稻殼層裡，慢慢變暗、變潤、變嫩——從白變墨綠、從硬變泥滑——它是鹹裡帶着一種不會被忘記的腥香，以一種完全不是料理的歷史被收進這湯裡。' },
      { type: 'cards', title: '皮蛋粥可食', items: [] },
      { type: 'heading', text: '三、粥碗前坐的人' },
      { type: 'paragraph', text: '凌晨兩點的食客沒有人爭麵。早下班的繪畫員仍然沒有下工；凌晨三點電車司機；寫稿的記者；也有一班只是陪朋友下車的人。碗邊放着油條，但很多人已經不吃了——只喝湯，喝它熱的那一口，然後把碗還給店。' },
      { type: 'cards', title: '皮蛋粥可飲', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「油麻地 皮蛋粥」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-lion-rock-chronicle', title: '獅子山：17:58 的第一粒燈（香港系列 · 第十三章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：傍晚第一粒燈亮起的瞬間，整座城把今天的擔子卸下來——不是奇蹟，是這個城每天兩次的儀式。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：傍晚六點，雨都停了，天還是芭黛般的灰藍。從灣仔到西環，每一幢樓都亮起來——這是全城每一天都不太特意，卻又每一天都見的儀式。' },
      { type: 'heading', text: '一、獅子山：一座城的印章' },
      { type: 'paragraph', text: '「獅子山精神」是一座城市的印章——這句話人人聽過，不等於它成真，但每天放學下班的人，把頭往東望，會瞥見那隻石灰色的長鬃在城的輪廓上歇著。它不問你今天有沒有中彩，它只坐在那裡。' },
      { type: 'cards', title: '山腳可看', items: [] },
      { type: 'heading', text: '二、17:58 的第一粒燈' },
      { type: 'paragraph', text: '傍晚六點零八分，港島這一端先亮第一家樓宇；六點四十二分，尖沙咀這一端亮起藍色窗。維港零星的燈光勻成網，船隻從中間穿過，把水紋畫成另一種銀。這只是一個城市把自己的擔子變成光的儀式——而不只是給遊客拍的一張照。' },
      { type: 'cards', title: '山腳可飲', items: [] },
      { type: 'heading', text: '三、看城市背光的方式' },
      { type: 'paragraph', text: '從茶樓上層望下去，整個城市像一件拼圖：這裡坐着會議，那裡坐着加班的文員，下班的每一處都是另一個角度——有人離開，有人回來，有人只是把燈按了又熄。生活沒有劇本，但每個窗縫之間，都有人在替這座城接住今天。' },
      { type: 'cards', title: '山腳可看', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「維港 景觀」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-cheung-chau-chronicle', title: '長洲：海與大嶼之內的那個週末（香港系列 · 第十四章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著一條渡輪，從北角、從西營盤看見維港縮小成一條灰影——然後這就是長洲。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：週日早上八點，中環渡輪碼頭已經站滿了提着慢熱的自己的人。船頭坐滿了提早十點出發的遊客；眼睛看着大嶼漸漸遠去，然後維港變成一條彎彎的灰線。' },
      { type: 'heading', text: '一、航線與海風' },
      { type: 'paragraph', text: '慢車一小時，快車只需二十五分鐘。快車駛過海面的聲音，就像一連串連船在用力呼喊。南面是港島，北面是大嶼，左右兩面都是海。海水與海鳥，把所有忙碌都吹散。' },
      { type: 'cards', title: '長洲可玩', items: [] },
      { type: 'heading', text: '二、碼頭邊的早晨' },
      { type: 'paragraph', text: '碼頭邊的小攤販一字排開：魚蛋、砵仔糕、腸粉、草菇。茶餐廳的招牌燉着香港的聲音，孩子催促父母，小販喊出「一籠啊」，海鷗在空中盤旋——這一場景才是香港的另一種顏色。' },
      { type: 'cards', title: '長洲可食', items: [] },
      { type: 'heading', text: '三、把手機放下一半天' },
      { type: 'paragraph', text: '在碼頭上坐兩個鐘頭，然後步行上山至觀頂，再快車折返。長洲這麼小，腳程可以讓你放下手機思考自己是什麼。晚上回程路上，維港亮起來了，你會明白為什麼這麼多人這麼累了半輩子，還是要回來休息一個下午。' },
      { type: 'cards', title: '長洲可逛', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「長洲 海鮮」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-mtr-evening-chronicle', title: '十八點半：辦公室落到地鐵（香港系列 · 第十五章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著下班的一頁，由九龍塘坐到油麻地，再走一段回家的路——這是整個城市收工的聲音。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：晚上十點，中環的寫字樓一層層熄燈。電梯從高樓落到底樓，全車只有刷卡聲，沒有人說話。整座城終於肯收工了。' },
      { type: 'heading', text: '一、半張臉' },
      { type: 'paragraph', text: '寫字樓的窗對着維港與山頂；誰東張西望，誰渾然不覺——冷氣慢慢關，工作桌一臺接一臺闔上，手機提袋裡帶着上一頁的未完事。電梯門開合之間，整座城市像一部執行中的城市，有點兒像一部儀式。' },
      { type: 'cards', title: '地鐵可玩', items: [] },
      { type: 'heading', text: '二、九龍塘點進油麻地' },
      { type: 'paragraph', text: '從高樓落到地鐵站，坐上一班上水列車。車廂裡擠滿了下班的人：西裝的、圍裙的、空着手的。沒有人說話，音樂從耳機裡滲出每個人的頭；手機螢幕亮了又暗，銀行通知，家人的信息，淘寶的物流。' },
      { type: 'cards', title: '地鐵可逛', items: [] },
      { type: 'heading', text: '三、落站，回家' },
      { type: 'paragraph', text: '油麻地、入夜之後一小時。街坊的吆喝從街角亮着的燈開出來——回家路上，茶樓已收工，檔販還在守着自己的魚缸；收工碰頭一次，再坐下來吃一碗粥，然後關門。' },
      { type: 'cards', title: '下班可吃', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「油麻地 魚蛋」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-lei-yue-mun-chronicle', title: '鯉魚門：東邊的晨曦、西邊的晚霞（香港系列 · 第十六章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著苦練鯉魚門的漁民與船長，走進這座城市一個仍養着老海濱秩序的角落。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：西灣河東面的盡頭，筲箕灣再向前走，到底就是鯉魚門堤壩入口。每天六點半天剛亮，屋前出船,到七點半已出去，到中午八九點漁會陸續拋錨、卸魚、分級——整個過程沒有台面上的一句話，全靠默契。' },
      { type: 'heading', text: '一、碼頭上的早晨' },
      { type: 'paragraph', text: '碼頭兩排，一排賣魚，一排賣殼。晨光從山脊滑到水面，船家魚媽媽臉色依然倔強——他們與香港人一樣準時，與海一樣準時。磅秤上數着魚巴，手勢乾淨俐落，連嘴巴都停頓半秒，不會錯價。' },
      { type: 'cards', title: '碼頭可食', items: [] },
      { type: 'heading', text: '二、海鮮與叫價' },
      { type: 'paragraph', text: '蟹肉一份七十八，蝦一斤一百四十八，石斑按呎數算。商戶以香港公斤稱量入盤，廚房依閣樓火候分層炸、煎、蒸、煮——蟹肉先煎香，蝦殼撕開，再加黃酒與薑白，最後悶熟。這是鯉魚門裡與傳統菜單爭一口氣的魚。' },
      { type: 'cards', title: '碼頭可食', items: [] },
      { type: 'heading', text: '三、堤壩下的河' },
      { type: 'paragraph', text: '鯉魚門堤壩底下從前是水的聲音，現在術語多了但坐不得——長港灣道繞過去，坐灣仔，一直順着河岸行走，你會經過鯉魚門公園與東區愛國愛港電影院——聽這裏的東人。' },
      { type: 'cards', title: '堤壩可食', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「鯉魚門 海鮮」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-bakery-dawn-chronicle', title: '鹹光燒餅：第十七章 · 燒餅與半生熟蛋（香港系列 · 第十七章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著一座叫鹹光的燒餅鋪，走過「深夜三點半」——烤一爐燒餅、關一爐爐火、熄一盞燈——然後整座城市醒過來。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：淩晨三點整。鹹光的爐火剛剛點起。陸哥站到風口前，手中拿着一塊牛油試燙，豬油的味道與煙同時壓下來——整片鑊邊開始由青變白。' },
      { type: 'heading', text: '一、燒餅出爐' },
      { type: 'paragraph', text: '燒餅是香的，蛋餅是熱的，甜筒是有毒但整齊的。鹹光的夜檔從來不缺客人，凌晨三點的半條街，彷彿走進非洲巴士上的一眾陌生人，彼此都不認識，但默契——亂的可賣、買完之後是自己的東西。' },
      { type: 'cards', title: '鹹光可購', items: [] },
      { type: 'heading', text: '二、三腳大刺蝟' },
      { type: 'paragraph', text: '鹹光的第三鍋爐，餅爐是焊鋼皮的附屬品。陸哥同水閘老王細數今晚要出多少批——一半賣出去、一半送給朋友急需救急用。價錢寫在小黑板上，從來不改。' },
      { type: 'cards', title: '鹹光可購', items: [] },
      { type: 'heading', text: '三、一座城醒過來' },
      { type: 'paragraph', text: '鹹光離開的時候，整條街慢慢醒過來。垃圾桶翻了一次，凌晨還沒睡的貓躲在兩車之間；天剛亮，陸哥踢推車回家時，垃圾佬笑說早上好、陌生人把他找出來。' },
      { type: 'cards', title: '鹹光可用', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「鹹光 燒餅」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-central-bourse-chronicle', title: '中環交易所：下午四點的鐘聲（香港系列 · 第十八章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟著中環交易大廳走完從早上九點到下午四點的一天，最後讀那一聲金到實在的鐘聲。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：下午四點三十三分。交易大廳裏的電腦屏幕比平時都多幾分紅燈，來自恆生指數的走圖一上一下。鍾澯翔（合成敘事，非真實人物）坐在最後三排，手機放了第二次鈴之家，沒人接。' },
      { type: 'heading', text: '一、開市' },
      { type: 'paragraph', text: 'HKEX 在十點十五分開市，早上九點半會先跑 OTC 那條線。早餐碟子放在桌前，咖啡慢慢涼；螢幕上預覽的整體標紅到緑，每個手勢裡有一個決策。' },
      { type: 'cards', title: '中環可行', items: [] },
      { type: 'heading', text: '二、盤中' },
      { type: 'paragraph', text: '下午兩點，恒指墜了 320 點。鍾澯翔抬眼，桌子旁邊的茶餐廳伙計正收他的杯——如果指數再跌兩個百分點，他今天會提早離場，不再等下午五點鐘。午後的交易大廳聽着銀行的聲音，還聽着十幾個牌子的響。' },
      { type: 'cards', title: '中環可看', items: [] },
      { type: 'heading', text: '三、鐘聲' },
      { type: 'paragraph', text: '下午四點收市鐘響了。地下交易大廳裏的人起身，還沒起身的人也暗裡把椅子拉開一點；螢幕藍燈綠燈自動刷新，民眾下了場時，茶餐廳一會就要有食客。' },
      { type: 'cards', title: '中環可買', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「中環 晚餐」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-er-chronicle', title: '半夜三點：急症室入口的警惕（香港系列 · 第十九章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着深夜醫院入口，從凌晨的濕地上看一座城市最低音的守護。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：半夜三點，炮台山民醫院急症室的燈亮着。整個入口沒有人聲，每隻救護車鳴Siren繞了幾圈才停下。走道是灰黄色，椅子排了四排，沒有人在討論。' },
      { type: 'heading', text: '一、首先是分診' },
      { type: 'paragraph', text: '分診護士貼着腕帶，量三樣：體溫、血壓、痛感位置。每個進來的人必先回答三句話——哪裏不舒服、什麽時候開始、服了藥沒有。沈姨（合成敘事，非真實人物）兩手抓着椅子，說了體溫 38.2℃。護士把她推過分診門，五分鐘後就看到麻醉室的地燈亮了。' },
      { type: 'cards', title: '醫院可看', items: [] },
      { type: 'heading', text: '二、等待' },
      { type: 'paragraph', text: '急症室的等待是十五分鐘加十五分鐘外加十分鐘撿。哪裡等，哪裡都一樣安靜——電視機台翻了一個故事繼續不肯更新，氧氣筒的聲音偶而發出滴滴幾聲——這裏不慌張。' },
      { type: 'cards', title: '醫院可坐', items: [] },
      { type: 'heading', text: '三、當下' },
      { type: 'paragraph', text: '沈姨終於捱過了這一夜。護士去麻醉室的時候把她放在家那邊睡了半個鐘，醒來的時候藥還在走——從生到醒，沈姨覺得「一件事還在」：醒着不見了對自己的恩情。醫院的地燈亮着，照出回去的路。' },
      { type: 'cards', title: '醫院可買', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「急症室 安心」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-window-cleaner-chronicle', title: '抹窗師傅：凌晨四點（香港系列 · 第二十章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着抹窗師傅陳叔，由凌晨四點開始——香港人每天往上望見的天空，是這樣一層一層擦出來的。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨四點。中環康樂廣場頂——八十八樓，風自山腳直衝上來。陳叔（合成敘事，非真實人物）把抹窗布擰乾，將安全繩扣在吊籃上，抬頭數了一遍霓虹：全港只有他一個人醒着，只有他看得見這個城市最灰的一面。' },
      { type: 'heading', text: '一、先繫繩，再看海' },
      { type: 'paragraph', text: '抹窗這一行，行內人叫「吊籃工」。師傅先測風、再測繩、最後才露出窗外一隻手。陳叔入行十四年，每日四點出門，六點下班——比寫字樓最早的清潔阿姨還早，比天文台發出預警還穩。他清楚每一片玻璃背後是誰的夢；玻璃不在乎，他在乎。' },
      { type: 'cards', title: '樓頂可見', items: [] },
      { type: 'heading', text: '二、刮一下，深一層' },
      { type: 'paragraph', text: '刮窗不是擦窗：抹、刮、抹、刮，四字循環，一片玻璃要走七遍。夏天三十五度貼住玻璃像蒸桑拿；冬天北風直接穿過外套——師傅們都穿兩層男裝、隨身帶一樽水，不能的擦乾。玻璃洗乾淨了，整座中環的玻璃幕牆一齊亮，整個城市才肯點燈。香港人從來不知道，原來抬頭望到的海景，全部是一個人懸吊在八十八樓一隻手保住的。' },
      { type: 'cards', title: '樓頂可聽', items: [] },
      { type: 'heading', text: '三、擦乾淨的早晨' },
      { type: 'paragraph', text: '早上六時四十分，最後一批師傅收繩落地。他們在便利店買兩個飯糰做早餐，然後坐上第一班巴士回家——七時整，全中環亮起來。八點辦公室全部人準時坐下，盯住乾淨到反光的玻璃罵街——沒有人記得，凌晨四點有人抹了他們看不到的那一層。陳叔放假日最想做的事情就是躺在海邊，什麼都不擦。' },
      { type: 'cards', title: '樓頂可吃', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「維港 景觀」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
  {
    slug: 'hk-last-taxi-chronicle', title: '半夜十二點半：的士站最後一客（香港系列 · 第二十一章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着的士師傅陳哥在的士站等最後一班渡輪——香港深夜的最後一條載客線。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：半夜十二點半。中環碼頭對面的的士站只剩一排車。陳哥（合成敘事，非真實人物）把計程車錶歸零，打開車廂吹冷氣——氣笛響了一聲，那是今日最後一班渡輪。' },
      { type: 'heading', text: '一、先泊好位置' },
      { type: 'paragraph', text: '的士站唔係誰都可以泊。行家會選最遠嗰一格——最後一班渡輪落客的人大多數要去九龍或港島西，直路返，唔洗兜。行家點人頭：三個留學生、一個返夜班的清潔阿嫲、一個拎住兩箱凍肉的檔主——全部都要回家。陳哥入行十九年，最清楚半夜十二點半的人往哪裡去；錢可以找，時間唔可以補。' },
      { type: 'cards', title: '的士站可等', items: [] },
      { type: 'heading', text: '二、最後一客的算法' },
      { type: 'paragraph', text: '半夜的士唔係計鐘，係計人——一個可以空車回程、一個四口同行、一個想坐在司機旁邊因為他趕飛機。紅的、綠的、黃的全部排在渡輪口下——票錢準確找，陳哥寧願多找一個兩個，因為『客人見你肯放，下次搭車會記得』。凌晨一點以後，仍然有人握住玫瑰花和紅色禮袋，把一束『快樂』交給一個不肯放手的朋友——的士的後座就是這個城市最後一張座椅。' },
      { type: 'cards', title: '的士站可坐', items: [] },
      { type: 'heading', text: '三、隧道口的一盞燈' },
      { type: 'paragraph', text: '凌晨一點廿五分，陳哥載住最後一位客人穿過紅磡海底隧道。隧道口的一盞燈照見維港夜景——客人帶着一束燒酒和一個謎語下車，「呢束燒酒，過幾日你就會知道送邊個」。陳哥搖下車窗，海風吹進車廂——這個深夜，總是靠一程又一程『還未知道去哪裡』的的士維持着。' },
      { type: 'cards', title: '的士站可見', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「渡輪 的士」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-school-bus-chronicle', title: '早上八點半：校巴的秘密班機（香港系列 · 第二十二章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着校巴師傅，由住宅區仔頁一直開到九樓操場——香港每個早上最守時的鐘。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：早上八點二十分，校巴師傅阿姐（合成敘事，非真實人物）在屋苑門前停好車，把趟環燈拉到八。這台巴士的鐘不是靠電，是靠一個一個打呵欠的小學生校服。' },
      { type: 'heading', text: '一、她的路線是一個秘密' },
      { type: 'paragraph', text: '校巴的路線不寫在任何一張車站圖上——阿姐自己背：先接五個住九龍城寨公館的、再接兩個港島西樓的住戶、最後停在寶雲道。未上車的時候，她會一個一個數校服口袋有沒有塞好眼鏡。全部人坐好，她才肯撬油門。' },
      { type: 'cards', title: '校巴可聽', items: [] },
      { type: 'heading', text: '二、一個鐘，加兩分鐘' },
      { type: 'paragraph', text: '八點三十分開出去，八點三十五分一定到校——每一個家長都知道：阿姐的校巴比港鐵站違約還要準時。少了一個人，她會原地等三分鐘，也不會動。九歲的阿妹每天都是最後一個跳上車，阿姐已經數好她的步伐：兩步上，一步停，兩步落椅。' },
      { type: 'cards', title: '校巴可數', items: [] },
      { type: 'heading', text: '三、下課鐘聲的另一面' },
      { type: 'paragraph', text: '放學三點四十分，同一班校巴又在校門口出現。全部人換了位置：早上的課堂袋拎着、放學後的人空了——只有一個傻小子拿着抽水會員卡和一個濕漉漉的書包回家。阿姐不按鈴，她只會說：「今日不用你幫我關門，我自己會關。」行一程密密的路，兩個鐘，一個城市，一顆下課的種子。' },
      { type: 'cards', title: '校巴可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「校巴 午飯」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-dishwash-auntie-chronicle', title: '下午一點半：洗碗阿姨的第二幕（香港系列 · 第二十三章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着廚房師傅，由污水聲一步一步看進洗碗間——香港每張餐枱背後看不見的人。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：下午一點半。茶餐廳安靜了下來——裡面只有煲嘰、碟碗互撞、熱水奔流的聲音。洗碗阿姨（合成敘事，非真實人物）把橡膠手套刷了一遍，把最後一碗滑膠浮升起來，落停箱上，輕力拍兩下：一切都乾淨了。整座城市的中餐習慣保留着，不過 nobody 知道，她每天都在用手掌給這座城市寫中篇小說。' },
      { type: 'heading', text: '一、「煲嘰」的簿記' },
      { type: 'paragraph', text: '午餐高峰已經退了，阿姨先把九米長的後台清空——瓷碗、碟、筷子、茶壺，清洗分三格：熱水、泡沫、乾淨水。每一只碗她都有一個第一眼的感覺——崩了一格的青花瓷手一拿就是八十二歲的舊友鄰居，她會原手放回自己櫥櫃，不再入店。這種堅守不是受訓，是她自己額外規範的——這間真的不會再出現崩口碗。' },
      { type: 'cards', title: '洗碗間可聽', items: [] },
      { type: 'heading', text: '二、她認得所有碟' },
      { type: 'paragraph', text: '哪一只碟會淘菜、哪一只碟會上蟹粉魚蛋、哪一只小碗是給香港長者的龜苓膏用的——阿姨閉着眼睛也認得。住宅樓換了三個公司，她還是留在同一間茶餐廳。每一天下班前，她會在盆沿寫「今日兩個豬臟百葉五碟」——老闆知道這就是老主題問卷：明天午餐會勤；同事彼此默許，不問原因。' },
      { type: 'cards', title: '洗碗間可數', items: [] },
      { type: 'heading', text: '三、收工的節拍' },
      { type: 'paragraph', text: '三點五十分，電箱熱過一段時間，阿姨緩步推開傷口布。她會把風筒對準入盆，把每件漬衣晒到亮。洗手間是她休息的椅子：杯水、小食、口香糖、紙巾——這間小小的空間是城市中最安靜、最溫暖的一小盆。三點五十八分，她會把所有東西重新歸位——這間茶餐廳就用一個人開始了第二天。' },
      { type: 'cards', title: '洗碗間可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「茶餐廳 下午茶」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-night-cleaner-chronicle', title: '凌晨一點：塔樓清潔工（香港系列 · 第二十四章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着夜班清潔阿姨的手，由樓梯塔到天台——這座城每一層最早知道自己的事的人，其實不在任何一張名片上。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨一點。整個屋邨熄了燈，只有一盞樓梯燈一路燒到天台。阿環（合成敘事，非真實人物）把工作紙摺好，先擰開四樓的水龍頭，把一個空膠袋輕輕挂在欄杆上——這座城的清潔工作內容不在任何一張打卡鐘上，但每日早上七點十分，每一扇窗都會乾淨給你看。' },
      { type: 'heading', text: '一、每一層的走廊燈' },
      { type: 'paragraph', text: '阿環這棟樓的十九個樓層，有十一座樓梯燈會先壞，因為它們每天升降三百多次。她知道每一層：哪盞燈在凌晨一點才真的亮起、哪扇窗打開一半風會怎麼推門、哪一個電錶讀數比其他的多了三百個 kilo-watt。她不是維修員——她只是晚上在走廊走走：握住樓梯扶手聞一聞味道、數一數拖把、抬頭看一看天庭。有些老一輩的清潔工說這就是讀書：這座城的每一層都有它自己的脾氣。' },
      { type: 'cards', title: '夜更可聽', items: [] },
      { type: 'heading', text: '二、一個鐘的樓梯，一個鐘的秤' },
      { type: 'paragraph', text: '從一樓拖到天台，來回三次，這座樓的空氣就是這樣每天更新。阿環不騎單車，不坐電梯——她用兩條腿認路：走廊左側鋪一張她自己的床單䨏臭，右側她會放一塊新炭排灰塵；有時後台二樓有人留下一份箱蛋飯，她不會動；但鄰居留下一份報紙，她每次都會摺好，第二天放在樓下的郵箱裡——哪怕她不認識這個人。她在用行動寫「這個城的人不必是一句話，也可以是一個習慣」。' },
      { type: 'cards', title: '夜更可數', items: [] },
      { type: 'heading', text: '三、天亮以前' },
      { type: 'paragraph', text: '四點四十五分，阿環把最後一扇窗扇再推上，吸一口清新。這間做過百次、做過千次的夜班，她把血唞滑、把抹布擰乾、把源動的鈴聲讓位給下一班。六點整，她在樓下的花槽前停一下，看到天逐步白——她不會拍照，只把今天面前的景象記起：這座城仍然在，仍然被那些沒名片的人維持着。她的工卡上沒有「職位」——上面寫的是「塔樓」，這樣就夠了。' },
      { type: 'cards', title: '夜更可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「塔樓 清潔」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-last-tong-sui-urn-chronicle', title: '凌晨兩點半：最後一鍋糖水（香港系列 · 第二十五章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着姨九黏到糖水檔收攤——香港夜晚最後一口甜的去留。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨兩點半。西環的糖水檔關門了，只有一口鐵鍋還站在後台的角落。姨九（合成敘事，非真實人物）蹲下來打開鍋蓋看了一眼——今日還有一碗底無主，但她知道那個無主的底永遠不會有人來拿；它只是一座山的影子，掛在這個城市最後那一口甜上。' },
      { type: 'heading', text: '一、最後一鍋的構成' },
      { type: 'paragraph', text: '一鍋糖水不是一鍋水，是一個完整的晚上：綠豆、芋頭、紅豆、班戟、西米、花生。姨九每一晚都照着這個順序煮。最後一鍋要留的位置不是給客人——是給遲那些重組自己日子的人：下了夜班的、考試退了、失戀了的。人們在最後的位置排隊的時候很少說話。姨九不說什麼，但會比平衡多放一把冰糖。' },
      { type: 'cards', title: '糖水檔可等', items: [] },
      { type: 'heading', text: '二、三種人' },
      { type: 'paragraph', text: '第一種：夜班工人——穿着衫不是自己買的，是公司借的；他們按時回來，碗放在金桔盤上，紅糖湯加一湯匙，邊食邊睇報紙上的波士表。第二種：學生——他們穿校服衫回家討糖水，一手推着 Nikon 一手拎着別人哭過沒有擦乾的眼淚，姨九給他們每一個人都「少甜」。第三種：失戀的人——不排隊，直接坐在後台的木壆上，他們知道姨九沒看見。但她知道。' },
      { type: 'cards', title: '糖水檔可選', items: [] },
      { type: 'heading', text: '三、收工以前' },
      { type: 'paragraph', text: '凌晨三點零五，姨九把最後一碗分三等：八十塊港幣、五十分、五元硬幣，丟進耳環盒裡——不是一盒錢，是簽名。她關鍋、擰布、拖第二次水道、小聲說一句：『今日收工。』然後她會推開鐵門，一隻貓跳上店篷，兩棵樹都醒了。整個西環在這一刻完全安靜了下來，但姨九走到店門口抬眼，仍然看見樓上的兩盏燈在亮，一個寫字樓的加班狗，一袋雞胸肉配一個鬼主意。她們會撐到早晨。她知道。' },
      { type: 'cards', title: '糖水檔可見', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「糖水 最後一鍋」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-fishball-stall-chronicle', title: '上午十點：魚蛋檔（香港系列 · 第二十六章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着魚蛋檔阿姐的手，由晨間一直煮到中午；跟着一串魚蛋經過香港的手心。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：上午十點。魚蛋檔阿姐（合成敘事，非真實人物）把猛火點起，第一個竹膠刷一刷籠沿。十個左右的中環白領不知道：每一粒魚蛋在她手上都是一百度的蒸氣——客人選牠的顏色、點牠的老練，不選牠的失敗——但沒有人知道每一粒魚蛋都是她當眾為市民做好的一次。' },
      { type: 'heading', text: '一、猛火的紀律' },
      { type: 'paragraph', text: '魚蛋不是滾水丟下去就熟了。猛火、中火、文火，都是她自己知道的節奏。她把魚蛋串放進籠裡，筷子湯匙遞到客人手裡，「七蚊」她會比出來——每一個買魚蛋串的香港人都有一條數：她會數客人回家的路程有多遠、有几層樓、幾個字交給誰。她知道誰是語文老師，誰是禮儀老師，誰是夜班護士。這不過是她每天早上十點之前讀完的一本書——收在她自己的胃裡。' },
      { type: 'cards', title: '魚蛋檔可點', items: [] },
      { type: 'heading', text: '二、老練的串法' },
      { type: 'paragraph', text: '一串豬膶、一串肥牛、一串魚蛋、一串小魚蛋——每一道都有一個專屬的老練。串的時候不問，只給：一串魚蛋四粒，小紅魚蛋三粒，肥牛二粒。客人笑她呆，但知道：多一粒就會爆，少一粒就不夠。十點半過後，關注的人都連成一條線，魚蛋從她手上沿著同一條手臂平衡過去。熟練得像「什麼東西」。' },
      { type: 'cards', title: '魚蛋檔可選', items: [] },
      { type: 'heading', text: '三、十一點的收工' },
      { type: 'paragraph', text: '十一點，猛火熄了，魚蛋串收了，阿姐把籠沿抹乾淨，用最尾的一湯匙湯給自己。下一個客人來了——她會笑他：「今日新的」，他懂。她向前遞出魚蛋串，手穩、眼睛穩、節拍穩——這座城市最準時的鐘，不在昂立城，而在她的手指尖上。' },
      { type: 'cards', title: '魚蛋檔可數', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「魚蛋 早上」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-newspaper-wrapper-chronicle', title: '早上十一點：報館放送（香港系列 · 第二十七章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着報紙包裝工人在紙廠前的走廊，由新聞紙卷一直到報紙架——早報是整個城市第一面鏡子。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：早上十一點。報館燈光齊了，膠紙架站滿了工人。阿潤（合成敘事，非真實人物）每日握住同一把鉸剪，把幾卷紙筒夾成一束——香港每個早上的第一張報紙在這個時刻正式印製成型，坐在走廊兩邊成排，準備發到全港。' },
      { type: 'heading', text: '一、紙在吃掉新聞' },
      { type: 'paragraph', text: '新聞紙黑晒晒、無略略生物，今天城市的所有當前，都要先擠在這一卷白紙上。阿潤會把十幾卷對折，用竹刀鐵箍一層層壓緊，走廊風吹着報紙嘩嘩響——這是整個城市在早上翻開看到的第一個動作：當你打開報紙，這座城市的聲音就在你手裡了。' },
      { type: 'cards', title: '報館可聽', items: [] },
      { type: 'heading', text: '二、對摺與發送' },
      { type: 'paragraph', text: '零時半，第一批版面送到走廊第一層。阿潤把紙壓緊、摺折、打印——每個動作都有專屬的順序。第一版預覽的是國際局勢，第二版是本地新聞，第三版是每個地區的天氣、每個地區的地區太陽。這一堆紙變成每日報紙，一號到一百號，再進每個茶餐廳、每個便利店、每個新聞檔。' },
      { type: 'cards', title: '報館可數', items: [] },
      { type: 'heading', text: '三、每次參與' },
      { type: 'paragraph', text: '中午十二點，阿潤把最後一捆報紙抬上小船，起槳。整個城市睜眼的第一個動作就是翻開這一頁紙。那麼多座寫字樓、那麼多輛的士、那麼多桌早餐，都是從他手上的這一捆紙出發的——他說：「牬？報紙發到全港，那是我一生中最像導演的工作。」他每做這個工作時都相信一個簡單的事：報紙不會打開，但報紙一旦被打開，這座城就醒了。' },
      { type: 'cards', title: '報館可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「報紙 早報」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-pigeon-coop-chronicle', title: '下午三點：九龍公園的雀籠房（香港系列 · 第二十八章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着雀鳥房的主人，由茶餐廳一路上到九龍公園的雀箱——這是一種把賽博與寵物間的最後一條傳輸線。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：下午三點。九龍公園西角的雀籠房已經亮了，伯仲兄弟的白鴿無事可做就在籠中走動。阿伯（合成敘事，非真實人物）穿着一件舊西裝，站在木櫃前，把新的捕鳥器用一條皮帶綁緊。這間雀房是一條新界——新與舊的橋梁。' },
      { type: 'heading', text: '一、鳩鴿的登記' },
      { type: 'paragraph', text: '白鴿有自己的號碼，有自己的血統證明書，有自己的比賽成績。阿伯應該中午十二點開門，下午一點到三點是他麥克風預習的時光。他不會表演，他誦讀——他常常會誦讀自己剛剛買的那些年華、那些環球。他真正聽的是每一只雀的尾音：袖旁出來的那隻雀的叫聲會決定下一年的種族記錄。' },
      { type: 'cards', title: '雀籠房可見', items: [] },
      { type: 'heading', text: '二、組裝與比賽' },
      { type: 'paragraph', text: '每年一次的全港賽鴿會，阿伯的伍付賽鴿要提前二十一日到達偵查區，讓牠們認得地方環境。那一段路，他走過十幾次，每一次都認得每一塊石磚。牠們會去參加那一年暑假的比賽，從大嶼山一路飛回九龍。阿伯會在那一天坐在公園角落，看那些年輕的翅膀飛過自己的天花板——這一刻他感覺到自己不是在看雀，而是在看一個國家之間的呼班。' },
      { type: 'cards', title: '雀籠房可數', items: [] },
      { type: 'heading', text: '三、放飛的一天' },
      { type: 'paragraph', text: '比賽的日子，阿伯早早到達鴿房，把櫃門打開，吹一口涼氣，然後把收信鴿的手杖傳給牠。鴿子被一圈一圈的陽光包裹住，然後忽然被放出來，飛穿過樹林和水塘、撞到的石柱和幼芽。他看到那一橙又一秒的橙色已經夠養活自己一個季節。他不喝酒，但會喝一種茶——姓名沒有公眾的那種，每口都夠燥。「鴿子還活着？」他喝完茶會縮手，自己回答自己：「當然還活着。牠們都會回來的。」' },
      { type: 'cards', title: '雀籠房可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「雀 比賽」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-typhoon-shelter-chronicle', title: '下午五點：太古城候車亭的一身風雨（香港系列 · 第二十九章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一班乘客擠進候車亭的這一分鐘——一間鐵頂下的市中心避難所。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：下午五點。太古城候車亭只有一間鐵頂、十幾平方米——但這天每一分鐘都是一場小型的避難演練。雨從橫掃的方向拍過來，下班的人把公文包裹進雨衣、把行李箱貼緊自己、把無所謂的表情貼在臉上：「這就是我一直等著的十五分鐘。」' },
      { type: 'heading', text: '一、候車的時間真的很長' },
      { type: 'paragraph', text: '下雨時候，每個人都清楚知道這一班車在李惠利公里東邊的一個角落，準點率大約七成——每個人都在打電話給老闆、孩子、父母。「我還在排隊。」「我在候車亭。」「我會趕到。」這一句話已經說了一百次，每一次都沒有人知道它是否真的會成真。但這個亭子的陽光只在雨水打完了以後才會真正到來——那一剎那間，所有人都會深呼吸，整個太古城都會輕輕嘆一口氣。' },
      { type: 'cards', title: '候車亭可聽', items: [] },
      { type: 'heading', text: '二、鐵頂下的一小會社交' },
      { type: 'paragraph', text: '候車亭是一個完全公共、完全無隱私的地方。每個人在這個五米以內的鐵頂下都赤裸裸地露出自己的下班脾氣——有人沒有耐性、有人對同事不滿、有人對家裡的時鐘有敵意。但也沒人投訴這裏的秩序：法律上這裏屬於公共空間，實際上它是午后的情緒避難所。這裏是香港唯一一個每天五點準時舉行的心理健康會議——只是沒有人在記錄。' },
      { type: 'cards', title: '候車亭可看', items: [] },
      { type: 'heading', text: '三、雨停的那一剎' },
      { type: 'paragraph', text: '雨突然停了，太陽從太古城東邊斜進來。候車亭的人同時抬頭，同時張嘴，同時慢慢放鬆。這個瞬間沒有人說話，但每個人都感覺到：這十五分鐘已經過去，下一秒城市會再次為Beacon Hill最佳景色亮相。他繼續走、她繼續走、他繼續趕、他繼續嘆——都走出去候車亭了。' },
      { type: 'cards', title: '候車亭可數', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「候車亭 太古城」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-soup-kitchen-communal-chronicle', title: '晚上八點：粥府的長枱（香港系列 · 第三十章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一城人共用一張長枱吃粥的晚上——這座城的共享菜，每晚八點開飯。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：晚上八點。廟街一間小小的粥府裡，一張長枱排得一二十個人。姨九（合成敘事，非真實人物）端出兩鍋粥，每鍋都是同一個味道、同一個溫度——這間店沒有菜單，也沒有分類：每個人進來坐下的時候都要先問：「今日有什麼？」姨九總是說：「有你。」' },
      { type: 'heading', text: '一、長枱的每日記' },
      { type: 'paragraph', text: '這張長枱是這個城市最不公平卻最公平的地方：坐上去的人每一個都一樣，不管他是東北邊的、銅鑼灣的、銅門的。姨九不會問來客的任何事，候選菜單也不會因人而異——白粥豬膶、豬脬芋頭煲、白鴿蛋；人們進來坐下，先食兩碗，再喝一口熱的，然後看自己對面的鄰居還沒有結帳——行走大約四十五分鐘，才慢慢有人離開。' },
      { type: 'cards', title: '粥府可聽', items: [] },
      { type: 'heading', text: '二、這張枱上的三種人' },
      { type: 'paragraph', text: '第一種：夜班工人——煤氣家具清潔工人、冷凍船碼頭搬運工、24小時工廠的半更工人——他們下了班，走進這裏，先滑一張面野紙，再坐在自己找到的空位。第二種：媽媽們——她們不是一起走進來的，是自己一個一個進來，每個都不認識對面那一位。第三種：那些只是吃不下飯的人——他們喝完粥，會對姨九說一句「好好食」，姨九每次都答：「慢慢食。」這間店沒有收據、沒有訂單，餐費是每個人自己心裡的數。' },
      { type: 'cards', title: '粥府可數', items: [] },
      { type: 'heading', text: '三、離開長枱的人' },
      { type: 'paragraph', text: '十點整，下一層客人上來；姨九會讓新人們選擇座位，然後才收拾上一輪的碗筷。每一個人離開的時候，侯間都會發出一陣笑。這是這座城裡最接近教堂的情景：一群人共享一張餐桌，離開之前每人都帶走同一句話——姨九總是說的那句：「慢慢食。」' },
      { type: 'cards', title: '粥府可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「粥 長枱」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-estate-cardboard-chronicle', title: '晚上九點半：屋邨電梯口的紙箱老伯（香港系列 · 第三十一章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着紙箱老伯由垃圾房一路折到回收站——這座城每個晚上最安靜的供應鏈。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：晚上九點半。屋邨電梯口，一個穿深藍色工裝的老伯將一疊疊乾紙殼小心裁成三等分。阿伯（合成敘事，非真實人物）不會說話，但每一次裁剪聲像鋼琴低音。整個屋邨的人早晚都經過電梯，但不知道：每天早上的回收車都是從這個電梯口出發的。' },
      { type: 'heading', text: '一、紙殼的等級' },
      { type: 'paragraph', text: '阿伯只收大型電器、冰箱機、空調、酒類、瓦通類——這類紙殼回收站最值錢。其他的則搭伙堆填。他大概從十點半開始拆洗、把髒的紙殼丟進一個專屬的垃圾桶。鄰居每個都會在他面前放一些「垃圾」——他不會拒絕，但會仔細查看：有價陣的留，沒價的收。他在每一份紙殼上進行一個無形的分類公會。' },
      { type: 'cards', title: '電梯口可聽', items: [] },
      { type: 'heading', text: '二、三十個紙箱，一座城' },
      { type: 'paragraph', text: '阿伯每天大約處理六十個紙殼。每一份紙殼的來源都可以追四五代：冷凍公司的包裝、大菜檔的紙板、太古城拉斯卡的搬運紙板。他會在晚一點時把車規（Renoimn）推到回收站的後台，把東西放在回收站上，一次一次地過秤，然後填一張預先準備好的收據：「廿三公斤，承惠七十元。」回收其實傳了二十年。' },
      { type: 'cards', title: '電梯口可數', items: [] },
      { type: 'heading', text: '三、十點半的收工' },
      { type: 'paragraph', text: '收工時間不會到十一點：阿伯推着車、嘴裡含着一顆薄荷糖，在電梯口的後台坐下。他會在牆上那張值班表上打一個小小的勾子。然後他會把這日剩下的膠紙箱分開，一半堆在自己的位置，一半放進回收的車斗——「呢啲要拿去錢糧局的。」他不會說別的。全屋邨都知道他的名字——「紙箱阿伯」——全屋邨也都不知道他真正姓什麼，但沒有人在乎：「是紙箱阿伯。」夠用了。' },
      { type: 'cards', title: '電梯口可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「紙皮 收購」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-drive-thru-midnight-chronicle', title: '深夜十一點：麥當勞得來速（香港系列 · 第三十二章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着午夜得來速永不熄滅的燈——整個城睡的時候，它繼續醒。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：深夜十一點。麥當勞得來速的燈仍然亮着，沒有熄滅過：這是一個完全為深夜工作而設計的小模型。阿健（合成敘事，非真實人物）站在揚聲器旁邊，聽每一輛車進來的時候，其實他不需要問：「您好，請問想要什麼？」——他只要先講：「第四份餐，番茄醬包一個，再給一份薯條。」' },
      { type: 'heading', text: '一、深夜的訂單' },
      { type: 'paragraph', text: '深夜來得來速的不是普通客人：夜班下班的搬運工、跨洋航班的機場員工、被打回家的酒鬼、離開醫院的護士、剛做完夜通經考的學生。第四份餐、第七份餐、第九份餐，全部都是夜班的蛋白質。阿健甚至認得這些常客的車號——紅色 Camry、黑色 Daewoo、白色 XE3——每一個車號都背後對應一段生命。' },
      { type: 'cards', title: '得來速可數', items: [] },
      { type: 'heading', text: '二、永遠的亮燈' },
      { type: 'paragraph', text: '這個燈永不熄滅是真的：整個橫地停車場的全部燈都會熄，但得來速的燈從不熄滅。它不是入屋的方法，是時間裡一個固定的坐標。即使颱風逼近、即使電車崩潰、即使成個城市停電十六分鐘——得來速的燈仍然亮着。有時候市民會開車走過去，路過，然後自動減速：因為他們很早就知道這一盞燈總是安全地、穩穩地。' },
      { type: 'cards', title: '得來速可看', items: [] },
      { type: 'heading', text: '三、收工的節拍' },
      { type: 'paragraph', text: '凌晨兩點半，麥當勞的公釐餐車經過，運走前一批冷貨，並收走所有廚具作最後清洗——整個得來速骨架停在原處，只是湯匙換了，番茄醬換了。然後他們會在鐵板上刻上下一次的時間：凌晨四時起即提供早餐，餐點一樣，燈一樣，尺寸一樣。整體城市在這個深夜裡有一個不停，而且從不遺忘——它一直為深夜工作的人們發着光。' },
      { type: 'cards', title: '得來速可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「麥當勞 深夜」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-vending-machine-chronicle', title: '凌晨零時零分：紙包飲品販賣機（香港系列 · 第三十三章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一部廢棄在屋邨角落的張機，由白天亮到半夜——每一個人沒想過三年，但每一個人都要用一次。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：凌晨零時零分。屋邨C座後頭那個角落，這台紙包飲品販賣機還是那樣亮着。它不是最近入屋，也不是最近被撤走——它已經在這裏八年，每年都有兩三撥人按出一罐東西，有時拿得起，有時拿不起。它下面貼着各種手寫便箋，有的寫「今日要命的」，有的「齋嚟睇睇」沒有任何聯絡人。' },
      { type: 'heading', text: '一、難得的選擇' },
      { type: 'paragraph', text: '中文字「販賣機」三個字念起來都有表面意思：販賣機裏有「高級」的橙汁、「最便宜」的紙盒奶茶、「經典」的青檸檬。裡面的東西每年都換，但標籤永遠是那些字。姨九（合成敘事，非真實人物）笑著說：「這台售賣機以前在食堂，然後在卡啦OK，最後又回到屋邨來。像歸鄉。」' },
      { type: 'cards', title: '販賣機可見', items: [] },
      { type: 'heading', text: '二、十八塊的試煉' },
      { type: 'paragraph', text: '十八蚊是只有本港人認得的神聖數字。有人投十八蚊，隔帶沒有聲音，沒有飲料出來。有人投十八蚊──這次出來了。有人直接拍。有人看到販賣機亮着，反而在那看了一個晚上。姨九說：「這棟樓一半租金不知道在哪裡，另一半就是這台販賣機養活——它的每一個按鈕都是這座城的耐性。」' },
      { type: 'cards', title: '販賣機可數', items: [] },
      { type: 'heading', text: '三、被遺忘的良宵' },
      { type: 'paragraph', text: '凌晨一點半，整幢樓清靜——每個窗口都已關燈。樓下的這台販賣機仍然亮着，仍然排著三個被掃出去的罐頭，兩罐剩下無。這座城其實沒有真正睡過——它只是在放鬆那一個善良的心腸。姨九最後說一句：「沒人買過這款飲品，但這裏一年多沒有人再買過了——沒有人知道，但這一台販賣機仍然一直是一個被人在意過的東西。」' },
      { type: 'cards', title: '販賣機可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「販賣機 屋邨」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-tung-chung-chronicle', title: '中午十二點：東涌——機場的風在跑道', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一群東涌人，由新機場到地產公司的食堂，由風的味道到中午十二點半的飯。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：中午十二點半。東涌新城市中心的購物走廊已經亮了，跑道風在空氣裡白過白雲。阿城（合成敘事，非真實人物）從新機場員工食堂出來，手裡拿著一罐檸茶——他是東涌新市鎮的典型矛盾：一半是機場的員工風，一半是屋苑市場的走廊氣。' },
      { type: 'heading', text: '一、那道風每天吹過' },
      { type: 'paragraph', text: '跑道的風是東涌特有的：一陣一陣，每次都帶着航油味和海鮮味，然後一次奇蹟地消失然後再來。阿城說：「每年都有人說這座城會『大幅精神化』；而每年這座城都回到了同一個自我調整。」——東涌的每個定在下午都再次安靜了下來。' },
      { type: 'cards', title: '東涌可見', items: [] },
      { type: 'heading', text: '二、新市鎮的日常' },
      { type: 'paragraph', text: '新機場的年輕人走了以後，這座城就是老鄰居、老餐廳的茶樓。阿城帶我走過一間細小雜貨店，老闆拉花布，中年太太正在稱一磅豉油——他們日常就是一種對新鮮的拒絕，一種對舊的忠誠。新市鎮的駐民每天都走過同一棟大樓：從你家到診所、到菜市場、到巴士站，一個小小的生活閉環不超過七百米。' },
      { type: 'cards', title: '東涌可數', items: [] },
      { type: 'heading', text: '三、風對面的人' },
      { type: 'paragraph', text: '下午三點，機場乘客大廳的喧囂開始退去。他們望著玻璃上的彩虹，然後拿出手機拍了一張，然後不再多看了。阿城外坐着的每一個人都好像準備好上飛機，又好像準備好什麼都不做——東涌駐民每天都要目送這一波波人離開，而這裏的空氣繼續在吹，繼續在清涼，好像一切都是一個幻。' },
      { type: 'cards', title: '東涌可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「東涌 新機場」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-peng-chau-chronicle', title: '下午四點半：坪洲——纜車鐵箱子', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着坪洲島上的人，由碼頭到纜車鐵箱，島上的閒暇一直坐在箱子裡。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：下午四點半。坪洲的碼頭旁邊停着那一艘老舊的纜車鐵箱——島上三千名居民每天忙碌勞動後都要坐回這艘鐵箱去，從島到交通樞紐的一個半小時不算太長，但對於腳踏海浪的人來說就是「最後的重生」。' },
      { type: 'heading', text: '一、鐵箱裡的人' },
      { type: 'paragraph', text: '鐵箱是一個活動的分界線：進去的時候是家裡來的工作者，出去的時候是目的地的人。導航員阿生（合成敘事，非真實人物）手持舊式錄音機，向每一艘船宣佈今天的起飛時刻、乘客情況和海浪、風向。這是鐵箱裡唯一的收音機頻道：這個頻道沒有頻率，只有坪洲的人知道。' },
      { type: 'cards', title: '坪洲可數', items: [] },
      { type: 'heading', text: '二、纜車機房' },
      { type: 'paragraph', text: '纜車上來下來要經過一個小小的機房，一共七個工作人員。他們每天只負責一件事情：把鐵箱從坪洲開到中環交通式的上電梯、然後在這架子上坐着。這裏沒有高速纜車、沒有UV光：整個纜車系統存在於一個童話裡，天真，單純，沒有高級口味，但讓島民有信心地回家。' },
      { type: 'cards', title: '坪洲可見', items: [] },
      { type: 'heading', text: '三、回到海上的路上' },
      { type: 'paragraph', text: '或許島民知道：番茄汁是每天早晨在箱上接過的第一口新鮮番茄。老人會邊走邊敘述他們的珠江生意、他們的子女、他們的海鮮檔怎樣。年輕人會說：「我只想看那個彩虹」——每毫秒的雨線都托管着島上一盞燈。或許坪洲會永遠這樣：三水之間的驛站、過去以後的重生。' },
      { type: 'cards', title: '坪洲可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「坪洲 纜車」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-tai-o-chronicle', title: '中午十一點半：大澳——鹹魚棧', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着大澳漁家的每日太陽，由碼頭到市場後的鹹魚架——這是一個城市最後未被替代的氣味的地方。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：中午十一點半。大澳第三條碼頭上，一排排淺色的木架掛着曬平的鹹魚，引力把魚眼拉圓了一點。阿華姐（合成敘事，非真實人物）在碼頭頭上，用一把無鋒的竹簾拍幾次鹽——她是這條碼頭的唯一店主，也是這座又一個被替代過又被保留過的場景的守護人。' },
      { type: 'heading', text: '一、潮汐與無人煮的午餐' },
      { type: 'paragraph', text: '大澳沒有什麼特別的 Restaurant 換過 Menu——這個地方永遠的每日餐牌是鹹魚、豉油、沙薑、檸檬。這是這條碼頭的靈魂：三十年前送鐵殼船去倉；三十年後，鐵殼船每餐都在惦記這份菜單。阿華姐每根熱騰騰的魚，都是在潮起潮落之間曬出的。每成的早晨，她都看着潮漲潮落，然後燒一盆滾水讓自己倒進淡淡的豉油。' },
      { type: 'cards', title: '大澳可見', items: [] },
      { type: 'heading', text: '二、碼頭的外國人' },
      { type: 'paragraph', text: '每年有四千名來自世界各地的日本人。他們來看這座城唯一的、未被現代豪華替代過的地方。每個人都會坐在這個碼頭，把剩下的半截檸檬水喝掉，然後走進商店擱在那裏的竹簾幕布裡面。這裏的笑容畢竟只有兩層：眼睛亮的、眼睛亮的 glint；不願被拍到的、又偷看不願意去的。' },
      { type: 'cards', title: '大澳可聽', items: [] },
      { type: 'heading', text: '三、沒人接回的輪' },
      { type: 'paragraph', text: '生長在這條碼頭的人很少會離開：第三代阿華姐的每一位從來沒有親戚想著讓她們搬入太古，所以她們住在這裏——就連他們的牆、他們的魚、他們的屋子都還是日本人舉起的。這座城十二點沒有教堂，但每天早上都是這樣煮出道明：沒人會讓阿華姐這些人走，但也沒人真正去拯救這個地方——就這樣：作者、碼頭、魚、鹽，萬事萬物都繼續。' },
      { type: 'cards', title: '大澳可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「大澳 鹹魚」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-north-run-chronicle', title: '清晨七點：隔水渡輪', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着隔水渡輪的每一名乘客，由起錨去到碼頭——每一場跨海都不止一次出發。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：清晨七點。隔水舊渡輪上，每個人兩手搭蓬、雙腋下靠着一根柱子。船推開了，就向着大嶼山驀然進入海心——潮洗出了水線，雞沒有叫，漁民也沒有醒過來。乘客的臉每個都在藍色蓬鐵裡，清清楚楚地在想昨晚的演示、他們 boss 的臉、他們的小佛。' },
      { type: 'heading', text: '一、舊渡輪的鋼架' },
      { type: 'paragraph', text: '水波痕、候鳥、鐵架著的老船——這些是渡輪特有的心跳。每天早上七點，它向南駛去，晚上再原路出去，七點再到，像一個不存在卻存在的時間囊。阿鐘（合成敘事，非真實人物）是這艘渡輪的廚師，每天為自己做一份冬菜湯粉；旁邊經常抱怨船晃的一位老闆娘，二人從無紀錄、從無矛盾。' },
      { type: 'cards', title: '隔水渡輪可看', items: [] },
      { type: 'heading', text: '二、礦工的飯壺' },
      { type: 'paragraph', text: '渡輪上的乘客都要帶自己的飯：老廚師說：「隔水渡輪沒有餐廳，沒有酒吧。」每天早上，他們最後一口喝了早上的茶，然後交到南角的窗口；南角永遠只等十五分鐘，遲到的人下一趟。去飯、去抖宮：每日重複。造了三十年的飯碗、手控自己：沒有人收集、沒人紀錄。' },
      { type: 'cards', title: '隔水渡輪可聽', items: [] },
      { type: 'heading', text: '三、終於登陸' },
      { type: 'paragraph', text: '大家都等到天光，等到那個一直天尚未清亮。然後天狗來了，大嶼山終於出現了。漂白的碼頭發出嘶嘶的鋼鐵聲，海碰到總是一撲一扑來回，每個人滿懷希望，走出去又滿懷擔心，重新上船。這是這座城特有的承諾：吃晚飯時，你可以從這艘船去島上吃一碗艇仔粥；可以坐在老闆旁邊看茶；可以把剩餘的魚肉再肉滋滋帶去這座城。整座城都好安穩，只不過等到天亮。' },
      { type: 'cards', title: '隔水渡輪可數', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「隔水渡輪」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-beijing-writer-chronicle', title: '早上十點半：北漂作家的香港筆記（香港系列 · 第三十八章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一位北漂作家在香港的第三年，從茶餐廳裏的筆記本到寫字樓的窗邊——這個南至極的城的北室。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：早上十點半。位於中環写字樓的窗口，陳生（合成敘事，非真實人物）拉開一盞 LED 檯燈，從書包裡拿出一本黑色筆記本。他从北京來到這里第三年，每頁都有一句話：「北京說自己是北京，而這里每句話都忘记了自己是北京。」' },
      { type: 'heading', text: '一、所有北方人落腳' },
      { type: 'paragraph', text: '陳生是個真正的北漂：本科念 literatura、研究沒畢業；然後他南下，三年，還沒回來；現在在一個金融公司做文案。每天早上九點，他都坐在電梯裡，看着電梯鏡子想：「北方多闊。」然後走出來的時候，他會笑：「這裡夠窄。」' },
      { type: 'cards', title: '寫字樓可見', items: [] },
      { type: 'heading', text: '二、北邊決定' },
      { type: 'paragraph', text: '但是陳生也寫：他最喜歡在 café 里看來看去。他說「這個城的 café 不是膀胱，而是幻夢：這個城每個 café 都覺得自己是北京胡同裡的空瓶子，但其實它們都是血液裡的煙——血液裡的鍋，血液裡的酒。」——他這一段寫完的時候，cafe 的老闆娘問他要不要再點一杯咖啡；他點了又說要；老闆娘笑：「你北方人不懂咖啡嗎？」他答：「我懂，我北方人不懂的是這裡的沉默。」' },
      { type: 'cards', title: '寫字樓可數', items: [] },
      { type: 'heading', text: '三、問故鄉' },
      { type: 'paragraph', text: '每逢中秋，陳生都會拍家族群那張毎年不變的照片：北京的長城、南方的茶餐廳聚集、寫字樓的日出 kiss。家人每次都會問：「你什麼時候回來啊？」陳生每次都會說：「回來了。」他不知道什麼時候答得出來。下午三點半，他會合上書本，把全部文件摺好，走進電梯；他在鏡子裡看見自己。「你北方人不懂沉默」——他很不懂。' },
      { type: 'cards', title: '寫字樓可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「茶餐廳 雖然」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-teochew-markets-chronicle', title: '傍晚六點：潮州話．旺角菜市場（香港系列 · 第三十九章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一個 tide潮的菜市場從清晨六點到傍晚六點——這係個唔差一句「這係個潮州人世界」的地方。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：傍晚六點。旺角菜市場的每日燈光仍然亮着，菜奴阿姨（合成敘事，非真實人物）在樓板上收拾它的魚——今天的魚腥味尚未消散，明天的魚腥味已經在同一條樓板上準備好了。這是旺角最不變的節奏，從一個人的祖母開始，一代接着一代。' },
      { type: 'heading', text: '一、潮州話才是普通話' },
      { type: 'paragraph', text: '這個市場裡每一個人都讲潮州話，而每一個人都假裝自己不懂潮州話。菜奴阿姨跟隔鄰的菜蟹阿婆打招呼說「你又嚟哦」；然後又转向Continental的妈妈說「你今日想食啲乜？」——全部的語言密碼都在這裡：「你又嚟哦」是潮州話，「今日想食乜」是廣東話，「Continental」是普通話……這市場是一個語言比賽場，每一個攤主都是最後的冠軍。' },
      { type: 'cards', title: '菜市場可見', items: [] },
      { type: 'heading', text: '二、蔬菜的頭髮' },
      { type: 'paragraph', text: '阿姨常常把菜頭髮剪掉一個個去裝菜，菜葉又高又大又香。有來自大嶼魚的海味——九龍菜市是唯一大嶼魚直接到來的地方。番茄、茄子、青菜、五香花椒、乾豆腐、香菜豆、薄荷葉……每一種都是來自同一個大嶼的魚市場分配。或許這一餐就是這個城的靈魂：菜奴、漁市場、潮州阿姨、一口鍋、一個煎蛋。' },
      { type: 'cards', title: '菜市場可數', items: [] },
      { type: 'heading', text: '三、放學路上' },
      { type: 'paragraph', text: '晚上七點以後，教育的小朋友走過這個菜市場。他們可能跑步、可能匆忙、可能問父母今天有什麼魚——但他們不會知道有一個潮州話的年長婦女早上五點就在這裡，把所有的魚洗過、把所有的魚魚叫過、把所有的魚還沒熬成羹就已經準備好了。晚上他們回家的時候，已經沒有魚腥味了：只剩下潮州話在口裡。' },
      { type: 'cards', title: '菜市場可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「旺角菜市場 潮州」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-filipino-central-chronicle', title: '深夜十點：名媛的中環寫字樓（香港系列 · 第四十章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一個中環深夜護更的 FILCC，由熄燈一直到翌晨九時——這個城深夜最安靜的運動體。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：深夜十點。中環的這座玻璃幕樓的任何一個辦公室都熄了燈——阿May（合成敘事，非真實人物）這個護更人正經過最高的一層樓，她每天都要把掌室閃一個護更，然後把最後一份報紙在每一層樓上都揉一揉：她在這個深夜裏是整幢樓最安靜的詩。' },
      { type: 'heading', text: '一、寫字樓的臉' },
      { type: 'paragraph', text: '阿May是中環的 Filipina. 她來港三年，除了當清潔工，還用 EOC 讀完了三級會計。她深夜走進這幢寫字樓的時候，實際上是在走進自己的職業生涯——這是她回到中環的最大鼓励：這是她每天都走的路線，也是這個城最不願意忘記的東西。' },
      { type: 'cards', title: '寫字樓可數', items: [] },
      { type: 'heading', text: '二、在鐵板上不下班' },
      { type: 'paragraph', text: '阿May十點到，凌晨六點把最後一紙垃圾倒進垃圾桶。她會把自己的地毯擦兩次——一次用一種牌子、一次用另一種，因為她說這是一座城市的商業底層的基礎。她每天早上都會把「明天」寫在一塊拼貼紙上，例如「明天要回家看我的孩子」或者「明天要去考三級會計的第一章」——然後把紙貼在電梯的牆上。這幢樓裡三四千個員工擦肩而過，沒有一個知道。' },
      { type: 'cards', title: '寫字樓可見', items: [] },
      { type: 'heading', text: '三、早上的交棒' },
      { type: 'paragraph', text: '明天早上八點零六分，早更阿姐交接給她的妹妹——然後自己走回家，吃一頓忙了一夜的早餐。阿May問：「她今天有什麼事嗎？」妹妹回答：「她今天很忙。」阿May笑：「大家都很忙。」然後兩個人都無人理睬沿街的期限，晚上再見。' },
      { type: 'cards', title: '寫字樓可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「中環 菲律賓」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-mumbai-curry-central-chronicle', title: '凌晨一點半：灣仔咖哩魚飯堂（香港系列 · 第四十一章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着灣仔的小咖哩魚飯堂熬煮到凌晨——香港印度人、排隊族、人生各種淚痕都在這一鍋咖哩裡。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：午夜十二點。灣仔阿昌（合成敘事，非真實人物）把土豆切成薄片；這是他的第一盤下鍋，之後才是洋蔥、番茄、咖喱、鹽、雞蛋。昨天都是煲底；今天是咖哩魚。' },
      { type: 'heading', text: '一、咖哩的執著' },
      { type: 'paragraph', text: '每日接近十二點，香港的灣仔有十幾座咖哩魚飯館，幾乎沒有人看得上，但總是坐得滿口。阿昌的咖哩魚不是火鍋式的——是鍋炒的：先把魚煎香，再把咖哩倒下去，蓋上鍋蓋，放十五分鐘。每一口都是所有印度人做菜的記憶，不消失，只是繼續。' },
      { type: 'cards', title: '咖哩魚飯堂可見', items: [] },
      { type: 'heading', text: '二、半夜的族人' },
      { type: 'paragraph', text: '半夜十二點，到灣仔吃咖哩魚飯的香港人有三種：印巴裔的初級經理人（他們下班打卡來；嘴裡繼續在講數學）、興趣廣汎的大學生（他們沒有辦法對自己買的香飯說不買）、新渡海客（他們每天深夜到灣仔看那一張牌匾）。阿昌對所有人都一視同仁，不會因為語言疏遠，他會以同一個咖哩對待每個人。' },
      { type: 'cards', title: '咖哩魚飯堂可數', items: [] },
      { type: 'heading', text: '三、熬煮的城市' },
      { type: 'paragraph', text: '阿昌今晚要下四碗咖喱魚雞蛋、兩碗咖哩魚土豆。他一個一個把十八種香料一層一層撒進碗裡；等全部人把碗喝完，整條灣仔就更濃了。如果今天沒人能夜宵，明天的太陽要把灣仔煮得再濃一次——灣仔的夜生活就專注吃這一碗。' },
      { type: 'cards', title: '咖哩魚飯堂可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「咖哩魚 灣仔」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-vic-park-sunday-chronicle', title: '星期天早上九點：維園的外國傭工（香港系列 · 第四十二章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：跟着一班菲律賓姐妹，由東頭的公園一層一層到西頭——香港每個星期天才會出現的擁抱與合影。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：星期天早上九點。維園東邊場內——一群菲律賓姐妹坐下來整理自己的行李。阿蓮（合成敘事，非真實人物）手裡拿著一卷番茄醬菜：這是她這週的第一口乾炒飯。這比星期天的brunch 更像brunch，比早餐更溫暖的早晨。' },
      { type: 'heading', text: '一、星期天才會出現的擁抱' },
      { type: 'paragraph', text: '菲律賓姐妹星期天從凌晨五點半起來，有些是從新界起程，有些直接在這個區住了一年。他們對話是菲律賓話、英語、廣東話、甚至是泰國話的片斷。全部來這裡只有同一個理由：六天加班後的一個休息日。這裡沒有rules，但她們會彼此告知今日是誰的生日。' },
      { type: 'cards', title: '維園可見', items: [] },
      { type: 'heading', text: '二、一對不同意的合影' },
      { type: 'paragraph', text: '有人在維園的亭子辦公室煮飯；有人在維園的小江直接吃粉絲；有人從菲律賓港來幫廚、從馬尼拉去東京，最後在這裡長得比上個世代更希望這裡。或許她們永遠不會到西邊的咖啡店，但她們每天都用這個公園當咖啡店的鏡子。' },
      { type: 'cards', title: '維園可聽', items: [] },
      { type: 'heading', text: '三、星期天再見' },
      { type: 'paragraph', text: '下午四點，西北邊的長者委員會會員開始舉手示意清場。部分姐妹還在草坪上聊天；有些正在包飯盒回家。有人這個星期天從維園去eat-bo，有人只想回去睡。阿蓮寫進筆記本：「整個維園的綠樹都是他們的故鄉。」' },
      { type: 'cards', title: '維園可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、口味、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「維園 菲律賓」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },

  {
    slug: 'hk-hopewell-sunday-lunch-chronicle', title: '下午一點：霍普韋爾的外傭午餐（香港系列 · 第四十三章）', city: 'hong-kong', category: 'activities',
    description: '合成敘事指南（非真實行程建議）：星期天的灣仔霍普韋爾中心——菲律賓姐妹和她們帶着的便當、互相交換的髮型和手機相片——香港星期天另一個擁抱了半個城的午后。',
    body_blocks: [
      { type: 'paragraph', text: '合成敘事示例（非真實行程建議）：星期天，下午一點前的二十分鐘。灣仔的霍普韋爾中心（合成敘事，非真實商戶）兩架觀光升降機一起往上走——阿蘭（合成敘事，非真實人物）手上的紙袋裡裝着她自己做的餸：一盒芒果醬（她媽媽上個月從她的老家寄來的）和兩個咖喱角。這是她這個星期的第一頓像樣的午餐；也是她六個星期以來第一個沒有人監督的自由下午。' },
      { type: 'heading', text: '一、午餐大堂的規則' },
      { type: 'paragraph', text: '每張枱都是一場小型的餐廳開幕。大家會把各自的餸一盤盤排出來交換：你的炒飯換我的咖喱角；她的沙律換我唯一一盒芒果醬。餐碟是塑料的，茶壺是塑料的，叉子是塑料的——沒有人介意。這裡是香港星期天的廚房：每個人都有一個自己的位、每個人都可以說自己是自己的廚師。大堂的空氣裡有咖喱、椰奶、蒜蓉，也有一種只有星期天才會有的勇氣：叫一罐冰凍蒸餾水，然後說一句「辛苦了」，然後坐得直直的。' },
      { type: 'cards', title: '霍普韋爾可見', items: [] },
      { type: 'heading', text: '二、天台的合影革命' },
      { type: 'paragraph', text: '下午一點半，合影時間。她們把手機串起來，輪流幫彼此照——六個人對着鏡頭用力地笑。星期天的太陽永遠往下斜，把黃昏一層一層壓在灣仔的建築上；海港、纜車線、樓頂的水塔，全都變成了她們鏡頭裡最便宜也最貴的風景。這是她們星期天的旅行紀念照——這星期、這個月、這整個合約年。阿蘭每次回想，都覺得她帶着這些照片，足以抵銷那些六天的疲勞——這是她私下叫自己「人生的年終獎」。' },
      { type: 'cards', title: '霍普韋爾可聽', items: [] },
      { type: 'heading', text: '三、分赴各處' },
      { type: 'paragraph', text: '下午兩點，大堂的燈一盞盞慢下來。姐妹們各自散去：有人去灣仔星街，因為那裡的甜品是合同規定之外的幸福；有人去銅鑼灣，因為潮貨要趁星期一之前買齊；有人直接回北角的宿舍，把芒果醬分給第二天的早餐。阿蘭在回去的路上寫：『連天台都是她們的。』她沒有把任何一個商戶的名字寫進筆記——她知道的，只有這個屋頂、這束光、和她們說了哪一個字。' },
      { type: 'cards', title: '霍普韋爾可等', items: [] },
      { type: 'heading', text: '後記' },
      { type: 'paragraph', text: '合成敘事示例：商戶、場景、故事全部是敘事建構，用於演示 NEXUS 內容層的呈現能力。趕時間的話，先去 SearchBox 搜「霍普韋爾 菲律賓」。' },
    ],
    generated_by: 'ai', reviewed_by_human: false,
    published_at: new Date().toISOString(), updated_at: new Date().toISOString(), flags: { demo: true },
  },
];
