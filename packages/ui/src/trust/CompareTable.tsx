'use client';

import * as React from 'react';
import Link from 'next/link';
import { cx } from '../utils';
import { Icon } from '../icons/Icon';
import { DemoBadge } from './Renderers';
import { cardKeys } from './cardKeys';
import type { CompareResult, CompareRow, EntityCard } from './types';
import type { TrustLabels } from './Renderers';

/**
 * CompareTable (§37) — attribute rows × candidate columns.
 * A cell is only renderable when it carries a `fact_id`; otherwise it shows the
 * unverified marker, exactly like the card renderers. On mobile the table scrolls
 * horizontally with a sticky attribute column, because squeezing four columns of
 * CJK text into 360px is worse UX than a deliberate scroll.
 */
export function CompareTable({
  result,
  cards,
  labels,
  bestLabel,
  className,
}: {
  result: CompareResult;
  cards?: EntityCard[];
  labels: TrustLabels & {
    compareTitle: string;
    best: string;
    viewMerchant: string;
    /** Localised names for the contract's row attributes; unknown keys fall back to the key. */
    rowLabels?: Record<string, string>;
  };
  bestLabel?: (row: CompareRow, index: number) => number | null;
  className?: string;
}) {
  const columns = cards ?? result.cards ?? [];
  const ordered = columns.filter((card): card is EntityCard => Boolean(card));
  const keys = cardKeys(ordered);

  if (ordered.length === 0 || result.rows.length === 0) {
    return (
      <div className={cx('rounded-lg border border-dashed border-line-strong p-8 text-center text-sm text-ink-muted', className)}>
        {labels.unverified}
      </div>
    );
  }

  return (
    <div className={cx('overflow-x-auto rounded-lg border border-line bg-surface shadow-xs', className)}>
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption className="sr-only">{labels.compareTitle}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 w-32 bg-surface p-3 text-left align-bottom text-xs font-medium text-ink-faint">
              {labels.provenance}
            </th>
            {ordered.map((card, index) => (
              <th key={keys[index]} scope="col" className="min-w-[10.5rem] border-l border-line p-3 align-bottom">
                <span className="flex flex-col gap-1.5">
                  {card.flags?.demo ? <DemoBadge labels={labels} /> : null}
                  <Link
                    href={card.card_type === 'merchant' ? `/m/${card.slug}` : `/o/${card.slug}`}
                    className="line-clamp-2 text-left text-sm font-semibold text-ink-strong hover:text-accent"
                  >
                    {card.title}
                  </Link>
                  <span className="text-xs font-normal text-ink-muted">{card.subtitle}</span>
                  <span className="text-2xs font-normal text-ink-faint">#{index + 1}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => {
            const best = bestLabel ? bestLabel(row, rowIndex) : null;
            return (
              <tr key={row.attribute} className="border-t border-line odd:bg-surface even:bg-surface-muted/45">
                <th scope="row" className="sticky left-0 z-10 bg-surface p-3 text-left align-top text-xs font-medium text-ink-muted">
                  {labels.rowLabels?.[row.attribute] ?? row.attribute}
                </th>
                {row.cards.map((cell, cellIndex) => {
                  const factBacked = Boolean(cell.fact_id);
                  return (
                    <td
                      key={`${row.attribute}-${cellIndex}`}
                      className={cx(
                        'border-l border-line p-3 align-top',
                        best === cellIndex && 'bg-positive-soft/70',
                      )}
                    >
                      <span className="flex flex-col gap-1">
                        <span className={cx('font-medium tabular-nums text-ink-strong', !factBacked && 'font-normal text-ink-faint')}>
                          {factBacked ? (cell.display ?? formatCell(cell.value)) : labels.unverified}
                        </span>
                        {factBacked && cell.stale ? (
                          <span className="inline-flex items-center gap-1 text-2xs text-warning">
                            <Icon name="warning" size={11} />
                            {labels.staleValue}
                          </span>
                        ) : null}
                        {best === cellIndex ? (
                          <span className="inline-flex items-center gap-1 text-2xs font-semibold text-positive">
                            <Icon name="check" size={11} />
                            {labels.best}
                          </span>
                        ) : null}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.amount === 'string') return record.amount;
    if (typeof record.value === 'number') return String(record.value);
    if (typeof record.meters === 'number') return `${record.meters}m`;
    if (typeof record.text === 'string') return record.text;
  }
  return '—';
}
