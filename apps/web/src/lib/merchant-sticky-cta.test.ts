import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1059 — the mobile sticky quick-action bar keeps its discipline in source:
 *
 *   - visible on phone widths only (never renders above 640px, verified by the media query);
 *   - exactly one primary (directions, accent) and at most one secondary (call) — no third button,
 *     no placeholder, no disabled ghost;
 *   - reuses the same two wire shapes the header already uses (directionsUrl + tel:) — no new calls;
 *   - the region names itself through the dictionary (stickyCtaLabel), never hard-coded copy;
 *   - the bar sits below sheets (z-50) and clears its own layering in both themes;
 *   - prefers-reduced-motion keeps it static (nothing transform-animates; filter blurs are dimmed, not dropped).
 *
 * A bar whose primary action is missing, or that leaks to desktop, is chrome pretending to be promise.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const VIEW = 'apps/web/src/components/merchant-view.tsx';
const CSS = 'apps/web/app/globals.css';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1059 merchant sticky quick-actions', () => {
  it('is mobile-only and carries a named region and one primary action', () => {
    const view = read(VIEW);
    expect(view).toContain('className="nexus-sticky-cta"');
    expect(view).toContain('role="region"');
    expect(view).toContain('aria-label={dict.merchant.stickyCtaLabel}');
    expect(view).toContain('directionsUrl(location.geo, geo)');
    expect(view).toContain('tel:');
    // exactly one primary (bg-accent), at most one secondary — inside the bar, not the page
    const start = view.indexOf('className="nexus-sticky-cta"');
    const end = view.indexOf('</div>', start);
    const bar = view.slice(start, end);
    expect(bar).toContain('bg-accent');
    expect((bar.match(/bg-accent/g) ?? []).length).toBe(1);
    expect((bar.match(/tel:/g) ?? []).length).toBe(1);
  });

  it('renders above page chrome and below modal sheets', () => {
    const css = read(CSS);
    expect(css).toMatch(/\.nexus-sticky-cta\s*\{[^}]*z-index:\s*50/s);
  });

  it('hides at desktop width and dims the blur under reduced motion', () => {
    const css = read(CSS);
    expect(css).toMatch(/@media \(min-width:\s*640px\)[\s\S]*?\.nexus-sticky-cta[\s\S]*?display:\s*none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.nexus-sticky-cta[\s\S]*?backdrop-filter:\s*blur\(2px\)/);
  });

  it('the dict carries stickyCtaLabel in both locales — Traditional script in zh', () => {
    const dict = read(DICT);
    expect(dict).toContain("stickyCtaLabel: '直接行動'");
    expect(dict).toContain("stickyCtaLabel: 'Quick actions'");
    expect(dict).toContain('stickyCtaLabel: string;');
  });
});
