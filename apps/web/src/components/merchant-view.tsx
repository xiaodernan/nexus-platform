'use client';

/**
 * The merchant profile (§34). Two rules shape this file:
 *
 *  1. It renders through the same trust components as the search cards (`merchantToCard` projects
 *     the detail into an `EntityCard`), so the profile page cannot grow weaker provenance rules
 *     than the results page.
 *  2. Sections that the data plane could not read are simply absent. An empty menu says "no
 *     published offerings"; it never shows placeholders.
 *
 * There is deliberately no "Reserve" button yet: the reservation write path (§44) is not wired to
 * an authenticated endpoint, and a button that only pretends to work is the §155 failure mode.
 */

import Link from 'next/link';
import { Badge, CardMedia, DemoBadge, Icon, OpenBadge, PriceTag, RatingStars, cx } from '@nexus/ui';
import type { GeoPoint } from '@nexus/ui/trust/types';
import { directionsUrl, factOf, formatDateTime, hoursText, hkNowParts, weekdayLabel } from '@/lib/format';
import { getDict, trustLabels } from '@/lib/i18n';
import { merchantToCard, offeringToCard } from '@/lib/adapters';
import type { MerchantPage } from '@/lib/data';
import { CardGrid } from './cards';
import { FactList } from './fact-list';

