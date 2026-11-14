/**
 * Deterministic daily fortune ("今日食運") — a pure, allocation-free algorithm layer.
 *
 * The island calls {@link almanacIndex} with the Hong Kong date key; the same day always yields
 * the same entry, tomorrow a different one, with no state, no fetch, no randomness. The hash is
 * cyrb53 — a 53-bit FNV-style mix that needs no dependencies and behaves uniformly for the small
 * pools we render (≤ 64 entries).
 *
 * Kept dependency-free and synchronous so it can run on any plane (the home page's mock and live
 * deployments alike) and so the vitest arms can assert the full contract without booting Next.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

/** FNV-1a over UTF-16 code units, folded into 53 bits. Deterministic across hosts. */
export function cyrb53(key: string, seed = 0): number {
  let h = FNV_OFFSET ^ BigInt(seed);
  for (let i = 0; i < key.length; i += 1) {
    h ^= BigInt(key.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK_64;
  }
  // Splitmix-style final avalanche so adjacent dates spread across the pool.
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & MASK_64;
  h ^= h >> 33n;
  return Number(h & ((1n << 53n) - 1n));
}

/** The Hong Kong local date key, `YYYY-MM-DD`, for the given instant (default: now). */
export function hkDateKey(now: Date = new Date()): string {
  // en-CA gives the ISO ordering without depending on locale session state.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Pool pick: same key in, same index out; spreads well for pools up to a few thousand. */
export function almanacIndex(dateKey: string, poolSize: number): number {
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new RangeError(`almanacIndex needs poolSize ≥ 1, got ${String(poolSize)}`);
  }
  return cyrb53(dateKey) % poolSize;
}
