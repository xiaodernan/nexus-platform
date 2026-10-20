import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Container, EmptyState, ErrorState, Icon } from '@nexus/ui';
import type { IconName } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import type { ConsoleRead, Freshness } from '@/lib/console-shared';
import { LocaleDemoBadge } from '../locale-badges';

/**
 * Shared chrome for the operator consoles (§23, §27, §47, §68). Deliberately no `'use client'`:
 * these are render-only pieces a Server Component may compose (calling a function out of a
 * client module from the server is the boundary bug; rendering a component is the normal path).
 *
 * The rule these parts enforce: a console figure is never bare — `SourceStamp` pins the endpoint,
 * the payload's own timestamp and the freshness bucket to it, and `ReadFailure` keeps a failed
 * read visible instead of letting an empty grid pretend the merchant has no data (§105, §155).
 */

export function ConsolePageHeader({
  title,
  intro,
  locale,
  badges,
}: {
  title: string;
  intro: string;
  locale: string;
  badges?: ReactNode;
}) {
  const dict = getDict(locale);
  return (
    <header className="flex flex-col gap-3 border-b border-line pb-6">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-accent">
          <Icon name="arrowLeft" size={13} />
          {dict.console.backToSite}
        </Link>
        {badges}
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-strong sm:text-3xl">{title}</h1>
      <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">{intro}</p>
    </header>
  );
}

/** The demo-mode strip every console page opens with — the §155 notice, worded for operators. */
export function ConsoleDemoBanner({ locale }: { locale: string }) {
  const dict = getDict(locale);
  return (
    <p className="flex items-start gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-ink-muted">
      <LocaleDemoBadge locale={locale} className="mt-px shrink-0" />
      <span>{dict.console.demoBanner}</span>
    </p>
  );
}

/**
 * The honest gate state: no login page exists, so live mode must not pretend there is a session.
 * Renders instead of redirecting so reviewers can still see the surface.
 */
export function SignInRequired({ locale }: { locale: string }) {
  const dict = getDict(locale);
  return (
    <EmptyState
      icon="lock"
      title={dict.console.signInRequiredTitle}
      description={dict.console.signInRequiredText}
      className="mt-8"
    />
  );
}

/**
 * Provenance line for one read: the endpoint (or fixture label) the payload names, the timestamp
 * the payload itself carried, and the freshness bucket derived from it. Never defaults to "fresh":
 * an absent timestamp renders `unknown` (console-shared.freshnessOf).
 */
export function SourceStamp({
  read,
  locale,
  className,
}: {
  read: Pick<ConsoleRead<unknown>, 'source' | 'asOf' | 'freshness' | 'demo' | 'origin'>;
  locale: string;
  className?: string;
}) {
  const dict = getDict(locale);
  const stamp = formatDateTime(read.asOf, dict.locale);
  return (
    <span
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs text-ink-faint ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1">
        <Icon name="link" size={11} />
        {read.source}
      </span>
      <span>
        · {read.asOf ? `${dict.console.provenance.computedAt} ${stamp ?? read.asOf}` : dict.console.provenance.updated}
      </span>
      <FreshnessBadge freshness={read.freshness} locale={locale} />
      {read.demo ? <LocaleDemoBadge locale={locale} /> : null}
    </span>
  );
}

const FRESHNESS_TONE: Record<Freshness, 'positive' | 'neutral' | 'warning'> = {
  fresh: 'positive',
  recent: 'neutral',
  stale: 'warning',
  unknown: 'warning',
};

export function FreshnessBadge({ freshness, locale }: { freshness: Freshness; locale: string }) {
  const dict = getDict(locale);
  return (
    <Badge tone={FRESHNESS_TONE[freshness]} size="sm">
      {dict.console.freshness[freshness]}
    </Badge>
  );
}

/** A failed read rendered as itself: the §1 error code and the endpoint that failed. §105. */
export function ReadFailure({
  read,
  locale,
  title,
}: {
  read: Pick<ConsoleRead<unknown>, 'source' | 'errorCode' | 'requestId'>;
  locale: string;
  title: string;
}) {
  const dict = getDict(locale);
  return (
    <ErrorState
      tone="warning"
      title={title}
      description={dict.console.read.failed(read.source, read.errorCode ?? 'upstream_unreachable')}
      requestId={read.requestId}
      className="my-4"
    />
  );
}

/** Section shell in the style of the consumer profile panels. */
export function ConsoleSection({
  id,
  title,
  note,
  icon,
  action,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="mt-8 border-t border-line pt-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink-strong sm:text-lg">
            {icon ? <Icon name={icon} size={17} className="text-ink-faint" /> : null}
            {title}
          </h2>
          {note ? <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">{note}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Big console figure cell: value + label + its own provenance line. */
export function MetricCell({
  label,
  value,
  note,
  read,
  locale,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  read: Pick<ConsoleRead<unknown>, 'source' | 'asOf' | 'freshness' | 'demo' | 'origin'>;
  locale: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-4">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="text-2xl font-semibold tabular-nums tracking-tight text-ink-strong">{value}</span>
      {note}
      <SourceStamp read={read} locale={locale} />
    </div>
  );
}

export function ConsoleContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Container size="wide" className={`flex flex-col gap-6 py-8 sm:py-10 ${className ?? ''}`}>
      {children}
    </Container>
  );
}
