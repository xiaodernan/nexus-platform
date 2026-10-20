import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';

import { merchantBySlug } from '@/lib/data';
import { formatMoney, formatNumber, formatRelativeDay } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { funnelRates } from '@/lib/console-shared';
import { merchantInboxRead, merchantOverviewRead } from '@/lib/console-merchant';
import { LocaleDemoBadge } from '@/components/locale-badges';
import {
  ConsoleSection,
  MetricCell,
  ReadFailure,
  SourceStamp,
} from '@/components/console/console-parts';
import {
  MerchantBusinessPicker,
  MerchantChrome,
  MerchantSignInStop,
  merchantSession,
} from '@/components/console/merchant-shell';

/**
 * `/merchant` — the business overview half of §23. Three reads, three independent fates: overview
 * (`GET /api/v1/merchant/businesses/{id}/overview`, platform-backed by `v_merchant_funnel`), inbox
 * (`GET /api/v1/merchant/conversations`) and the documented public merchant read via `lib/data`. A
 * read that fails renders `ReadFailure` with its §1 error code — never a fixture backfill, never a
 * silent zero (data.ts header, D6).
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.console.merchantTitle,
    description: dict.console.merchantIntro,
    alternates: { canonical: '/merchant' },
    // Operator surfaces are never for crawlers (§27 discipline: publishing is a human act).
    robots: { index: false, follow: false },
  };
}

export default async function MerchantConsolePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await merchantSession(await props.searchParams);
  const dict = getDict(session.locale);

  if (session.blocked) return <MerchantSignInStop locale={session.locale} />;

  const businessId = session.businessId;
  const [overview, inbox] = await Promise.all([merchantOverviewRead(businessId), merchantInboxRead(businessId)]);
  const page = overview.data ? await merchantBySlug(overview.data.slug) : null;
  const detail = page?.data?.detail ?? null;

  return (
    <MerchantChrome
      title={dict.console.merchantTitle}
      intro={dict.console.merchantIntro}
      section={dict.console.sections.overview}
      active="/merchant"
      locale={session.locale}
      demo={overview.origin === 'mock'}
    >
      {overview.origin === 'mock' ? (
        <MerchantBusinessPicker locale={session.locale} activeId={businessId} />
      ) : null}

      {overview.status === 'failed' ? (
        <ReadFailure read={overview} locale={session.locale} title={dict.merchant.degradedTitle} />
      ) : null}

      {overview.data ? (
        <>
          <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              {overview.data.data_origin === 'demo' ? <LocaleDemoBadge locale={session.locale} /> : null}
              <Badge tone={overview.data.status === 'published' ? 'positive' : 'warning'} size="sm">
                {dict.console.funnel.statusLabel}: {overview.data.status}
              </Badge>
              <Badge tone="neutral" size="sm">
                {dict.console.funnel.planLabel}: {overview.data.plan}
              </Badge>
              {overview.data.category_primary ? (
                <Badge tone="outline" size="sm">
                  {dict.console.funnel.categoryLabel}: {overview.data.category_primary}
                </Badge>
              ) : null}
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-ink-strong">{overview.data.display_name}</h2>
            <p className="text-xs text-ink-muted">
              {overview.data.slug ? `/m/${overview.data.slug}` : ''} · {dict.console.funnel.zeroNote}
            </p>
            <SourceStamp read={overview} locale={session.locale} />
          </section>

          <ConsoleSection id="funnel" title={dict.console.sections.funnel} note={dict.console.sections.funnelNote} icon="trending">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <MetricCell label={dict.console.funnel.views} value={formatNumber(overview.data.funnel.views, dict.locale)} read={overview} locale={session.locale} />
              <MetricCell label={dict.console.funnel.clicks} value={formatNumber(overview.data.funnel.clicks, dict.locale)} read={overview} locale={session.locale} />
              <MetricCell label={dict.console.funnel.actions} value={formatNumber(overview.data.funnel.actions, dict.locale)} read={overview} locale={session.locale} />
              <MetricCell label={dict.console.funnel.reservations} value={formatNumber(overview.data.funnel.reservations, dict.locale)} read={overview} locale={session.locale} />
              <MetricCell label={dict.console.funnel.orders} value={formatNumber(overview.data.funnel.orders, dict.locale)} read={overview} locale={session.locale} />
              <MetricCell
                label={dict.console.funnel.revenue}
                value={formatMoney(overview.data.funnel.revenue, dict.locale) ?? `HKD ${overview.data.funnel.revenue.amount}`}
                note={<p className="text-2xs text-ink-faint">{dict.console.funnel.definition(overview.data.revenue_definition)}</p>}
                read={overview}
                locale={session.locale}
              />
              {(() => {
                const rates = funnelRates(overview.data.funnel);
                return (
                  <>
                    <MetricCell
                      label={dict.console.funnel.clickThrough}
                      value={rates.clickThrough === null ? '—' : `${(rates.clickThrough * 100).toFixed(1)}%`}
                      note={<Badge tone="neutral" size="sm">{dict.console.funnel.derived}</Badge>}
                      read={overview}
                      locale={session.locale}
                    />
                    <MetricCell
                      label={dict.console.funnel.actionPerClick}
                      value={rates.actionPerClick === null ? '—' : `${(rates.actionPerClick * 100).toFixed(1)}%`}
                      note={<Badge tone="neutral" size="sm">{dict.console.funnel.derived}</Badge>}
                      read={overview}
                      locale={session.locale}
                    />
                  </>
                );
              })()}
            </div>
          </ConsoleSection>

          <ConsoleSection
            id="conversations"
            title={dict.console.sections.conversations}
            icon="mail"
            action={
              <Link
                href={`/merchant/conversations${session.requested ? `?business=${encodeURIComponent(session.requested)}` : ''}`}
                className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink-strong hover:border-accent hover:text-accent"
              >
                <Icon name="arrowRight" size={13} />
                {dict.console.nav.conversations}
              </Link>
            }
          >
            {inbox.status === 'failed' ? (
              <ReadFailure read={inbox} locale={session.locale} title={dict.merchant.degradedTitle} />
            ) : inbox.data && inbox.data.length > 0 ? (
              <>
                <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
                  {inbox.data.slice(0, 5).map((thread) => (
                    <li key={thread.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/merchant/conversations/${encodeURIComponent(thread.id)}`}
                          className="truncate text-sm font-medium text-ink-strong hover:text-accent"
                        >
                          {thread.subject ?? dict.console.conversations.subjectFallback}
                        </Link>
                        <p className="text-2xs text-ink-faint">
                          {thread.consumer_name ?? '—'} · {dict.console.conversations.lastActivity}:{' '}
                          {thread.last_message_at ? formatRelativeDay(thread.last_message_at, dict.locale) : '—'}
                        </p>
                      </div>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone="neutral" size="sm">
                          {dict.console.conversations.modeLabel}: {dict.console.conversations.modes[thread.mode] ?? thread.mode}
                        </Badge>
                        <Badge tone={thread.status === 'handoff' ? 'danger' : thread.status === 'open' ? 'accent' : 'neutral'} size="sm">
                          {dict.console.conversations.statuses[thread.status] ?? thread.status}
                        </Badge>
                        {thread.handoffs.some((handoff) => handoff.status === 'open') ? (
                          <Badge tone="warning" size="sm" icon="bell">
                            {dict.console.conversations.handoffOpen}
                          </Badge>
                        ) : null}
                        {thread.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                <SourceStamp read={inbox} locale={session.locale} className="mt-2" />
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-ink-muted">{dict.console.conversations.empty}</p>
                <SourceStamp read={inbox} locale={session.locale} />
              </div>
            )}
          </ConsoleSection>

          <ConsoleSection
            id="listings"
            title={dict.console.sections.listings}
            icon="store"
            action={
              <Link
                href={`/merchant/offerings${session.requested ? `?business=${encodeURIComponent(session.requested)}` : ''}`}
                className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent-line/60"
              >
                <Icon name="store" size={13} />
                {dict.console.nav.offerings}
              </Link>
            }
          >
            {page && page.degraded ? (
              <p className="mb-3 flex items-center gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-warning">
                <Icon name="warning" size={14} className="shrink-0" />
                {dict.merchant.degradedTitle}: {page.degradedReason}
              </p>
            ) : null}
            {detail && detail.top_offerings.length === 0 && page?.data && page.data.offerings.items.length === 0 ? (
              <p className="text-sm text-ink-muted">{dict.console.listings.empty}</p>
            ) : page?.data && page.data.offerings.items.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {page.data.offerings.items.map((offering) => (
                  <li key={offering.id}>
                    <Link
                      href={`/o/${offering.slug}`}
                      className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-strong hover:border-accent hover:text-accent"
                    >
                      {offering.title}
                      {offering.price ? (
                        <span className="font-mono text-2xs text-ink-faint">
                          {formatMoney({ amount: offering.price.amount, currency: offering.price.currency }, dict.locale)}
                        </span>
                      ) : null}
                      {offering.flags.demo ? <LocaleDemoBadge locale={session.locale} /> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">{dict.console.listings.empty}</p>
            )}
          </ConsoleSection>
        </>
      ) : null}
    </MerchantChrome>
  );
}

export const dynamic = 'force-dynamic';