function Panel({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="mt-8 border-t border-line pt-6">
      <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight text-ink-strong sm:text-lg">
        {title}
      </h2>
      {note ? <p className="mt-1 text-xs text-ink-muted">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function MerchantView({
  page,
  locale,
  geo,
  degradedReason,
}: {
  page: MerchantPage;
  locale: string;
  geo: GeoPoint | null;
  degradedReason?: string | null;
}) {
  const dict = getDict(locale);
  const labels = trustLabels(locale);
  const detail = page.detail;
  const card = merchantToCard(detail);
  const location = detail.locations[0];
  const lang = dict.locale;
  const today = hkNowParts().weekday;
  const hoursFact = factOf({ facts: detail.facts }, 'business_hours');
  const upcoming = page.availability.slice(0, 6);
  // The platform stores praise/complaint bullets and no narrative, so a summary can legitimately carry
  // only themes; a block with neither a line nor a bullet would state nothing while asking for trust.
  const summaryBlock = page.summary?.summary || page.summary?.themes.length ? page.summary : null;

  return (
    <article className="pb-4">
      {degradedReason ? (
        <p className="mb-5 flex items-start gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-ink-muted">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium text-ink-strong">{dict.merchant.degradedTitle}：</span>
            {degradedReason}
          </span>
        </p>
      ) : null}

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {detail.flags.demo ? <DemoBadge labels={labels} /> : null}
            {detail.category ? <Badge tone="neutral" size="sm">{detail.category}</Badge> : null}
            <OpenBadge card={card} labels={labels} />
          </div>
          <h1 className="mt-2 text-2xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-3xl">
            {detail.name}
          </h1>
          {detail.tagline ? <p className="mt-1 text-sm text-ink-muted">{detail.tagline}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <RatingStars card={card} labels={labels} size="md" />
            <PriceTag card={card} labels={labels} size="lg" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {location?.geo ? (
              <a
                href={directionsUrl(location.geo, geo)}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink-strong shadow-xs transition-colors hover:border-accent hover:text-accent"
              >
                <Icon name="navigation" size={14} />
                {dict.merchant.directions}
              </a>
            ) : null}
            {location?.phone ? (
              <a
                href={`tel:${location.phone.replace(/[^\d+]/g, '')}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink-strong shadow-xs transition-colors hover:border-accent hover:text-accent"
              >
                <Icon name="phone" size={14} />
                {dict.merchant.call}
              </a>
            ) : null}
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-72">
          <CardMedia card={card} ratio="4/3" className="rounded-lg border border-line" />
        </div>
      </header>

      {detail.description ? (
        <Panel id="about" title={dict.merchant.about}>
          <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-ink-muted">{detail.description}</p>
          {detail.cuisine?.length ? (
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
              <span className="font-medium text-ink-strong">{dict.merchant.cuisineLabel}</span>
              {detail.cuisine.map((item) => (
                <Badge key={item} tone="neutral" size="sm">
                  {item}
                </Badge>
              ))}
            </p>
          ) : null}
          {detail.attributes
            ? Object.entries(detail.attributes).map(([key, values]) => (
                <p key={key} className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                  <span className="font-medium text-ink-strong">{dict.facts.attributes[key] ?? key}</span>
                  {values.map((value) => (
                    <Badge key={value} tone="outline" size="sm">
                      {value}
                    </Badge>
                  ))}
                </p>
              ))
            : null}
        </Panel>
      ) : null}

      <Panel id="menu" title={dict.merchant.menu}>
        {page.offerings.items.length ? (
          <CardGrid
            cards={page.offerings.items.map((offering) => offeringToCard(offering))}
            locale={locale}
            className="sm:grid-cols-2 xl:grid-cols-4"
          />
        ) : (
          <p className="text-sm text-ink-muted">{dict.merchant.offeringsEmpty}</p>
        )}
      </Panel>

      <Panel id="reviews" title={dict.merchant.reviews}>
        {summaryBlock ? (
          <section
            aria-label={dict.merchant.summaryTitle}
            className="rounded-lg border border-accent-line bg-accent-soft/50 p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-ai">
                <Icon name="ai" size={12} />
                {dict.merchant.summaryTitle}
              </span>
              {summaryBlock.flags.demo ? <DemoBadge labels={labels} /> : null}
            </div>
            {summaryBlock.summary ? (
              <p className="mt-2 text-sm leading-relaxed text-ink-strong">{summaryBlock.summary}</p>
            ) : null}
            {summaryBlock.themes.length ? (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {summaryBlock.themes.map((theme) => (
                  <li key={`${theme.label}-${theme.sentiment}`}>
                    <Badge
                      tone={theme.sentiment === 'positive' ? 'positive' : theme.sentiment === 'negative' ? 'danger' : 'neutral'}
                      size="sm"
                    >
                      {theme.label} · {theme.mentions}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
              <span>{dict.merchant.evidenceLabel(summaryBlock.evidence_review_ids.length)}</span>
              <span>{labels.observedLabel(summaryBlock.generated_at)}</span>
              {summaryBlock.model ? <span>{summaryBlock.model}</span> : null}
              <span>{dict.merchant.reviewedBy}</span>
            </footer>
          </section>
        ) : null}

        {page.reviews.items.length ? (
          <ul className="mt-4 flex flex-col divide-y divide-line">
            {page.reviews.items.map((review) => (
              <li key={review.review_id} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink-strong">{review.author.display_name}</span>
                  <span className="inline-flex items-center gap-0.5 text-xs text-warning" aria-label={`${review.rating}/5`}>
                    {Array.from({ length: 5 }, (_, index) => (
                      <Icon
                        key={index}
                        name="star"
                        size={12}
                        className={index < Math.round(review.rating) ? 'fill-current' : 'text-ink-faint'}
                      />
                    ))}
                  </span>
                  {review.verified_reservation ? (
                    <Badge tone="positive" size="sm">
                      {dict.merchant.verifiedVisit}
                    </Badge>
                  ) : null}
                  {review.verified_purchase ? (
                    <Badge tone="positive" size="sm">
                      {dict.merchant.verifiedPurchase}
                    </Badge>
                  ) : null}
                  {review.flags.demo ? <DemoBadge labels={labels} /> : null}
                  <span className="text-2xs text-ink-faint">{formatDateTime(review.created_at, lang)}</span>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{review.text}</p>
                {review.helpful_count > 0 ? (
                  <p className="mt-1 text-2xs text-ink-faint">{dict.merchant.helpful(review.helpful_count)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : summaryBlock ? null : (
          <p className="text-sm text-ink-muted">{dict.merchant.reviewsEmpty}</p>
        )}
      </Panel>

      <Panel id="hours" title={dict.merchant.hours} note={hoursFact ? dict.merchant.hoursFact : labels.unverified}>
        <ul className="grid max-w-md grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          {detail.business_hours.map((day) => (
            <li
              key={day.weekday}
              className={cx('flex items-baseline justify-between gap-4 py-0.5', day.weekday === today && 'font-semibold text-ink-strong')}
            >
              <span className="text-ink-muted">{weekdayLabel(day.weekday, lang)}</span>
              <span>{hoursText(day, lang)}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {upcoming.length ? (
        <Panel id="slots" title={dict.merchant.slots} note={dict.merchant.slotsNote}>
          <ul className="flex flex-wrap gap-2">
            {upcoming.map((slot) => (
              <li key={slot.slot_id}>
                <span
                  className={cx(
                    'inline-flex items-baseline gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs',
                    slot.status === 'available' ? 'text-ink-strong' : slot.status === 'limited' ? 'text-warning' : 'text-ink-faint',
                  )}
                >
                  <span className="font-medium">{formatDateTime(slot.starts_at, lang) ?? slot.starts_at}</span>
                  <span className="text-2xs text-ink-faint">
                    {slot.party_size}
                    {lang === 'en' ? ' guests' : ' 位'}
                  </span>
                  {slot.remaining != null ? <span className="text-2xs text-ink-faint">· {slot.remaining}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {location ? (
        <Panel id="location" title={dict.merchant.location}>
          <address className="flex flex-col gap-1 text-sm not-italic leading-relaxed text-ink-muted">
            <span className="inline-flex items-start gap-1.5">
              <Icon name="pin" size={14} className="mt-0.5 shrink-0 text-ink-faint" />
              <span>
                {location.address}
                <br />
                {location.district} · {location.city}
              </span>
            </span>
            {location.mtr ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="map" size={14} className="shrink-0 text-ink-faint" />
                {dict.merchant.mtr(location.mtr.station, location.mtr.walk_minutes)}
              </span>
            ) : null}
          </address>
        </Panel>
      ) : null}

      <Panel id="facts" title={dict.facts.title} note={dict.facts.note}>
        <FactList facts={detail.facts} locale={locale} />
        {detail.top_offerings.length ? (
          <p className="mt-3 text-2xs text-ink-faint">
            <Link href={`/o/${detail.top_offerings[0]?.slug ?? ''}`} className="text-accent hover:underline">
              {detail.top_offerings[0]?.title ?? ''}
            </Link>
          </p>
        ) : null}
      </Panel>
    </article>
  );
}
