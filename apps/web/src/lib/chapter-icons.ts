/**
 * D1181 — the chapter-glyph map. Each HK chapter gets one tasteful monochrome glyph to be read next
 * to its kicker. The map is keyed by `slug`; an unmapped slug renders no glyph (never a wrong one).
 * Local-first, zero network, zero schema — used only for the trophy case / card rail where a
 * visual cue helps the eye find a chapter fast.
 */

type IconName =
  | 'search' | 'ai' | 'arrowRight' | 'arrowLeft' | 'arrowUpRight' | 'chevronDown' | 'chevronUp'
  | 'chevronLeft' | 'chevronRight' | 'close' | 'check' | 'plus' | 'minus' | 'pin' | 'navigation'
  | 'clock' | 'star' | 'heart' | 'bookmark' | 'share' | 'compare' | 'layers' | 'map' | 'list'
  | 'grid' | 'filter' | 'user' | 'users' | 'settings' | 'bell' | 'calendar' | 'ticket' | 'wallet'
  | 'store' | 'globe' | 'mail' | 'lock' | 'sun' | 'moon' | 'menu' | 'info' | 'warning' | 'shield'
  | 'quote' | 'trending' | 'refresh' | 'download' | 'trash' | 'eye' | 'link' | 'phone' | 'spinner' | 'slash';

export const CHAPTER_ICONS: Readonly<Record<string, IconName>> = {
  'hk-food-chronicle': 'store',
  'hk-siu-mei-chronicle': 'store',
  'hk-dim-sum-chronicle': 'store',
  'hk-temple-street-chronicle': 'navigation',
  'hk-cha-chaan-teng-chronicle': 'store',
  'hk-fish-market-chronicle': 'map',
  'hk-yu-huei-chronicle': 'map',
  'hk-fruit-market-chronicle': 'map',
  'hk-tongsui-chronicle': 'store',
  'hk-bing-sat-chronicle': 'store',
  'hk-cart-noodles-chronicle': 'store',
  'hk-congee-chronicle': 'store',
  'hk-lion-rock-chronicle': 'map',
  'hk-cheung-chau-chronicle': 'map',
  'hk-mtr-evening-chronicle': 'clock',
  'hk-lei-yue-mun-chronicle': 'map',
  'hk-bakery-dawn-chronicle': 'sun',
  'hk-central-bourse-chronicle': 'store',
  'hk-er-chronicle': 'shield',
  'hk-window-cleaner-chronicle': 'eye',
  'hk-last-taxi-chronicle': 'navigation',
  'hk-school-bus-chronicle': 'users',
  'hk-dishwash-auntie-chronicle': 'store',
  'hk-night-cleaner-chronicle': 'moon',
  'hk-last-tong-sui-urn-chronicle': 'store',
  'hk-fishball-stall-chronicle': 'store',
  'hk-newspaper-wrapper-chronicle': 'mail',
  'hk-pigeon-coop-chronicle': 'globe',
  'hk-typhoon-shelter-chronicle': 'warning',
  'hk-soup-kitchen-communal-chronicle': 'users',
  'hk-estate-cardboard-chronicle': 'layers',
  'hk-drive-thru-midnight-chronicle': 'clock',
  'hk-vending-machine-chronicle': 'grid',
  'hk-tung-chung-chronicle': 'map',
  'hk-peng-chau-chronicle': 'map',
  'hk-tai-o-chronicle': 'map',
  'hk-north-run-chronicle': 'map',
  'hk-beijing-writer-chronicle': 'quote',
  'hk-teochew-markets-chronicle': 'map',
  'hk-filipino-central-chronicle': 'store',
  'hk-mumbai-curry-central-chronicle': 'store',
  'hk-vic-park-sunday-chronicle': 'users',
  'hk-hopewell-sunday-lunch-chronicle': 'store',
  'hk-temple-circuit-sunday-chronicle': 'star',
  'hk-last-queue-sunday-chronicle': 'clock',
  'hk-loohu-weekend-chronicle': 'map',
  'hk-huanggang-crossing-crew-chronicle': 'navigation',
  'hk-mixc-world-designer-chronicle': 'sun',
  'hk-loohu-trolleys-chronicle': 'sun',
  'hk-yauma-tei-dumpling-chronicle': 'store',
  'hk-kwun-tong-newsboy-chronicle': 'mail',
  'hk-kowloon-bay-garment-chronicle': 'store',
  'hk-acu-clinic-opens-chronicle': 'shield',
  'hk-sham-shui-po-fabric-chronicle': 'layers',
  'hk-loko-ma-chau-barrier-chronicle': 'navigation',
  'hk-yauma-tei-opera-supper-chronicle': 'moon',
  'hk-taipo-wholesale-market-chronicle': 'map',
  'hk-container-terminal-noon-chronicle': 'layers',
  'hk-yuen-long-shoemaker-shop-chronicle': 'store',
  'hk-mong-kok-ping-li-grocery-chronicle': 'bookmark',
  'hk-shenzhen-huanggang-night-gate-chronicle': 'shield',
  'hk-shenzhen-luohu-night-market-chronicle': 'map',
  'hk-sham-shui-po-north-river-market-chronicle': 'sun',
  'hk-man-kam-to-driver-chronicle': 'navigation',
  'hk-man-kam-to-return-chronicle': 'navigation',
  'hk-man-kam-to-morning-chronicle': 'navigation',
  'hk-man-kam-to-second-truck-chronicle': 'navigation',
  'hk-huanggang-return-coach-chronicle': 'navigation',
  'hk-central-pier-star-ferry-chronicle': 'navigation',
  'hk-central-pier-star-ferry-midbay-chronicle': 'navigation',
  'hk-mong-kok-flower-market-closeout-chronicle': 'navigation',
  'hk-central-tram-ding-ding-chronicle': 'navigation',
  'hk-wing-lei-street-analog-chronicle': 'navigation',
  'hk-central-mandarin-oriental-chef-chronicle': 'navigation',
  'hk-wan-chai-pawnshop-chronicle': 'navigation',
};

export const chapterIcon = (slug: string): IconName | undefined => CHAPTER_ICONS[slug];
