import type { Metadata } from 'next';
import { Badge } from '@nexus/ui';

import { formatNumber } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { searchFulfilmentShare } from '@/lib/console-shared';
import { adminSearchAnalyticsRead } from '@/lib/console-admin';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { ConsoleTable } from '@/components/console/console-table';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/**
 * `/admin/search` — §9. Deliberately descriptive: the platform reports searches, sessions,
 * fulfilled intents and active days, and there is no search-quality metric in the schema. The only
 * derived figure is the fulfilment share, and it is labelled as derived (§19/§109).
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.searchTitle,
    description: dict.console.adminConsole.searchIntro,
    alternates: { canonical: '/admin/search' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminSearchPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.search;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const read = await adminSearchAnalyticsRead();
  const data = read.data;
  const share = data ? searchFulfilmentShare(data.totals.searches, data.totals.fulfilled_intents) : null;

  return (
    <AdminChrome
      title={dict.console.adminConsole.searchTitle}
      intro={dict.console.adminConsole.searchIntro}
      section={dict.console.nav.search}
      active="/admin/search"
      locale={locale}
      access={access}
    >
      {read.status === 'failed' ? (
        <ReadFailure read={read} locale={locale} title={dict.merchant.degradedTitle} />
      ) : data ? (
        <>
          <ConsoleSection
            id="totals"
            title={copy.totalsTitle}
            note={data.window_days === null ? undefined : copy.window(String(data.window_days))}
            icon="search"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <MetricCell label={copy.totals.searches} value={data.totals.searches === null ? '—' : formatNumber(data.totals.searches, dict.locale)} read={read} locale={locale} />
              <MetricCell label={copy.totals.sessions} value={data.totals.sessions === null ? '—' : formatNumber(data.totals.sessions, dict.locale)} read={read} locale={locale} />
              <MetricCell label={copy.totals.fulfilled} value={data.totals.fulfilled_intents === null ? '—' : formatNumber(data.totals.fulfilled_intents, dict.locale)} read={read} locale={locale} />
              <MetricCell label={copy.totals.activeDays} value={data.totals.active_days === null ? '—' : String(data.totals.active_days)} read={read} locale={locale} />
              <MetricCell
                label={copy.fulfilmentShare}
                value={share === null ? '—' : `${(share * 100).toFixed(1)}%`}
                note={<Badge tone="neutral" size="sm">{dict.console.common.derived}</Badge>}
                read={read}
                locale={locale}
              />
            </div>
            <p className="mt-2 max-w-3xl text-2xs text-ink-faint">{copy.fulfilmentNote}</p>
            <p className="mt-1 max-w-3xl text-2xs text-ink-faint">{copy.noQualityScore}</p>
            <SourceStamp read={read} locale={locale} className="mt-2" />
          </ConsoleSection>

          <ConsoleSection id="daily" title={copy.dailyTitle} icon="list">
            <ConsoleTable
              caption={copy.dailyTitle}
              head={[copy.dailyColumns.day, copy.dailyColumns.sessions, copy.dailyColumns.searches, copy.dailyColumns.fulfilled]}
              rows={data.daily.map((row) => [
                <span key="d" className="font-mono text-2xs">{row.day}</span>,
                <span key="s" className="font-mono text-2xs">{row.sessions ?? '—'}</span>,
                <span key="q" className="font-mono text-2xs">{row.searches ?? '—'}</span>,
                <span key="f" className="font-mono text-2xs">{row.fulfilled_intents ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.dailyEmpty}</p>}
            />
          </ConsoleSection>

          <ConsoleSection id="events" title={copy.eventsTitle} icon="filter">
            <ConsoleTable
              caption={copy.eventsTitle}
              head={[copy.eventColumns.name, copy.eventColumns.events, copy.eventColumns.sessions]}
              rows={data.by_event.map((row) => [
                <span key="n" className="font-mono text-2xs text-ink-strong">{row.name}</span>,
                <span key="e" className="font-mono text-2xs">{row.events ?? '—'}</span>,
                <span key="s" className="font-mono text-2xs">{row.sessions ?? '—'}</span>,
              ])}
              empty={<p className="text-sm text-ink-muted">{copy.eventsEmpty}</p>}
            />
            {data.source || data.note ? (
              <p className="mt-2 max-w-3xl text-2xs leading-relaxed text-ink-faint">
                {data.source ? <span className="font-mono">{data.source}</span> : null}
                {data.note ? <span> — {data.note}</span> : null}
              </p>
            ) : null}
          </ConsoleSection>
        </>
      ) : null}
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
