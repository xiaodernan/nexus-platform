import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';

import { formatMoney, formatNumber } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { ANALYTICS_LIVE_FIELDS, analyticsFieldProvided, analyticsIsEmpty, analyticsRates } from '@/lib/console-shared';
import { merchantAnalyticsRead } from '@/lib/console-merchant';
import { ConsoleSection, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { MerchantChrome, MerchantSignInStop, merchantSession } from '@/components/console/merchant-shell';

const WINDOW_DAYS = 7;

function defaultRange(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

/**
 * `/merchant/analytics` — §56, windowed. The honesty rule this page is built around: the platform's
 * `metrics` object carries only the fields it actually measured, so a field it did not report
 * renders "—" with the reason, never a 0 (§19/§109). `analyticsFieldProvided` is the gate.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.nav.analytics,
    description: dict.console.analytics.intro,
    alternates: { canonical: '/merchant/analytics' },
    robots: { index: false, follow: false },
  };
}

export default async function MerchantAnalyticsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const session = await merchantSession(search);
  const dict = getDict(session.locale);
  const copy = dict.console.analytics;
  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const defaults = defaultRange(new Date());
  const from = typeof search.from === 'string' && search.from ? search.from : defaults.from;
  const to = typeof search.to === 'string' && search.to ? search.to : defaults.to;
  const metric = typeof search.metric === 'string' && search.metric ? search.metric : 'views';

  const read = await merchantAnalyticsRead(session.businessId, { from, to, metric });
  const data = read.data;
  const rates = data ? analyticsRates(data.totals) : null;
  const empty = data ? analyticsIsEmpty(data.totals) : false;
  const businessQuery = session.requested ? `&business=${encodeURIComponent(session.requested)}` : '';

  const metricValue = (field: string): string => {
    if (!data) return '—';
    if (!analyticsFieldProvided(data, field)) return '—';
    const raw = (data.totals as unknown as Record<string, unknown>)[field];
    if (field === 'revenue') return formatMoney(data.totals.revenue, dict.locale) ?? data.totals.revenue.amount;
    return typeof raw === 'number' ? formatNumber(raw, dict.locale) : '—';
  };

  return (
    <MerchantChrome
      title={copy.title}
      intro={copy.intro}
      section={dict.console.nav.analytics}
      active="/merchant/analytics"
      locale={session.locale}
      demo={read.origin === 'mock'}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.metric}</span>
        {ANALYTICS_LIVE_FIELDS.map((field) => (
          <Link
            key={field}
            href={`/merchant/analytics?from=${from}&to=${to}&metric=${field}${businessQuery}`}
            className={
              field === metric
                ? 'rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-xs text-accent'
                : 'rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent'
            }
          >
            {copy.metrics[field] ?? field}
          </Link>
        ))}
        <span className="ml-2 font-mono text-2xs text-ink-faint">{copy.window(from, to)}</span>
      </div>

      {read.status === 'failed' ? (
        <ReadFailure read={read} locale={session.locale} title={dict.merchant.degradedTitle} />
      ) : data ? (
        <>
          <ConsoleSection id="totals" title={copy.title} note={copy.window(data.from, data.to)} icon="trending">
            {empty ? <p className="mb-3 text-sm text-ink-muted">{copy.empty}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {ANALYTICS_LIVE_FIELDS.map((field) => {
                const provided = analyticsFieldProvided(data, field);
                return (
                  <div key={field} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-4">
                    <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.metrics[field] ?? field}</span>
                    <span className="text-2xl font-semibold tabular-nums tracking-tight text-ink-strong">{metricValue(field)}</span>
                    {!provided ? (
                      <span className="text-2xs text-warning">{copy.notProvided}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {data.provided.length > 0 ? (
              <p className="mt-2 text-2xs text-ink-faint">{copy.providedNote(data.provided.join(', '))}</p>
            ) : null}
            <SourceStamp read={read} locale={session.locale} className="mt-2" />
          </ConsoleSection>

          {rates ? (
            <ConsoleSection id="rates" title={copy.ratesTitle} icon="trending">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {(['viewToClick', 'clickToLead', 'leadToReservation', 'leadToOrder', 'repeatShare'] as const).map((key) => (
                  <div key={key} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-4">
                    <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.rates[key]}</span>
                    <span className="text-xl font-semibold tabular-nums tracking-tight text-ink-strong">
                      {rates[key] === null ? '—' : `${(rates[key] * 100).toFixed(1)}%`}
                    </span>
                    <Badge tone="neutral" size="sm">{dict.console.common.derived}</Badge>
                  </div>
                ))}
              </div>
            </ConsoleSection>
          ) : null}

          {data.event_series.length > 0 ? (
            <ConsoleSection id="series" title={copy.eventSeries} icon="list">
              <ul className="flex flex-col gap-1">
                {data.event_series.map((point) => (
                  <li key={point.date} className="flex items-center gap-3 text-xs">
                    <span className="w-24 font-mono text-2xs text-ink-muted">{point.date}</span>
                    <span className="font-mono text-2xs text-ink-strong">{formatNumber(point.events, dict.locale)}</span>
                  </li>
                ))}
              </ul>
            </ConsoleSection>
          ) : null}

          {Object.keys(data.definitions).length > 0 ? (
            <ConsoleSection id="definitions" title={copy.definitions} icon="info">
              <ul className="flex flex-col gap-1">
                {Object.entries(data.definitions).map(([key, text]) => (
                  <li key={key} className="text-2xs text-ink-muted">
                    <span className="font-mono text-ink-faint">{key}</span> — {text}
                  </li>
                ))}
              </ul>
            </ConsoleSection>
          ) : null}

          {data.source || data.note ? (
            <p className="flex items-start gap-2 text-2xs leading-relaxed text-ink-faint">
              <Icon name="info" size={12} className="mt-0.5 shrink-0" />
              {data.source ? <span>{copy.source}: {data.source}</span> : null}
              {data.note ? <span>{data.note}</span> : null}
            </p>
          ) : null}
        </>
      ) : null}
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
