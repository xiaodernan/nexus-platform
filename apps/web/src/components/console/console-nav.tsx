import Link from 'next/link';
import { Icon } from '@nexus/ui';
import type { IconName } from '@nexus/ui';

import { getDict } from '@/lib/i18n';

/**
 * Console chrome (§155: the nav advertises only URLs it can answer). Every entry here is a real
 * `app/merchant/**` or `app/admin/**` route in this build — nothing is listed "for later", because a
 * nav link to a 404 is exactly the failure the §155 rule exists to prevent.
 *
 * Render-only, no `'use client'`: a Server Component may compose it, and the active state is derived
 * from the path the caller passes in rather than from a browser hook.
 */

export interface ConsoleNavItem {
  href: string;
  label: string;
  icon?: IconName;
}

export function ConsoleNav({
  items,
  active,
  label,
}: {
  items: ConsoleNavItem[];
  active: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => {
        const isActive = item.href === active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={
              isActive
                ? 'inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent'
                : 'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-muted hover:border-accent hover:text-accent'
            }
          >
            {item.icon ? <Icon name={item.icon} size={13} /> : null}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function merchantNavItems(locale: string): ConsoleNavItem[] {
  const nav = getDict(locale).console.nav;
  return [
    { href: '/merchant', label: nav.overview, icon: 'grid' },
    { href: '/merchant/offerings', label: nav.offerings, icon: 'store' },
    { href: '/merchant/reservations', label: nav.reservations, icon: 'calendar' },
    { href: '/merchant/conversations', label: nav.conversations, icon: 'mail' },
    { href: '/merchant/reviews', label: nav.reviews, icon: 'star' },
    { href: '/merchant/campaigns', label: nav.campaigns, icon: 'ticket' },
    { href: '/merchant/imports', label: nav.imports, icon: 'download' },
    { href: '/merchant/analytics', label: nav.analytics, icon: 'trending' },
    { href: '/merchant/settings', label: nav.settings, icon: 'settings' },
    { href: '/merchant/listings', label: nav.listings, icon: 'list' },
  ];
}

export function adminNavItems(locale: string): ConsoleNavItem[] {
  const nav = getDict(locale).console.nav;
  return [
    { href: '/admin', label: nav.overview, icon: 'grid' },
    { href: '/admin/moderation', label: nav.moderation, icon: 'shield' },
    { href: '/admin/merchants', label: nav.merchants, icon: 'store' },
    { href: '/admin/users', label: nav.users, icon: 'users' },
    { href: '/admin/orders', label: nav.orders, icon: 'wallet' },
    { href: '/admin/reservations', label: nav.adminReservations, icon: 'calendar' },
    { href: '/admin/ai', label: nav.ai, icon: 'ai' },
    { href: '/admin/search', label: nav.search, icon: 'search' },
    { href: '/admin/system', label: nav.system, icon: 'shield' },
  ];
}
