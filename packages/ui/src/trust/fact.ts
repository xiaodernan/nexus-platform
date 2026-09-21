import type { Fact, EntityCard, FactSource } from './types';

/**
 * Fact resolution — the single policy point for "may this number be shown?"
 * (spec §19 trust layer, [`AGENT_CONTRACT.md`](../../../../docs/AGENT_CONTRACT.md) §4, §5 freshness).
 *
 * Rules encoded here:
 *  1. A value with no backing fact is NOT renderable (`null` out of `findFact`).
 *  2. `confidence < 0.4` ⇒ omit (the caller must show the unverified marker / offer handoff).
 *     `0.4 … 0.6` ⇒ renderable but must be phrased as uncertain (`isUncertain`).
 *  3. `expires_at` in the past or `stale === true` ⇒ the value is renderable but must carry the
 *     "may have changed" warning; never presented as a live price.
 *  4. When several facts share an attribute, `merchant > observed > imported > third_party > inferred`
 *     wins, then freshness (`observed_at`), then confidence. Ties never resolve to the higher number.
 */

export const SOURCE_RANK: Record<FactSource, number> = {
  merchant: 5,
  observed: 4,
  imported: 3,
  third_party: 2,
  inferred: 1,
};

export const CONFIDENCE_OMIT_BELOW = 0.4;
export const CONFIDENCE_UNCERTAIN_BELOW = 0.6;

/** Attributes that carry the trust requirement (price / rating / hours / distance / availability). */
export const TRUSTED_ATTRIBUTES = [
  'price',
  'rating',
  'business_hours',
  'distance',
  'availability',
] as const;

export type TrustedAttribute = (typeof TRUSTED_ATTRIBUTES)[number];

export function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function isExpired(fact?: Fact | null, now: number = Date.now()): boolean {
  const expires = parseTime(fact?.expires_at);
  return expires !== null && expires <= now;
}

export function isStale(fact?: Fact | null, now: number = Date.now()): boolean {
  if (!fact) return false;
  return fact.stale === true || isExpired(fact, now);
}

export function isUncertain(fact?: Fact | null): boolean {
  if (!fact) return true;
  return typeof fact.confidence === 'number' && fact.confidence < CONFIDENCE_UNCERTAIN_BELOW;
}

export function isRenderable(fact?: Fact | null): boolean {
  if (!fact) return false;
  if (typeof fact.confidence === 'number' && fact.confidence < CONFIDENCE_OMIT_BELOW) return false;
  return true;
}

/** Deterministic provenance ordering; returns the fact the UI is allowed to show. */
export function pickFact(facts: Fact[] | null | undefined, attribute: string): Fact | null {
  if (!facts?.length) return null;
  const candidates = facts.filter((fact) => fact.attribute === attribute);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => {
    const rank = SOURCE_RANK[candidate.source] ?? 0;
    const bestRank = SOURCE_RANK[best.source] ?? 0;
    if (rank !== bestRank) return rank > bestRank ? candidate : best;
    const at = parseTime(candidate.observed_at) ?? 0;
    const bestAt = parseTime(best.observed_at) ?? 0;
    if (at !== bestAt) return at > bestAt ? candidate : best;
    return (candidate.confidence ?? 0) > (best.confidence ?? 0) ? candidate : best;
  }, candidates[0] as Fact);
}

/** Resolve an attribute to a *renderable* fact, or `null` when the trust rules forbid it. */
export function findFact(card: Pick<EntityCard, 'facts'> | null | undefined, attribute: TrustedAttribute | string): Fact | null {
  const fact = pickFact(card?.facts ?? null, attribute);
  return isRenderable(fact) ? fact : null;
}

/** Follow-up lookup for explanations: a bullet is only renderable when its fact id exists. */
export function factById(card: Pick<EntityCard, 'facts'> | null | undefined, factId?: string | null): Fact | null {
  if (!factId) return null;
  return card?.facts?.find((fact) => fact.fact_id === factId) ?? null;
}

/** Read a nested value out of `Fact.value` without any casting games at call sites. */
export function factValue<T>(fact: Fact | null | undefined): T | null {
  if (!fact || fact.value === null || fact.value === undefined) return null;
  return fact.value as T;
}

export function hasNumericValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}
