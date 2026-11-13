/**
 * D1032 — the rails streamed, one boundary each.
 *
 * `app/page.tsx` renders the hero and then five `<Suspense>` boundaries — one per rail — so the
 * route's first paint never waits on the slowest upstream. Each section awaits `loadRailCards`,
 * which is shared verbatim with the `homeRails()` composer (the shape the degrade test pins),
 * and renders the same `<CardRail>` the page always rendered.
 *
 * A rail whose fetch throws does NOT vanish silently any more than the old all-settled page did:
 * it renders the same warning line the old `degraded` banner used, without inventing a cause —
 * `dict.merchant.degradedTitle` is the shipped string the error boundary already uses
 * ('Some sections could not be loaded'). A rail that reads as empty stays absent (§105).
 *
 * Copy: every label comes from the dictionaries (`dict.home.rails[key]`, `dict.merchant.degradedTitle`).
 */
import Link from 'next/link';
import { Icon } from '@nexus/ui';

import { loadRailCards, type RailKey } from '@/lib/rails-stream';
import type { EntityCard, GeoPoint } from '@/lib/types';
import { getDict } from '@/lib/i18n';
import { CardRail } from './cards';

export async function RailSection({ railKey, locale, geo }: { railKey: RailKey; locale: string; geo: GeoPoint | null }) {
  const dict = getDict(locale);
  let cards: EntityCard[] | null = null;
  try {
    cards = await loadRailCards(railKey, { geo, locale, signedIn: false });
  } catch {
    cards = null;
  }
  if (cards === null) {
    return (
      <p className="mt-6 flex items-center gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
        <Icon name="warning" size={14} className="shrink-0" />
        {dict.merchant.degradedTitle}
      </p>
    );
  }
  if (cards.length === 0) return null;
  return (
    <CardRail
      id={railKey}
      title={dict.home.rails[railKey].title}
      description={dict.home.rails[railKey].description}
      cards={cards}
      locale={locale}
      action={
        railKey === 'popular_near_you' ? (
          <Link href="/search" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            {dict.nav.search}
            <Icon name="navigation" size={13} />
          </Link>
        ) : undefined
      }
    />
  );
}
