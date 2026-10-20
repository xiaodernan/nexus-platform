/**
 * Coarse location for a request. Three inputs, in this order of trust: explicit coordinates the
 * visitor granted (never stored, §106), a district name they picked, then the documented default
 * (Central) so a first visit still gets distance numbers rather than none.
 *
 * Server-side only: resolving a district reads the fixture district table, and a lat/lng pair from
 * the query string is validated here so no page has to repeat the range check.
 */

import { DEFAULT_GEO, DEFAULT_RADIUS_M } from './env';
import { DISTRICTS, type DistrictKey } from './mock';
import type { GeoPoint } from '@nexus/ui/trust/types';

/** HK sits inside a narrow box; anything outside it is a typo or an injected value, not a location. */
const HK_BOX = { minLat: 22.1, maxLat: 22.6, minLng: 113.8, maxLng: 114.5 };

export interface GeoParams {
  lat?: string | string[] | undefined;
  lng?: string | string[] | undefined;
  district?: string | string[] | undefined;
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function districtKey(value: string | string[] | undefined): DistrictKey | null {
  const name = single(value);
  if (!name) return null;
  const entry = Object.entries(DISTRICTS).find(
    ([key, district]) => key === name || district.name === name || district.zh === name,
  );
  return entry ? (entry[0] as DistrictKey) : null;
}

export function resolveGeo(params: GeoParams): GeoPoint {
  const lat = Number.parseFloat(single(params.lat) ?? '');
  const lng = Number.parseFloat(single(params.lng) ?? '');
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= HK_BOX.minLat &&
    lat <= HK_BOX.maxLat &&
    lng >= HK_BOX.minLng &&
    lng <= HK_BOX.maxLng
  ) {
    return { lat, lng };
  }
  const key = districtKey(params.district);
  if (key) return DISTRICTS[key].geo;
  return { lat: DEFAULT_GEO[0], lng: DEFAULT_GEO[1] };
}

export const DEFAULT_CENTER: GeoPoint = { lat: DEFAULT_GEO[0], lng: DEFAULT_GEO[1] };

export { DEFAULT_RADIUS_M };
