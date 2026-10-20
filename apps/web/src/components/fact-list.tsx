'use client';

/**
 * The provenance panel (§19, §35): the list behind every "why should I believe this?" affordance.
 *
 * It renders the facts a page was built from, attribute by attribute, with the source, the
 * confidence and the observed time attached to each one. A fact below the omit threshold is still
 * listed — hiding it would be worse than stating that it is not strong enough to rank on — but its
 * value is not presented as a number the visitor should act on.
 */

import { Badge, FactSourceChip, Icon, isStale, isUncertain, cx } from '@nexus/ui';
import type { Fact } from '@nexus/ui/trust/types';
import { formatMoney, hoursFactText } from '@/lib/format';
import { getDict, trustLabels } from '@/lib/i18n';

/** A `Fact.value` is `unknown` on the wire; render the shapes the contract actually produces. */
function factText(fact: Fact, locale: string): string {
  const value = fact.value;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、');
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.zones)) return hoursFactText(value, locale) ?? '—';
  if (typeof record.amount === 'string' || typeof record.amount === 'number') {
    return (
      formatMoney({ amount: String(record.amount), currency: String(record.currency ?? 'HKD') }, locale) ?? '—'
    );
  }
  if (typeof record.value === 'number') {
    return typeof record.count === 'number' ? `${record.value.toFixed(1)} (${record.count})` : String(record.value);
  }
  if (typeof record.meters === 'number') return `${record.meters} m`;
  if (typeof record.text === 'string') return record.text;
  return JSON.stringify(value).slice(0, 120);
}

export function FactList({
  facts,
  locale,
  emptyLabel,
  className,
}: {
  facts: Fact[] | null | undefined;
  locale: string;
  emptyLabel?: string;
  className?: string;
}) {
  const dict = getDict(locale);
  const labels = trustLabels(locale);
  if (!facts?.length) {
    return (
      <p className={cx('flex items-center gap-1.5 text-xs text-ink-faint', className)}>
        <Icon name="warning" size={13} />
        {emptyLabel ?? dict.facts.empty}
      </p>
    );
  }

  return (
    <ul className={cx('flex flex-col divide-y divide-line', className)}>
      {facts.map((fact) => (
        <li key={fact.fact_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
          <span className="min-w-[7rem] text-xs font-medium text-ink-strong">
            {dict.facts.attributes[fact.attribute] ?? fact.attribute}
          </span>
          <span className="min-w-0 flex-1 break-words text-xs text-ink-muted">{factText(fact, dict.locale)}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {isStale(fact) ? (
              <Badge tone="warning" size="sm">
                {labels.staleValue}
              </Badge>
            ) : null}
            {isUncertain(fact) ? (
              <Badge tone="neutral" size="sm">
                {labels.uncertain}
              </Badge>
            ) : null}
            <FactSourceChip fact={fact} labels={labels} />
          </span>
        </li>
      ))}
    </ul>
  );
}
