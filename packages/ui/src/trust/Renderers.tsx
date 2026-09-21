'use client';

import * as React from 'react';
import { cx } from '../utils';
import { Icon } from '../icons/Icon';
import { Tooltip } from '../primitives/Floating';
import { Badge } from '../primitives/Badge';
import { Skeleton } from '../primitives/Skeleton';
import type { EntityCard, Fact, FactSource, PriceModel } from './types';
import { findFact, factValue, isStale, isUncertain } from './fact';

/**
 * Every string in the trust renderers is injected. The design system ships zero copy,
 * which is what makes the "未验证" fallback impossible to localise incorrectly or fork
 * ([`AGENT_CONTRACT.md`](../../../../docs/AGENT_CONTRACT.md) §12 i18n, [`CONSUMER.md`](../../../../docs/CONSUMER.md) §4).
 */
export interface TrustLabels {
  unverified: string;
  staleValue: string;
  uncertain: string;
  demo: string;
  demoTooltip: string;
  sponsored: string;
  sponsoredTooltip: string;
  open: string;
  closed: string;
  priceModels: Record<PriceModel, string>;
  reviewsCount: (count: number) => string;
  distanceText: (meters: number) => string;
  travelMinutes: (minutes: number) => string;
  sourceLabel: Record<FactSource, string>;
  confidenceLabel: (confidence: number) => string;
  observedLabel: (iso: string) => string;
  availability: { available: string; limited: string; full: string; unknown: string; closed: string };
  matchScore: (score: number) => string;
  provenance: string;
}

/* ------------------------------------------------------------------ DemoBadge */

/**
 * DemoBadge (§109, [`DECISIONS.md`](../../../../docs/DECISIONS.md) D6) — synthetic data must never pass
 * as a real business. Rendered on every card/panel whose payload has `flags.demo`.
 */
