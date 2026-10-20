/**
 * Locale + copy for both sides of the RSC boundary.
 *
 * This barrel must stay importable from a client component, so it re-exports the pure modules only.
 * `currentLocale()` reads cookies and headers and therefore lives in `./server`; importing it here
 * would make every client component that wants a dictionary fail to build.
 */

export * from './dict';
export * from './trust-labels';
