'use client';

import * as React from 'react';
import Link from 'next/link';
import { cx } from '../utils';
import { Icon } from '../icons/Icon';
import { CardMedia, DemoBadge, DistanceBadge, MatchExplanations, OpenBadge, PriceTag, RatingStars, SponsoredBadge, AvailabilityBadge, type TrustLabels } from './Renderers';
import type { CardAction, EntityCard as EntityCardModel } from './types';

/**
 * EntityCard — THE render contract (§35, [`API_CONTRACT.md`](../../../../docs/API_CONTRACT.md) §2).
 * Merchant / product / service / experience / collection all render through this one component,
 * which is what stops a page from inventing a card that skips the trust rules.
 *
 * Invariants enforced here (not at call sites):
 *  - price / rating / distance / opening / availability resolve through `facts[]` (./fact.ts);
 *    a missing or sub-threshold fact renders the "unverified" label instead of a number;
 *  - `flags.demo` ⇒ DemoBadge, `flags.sponsored` ⇒ SponsoredBadge, both always visible;
 *  - AI match bullets without a resolvable `fact_id` are dropped (§4 trust layer);
 *  - the card title is a "stretched link" (aria-labelled anchor + full-area ::after overlay)
 *    so nested action buttons stay valid HTML and keep their own tab stop.
 */
export interface EntityCardProps {
  card: EntityCardModel;
  labels: TrustLabels;
  variant?: 'grid' | 'rail' | 'row' | 'featured';
  href?: string;
  onAction?: (action: CardAction, card: EntityCardModel) => void;
  compareSelected?: boolean;
  onToggleCompare?: (card: EntityCardModel) => void;
  compareLabel?: string;
  compareDeselectLabel?: string;
  rank?: number;
  showAvailability?: boolean;
  className?: string;
}

function hrefFor(card: EntityCardModel, href?: string) {
  if (href) return href;
  return card.card_type === 'merchant' ? `/m/${card.slug}` : `/o/${card.slug}`;
}

