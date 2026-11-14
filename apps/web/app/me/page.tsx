import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Container, EmptyState, Icon } from '@nexus/ui';

import { MeFavoritesGrid } from '@/components/me-favorites-grid';
import { LocaleDemoBadge } from '@/components/locale-badges';
import { MeReadAll } from '@/components/me-read-all';
import { ReadFailure, SignInRequired, SourceStamp } from '@/components/console/console-parts';
import {
  meFavoritesRead,
  meNotificationsRead,
  meOrdersRead,
  mePreferencesRead,
  meProfileRead,
  meReservationsRead,
  meSavedSearchesRead,
  meSession,
  type MeNotificationRow,
} from '@/lib/console-consumer';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { formatDateTime, formatMoney, formatNumber, formatRelativeDay } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * `/me` — the consumer account hub. Six reads, six independent fates, one page: profile, saved
 * favourites, reservations, orders, saved searches and the inbox. A read that fails renders its
 * §1 error code in the section that asked for it — never fixtures, never a silent zero.
 *
 * The demo plane always has a demo identity; live mode stops at `/signin` when the cookie the
 * sign-in sets is absent, exactly like the merchant console.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.me.title,
    description: dict.me.intro,
    alternates: { canonical: '/me' },
    robots: { index: false, follow: false },
  };
}

const NOTIFICATION_ICON = {
  reservation: 'calendar',
  order: 'wallet',
  review: 'quote',
  guide: 'bookmark',
  price: 'trending',
  system: 'info',
} as const;

function notificationIcon(kind: MeNotificationRow['kind']) {
  return NOTIFICATION_ICON[kind] ?? 'info';
}

