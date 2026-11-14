'use client';

/**
 * 今日卡 — composes the /daily page into a shareable text card and copies it to the clipboard.
 *
 * The card is assembled client-side from the same deterministic picks the page renders (the cyrb53
 * hash of the HK date — identical inputs for every reader), so the card you share is exactly the
 * one you see. No network, no share dialog, no telemetry: one button, one clipboard write, one
 * honest label swap. If `navigator.clipboard` is unavailable, the button reports that honestly
 * instead of pretending success.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { almanacIndex, hkDateKey } from '@/lib/almanac';
import type { HkDailyArcCard } from './hk-daily-arc-pick';
import type { HkCantoneseEntry } from './hk-cantonese-daily';

export interface HkDailyShareDict {
  eyebrow: string;
  title: string;
  note: string;
  cta: string;
  copied: string;
  unavailable: string;
  format: string;
}

export function HkDailyShare({
  almanacEntries,
  phraseEntries,
  cards,
  dict,
}: {
  almanacEntries: readonly string[];
  phraseEntries: readonly HkCantoneseEntry[];
  cards: readonly HkDailyArcCard[];
  dict: HkDailyShareDict;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'unavailable'>('idle');
  const [dateKey, setDateKey] = useState<string | null>(null);

  useEffect(() => {
    setDateKey(hkDateKey());
  }, []);

  const compose = () => {
    const key = dateKey ?? hkDateKey();
    const almanac = almanacEntries[almanacIndex(key, almanacEntries.length)] ?? '';
    const phrase = phraseEntries[almanacIndex(key, phraseEntries.length)] ?? phraseEntries[0];
    const phraseText = phrase ? phrase.phrase : '';
    const phraseGloss = phrase ? phrase.gloss : '';
    const card = cards[almanacIndex(key, cards.length)] ?? cards[0];
    return dict.format
      .replaceAll('{date}', key)
      .replaceAll('{almanac}', almanac)
      .replaceAll('{phrase}', phraseText)
      .replaceAll('{gloss}', phraseGloss)
      .replaceAll('{chapter}', card ? card.label : '');
  };

  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        setStatus('unavailable');
        return;
      }
      await navigator.clipboard.writeText(compose());
      setStatus('copied');
    } catch {
      setStatus('unavailable');
    }
  };

  return (
    <section aria-label={dict.eyebrow} className="rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center gap-2">
        <Icon name="share" size={14} className="text-accent" />
        <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{dict.eyebrow}</span>
      </div>
      <h2 className="mt-4 max-w-[24ch] text-2xl font-semibold leading-snug tracking-tight text-ink-strong">{dict.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{dict.note}</p>
      <button
        type="button"
        onClick={onCopy}
        className="mt-4 inline-flex items-center gap-2 rounded-full border border-line bg-canvas px-4 py-2 text-sm font-medium text-ink-strong shadow-xs transition-colors hover:border-accent hover:text-accent"
      >
        <Icon name="share" size={16} />
        {status === 'copied' ? dict.copied : status === 'unavailable' ? dict.unavailable : dict.cta}
      </button>
    </section>
  );
}
