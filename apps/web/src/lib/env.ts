/**
 * Every outbound URL and runtime knob the web app uses, in one file, all documented.
 * Server-only values are never read from `process.env` inside client components: the
 * client always talks to the BFF (`/api/nexus/**`), which reads these on the server.
 *
 * Defaults are chosen so `npm run dev` works with nothing running (§130 one-command dev).
 */

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function geo(value: string | undefined, fallback: [number, number]): [number, number] {
  const parts = (value ?? '').split(',').map((part) => Number.parseFloat(part.trim()));
  if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
    return [parts[0] as number, parts[1] as number];
  }
  return fallback;
}

/** Truthy only for `true`/`1`; anything else (unset, empty, junk) falls back. Never throw on env noise. */
function bool(value: string | undefined, fallback: boolean): boolean {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  return fallback;
}

/** Platform commerce service (Spring Boot). Server-side only. Port from D9, not 8080. */
export const PLATFORM_BASE_URL = str(process.env.PLATFORM_API_BASE_URL, 'http://127.0.0.1:8090');

/** AI service (FastAPI). Server-side only. Port from D9, not 8000. */
export const AI_BASE_URL = str(process.env.AI_API_BASE_URL, 'http://127.0.0.1:8010');

/** `mock` renders contract-shaped fixtures; `live` calls the services through the BFF. */
export const DATA_MODE: 'mock' | 'live' =
  str(process.env.NEXT_PUBLIC_DATA_MODE, 'mock') === 'live' ? 'live' : 'mock';

export const IS_MOCK = DATA_MODE === 'mock';

export const TENANT = str(process.env.NEXUS_TENANT ?? process.env.NEXT_PUBLIC_TENANT, 'hong-kong');

export const SITE_URL = str(process.env.NEXT_PUBLIC_SITE_URL, 'http://localhost:3000');

export const DEFAULT_LOCALE = str(process.env.NEXT_PUBLIC_DEFAULT_LOCALE, 'zh-HK');

/** Default coarse location: Central, HK. Only used when the user has not granted geolocation. */
export const DEFAULT_GEO = geo(process.env.NEXT_PUBLIC_DEFAULT_GEO, [22.2817, 114.1585]);

export const DEFAULT_RADIUS_M = int(process.env.NEXT_PUBLIC_GEO_RADIUS_M, 3000);

/** BFF upstream timeout (§2 orchestrator budget is 12s/request; web never waits longer). */
export const BFF_TIMEOUT_MS = int(process.env.NEXUS_BFF_TIMEOUT_MS, 12_000);

/** The stream is a long-lived response, so it gets its own budget instead of the 12s read budget. */
export const AI_INTERNAL_TIMEOUT_MS = int(process.env.NEXUS_AI_STREAM_TIMEOUT_MS, 20_000);

export const SESSION_COOKIE = str(process.env.NEXUS_SESSION_COOKIE, 'nexus_session');
export const CSRF_COOKIE = str(process.env.NEXUS_CSRF_COOKIE, 'nexus_csrf');

/** Programmatic SEO quality bar (§30): fewer than this many real listings ⇒ noindex. */
export const MIN_LISTINGS_FOR_INDEX = 5;

/**
 * §27 keeps every publish behind an explicit human action, and letting crawlers index the site is a
 * publish: it hands our content to search engines. So discovery is OFF by default — `robots.txt`
 * answers `Disallow: /` and `/sitemap.xml` 404s — and an operator opts in with
 * `NEXUS_SEO_DISCOVERY_ENABLED=true`, never by a code change. Server-only, so it stays out of
 * `publicEnv`: a browser has no business toggling whether the site is crawlable.
 */
export const SEO_DISCOVERY_ENABLED = bool(process.env.NEXUS_SEO_DISCOVERY_ENABLED, false);

export const publicEnv = {
  dataMode: DATA_MODE,
  tenant: TENANT,
  siteUrl: SITE_URL,
  defaultLocale: DEFAULT_LOCALE,
  defaultGeo: DEFAULT_GEO,
  radiusM: DEFAULT_RADIUS_M,
  /** Where the browser sends search/stream requests: always our BFF, never a service origin. */
  bffBase: '/api/nexus',
} as const;
