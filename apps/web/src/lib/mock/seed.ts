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
];