export function EntityCard({
  card,
  labels,
  variant = 'grid',
  href,
  onAction,
  compareSelected,
  onToggleCompare,
  compareLabel,
  compareDeselectLabel,
  rank,
  showAvailability,
  className,
}: EntityCardProps) {
  const linkHref = hrefFor(card, href);
  const demo = card.flags?.demo === true;
  const sponsored = card.flags?.sponsored === true;
  const row = variant === 'row';
  const featured = variant === 'featured';
  const explanations = card.ai_match?.reasons?.filter(
    (reason) => Boolean(reason.fact_id) && (card.facts?.some((fact) => fact.fact_id === reason.fact_id) ?? false),
  ).length;

  const badges = (
    <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5">
      {demo ? <DemoBadge labels={labels} /> : null}
      {sponsored ? <SponsoredBadge labels={labels} /> : null}
      {typeof rank === 'number' ? (
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-ink-strong/85 px-1.5 text-2xs font-semibold text-ink-inverse backdrop-blur-sm">
          {rank}
        </span>
      ) : null}
    </div>
  );

  return (
    <article
      className={cx(
        'group/card relative flex overflow-hidden rounded-lg border border-line bg-surface shadow-xs',
        'transition-[box-shadow,transform,border-color] duration-base ease-nexusOut motion-reduce:transition-none',
        'hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md motion-reduce:hover:translate-y-0',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-canvas',
        variant === 'rail' && 'w-[15.5rem] shrink-0 flex-col sm:w-[16.5rem]',
        variant === 'grid' && 'flex-col',
        row && 'flex-row gap-3 p-3',
        featured && 'sm:flex-row',
        className,
      )}
      data-card-type={card.card_type}
      data-demo={demo ? 'true' : undefined}
      data-sponsored={sponsored ? 'true' : undefined}
    >
      {badges}

      <div className={cx('relative shrink-0', row ? 'w-24 sm:w-28' : featured ? 'sm:w-[46%]' : '')}>
        <CardMedia card={card} ratio={row ? '1/1' : featured ? '16/10' : '4/3'} className={row || featured ? '' : 'rounded-t-[0.4375rem]'} />
        {card.ai_match?.score && explanations ? (
          <span className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-surface/92 px-2 py-0.5 text-2xs font-semibold text-ai shadow-xs backdrop-blur-sm">
            <Icon name="ai" size={12} />
            {labels.matchScore(card.ai_match.score)}
          </span>
        ) : null}
      </div>

      <div className={cx('flex min-w-0 flex-1 flex-col gap-2', row ? 'py-0.5 pr-1' : 'px-4 pb-4 pt-3')}>
        <div className="flex min-w-0 flex-col">
          <h3 className={cx('truncate font-semibold tracking-tight text-ink-strong', featured ? 'text-xl' : 'text-base')}>
            <Link
              href={linkHref}
              className="outline-none after:absolute after:inset-0 after:content-[''] hover:text-accent focus-visible:text-accent"
            >
              {card.title}
            </Link>
          </h3>
          {card.subtitle ? (
            <p className="truncate text-xs text-ink-muted sm:text-[0.8125rem]">{card.subtitle}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PriceTag card={card} labels={labels} size={featured ? 'lg' : 'md'} />
          <RatingStars card={card} labels={labels} />
          <DistanceBadge card={card} labels={labels} />
          <OpenBadge card={card} labels={labels} />
          {showAvailability ? <AvailabilityBadge card={card} labels={labels} /> : null}
        </div>

        <MatchExplanations card={card} labels={labels} max={featured ? 4 : 2} />

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {(card.actions ?? []).slice(0, 3).map((action, index) => (
            <button
              key={`${action.type}-${index}`}
              type="button"
              onClick={() => onAction?.(action, card)}
              className={cx(
                'relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                index === 0
                  ? 'bg-accent text-accent-ink shadow-xs hover:bg-accent-hover'
                  : 'border border-line-strong text-ink-muted hover:border-accent hover:text-accent',
              )}
            >
              {action.type === 'favorite' ? <Icon name="heart" size={13} /> : null}
              {action.type === 'share' ? <Icon name="share" size={13} /> : null}
              {action.type === 'ask_ai' ? <Icon name="ai" size={13} /> : null}
              {action.type === 'directions' ? <Icon name="navigation" size={13} /> : null}
              {action.label}
            </button>
          ))}

          {onToggleCompare && compareLabel ? (
            <button
              type="button"
              aria-pressed={compareSelected ?? false}
              onClick={(event) => {
                event.preventDefault();
                onToggleCompare(card);
              }}
              className={cx(
                'relative z-10 ml-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                compareSelected
                  ? 'bg-accent-soft text-accent-soft-ink'
                  : 'border border-line text-ink-muted hover:border-accent hover:text-accent',
              )}
            >
              <Icon name="compare" size={13} />
              {compareSelected ? compareDeselectLabel : compareLabel}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Horizontal snap-scrolling rail (homepage §6). Reachable by keyboard, labelled by title. */
export function EntityRail({
  title,
  description,
  cards,
  labels,
  id,
  action,
  renderCard,
  hrefFor: hrefOverride,
}: {
  title: string;
  description?: string;
  cards: EntityCardModel[];
  labels: TrustLabels;
  id?: string;
  action?: React.ReactNode;
  renderCard?: (card: EntityCardModel, index: number) => React.ReactNode;
  hrefFor?: (card: EntityCardModel) => string;
}) {
  if (cards.length === 0) return null;
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="py-7 sm:py-8">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 id={id ? `${id}-title` : undefined} className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">
            {title}
          </h2>
          {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
        </div>
        <React.Fragment key="rail-action">{action}</React.Fragment>
      </header>
      <div className="rail-scroll -mx-4 flex gap-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {cards.map((card, index) => (
          <React.Fragment key={card.id}>
            {renderCard
              ? renderCard(card, index)
              : <EntityCard card={card} labels={labels} variant="rail" href={hrefOverride?.(card)} />}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}
