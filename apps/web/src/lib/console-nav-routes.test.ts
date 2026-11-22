import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §155 — the console nav advertises only URLs it can actually answer. A nav entry whose
 * page.tsx does not exist is a link to a 404, and the whole point of deriving the nav from
 * a single list is that this check can be mechanical. D1515 adds the finding that the
 * §九 password-123 analytics page shipped but was missing from adminNavItems — reachable
 * only by typing its URL — so we pin BOTH the generic §155 rule and that specific entry.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const navSrc = readFileSync(join(repoRoot, 'apps/web/src/components/console/console-nav.tsx'), 'utf8');

/** Every `{ href: '/admin/...' }` / `{ href: '/merchant/...' }` literal in the nav module. */
const hrefs = [...navSrc.matchAll(/href: '(\/(?:admin|merchant)[^']*)'/g)].map((m) => m[1] as string);

describe('console nav never advertises a route it cannot answer (§155)', () => {
  it('reads a non-empty set of nav hrefs', () => {
    expect(hrefs.length).toBeGreaterThan(0);
  });

  it.each(hrefs)('%s has a real page.tsx in this build', (href) => {
    const page = join(repoRoot, 'apps/web/app', href, 'page.tsx');
    expect(existsSync(page)).toBe(true);
  });

  it('the §九 password-123 analytics page is discoverable from the admin nav', () => {
    expect(hrefs).toContain('/admin/analytics');
  });
});