export default async function MePage() {
  const session = await meSession();
  const dict = getDict(session.locale);
  if (session.blocked) {
    return (
      <Container size="wide" className="pb-24 pt-10">
        <SignInRequired locale={session.locale} />
      </Container>
    );
  }

  const locale = session.locale;
  const [profile, favorites, reservations, orders, savedSearches, inbox, preferences] = await Promise.all([
    meProfileRead(),
    meFavoritesRead(6),
    meReservationsRead(3),
    meOrdersRead(3),
    meSavedSearchesRead(6),
    meNotificationsRead(6),
    mePreferencesRead(8),
  ]);

  const me = profile.data;
  const savedCards = favorites.data?.filter((favorite) => favorite.card) ?? [];
  const unsavedCount = (favorites.data?.length ?? 0) - savedCards.length;
  const favoritesCount = favorites.data?.length ?? null;
  const reservationsCount = reservations.data?.length ?? null;
  const ordersCount = orders.data?.length ?? null;

  return (
    <Container size="wide" className="pb-24 pt-8 sm:pt-10">
      {/* ------------------------------------------------ identity panel */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
          style={{ background: 'var(--nexus-ai-gradient)' }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-20 h-56 w-96"
          style={{ background: 'radial-gradient(closest-side, rgb(var(--nexus-accent-rgb) / 0.14), transparent)' }}
        />
        <div className="relative grid gap-6 p-6 sm:p-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xs font-medium uppercase tracking-[0.18em] text-ink-faint">{dict.me.eyebrow}</span>
              {profile.demo ? <LocaleDemoBadge locale={locale} /> : null}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <span
                aria-hidden="true"
                className="inline-flex h-16 w-16 shrink-0 select-none items-center justify-center rounded-2xl bg-accent text-2xl font-semibold text-accent-ink"
              >
                {(me?.displayName ?? '?').trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-ink-strong sm:text-3xl">
                  {me?.displayName ?? dict.states.error}
                </h1>
                {me?.email ? <p className="mt-1 font-mono text-2xs text-ink-muted">{me.email}</p> : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-2xs text-ink-faint">
              {me?.memberships.length ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Icon name="users" size={12} />
                  <span className="font-medium">{dict.me.membershipsLabel}</span>
                  {me.memberships.map((membership) => (
                    <Badge key={`${membership.role}:${membership.merchantSlug ?? 'platform'}`} tone="outline" size="sm">
                      {membership.merchantSlug
                        ? `${membership.role} · ${membership.merchantSlug}`
                        : membership.role}
                    </Badge>
                  ))}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <Icon name="trending" size={12} />
                {dict.me.preferencesSignals(me?.preferencesUsed ?? 0)}
              </span>
            </div>
            {profile.status === 'failed' ? (
              <ReadFailure read={profile} locale={locale} title={dict.states.error} />
            ) : null}
          </div>

          {/* the three counts, only when the reads answered — never zeros by design */}
          <div className="flex items-stretch gap-0 self-center lg:self-end lg:justify-end">
            {[
              { label: dict.me.statsFavorites, value: favoritesCount, icon: 'heart' as const },
              { label: dict.me.statsReservations, value: reservationsCount, icon: 'calendar' as const },
              { label: dict.me.statsOrders, value: ordersCount, icon: 'wallet' as const },
            ].map((stat) => (
              <div
                key={stat.label}
                className="flex min-w-[5.5rem] flex-col items-center justify-center gap-1 border-l border-line px-4 py-2 first:border-l-0 sm:min-w-[7rem] sm:px-6"
              >
                <Icon name={stat.icon} size={15} className="text-ink-faint" />
                <span className="text-2xl font-semibold tabular-nums text-ink-strong">
                  {stat.value === null ? '—' : formatNumber(stat.value, locale)}
                </span>
                <span className="text-2xs text-ink-faint">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="relative border-t border-line px-6 py-3 sm:px-8">
          <SourceStamp read={profile} locale={locale} />
        </div>
      </section>

      {/* section jump rail — tasteful, mobile-scrollable, pure anchor links */}
      <nav aria-label={dict.me.jumpNavLabel} className="mt-6 -mx-1 overflow-x-auto pb-1">
        <ul className="flex min-w-max items-center gap-1.5 px-1">
          {[
            { href: '#me-favorites', label: dict.me.favoritesTitle },
            { href: '#me-searches', label: dict.me.savedSearchesTitle },
            ...(preferences.data && preferences.data.length > 0
              ? [{ href: '#me-preferences', label: dict.me.preferencesTitle }]
              : []),
            { href: '#me-inbox', label: dict.me.notificationsTitle },
            { href: '#me-reservations', label: dict.me.reservationsTitle },
            { href: '#me-orders', label: dict.me.ordersTitle },
          ].map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-8 grid gap-8 xl:grid-cols-[1.7fr_1fr]">
        {/* ------------------------------------------- left column */}
        <div className="flex min-w-0 flex-col gap-8">
          {/* favorites */}
          <section aria-labelledby="me-favorites" className="scroll-mt-20">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="me-favorites" className="text-xl font-semibold tracking-tight text-ink-strong">
                  {dict.me.favoritesTitle}
                </h2>
                <p className="mt-0.5 text-xs text-ink-muted">{dict.me.favoritesIntro}</p>
              </div>
              <Link href="/search" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                {dict.me.favoritesManage}
                <Icon name="arrowRight" size={12} />
              </Link>
            </div>
            {favorites.status === 'failed' ? (
              <div className="mt-3">
                <ReadFailure read={favorites} locale={locale} title={dict.states.error} />
              </div>
            ) : savedCards.length > 0 ? (
              <>
                <MeFavoritesGrid
                  rows={savedCards.map((favorite) => ({
                    favoriteId: favorite.id,
                    subjectType: favorite.subjectType,
                    subjectId: favorite.subjectId,
                    card: favorite.card as NonNullable<typeof favorite.card>,
                  }))}
                  locale={locale}
                  labels={{
                    unsave: dict.me.favoritesUnsave,
                    unsaveBusy: dict.me.favoritesUnsaveBusy,
                    unsaveDone: dict.me.favoritesUnsaveDone,
                    unsaveFailed: dict.me.favoritesUnsaveFailed,
                  }}
                  className="mt-4"
                />
                {unsavedCount > 0 ? (
                  <p className="mt-2 text-2xs text-ink-faint">{dict.me.favoritesNote}</p>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon="heart"
                title={dict.me.favoritesEmptyTitle}
                description={dict.me.favoritesEmptyText}
                className="mt-4 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-10"
              />
            )}
            {favorites.status === 'ok' ? <SourceStamp read={favorites} locale={locale} className="mt-2" /> : null}
          </section>

          {/* saved searches */}
          <section aria-labelledby="me-searches" className="scroll-mt-20">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 id="me-searches" className="text-xl font-semibold tracking-tight text-ink-strong">
                {dict.me.savedSearchesTitle}
              </h2>
              {savedSearches.data?.length ? (
                <span className="text-2xs font-medium tabular-nums text-ink-faint">{savedSearches.data.length}</span>
              ) : null}
            </div>
            {savedSearches.status === 'failed' ? (
              <div className="mt-3">
                <ReadFailure read={savedSearches} locale={locale} title={dict.states.error} />
              </div>
            ) : savedSearches.data?.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {savedSearches.data.map((search) => (
                  <li key={search.id}>
                    <Link
                      href={`/search?q=${encodeURIComponent(search.query)}`}
                      className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent"
                      title={dict.me.savedSearchesRerun}
                    >
                      <Icon name="search" size={12} className="shrink-0 text-ink-faint" />
                      <span className="truncate">{search.query}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="search"
                title={dict.states.empty}
                className="mt-3 rounded-2xl border border-dashed border-line bg-surface/60 py-6"
              />
            )}
          </section>

          {/* preference memory — §33: the ranker's window onto the person, and the person's view of it */}
          {preferences.data && preferences.data.length > 0 ? (
            <section aria-labelledby="me-preferences" className="scroll-mt-20">
              <h2 id="me-preferences" className="text-xl font-semibold tracking-tight text-ink-strong">
                {dict.me.preferencesTitle}
              </h2>
              <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">{dict.me.preferencesIntro}</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {preferences.data.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-3"
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="outline" size="sm">{row.scope === 'session' ? dict.me.preferencesScope.session : dict.me.preferencesScope.long_term}</Badge>
                      <span className="min-w-0 truncate font-mono text-2xs text-ink-faint" title={row.key}>{row.kind ? `${row.kind}.${row.key}` : row.key}</span>
                    </span>
                    <span className="truncate font-mono text-xs font-medium text-ink-strong" title={row.value}>{row.value}</span>
                    <span className="flex flex-wrap items-center justify-between gap-2 text-2xs text-ink-faint">
                      <span className="inline-flex items-center gap-1">
                        <Icon name="user" size={11} />
                        {dict.me.preferencesSource[row.source]}
                      </span>
                      {typeof row.confidence === 'number' ? (
                        <span className="font-mono tabular-nums">{dict.me.preferencesConfidence} {Math.round(row.confidence * 100)}%</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {preferences.status === 'ok' ? <SourceStamp read={preferences} locale={locale} className="mt-2" /> : null}
            </section>
          ) : preferences.status === 'failed' ? (
            <ReadFailure read={preferences} locale={locale} title={dict.states.error} />
          ) : null}
        </div>

        {/* ------------------------------------------- right rail */}
        <div className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-20 xl:self-start">
          {/* inbox */}
          <section aria-labelledby="me-inbox" className="scroll-mt-20 rounded-2xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="me-inbox" className="text-base font-semibold tracking-tight text-ink-strong">
                {dict.me.notificationsTitle}
              </h2>
              <div className="flex items-center gap-2">
                {inbox.data && inbox.data.unread > 0 ? (
                  <Badge tone="accent" size="sm">
                    {dict.me.notificationsUnread(inbox.data.unread)}
                  </Badge>
                ) : null}
                {inbox.data?.rows.length ? (
                  <MeReadAll
                    label={dict.me.notificationsReadAll}
                    doneLabel={dict.me.notificationsReadAllDone}
                    busyLabel={dict.me.notificationsReadAllBusy}
                  />
                ) : null}
              </div>
            </div>
            {inbox.status === 'failed' ? (
              <div className="mt-3">
                <ReadFailure read={inbox} locale={locale} title={dict.states.error} />
              </div>
            ) : inbox.data?.rows.length ? (
              <ul className="mt-3 divide-y divide-line">
                {inbox.data.rows.map((row) => {
                  const when = formatRelativeDay(row.createdAt ?? '', locale);
                  const content = (
                    <span className="flex items-start gap-2.5 py-2.5">
                      <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${row.unread ? 'bg-accent-soft text-accent' : 'bg-surface-muted text-ink-faint'}`}>
                        <Icon name={notificationIcon(row.kind)} size={12} />
                      </span>
                      <span className="min-w-0">
                        <span className={`block truncate text-xs leading-snug ${row.unread ? 'font-semibold text-ink-strong' : 'text-ink-muted'}`}>
                          {row.title}
                        </span>
                        {row.body ? (
                          <span className="mt-0.5 block truncate text-2xs text-ink-faint">{row.body}</span>
                        ) : null}
                        <span className="mt-0.5 block font-mono text-2xs text-ink-faint">{when}</span>
                      </span>
                      {row.unread ? <span aria-hidden="true" className="ml-auto mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    </span>
                  );
                  return (
                    <li key={row.id}>
                      {row.href ? (
                        <Link href={row.href} className="block rounded-md hover:bg-surface-muted">
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                icon="bell"
                title={dict.me.notificationsEmptyTitle}
                description={dict.me.notificationsEmptyText}
                className="mt-3 px-4 py-6"
              />
            )}
          </section>

          {/* reservations */}
          <section aria-labelledby="me-reservations" className="scroll-mt-20 rounded-2xl border border-line bg-surface p-5">
            <h2 id="me-reservations" className="text-base font-semibold tracking-tight text-ink-strong">
              {dict.me.reservationsTitle}
            </h2>
            {reservations.status === 'failed' ? (
              <div className="mt-3">
                <ReadFailure read={reservations} locale={locale} title={dict.states.error} />
              </div>
            ) : reservations.data?.length ? (
              <ul className="mt-3 divide-y divide-line">
                {reservations.data.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 py-2.5">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <Icon name="calendar" size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink-strong">
                        {row.merchantName ?? row.code ?? row.id}
                      </span>
                      <span className="mt-0.5 block font-mono text-2xs text-ink-faint">
                        {[formatDateTime(row.startsAt, locale), row.partySize ? `${row.partySize} · ${dict.me.reservationStatus[row.status as keyof typeof dict.me.reservationStatus] ?? row.status}` : dict.me.reservationStatus[row.status as keyof typeof dict.me.reservationStatus] ?? row.status].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <Badge
                      tone={row.status === 'confirmed' || row.status === 'seated' ? 'positive' : row.status === 'cancelled' || row.status === 'no_show' ? 'danger' : 'warning'}
                      size="sm"
                    >
                      {dict.me.reservationStatus[row.status as keyof typeof dict.me.reservationStatus] ?? row.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="calendar"
                title={dict.me.reservationsEmptyTitle}
                description={dict.me.reservationsEmptyText}
                className="mt-3 px-4 py-6"
              />
            )}
          </section>

          {/* orders */}
          <section aria-labelledby="me-orders" className="scroll-mt-20 rounded-2xl border border-line bg-surface p-5">
            <h2 id="me-orders" className="text-base font-semibold tracking-tight text-ink-strong">
              {dict.me.ordersTitle}
            </h2>
            {orders.status === 'failed' ? (
              <div className="mt-3">
                <ReadFailure read={orders} locale={locale} title={dict.states.error} />
              </div>
            ) : orders.data?.length ? (
              <ul className="mt-3 divide-y divide-line">
                {orders.data.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 py-2.5">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
                      <Icon name="wallet" size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink-strong">
                        {row.merchantName ?? row.code ?? row.id}
                      </span>
                      <span className="mt-0.5 block font-mono text-2xs text-ink-faint">
                        {[row.code, formatDateTime(row.createdAt, locale)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="font-mono text-2xs tabular-nums text-ink-strong">
                        {row.total ? formatMoney(row.total, locale) : '—'}
                      </span>
                      <Badge
                        tone={row.status === 'paid' || row.status === 'confirmed' || row.status === 'completed' ? 'positive' : row.status === 'cancelled' || row.status === 'refunded' ? 'danger' : 'warning'}
                        size="sm"
                      >
                        {dict.me.orderStatus[row.status as keyof typeof dict.me.orderStatus] ?? row.status}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="wallet"
                title={dict.me.ordersEmptyTitle}
                description={dict.me.ordersEmptyText}
                className="mt-3 px-4 py-6"
              />
            )}
          </section>
        </div>
      </div>
    </Container>
  );
}
