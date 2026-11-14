import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1075 — the consumer account hub pins its contract:
 *   - the page is a server component with `force-dynamic`, stops at the sign-in desk when the
 *     session cookie is absent, and never shows fixtures as live reads;
 *   - the dict carries the `me` block in both locales, zh in Traditional script, with
 *     function-shaped paddings for counts;
 *   - every read goes through the consumer data plane (`console-consumer.ts`), which hits
 *     `/api/v1/me/**` (§3) and `/api/v1/notifications` (§123) — nothing is hard-coded;
 *   - the nav + footer carry the `/me` link (the surface must be reachable or it does not exist).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/me/page.tsx';
const LOADING = 'apps/web/app/me/loading.tsx';
const CONSUMER = 'apps/web/src/lib/console-consumer.ts';
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const CHROME = 'apps/web/src/components/site-chrome.tsx';

describe('D1075 consumer account hub', () => {
  it('is a server component that stops at the sign-in desk instead of redirecting', () => {
    const page = read(PAGE);
    expect(page).not.toContain("'use client'");
    expect(page).toContain("export const dynamic = 'force-dynamic';");
    expect(page).toContain('session.blocked');
    expect(page).toContain('<SignInRequired locale={session.locale} />');
    expect(read(LOADING)).toContain('aria-busy="true"');
  });

  it('reads live data only through the documented §3/§123 endpoints', () => {
    const source = read(CONSUMER);
    for (const route of [
      '/api/v1/me',
      '/api/v1/me/favorites',
      '/api/v1/me/reservations',
      '/api/v1/me/orders',
      '/api/v1/me/saved-searches',
      '/api/v1/notifications',
    ]) {
      expect(source).toContain(route);
    }
    // No fixtures leak into live mode: the mock branch is gated behind IS_MOCK in every reader.
    expect(source).toContain('if (IS_MOCK)');
    expect(source).not.toContain('IS_MOCK === false');
  });

  it('renders favorites through EntityCard and states the subject-type limit honestly', () => {
    const page = read(PAGE);
    // The favorites grid is an island (unsave door since D1085) — it renders EntityCardView rows.
    expect(page).toContain('<MeFavoritesGrid');
    expect(page).toContain('dict.me.favoritesNote');
  });

  it('the dict carries both locales with Traditional script in zh-HK', () => {
    const dict = read(DICT);
    expect(dict).toContain("title: '我的'");
    expect(dict).toContain("title: 'My account'");
    expect(dict).toContain("notificationsUnread: (count: number) => string;");
    expect(dict).toContain('preferencesSignals: (count: number) => string;');
    expect(dict).toContain('訂位');
    expect(dict).toContain('訂單');
    expect(dict).toContain('收藏');
  });

  it('the chrome links the surface from both the nav rail and the footer', () => {
    const chrome = read(CHROME);
    // Nav rail carries JSX `href="/me"`; the footer carries the object-literal `{ href: '/me' }`.
    expect(chrome.match(/href="\/me"/g)?.length).toBe(1);
    expect(chrome.match(/href: '\/me'/g)?.length).toBe(1);
  });

  it('the inbox carries a read-all door onto the documented §123 endpoint', () => {
    const island = read('apps/web/src/components/me-read-all.tsx');
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain("fetch('/api/nexus/platform/notifications/read-all'");
    expect(island).toContain("method: 'POST'");
    expect(island).toContain('router.refresh()');
    const dict = read(DICT);
    expect(dict).toContain("notificationsReadAll: '全部標記為已讀'");
    expect(dict).toContain("notificationsReadAll: 'Mark all as read'");
  });

  it('the preferences section reads §33 rows and renders both locales', () => {
    const page = read('apps/web/app/me/page.tsx');
    expect(page).toContain("aria-labelledby=\"me-preferences\"");
    expect(page).toContain('dict.me.preferencesSource[row.source]');
    const consumer = read(CONSUMER);
    expect(consumer).toContain("/api/v1/me/preferences");
    expect(consumer).toContain('mePreferencesRead');
    const dict = read(DICT);
    expect(dict).toContain("preferencesTitle: '我的排序訊號'");
    expect(dict).toContain("preferencesTitle: 'My ranking signals'");
    expect(dict).toContain("preferencesSource: {");
  });

  it('the jump rail links to every hub section with scroll-margin aware anchors', () => {
    const page = read(PAGE);
    for (const anchor of ["'#me-favorites'", "'#me-searches'", "'#me-preferences'", "'#me-inbox'", "'#me-reservations'", "'#me-orders'"]) {
      expect(page).toContain(anchor);
    }
    expect(page).toContain('dict.me.jumpNavLabel');
    expect(page).toContain('scroll-mt-20');
    const dict = read(DICT);
    expect(dict).toContain("jumpNavLabel: '跳到區塊'");
    expect(dict).toContain("jumpNavLabel: 'Jump to'");
  });

  it('the favorites grid carries the unsave door onto the documented DELETE route', () => {
    const island = read('apps/web/src/components/me-favorites-grid.tsx');
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain('/api/nexus/platform/me/favorites/');
    expect(island).toContain("method: 'DELETE'");
    expect(island).toContain('router.refresh()');
    expect(island).toContain('onAction={() => unsave(row)}');
    const page = read('apps/web/app/me/page.tsx');
    expect(page).toContain('<MeFavoritesGrid');
    const dict = read(DICT);
    expect(dict).toContain("favoritesUnsave: '取消收藏'");
    expect(dict).toContain("favoritesUnsave: 'Unsave'");
  });
});
