import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';

import { formatNumber } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { adminAiCostsRead, adminCountersRead, adminSearchAnalyticsRead, adminSystemHealthRead } from '@/lib/console-admin';
import { ConsoleSection, MetricCell, ReadFailure, SourceStamp } from '@/components/console/console-parts';
import { AdminChrome, AdminDenied, adminSession } from '@/components/console/admin-shell';

/**
 * `/admin` — the operator overview (§68). Each block is an independent read with its own fate, so a
 * single failing endpoint degrades one section instead of blanking the page. The counters are the
 * platform's own `total_estimate`, never `items.length`, and a missing estimate renders `—`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.adminConsole.overviewTitle,
    description: dict.console.adminConsole.overviewIntro,
    alternates: { canonical: '/admin' },
    robots: { index: false, follow: false },
  };
}

export default async function AdminOverviewPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const copy = dict.console.adminConsole;

  const access = await adminSession();
  if (!access.granted) return <AdminDenied access={access} locale={locale} />;

  const [counters, costs, search, health] = await Promise.all([
    adminCountersRead(),
    adminAiCostsRead('agent'),
    adminSearchAnalyticsRead(),
    adminSystemHealthRead(),
  ]);

  const counterValue = (value: number | null): string => (value === null ? '—' : formatNumber(value, dict.locale));
  const topCost = (costs.data ?? []).slice(0, 5);

  return (
    <AdminChrome
      title={copy.overviewTitle}
      intro={copy.overviewIntro}
      section={dict.console.nav.overview}
      active="/admin"
      locale={locale}
      access={access}
    >
      <ConsoleSection id="counters" title={dict.console.nav.overview} icon="grid">
        {counters.status === 'failed' ? (
          <ReadFailure read={counters} locale={locale} title={dict.merchant.degradedTitle} />
        ) : counters.data ? (
          <>
            {counters.data.failures.length > 0 ? (
              <p className="mb-3 flex items-start gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
                <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                {copy.counters.degraded(counters.data.failures.length)}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <MetricCell label={copy.counters.users} value={counterValue(counters.data.users)} read={counters} locale={locale} />
              <MetricCell label={copy.counters.merchants} value={counterValue(counters.data.merchants)} read={counters} locale={locale} />
              <MetricCell label={copy.counters.orders} value={counterValue(counters.data.orders)} read={counters} locale={locale} />
              <MetricCell label={copy.counters.reservations} value={counterValue(counters.data.reservations)} read={counters} locale={locale} />
              <MetricCell label={copy.counters.suspended} value={counterValue(counters.data.suspendedMerchants)} read={counters} locale={locale} />
              <MetricCell
                label={copy.counters.openCases}
                value={counters.data.moderation === null ? '—' : String(counters.data.moderation.open)}
                read={counters}
                locale={locale}
              />
              <MetricCell
                label={copy.counters.resolvable}
                value={counters.data.moderation === null ? '—' : String(counters.data.moderation.resolvable)}
                read={counters}
                locale={locale}
              />
            </div>
            {counters.data.failures.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {counters.data.failures.map((failure) => (
                  <li key={failure.source} className="font-mono text-2xs text-ink-faint">
                    {failure.source} → {failure.errorCode}
                  </li>
                ))}
              </ul>
            ) : null}
            <SourceStamp read={counters} locale={locale} className="mt-2" />
          </>
        ) : null}
      </ConsoleSection>

      <ConsoleSection
        id="moderation"
        title={copy.moderationTitle}
        icon="shield"
        action={
          <Link href="/admin/moderation" className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink-strong hover:border-accent hover:text-accent">
            <Icon name="arrowRight" size={13} />
            {dict.console.nav.moderation}
          </Link>
        }
      >
        <p className="text-xs text-ink-muted">{copy.moderationIntro}</p>
      </ConsoleSection>

      <ConsoleSection
        id="ai"
        title={copy.ai.costsTitle}
        note={copy.ai.costsIntro}
        icon="ai"
        action={
          <Link href="/admin/ai" className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink-strong hover:border-accent hover:text-accent">
            <Icon name="arrowRight" size={13} />
            {dict.console.nav.ai}
          </Link>
        }
      >
        {costs.status === 'failed' ? (
          <ReadFailure read={costs} locale={locale} title={dict.merchant.degradedTitle} />
        ) : topCost.length === 0 ? (
          <p className="text-sm text-ink-muted">{copy.ai.costsEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {topCost.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="min-w-[10rem] font-mono text-ink-strong">{row.key}</span>
                <span className="text-ink-muted">{copy.ai.costColumns.runs}: {row.runs ?? '—'}</span>
                <span className="text-ink-muted">{copy.ai.costColumns.cost}: {row.cost_usd === null ? '—' : `$${row.cost_usd.toFixed(4)}`}</span>
                <Badge tone="neutral" size="sm">{dict.console.common.derived}</Badge>
              </li>
            ))}
          </ul>
        )}
      </ConsoleSection>

      <ConsoleSection
        id="search"
        title={copy.searchTitle}
        note={copy.searchIntro}
        icon="search"
        action={
          <Link href="/admin/search" className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink-strong hover:border-accent hover:text-accent">
            <Icon name="arrowRight" size={13} />
            {dict.console.nav.search}
          </Link>
        }
      >
        {search.status === 'failed' ? (
          <ReadFailure read={search} locale={locale} title={dict.merchant.degradedTitle} />
        ) : search.data ? (
          <p className="text-xs text-ink-muted">
            {copy.search.totals.searches}: {search.data.totals.searches ?? '—'} · {copy.search.totals.sessions}: {search.data.totals.sessions ?? '—'} ·{' '}
            {copy.search.totals.fulfilled}: {search.data.totals.fulfilled_intents ?? '—'}
          </p>
        ) : null}
      </ConsoleSection>

      <ConsoleSection
        id="system"
        title={copy.systemTitle}
        note={copy.systemIntro}
        icon="shield"
        action={
          <Link href="/admin/system" className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink-strong hover:border-accent hover:text-accent">
            <Icon name="arrowRight" size={13} />
            {dict.console.nav.system}
          </Link>
        }
      >
        {health.status === 'failed' ? (
          <ReadFailure read={health} locale={locale} title={dict.merchant.degradedTitle} />
        ) : health.data ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={health.data.overall === 'ok' ? 'positive' : health.data.overall === 'down' ? 'danger' : 'warning'} size="sm">
              {copy.system.overall[health.data.overall]}
            </Badge>
            {health.data.dependencies.map((dependency) => (
              <Badge
                key={dependency.name}
                tone={dependency.state === 'ok' ? 'positive' : dependency.state === 'down' ? 'danger' : 'neutral'}
                size="sm"
              >
                {dependency.name}: {dependency.raw_status ?? copy.system.overall[dependency.state]}
              </Badge>
            ))}
          </div>
        ) : null}
      </ConsoleSection>
    </AdminChrome>
  );
}

export const dynamic = 'force-dynamic';