export function DemoBadge({ labels, className }: { labels: Pick<TrustLabels, 'demo' | 'demoTooltip'>; className?: string }) {
  return (
    <Tooltip content={labels.demoTooltip}>
      <span
        className={cx(
          'inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-warning/70 bg-warning-soft px-1.5 text-2xs font-bold uppercase tracking-wide text-warning',
          className,
        )}
        data-testid="demo-badge"
      >
        {labels.demo}
        <span className="nexus-sr-only">— {labels.demoTooltip}</span>
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------ SponsoredBadge */

/** Sponsored slot label (§66/§67): paid placement is always labelled, never blended in. */
export function SponsoredBadge({ labels, className }: { labels: Pick<TrustLabels, 'sponsored' | 'sponsoredTooltip'>; className?: string }) {
  return (
    <Tooltip content={labels.sponsoredTooltip}>
      <span className={cx('inline-block', className)}>
        <Badge tone="outline" size="sm" className="border-line-strong text-ink-muted">
          {labels.sponsored}
        </Badge>
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------ FactSourceChip */

/**
 * Provenance chip: who said this, how sure they are, and when they said it.
 * Named `…Chip` because `FactSource` is the §2 wire union (`merchant | observed | …`).
 */
export function FactSourceChip({
  fact,
  labels,
  compact,
  className,
}: {
  fact: Fact | null;
  labels: TrustLabels;
  compact?: boolean;
  className?: string;
}) {
  if (!fact) {
    return (
      <span className={cx('inline-flex items-center gap-1 text-2xs text-ink-faint', className)}>
        <Icon name="warning" size={12} />
        {labels.unverified}
      </span>
    );
  }
  const tone =
    fact.source === 'merchant' ? 'positive' : fact.source === 'inferred' || fact.source === 'third_party' ? 'warning' : 'neutral';
  const detail = `${labels.sourceLabel[fact.source]} · ${labels.confidenceLabel(fact.confidence)} · ${labels.observedLabel(
    fact.observed_at,
  )}`;
  return (
    <Tooltip content={detail}>
      <span className={cx('inline-flex items-center gap-1 text-2xs text-ink-faint', className)}>
        <Icon name={tone === 'positive' ? 'shield' : 'info'} size={12} />
        {compact ? null : labels.sourceLabel[fact.source]}
        <span className="nexus-sr-only">{detail}</span>
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ PriceTag */

export function PriceTag({
  card,
  labels,
  size = 'md',
  className,
}: {
  card: EntityCard;
  labels: TrustLabels;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const fact = findFact(card, 'price');
  const value = factValue<{ amount?: string; currency?: string }>(fact);
  const amount = value?.amount ?? card.price?.amount;
  const currency = value?.currency ?? card.price?.currency ?? 'HKD';
  const model = card.price?.model ?? (value ? null : null);

  if (!fact || !amount) {
    return (
      <span
        className={cx('inline-flex items-center gap-1 text-ink-faint', size === 'lg' ? 'text-sm' : 'text-xs', className)}
        data-testid="price-unverified"
      >
        <Icon name="info" size={13} />
        {labels.unverified}
      </span>
    );
  }

  const stale = isStale(fact);
  const uncertain = isUncertain(fact);

  return (
    <span className={cx('inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
      <span
        className={cx(
          'font-semibold tabular-nums',
          size === 'lg' ? 'text-xl text-ink-strong' : size === 'sm' ? 'text-xs text-ink' : 'text-sm text-ink-strong',
          stale && 'text-warning line-through decoration-warning/50',
        )}
      >
        {formatMoney(amount, currency)}
      </span>
      {model ? (
        <span className={cx('text-ink-faint', size === 'lg' ? 'text-xs' : 'text-2xs')}>
          {labels.priceModels[model] ?? ''}
        </span>
      ) : null}
      {stale ? (
        <Tooltip content={labels.staleValue}>
          <span className="inline-flex items-center gap-1 text-2xs font-medium text-warning">
            <Icon name="warning" size={12} />
            {labels.staleValue}
          </span>
        </Tooltip>
      ) : uncertain ? (
        <span className="text-2xs text-warning">{labels.uncertain}</span>
      ) : (
        <FactSource fact={fact} labels={labels} compact className="text-2xs" />
      )}
    </span>
  );
}

export function formatMoney(amount: string, currency: string): string {
  const numeric = Number(amount);
  const symbol = currency === 'HKD' ? 'HK$' : `${currency} `;
  if (!Number.isFinite(numeric)) return `${symbol}${amount}`;
  return `${symbol}${numeric.toFixed(0)}`;
}

/* --------------------------------------------------------------- RatingStars */

export function RatingStars({
  card,
  labels,
  showCount = true,
  size = 'sm',
  className,
}: {
  card: EntityCard;
  labels: TrustLabels;
  showCount?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const fact = findFact(card, 'rating');
  const value = factValue<{ value?: number; count?: number }>(fact);
  const rating = value?.value ?? (fact ? card.rating?.value : undefined);
  const count = value?.count ?? card.rating?.count;

  if (!fact || typeof rating !== 'number') {
    return (
      <span className={cx('inline-flex items-center gap-1 text-ink-faint', size === 'md' ? 'text-sm' : 'text-xs', className)}>
        <Icon name="info" size={13} />
        {labels.unverified}
      </span>
    );
  }

  const filled = Math.round(rating);
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)} title={labels.sourceLabel[fact.source]}>
      <span aria-hidden className="inline-flex items-center gap-px">
        {[1, 2, 3, 4, 5].map((step) => (
          <Icon
            key={step}
            name="star"
            size={size === 'md' ? 15 : 13}
            className={cx(step <= filled ? 'text-warning' : 'text-line-strong')}
            fill={step <= filled ? 'currentColor' : 'none'}
          />
        ))}
      </span>
      <span className={cx('font-semibold tabular-nums text-ink-strong', size === 'md' ? 'text-sm' : 'text-xs')}>
        {rating.toFixed(1)}
      </span>
      {showCount && typeof count === 'number' ? (
        <span className={cx('tabular-nums text-ink-faint', size === 'md' ? 'text-xs' : 'text-2xs')}>
          ({labels.reviewsCount(count)})
        </span>
      ) : null}
      {isStale(fact) ? <Icon name="warning" size={13} className="text-warning" label={labels.staleValue} /> : null}
    </span>
  );
}

/* -------------------------------------------------------------- DistanceBadge */

export function DistanceBadge({
  card,
  labels,
  className,
}: {
  card: EntityCard;
  labels: TrustLabels;
  className?: string;
}) {
  const fact = findFact(card, 'distance');
  const value = factValue<{ meters?: number; travel_minutes?: number; text?: string }>(fact);
  const meters = value?.meters ?? card.distance?.meters;
  const travel = value?.travel_minutes ?? card.distance?.travel_minutes;
  const text = value?.text ?? card.distance?.text;

  if (!fact || typeof meters !== 'number') {
    return (
      <span className={cx('inline-flex items-center gap-1 text-xs text-ink-faint', className)}>
        <Icon name="pin" size={13} />
        {labels.unverified}
      </span>
    );
  }
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs tabular-nums text-ink-muted', className)}>
      <Icon name="pin" size={13} className="text-accent" />
      {text ?? labels.distanceText(meters)}
      {typeof travel === 'number' ? (
        <span className="text-ink-faint">· {labels.travelMinutes(travel)}</span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ OpenBadge */

/** Open/closed is *computed* from a business-hours fact, never guessed (§20). */
export function OpenBadge({ card, labels, className }: { card: EntityCard; labels: TrustLabels; className?: string }) {
  const fact = findFact(card, 'business_hours');
  const open = card.open;
  if (!fact || !open || !open.source_fact_id) {
    return (
      <span className={cx('inline-flex items-center gap-1 text-xs text-ink-faint', className)}>
        <Icon name="clock" size={13} />
        {labels.unverified}
      </span>
    );
  }
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        open.is_open ? 'bg-positive-soft text-positive' : 'bg-surface-sunken text-ink-muted',
        className,
      )}
    >
      <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', open.is_open ? 'bg-positive' : 'bg-ink-disabled')} />
      {open.text ?? (open.is_open ? labels.open : labels.closed)}
    </span>
  );
}

/* ---------------------------------------------------------- MatchExplanations */

/**
 * AI match bullets (§18). Filter rule enforced here, not at call sites:
 * a bullet without a resolvable `fact_id` is dropped (§4 trust layer).
 */
export function MatchExplanations({
  card,
  labels,
  max = 4,
  className,
}: {
  card: EntityCard;
  labels: TrustLabels;
  max?: number;
  className?: string;
}) {
  const reasons = (card.ai_match?.reasons ?? []).filter(
    (reason) => Boolean(reason.fact_id) && (card.facts?.some((fact) => fact.fact_id === reason.fact_id) ?? false),
  );
  if (reasons.length === 0) {
    return card.ai_match?.score ? (
      <span className={cx('text-xs text-ink-faint', className)}>{labels.matchScore(card.ai_match.score)}</span>
    ) : null;
  }
  return (
    <ul className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {reasons.slice(0, max).map((reason, index) => (
        <li key={`${reason.label}-${index}`} className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <Icon name="check" size={13} className="shrink-0 text-positive" />
          <span className="line-clamp-1">{reason.text}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------- AvailabilityBadge */

export function AvailabilityBadge({ card, labels, className }: { card: EntityCard; labels: TrustLabels; className?: string }) {
  const availability = card.availability;
  const fact = availability?.source_fact_id
    ? card.facts?.find((item) => item.fact_id === availability.source_fact_id) ?? null
    : findFact(card, 'availability');
  if (!availability || !fact || fact.source === 'inferred') {
    return (
      <span className={cx('inline-flex items-center gap-1 text-xs text-ink-faint', className)}>
        <Icon name="calendar" size={13} />
        {labels.unverified}
      </span>
    );
  }
  const map = {
    available: { tone: 'positive', text: labels.availability.available },
    limited: { tone: 'warning', text: labels.availability.limited },
    full: { tone: 'danger', text: labels.availability.full },
    unknown: { tone: 'neutral', text: labels.availability.unknown },
    closed: { tone: 'neutral', text: labels.availability.closed },
  } as const;
  const entry = map[availability.status] ?? map.unknown;
  return (
    <Badge tone={entry.tone} size="sm" icon="calendar" className={className}>
      {entry.text}
    </Badge>
  );
}

/** Image with an honest synthetic treatment: no remote fetch, gradient + monogram. */
export function CardMedia({
  card,
  ratio = '4/3',
  className,
}: {
  card: EntityCard;
  ratio?: string;
  className?: string;
}) {
  const [loaded, setLoaded] = React.useState(false);
  return (
    <div
      className={cx('relative w-full overflow-hidden bg-surface-muted', className)}
      style={{ aspectRatio: ratio }}
    >
      {!loaded ? <Skeleton className="absolute inset-0 h-full w-full rounded-none" /> : null}
      {card.image?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.image.url}
          alt={card.image.alt || card.title}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className={cx(
            'h-full w-full object-cover transition-opacity duration-slow ease-nexusOut motion-reduce:transition-none',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-ink-faint">
          {card.title.slice(0, 2)}
        </div>
      )}
    </div>
  );
}

export { findFact };
