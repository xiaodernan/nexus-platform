'use client';

/**
 * The card surfaces. Both exist for one reason: `EntityCardView` needs a `TrustLabels` object,
 * which contains functions and therefore cannot cross the server → client prop boundary. So the
 * server passes a `locale` string and the labels are built here, on the client side, against the
 * same dictionary the server used. The trust rules themselves live in `@nexus/ui` — this file
 * adds no behaviour beyond layout and selection.
 */

import Link from 'next/link';
import { Button, CompareTable, EntityCardView, EntityRail, Icon, cardKeys, cx } from '@nexus/ui';
import type { CompareResult, EntityCard as EntityCardModel } from '@nexus/ui/trust/types';
import { getDict, trustLabels } from '@/lib/i18n';

export interface CompareSelection {
  selected: string[];
  onToggle: (card: EntityCardModel) => void;
}

export function CardGrid({
  cards,
  locale,
  compare,
  rankOffset = 0,
  className,
}: {
  cards: EntityCardModel[];
  locale: string;
  compare?: CompareSelection;
  rankOffset?: number;
  className?: string;
}) {
  const labels = trustLabels(locale);
  const dict = getDict(locale);
  if (cards.length === 0) return null;
  const keys = cardKeys(cards);
  return (
    <ul className={cx('grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {cards.map((card, index) => (
        <li key={keys[index]} className="flex">
          <EntityCardView
            card={card}
            labels={labels}
            variant="grid"
            rank={index + 1 + rankOffset}
            showAvailability
            compareSelected={compare?.selected.includes(card.id) ?? false}
            compareLabel={dict.search.compareLabel}
            compareDeselectLabel={dict.search.compareClear}
            onToggleCompare={compare?.onToggle}
            className="w-full"
          />
        </li>
      ))}
    </ul>
  );
}

export function CardRail({
  title,
  description,
  cards,
  locale,
  id,
  action,
}: {
  title: string;
  description?: string;
  cards: EntityCardModel[];
  locale: string;
  id?: string;
  action?: React.ReactNode;
}) {
  const labels = trustLabels(locale);
  if (cards.length === 0) return null;
  return <EntityRail title={title} description={description} cards={cards} labels={labels} id={id} action={action} />;
}

/** Sticky compare tray: the selected cards plus the fact-backed comparison table (§37). */
export function CompareTray({
  cards,
  result,
  locale,
  onClear,
  onRemove,
}: {
  cards: EntityCardModel[];
  result: CompareResult | null;
  locale: string;
  onClear: () => void;
  onRemove: (card: EntityCardModel) => void;
}) {
  const labels = trustLabels(locale);
  const dict = getDict(locale);
  if (cards.length === 0) return null;
  const keys = cardKeys(cards);
  return (
    <section aria-label={dict.search.compareTitle(cards.length)} className="mt-8 flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-xs sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-strong">{dict.search.compareTitle(cards.length)}</h2>
        <Button variant="ghost" size="sm" onClick={onClear} leadingIcon={<Icon name="close" size={14} />}>
          {dict.search.compareClear}
        </Button>
      </header>
      {result ? (
        <CompareTable result={result} cards={cards} labels={labels} className="border-0 shadow-none" />
      ) : (
        <p className="text-sm text-ink-muted">{dict.states.loading}</p>
      )}
      <ul className="flex flex-wrap gap-2">
        {cards.map((card, index) => (
          <li key={keys[index]}>
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-xs text-ink-muted">
              <Link href={card.card_type === 'merchant' ? `/m/${card.slug}` : `/o/${card.slug}`} className="hover:text-accent">
                {card.title}
              </Link>
              <button
                type="button"
                onClick={() => onRemove(card)}
                className="rounded-full p-0.5 hover:bg-surface hover:text-ink-strong"
                aria-label={dict.search.compareRemoveItem(card.title)}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
