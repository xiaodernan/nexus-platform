'use client';

/**
 * D1183 — the /command demo console. A password-gated view unlocked by the shared passphrase `123`.
 * The page is localStorage-only, server-rendered per request, bilingual; no login state leaves the device; the
 * data feed is synthetic and **explicit about it** — every panel carries a source note so the
 * operator never mistakes demo for production telemetry.
 *
 * The whole view is one screen:
 *   1. counters
 *   2. top searches
 *   3. content heat (impressions + saves per guide)
 *   4. retention proxy (returning readers vs new readers over the trailing 14d)
 *   5. next moves (the two recommendations the system would surface to the operator)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';
import type { RealTraceRow, RealTraceSummary } from '@/lib/real-trace';

export interface CommandConsoleCopy {
  eyebrow: string;
  title: string;
  intro: string;
  realTraceTitle: string;
  realTraceNote: string;
  realTraceCols: {
    journey: string;
    duration: string;
    outcome: string;
    landed: string;
  };
  unlocked: string;
  unlockedHint: string;
  passwordLabel: string;
  passwordHint: string;
  passwordCta: string;
  forbidden: string;
  note: string;
  sections: {
    counters: string;
    topSearches: string;
    contentHeat: string;
    retention: string;
    nextMoves: string;
  };
  counters: Array<{ label: string; value: string }>;
  topSearches: Array<{ phrase: string; count: number }>;
  contentHeat: Array<{ title: string; impressions: number; saves: number }>;
  retention: {
    returning14d: number;
    new14d: number;
    returningLabel: string;
    returningHint: string;
    newLabel: string;
    newHint: string;
    nextPushLabel: string;
    nextAction: string;
  };
  savesUnit: string;
  nextMoves: Array<{ move: string; why: string; risk: 'low' | 'medium' | 'high' }>;
  sourceStamp: string;
  backLink: string;
}

const SESSION_KEY = 'nexus.command.unlocked';
const PASSPHRASE = '123';

const readUnlocked = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
};
const setUnlocked = (value: boolean): void => {
  try {
    if (value) window.sessionStorage.setItem(SESSION_KEY, '1');
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
};

export function CommandConsoleClient({
  copy,
  traceRows = [],
  traceTotals,
}: {
  copy: CommandConsoleCopy;
  traceRows?: ReadonlyArray<RealTraceRow>;
  traceTotals?: RealTraceSummary['totals'];
}) {
  const [unlocked, setUnlockedClient] = useState(false);
  const [attempt, setAttempt] = useState('');
  const [shake, setShake] = useState(false);

  // SSR always renders the locked gate (no sessionStorage on the server); on mount, if
  // this tab had previously unlocked, swap in the dashboard without a reload.
  useEffect(() => {
    if (readUnlocked()) setUnlockedClient(true);
  }, []);

  const tryUnlock = () => {
    if (attempt.trim() === PASSPHRASE) {
      setUnlocked(true);
      setUnlockedClient(true);
      return;
    }
    setShake(true);
    window.setTimeout(() => setShake(false), 380);
  };

  const lock = () => {
    setUnlocked(false);
    setUnlockedClient(false);
    setAttempt('');
  };

  if (!unlocked) {
    return (
      <section className="relative mx-auto flex max-w-md flex-col gap-6 rounded-2xl border border-line bg-surface p-8 shadow-md">
        <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
          <Icon name="lock" size={14} />
          {copy.eyebrow}
        </span>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-ink-strong">{copy.title}</h1>
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
        <label className="flex flex-col gap-2 text-sm" htmlFor="cmd-passphrase">
          <span className="font-medium text-ink-strong">{copy.passwordLabel}</span>
          <input
            id="cmd-passphrase"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder={copy.passwordHint}
            value={attempt}
            onChange={(event) => setAttempt(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && tryUnlock()}
            className={
              'h-11 rounded-md border border-line bg-canvas px-3 text-base text-ink-strong outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/30 ' +
              (shake ? 'ring-2 ring-warning' : '')
            }
          />
        </label>
        <p role="status" aria-live="polite" className={
          'min-h-4 text-2xs font-medium text-warning transition-opacity ' + (shake ? 'opacity-100' : 'opacity-0')
        }>
          {copy.forbidden}
        </p>
        <button
          type="button"
          onClick={tryUnlock}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
        >
          {copy.passwordCta}
          <Icon name="arrowRight" size={14} />
        </button>
        <p className="text-2xs leading-relaxed text-ink-faint">{copy.note}</p>
      </section>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
            <Icon name="shield" size={12} />
            {copy.eyebrow}
          </span>
          <h1 className="text-balance text-3xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-4xl">
            {copy.title}
          </h1>
          <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Badge tone="outline" size="sm">{copy.unlocked}</Badge>
          <button
            type="button"
            onClick={lock}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent"
          >
            <Icon name="lock" size={11} />
            {copy.unlockedHint}
          </button>
        </div>
      </header>

      <section aria-labelledby="cmd-counters" className="flex flex-col gap-3">
        <h2 id="cmd-counters" className="text-2xs font-semibold uppercase tracking-wide text-accent">
          {copy.sections.counters}
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {copy.counters.map((s) => (
            <div key={s.label} className="rounded-xl border border-line bg-surface p-4">
              <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{s.label}</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold leading-none text-ink-strong">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="cmd-topsearches" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
          <h2 id="cmd-topsearches" className="text-2xs font-semibold uppercase tracking-wide text-accent">
            {copy.sections.topSearches}
          </h2>
          <ol className="flex flex-col divide-y divide-line">
            {copy.topSearches.map((s, i) => (
              <li key={s.phrase} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2">
                <span className="font-mono text-sm font-semibold text-accent">{String(i + 1).padStart(2, '0')}</span>
                <span className="min-w-0 truncate">{s.phrase}</span>
                <span className="rounded-full border border-line bg-canvas px-2 py-0.5 font-mono text-2xs text-ink-muted">{s.count}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="cmd-content" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
          <h2 id="cmd-content" className="text-2xs font-semibold uppercase tracking-wide text-accent">
            {copy.sections.contentHeat}
          </h2>
          <ol className="flex flex-col divide-y divide-line">
            {copy.contentHeat.map((c) => (
              <li key={c.title} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="min-w-0 text-sm font-medium text-ink-strong">{c.title}</span>
                <span className="shrink-0 font-mono text-2xs text-ink-muted">
                  {c.impressions.toLocaleString()} · {c.saves} {copy.savesUnit}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section aria-labelledby="cmd-retention" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
        <h2 id="cmd-retention" className="text-2xs font-semibold uppercase tracking-wide text-accent">
          {copy.sections.retention}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-line bg-canvas p-4">
            <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.retention.returningLabel}</p>
            <p className="mt-1 font-mono text-3xl font-semibold leading-none text-ink-strong">{copy.retention.returning14d}</p>
            <p className="mt-1 text-2xs text-ink-faint">{copy.retention.returningHint}</p>
          </div>
          <div className="rounded-lg border border-line bg-canvas p-4">
            <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.retention.newLabel}</p>
            <p className="mt-1 font-mono text-3xl font-semibold leading-none text-ink-strong">{copy.retention.new14d}</p>
            <p className="mt-1 text-2xs text-ink-faint">{copy.retention.newHint}</p>
          </div>
          <div className="col-span-2 rounded-lg border border-accent-line bg-accent-soft p-4 sm:col-span-1">
            <p className="text-2xs font-medium uppercase tracking-wide text-accent">{copy.retention.nextPushLabel}</p>
            <p className="mt-1 text-sm leading-snug text-ink-strong">{copy.retention.nextAction}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="cmd-moves" className="flex flex-col gap-3">
        <h2 id="cmd-moves" className="text-2xs font-semibold uppercase tracking-wide text-accent">
          {copy.sections.nextMoves}
        </h2>
        <ol className="flex flex-col gap-2">
          {copy.nextMoves.map((m, i) => (
            <li key={i} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-semibold leading-snug text-ink-strong">{m.move}</p>
                  <p className="text-2xs leading-relaxed text-ink-muted">{m.why}</p>
                </div>
                <span
                  className={
                    'shrink-0 rounded-full border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide ' +
                    (m.risk === 'low'
                      ? 'border-accent/40 bg-accent-soft text-accent'
                      : m.risk === 'medium'
                        ? 'border-warning/60 bg-warning-soft text-warning'
                        : 'border-danger/60 bg-danger-soft text-danger')
                  }
                >
                  {m.risk}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="cmd-realtrace" className="flex flex-col gap-3 rounded-2xl border border-accent-line bg-canvas p-5">
        <h2 id="cmd-realtrace" className="text-2xs font-semibold uppercase tracking-wide text-accent">
          {copy.realTraceTitle}
        </h2>
        <p className="max-w-prose text-2xs leading-relaxed text-ink-muted">{copy.realTraceNote}</p>
        {traceTotals && (
          <p className="font-mono text-2xs text-ink-faint">
            {traceTotals.journeys} journeys · {traceTotals.completed} completed · {traceTotals.crashed} crashed · {traceTotals.totalMs} ms
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="mt-1 w-full text-left text-2xs">
            <thead className="uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-3 py-2">{copy.realTraceCols.journey}</th>
                <th className="px-3 py-2">{copy.realTraceCols.duration}</th>
                <th className="px-3 py-2">{copy.realTraceCols.outcome}</th>
                <th className="px-3 py-2">{copy.realTraceCols.landed}</th>
              </tr>
            </thead>
            <tbody>
              {traceRows.map((row) => (
                <tr key={row.idx} className="border-t border-line">
                  <td className="px-3 py-2">{row.idx}. {row.name}</td>
                  <td className="px-3 py-2 font-mono">{row.duration_ms}</td>
                  <td className="px-3 py-2 font-mono">{row.outcome}</td>
                  <td className="px-3 py-2 font-mono">{row.end_url || '/'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-2xs text-ink-faint">
        <span>{copy.sourceStamp}</span>
        <Link href="/" className="inline-flex items-center gap-1 text-accent transition-colors hover:underline">
          <Icon name="arrowLeft" size={11} />
          {copy.backLink}
        </Link>
      </footer>
    </div>
  );
}
