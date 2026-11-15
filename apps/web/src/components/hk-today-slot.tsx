'use client';

/**
 * D1178 — the client island for the front-page “今日章節” spotlight. Deterministic, single-date
 * computed on the server; this component just renders the card. Zero network, zero state,
 * deterministic — same HK date, same chapter.
 */

import Link from 'next/link';
import { Icon } from '@nexus/ui';

import type { HkTodaySlot } from '@/lib/today-slot';
import type { HkTodaySlotCopy } from './hk-today-slot.copy';

export function HkTodaySlotCard({ slot, copy }: { slot: HkTodaySlot; copy: HkTodaySlotCopy }) {
  return (
    <Link
      href={slot.href}
      className="group relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-accent-line bg-accent-soft p-6 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:gap-6"
      aria-label={`${copy.eyebrow} · ${slot.label}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full"
        style={{ background: 'var(--nexus-ai-gradient)', opacity: 0.22, filter: 'blur(36px)' }}
      />
      <div className="relative flex flex-col gap-2">
        <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
          <Icon name="star" size={12} className="shrink-0" />
          {copy.eyebrow}
        </span>
        <h3 className="max-w-[46ch] text-balance text-xl font-semibold leading-snug tracking-tight text-ink-strong sm:text-2xl">
          {slot.label}
        </h3>
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          <span className="font-medium text-ink-faint">{slot.roman}</span>{' '}
          <span>{copy.hint}</span>
        </p>
      </div>
      <span className="relative inline-flex shrink-0 items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-ink transition-colors group-hover:bg-accent-hover">
        {copy.cta}
        <Icon name="arrowRight" size={14} className="transition-transform duration-200 group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
