/**
 * Generates the synthetic demo imagery used by the mock fixtures.
 *
 * Run: node scripts/gen-media.mjs   (idempotent; output committed under public/media)
 *
 * Why generated instead of downloaded: (a) the app must run offline (§130),
 * (b) D6/§155 forbid presenting stock photography as if it were a real business —
 * every image is an abstract placeholder that literally says SYNTHETIC DEMO.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'media');
mkdirSync(outDir, { recursive: true });

const SEEDS = [
  ['lung-yuen-kitchen', 212, '龍苑'],
  ['haeto-bistro', 188, '海塘'],
  ['ramen-koji', 24, '拉麵'],
  ['sichuan-lane', 6, '川巷'],
  ['bauhinia-cafe', 36, '洋紫荊'],
  ['granite-gym', 210, 'GRANITE'],
  ['petal-tea-house', 132, '花瓣'],
  ['harbour-quiet-bar', 268, 'HARBOUR'],
  ['green-curve-vegetarian', 108, '青弯'],
  ['north-point-inn', 200, 'NORTH'],
  ['tsuen-wan-dimsum-house', 44, '荃灣'],
  ['jordan-seoul-grill', 16, '首尔'],
  ['central-runs-club', 156, 'RUNS'],
  ['sha-tin-hotpot', 350, '围炉'],
  ['wan-chai-listening-bar', 282, 'LISTEN'],
  ['kowloon-bay-bakery', 52, '面包'],
  ['mong-kok-rain-ready', 226, 'RAIN'],
  ['tst-recovery-studio', 168, 'RECOVERY'],
  ['collection-quiet-date', 250, 'QUIET'],
  ['collection-rainy-day', 196, 'RAIN'],
  ['collection-late-night', 276, 'LATE'],
];

const RATIOS = [
  ['a', 640, 480],
  ['b', 640, 480],
  ['c', 640, 480],
];

function svg({ hue, label, w, h, variant }) {
  const rot = (variant.charCodeAt(0) * 37) % 180;
  const cx = w * (0.25 + (variant.charCodeAt(0) % 5) * 0.12);
  const cy = h * (0.3 + (variant.charCodeAt(0) % 3) * 0.16);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="presentation">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${rot} 0.5 0.5)">
      <stop offset="0%" stop-color="hsl(${hue} 46% 96%)"/>
      <stop offset="55%" stop-color="hsl(${(hue + 24) % 360} 42% 88%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 60) % 360} 38% 80%)"/>
    </linearGradient>
    <pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(${rot / 2})">
      <circle cx="2" cy="2" r="1.1" fill="hsl(${hue} 30% 30%)" fill-opacity="0.14"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#p)"/>
  <g opacity="0.9">
    <circle cx="${cx}" cy="${cy}" r="${Math.min(w, h) * 0.24}" fill="none" stroke="hsl(${hue} 55% 26%)" stroke-opacity="0.28" stroke-width="1.5"/>
    <circle cx="${cx}" cy="${cy}" r="${Math.min(w, h) * 0.13}" fill="hsl(${hue} 55% 26%)" fill-opacity="0.08"/>
  </g>
  <text x="${w / 2}" y="${h / 2 + 6}" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, PingFang HK, Microsoft JhengHei, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.16)}" font-weight="600" fill="hsl(${hue} 45% 22%)" fill-opacity="0.55">${label}</text>
  <g>
    <rect x="${w - 118}" y="${h - 34}" width="106" height="20" rx="10" fill="hsl(${hue} 45% 18%)" fill-opacity="0.5"/>
    <text x="${w - 65}" y="${h - 20}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" letter-spacing="1.4" fill="#ffffff" fill-opacity="0.92">SYNTHETIC DEMO</text>
  </g>
</svg>
`;
}

let count = 0;
for (const [slug, hue, label] of SEEDS) {
  const variants = slug.startsWith('collection-') ? [['a', 640, 480]] : RATIOS;
  for (const [variant, w, h] of variants) {
    const file = join(outDir, `${slug}-${variant}.svg`);
    writeFileSync(file, svg({ hue, label, w, h, variant }), 'utf8');
    count += 1;
  }
}
console.info(`generated ${count} synthetic SVG placeholders in ${outDir}`);
